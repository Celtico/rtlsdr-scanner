import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from '../db.js';
import type {
  AdsbConfig, DevicesConfig, DongleInfo, HuntConfig, Mode, ModeConfig, SdrErrorCode, Signal, Status, SurveyConfig, WsMessage,
} from '../types.js';
import { SdrProcess, stopAll, type SdrError } from './process.js';
import { rtlPowerArgs, SignalTracker, SweepAssembler, validateSurveyConfig } from './survey.js';
import { parseRtl433Line, rtl433Args, validateDevicesConfig } from './devices.js';
import { parseAdsbLine, PlaneTracker, rtlAdsbArgs, toPlane } from './adsb.js';
import { LevelMeter, rtlSdrArgs, validateHuntConfig } from './hunt.js';

const execFileP = promisify(execFile);

type Tool = 'rtl_test' | 'rtl_power' | 'rtl_433' | 'rtl_adsb' | 'rtl_sdr';

interface Active {
  mode: Exclude<Mode, 'idle'>;
  proc: SdrProcess;
  scanId: number;
  startedAt: number;
  config: SurveyConfig | DevicesConfig | AdsbConfig | HuntConfig;
  counters: { sweeps: number; signals: number; devices: number; planes: number };
  /** Devices seen in this scan (keys), for the counter. */
  seenKeys: Set<string>;
  signals: Signal[];
}

/**
 * Sole owner of the dongle. Serialises every mode change so at most one rtl_* process is alive,
 * and always waits for the previous process to release the USB interface before starting the next.
 */
export class SdrManager extends EventEmitter<{ message: [WsMessage] }> {
  private active: Active | null = null;
  private queue: Promise<void> = Promise.resolve();
  private dongle: DongleInfo = { state: 'unknown', name: null, tuner: null, message: null, checkedAt: null };
  private lastError: Status['lastError'] = null;
  private tools: Record<Tool, boolean> = { rtl_test: false, rtl_power: false, rtl_433: false, rtl_adsb: false, rtl_sdr: false };

  constructor(private readonly db: Db) {
    super();
  }

  // ---------- status ----------

  status(): Status {
    const a = this.active;
    return {
      mode: a?.mode ?? 'idle',
      dongle: this.dongle,
      scanId: a?.scanId ?? null,
      startedAt: a?.startedAt ?? null,
      config: a?.config ?? null,
      lastError: this.lastError,
      counters: a?.counters ?? { sweeps: 0, signals: 0, devices: 0, planes: 0 },
      tools: this.tools,
    };
  }

  currentSignals(): Signal[] {
    return this.active?.signals ?? [];
  }

  private emitStatus(): void {
    this.emit('message', { type: 'status', status: this.status() });
  }

  private fail(code: SdrErrorCode, message: string): void {
    this.lastError = { code, message, at: Date.now() };
    if (code === 'busy') this.dongle = { ...this.dongle, state: 'busy', message };
    else if (code === 'missing') this.dongle = { ...this.dongle, state: 'missing', message };
    this.emit('message', { type: 'error', code, message });
    this.emitStatus();
  }

  // ---------- tool / dongle detection ----------

  async detectTools(): Promise<void> {
    for (const t of Object.keys(this.tools) as Tool[]) {
      try {
        await execFileP('which', [t]);
        this.tools[t] = true;
      } catch {
        this.tools[t] = false;
      }
    }
  }

  /** Runs `rtl_test -t` for ~1.5 s while idle to read the dongle name and tuner. */
  async probeDongle(): Promise<DongleInfo> {
    if (this.active) return this.dongle;
    if (!this.tools.rtl_test) {
      this.dongle = { state: 'error', name: null, tuner: null, message: 'rtl_test no està instal·lat (brew install librtlsdr).', checkedAt: Date.now() };
      this.emitStatus();
      return this.dongle;
    }
    const lines: string[] = [];
    let err: SdrError | null = null;
    const proc = new SdrProcess('rtl_test', ['-t'], {
      onLine: (l) => lines.push(l),
      onStderr: (l) => lines.push(l),
      onError: (e) => { err = err ?? e; },
    });
    await new Promise((r) => setTimeout(r, 1500));
    await proc.stop();
    const text = lines.join('\n');
    const name = text.match(/^\s*0:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const tuner = text.match(/Found (.+ tuner)/)?.[1] ?? null;
    const e = err as SdrError | null;
    if (e) this.dongle = { state: e.code === 'busy' ? 'busy' : e.code === 'missing' ? 'missing' : 'error', name, tuner, message: e.message, checkedAt: Date.now() };
    else if (name) this.dongle = { state: 'connected', name, tuner, message: null, checkedAt: Date.now() };
    else this.dongle = { state: 'missing', name: null, tuner: null, message: 'rtl_test no ha trobat cap dispositiu.', checkedAt: Date.now() };
    this.emitStatus();
    return this.dongle;
  }

  // ---------- mode switching ----------

  /** Switches mode. Serialised: concurrent calls run one after another. */
  setMode(req: ModeConfig): Promise<Status> {
    const run = this.queue.then(() => this.switchTo(req));
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(() => this.status());
  }

  private async switchTo(req: ModeConfig): Promise<void> {
    if (req.mode !== 'idle') {
      const err = req.mode === 'survey' ? validateSurveyConfig(req.config)
        : req.mode === 'devices' ? validateDevicesConfig(req.config)
        : req.mode === 'hunt' ? validateHuntConfig(req.config) : null;
      if (err) throw new Error(err);
      const tool: Tool = req.mode === 'survey' ? 'rtl_power' : req.mode === 'devices' ? 'rtl_433' : req.mode === 'hunt' ? 'rtl_sdr' : 'rtl_adsb';
      if (!this.tools[tool]) throw new Error(`No trobo "${tool}". Instal·la'l amb brew install librtlsdr rtl_433.`);
    }
    await this.stopActive();
    if (req.mode === 'idle') {
      this.emitStatus();
      return;
    }
    this.lastError = null;
    if (req.mode === 'survey') this.startSurvey(req.config);
    else if (req.mode === 'devices') this.startDevices(req.config);
    else if (req.mode === 'hunt') this.startHunt(req.config);
    else this.startAdsb(req.config);
    this.dongle = { ...this.dongle, state: 'in-use', message: null };
    this.emitStatus();
  }

  private async stopActive(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    await a.proc.stop();
    this.db.endScan(a.scanId);
    if (this.dongle.state === 'in-use') this.dongle = { ...this.dongle, state: 'connected' };
  }

  /** Called when a child exits by itself (error, USB unplugged, ...). */
  private onChildExit(a: Active, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.active !== a) return; // we stopped it deliberately
    this.active = null;
    this.db.endScan(a.scanId);
    if (this.dongle.state === 'in-use') this.dongle = { ...this.dongle, state: 'connected' };
    if (!this.lastError) this.fail('exit', `${a.proc.bin} ha acabat inesperadament (codi ${code ?? signal ?? '?'}).`);
    else this.emitStatus();
  }

  private baseHandlers(getActive: () => Active) {
    return {
      onStderr: (l: string) => {
        if (process.env.SDR_DEBUG) console.error(`[${getActive().proc.bin}] ${l}`);
        const tuner = l.match(/Found (.+ tuner)/)?.[1];
        if (tuner && tuner !== this.dongle.tuner) this.dongle = { ...this.dongle, tuner };
      },
      onError: (e: SdrError) => this.fail(e.code, e.message),
      onExit: (code: number | null, signal: NodeJS.Signals | null) => this.onChildExit(getActive(), code, signal),
    };
  }

  private newActive(mode: Active['mode'], config: Active['config'], proc: SdrProcess, scanId: number): Active {
    return {
      mode, proc, scanId, startedAt: Date.now(), config,
      counters: { sweeps: 0, signals: 0, devices: 0, planes: 0 }, seenKeys: new Set(), signals: [],
    };
  }

  // ---------- survey ----------

  private startSurvey(config: SurveyConfig): void {
    const scanId = this.db.createScan('survey', config);
    const assembler = new SweepAssembler(scanId, config.toHz);
    const tracker = new SignalTracker(scanId, { thresholdDb: config.thresholdDb });
    const ref: { a: Active | null } = { a: null };
    const proc = new SdrProcess('rtl_power', rtlPowerArgs(config), {
      ...this.baseHandlers(() => ref.a!),
      onLine: (line) => {
        const active = ref.a;
        const sweep = assembler.push(line);
        if (!sweep || !active || this.active !== active) return;
        this.db.insertSweep(sweep);
        active.counters.sweeps += 1;
        this.emit('message', { type: 'survey:sweep', sweep });
        const signals = tracker.push(sweep);
        active.signals = signals;
        active.counters.signals = signals.length;
        this.db.replaceSignals(scanId, signals);
        this.emit('message', { type: 'survey:signals', scanId, signals });
        this.emitStatus();
      },
    });
    ref.a = this.newActive('survey', config, proc, scanId);
    this.active = ref.a;
  }

  // ---------- devices ----------

  private startDevices(config: DevicesConfig): void {
    const scanId = this.db.createScan('devices', config);
    const ref: { a: Active | null } = { a: null };
    const proc = new SdrProcess('rtl_433', rtl433Args(config), {
      ...this.baseHandlers(() => ref.a!),
      onLine: (line) => {
        const active = ref.a;
        const m = parseRtl433Line(line);
        if (!m || !active || this.active !== active) return;
        const { device, isNew } = this.db.upsertDevice({ ...m, scanId });
        if (!active.seenKeys.has(m.key)) {
          active.seenKeys.add(m.key);
          active.counters.devices = active.seenKeys.size;
        }
        this.emit('message', { type: isNew ? 'device:new' : 'device:update', device });
        this.emitStatus();
      },
    });
    ref.a = this.newActive('devices', config, proc, scanId);
    this.active = ref.a;
  }

  // ---------- adsb ----------

  private startAdsb(config: AdsbConfig): void {
    const scanId = this.db.createScan('adsb', config);
    const tracker = new PlaneTracker();
    const ref: { a: Active | null } = { a: null };
    const proc = new SdrProcess('rtl_adsb', rtlAdsbArgs(config), {
      ...this.baseHandlers(() => ref.a!),
      onLine: (line) => {
        const active = ref.a;
        const hex = parseAdsbLine(line);
        if (!hex || !active || this.active !== active) return;
        const r = tracker.push(hex, Date.now());
        if (!r) return;
        active.counters.planes = tracker.planes.size;
        const plane = toPlane(r.plane);
        // Persist every frame (msgs counter) but only broadcast when something visible changed.
        this.db.upsertPlane({ ...plane, msgs: 1 }, scanId);
        if (r.changed || r.plane.msgs % 20 === 0) {
          this.emit('message', { type: 'adsb:plane', plane });
          this.emitStatus();
        }
      },
    });
    ref.a = this.newActive('adsb', config, proc, scanId);
    this.active = ref.a;
  }

  // ---------- hunt ----------

  private startHunt(config: HuntConfig): void {
    const scanId = this.db.createScan('hunt', config);
    const meter = new LevelMeter(config.sampleRate);
    const ref: { a: Active | null } = { a: null };
    const proc = new SdrProcess('rtl_sdr', rtlSdrArgs(config), {
      ...this.baseHandlers(() => ref.a!),
      binary: true,
      onData: (chunk) => {
        const active = ref.a;
        if (!active || this.active !== active) return;
        for (const level of meter.push(chunk)) {
          this.emit('message', { type: 'hunt:level', level, maxDbfs: meter.maxDbfs, maxAt: meter.maxAt });
        }
      },
    });
    ref.a = this.newActive('hunt', config, proc, scanId);
    this.active = ref.a;
  }

  // ---------- shutdown ----------

  async shutdown(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (a) this.db.endScan(a.scanId);
    await stopAll();
  }
}
