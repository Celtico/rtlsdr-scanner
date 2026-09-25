import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from '../db.js';
import { connect as netConnect } from 'node:net';
import {
  AUDIO_SAMPLE_RATE, DAB_CHANNELS, DAB_CONTAINER, DAB_IMAGE, DAB_WEB_PORT, FM_BAND, RTL_TCP_PORT,
  type AdsbConfig, type AudioConfig, type DabConfig, type DevicesConfig, type DongleInfo, type HuntConfig, type Mode, type ModeConfig,
  type SatelliteConfig, type SdrErrorCode, type Signal, type Status, type SurveyConfig, type WsMessage,
} from '../types.js';
import { SdrProcess, stopAll, type SdrError } from './process.js';
import { rtlPowerArgs, SignalTracker, SweepAssembler, validateSurveyConfig } from './survey.js';
import { parseRtl433Line, rtl433Args, validateDevicesConfig } from './devices.js';
import { parseAdsbLine, PlaneTracker, rtlAdsbArgs, toPlane } from './adsb.js';
import { LevelMeter, rtlSdrArgs, validateHuntConfig } from './hunt.js';
import { findSatdump, listImages, satdumpArgs } from './satellite.js';

const execFileP = promisify(execFile);

export function validateDabConfig(c: DabConfig): string | null {
  if (!DAB_CHANNELS.some((ch) => ch.name === c.channel)) return 'Bloc DAB desconegut (5A–13F).';
  if (c.gainDb !== null && (c.gainDb < 0 || c.gainDb > 50)) return 'El guany ha d’estar entre 0 i 50 dB.';
  return null;
}

/** Polls a local TCP port until it accepts connections. */
export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const s = netConnect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 250); });
    };
    attempt();
  });
}

export function validateAudioConfig(c: AudioConfig): string | null {
  if (c.freqHz < FM_BAND.fromHz || c.freqHz > FM_BAND.toHz) return 'Només es pot escoltar la banda de radiodifusió FM (87,5–108 MHz).';
  if (c.gainDb !== null && (c.gainDb < 0 || c.gainDb > 50)) return 'El guany ha d’estar entre 0 i 50 dB.';
  return null;
}

type Tool = 'rtl_test' | 'rtl_power' | 'rtl_433' | 'rtl_adsb' | 'rtl_sdr' | 'rtl_fm' | 'rtl_tcp' | 'satdump' | 'docker';

interface Active {
  mode: Exclude<Mode, 'idle'>;
  proc: SdrProcess;
  scanId: number;
  startedAt: number;
  config: SurveyConfig | DevicesConfig | AdsbConfig | HuntConfig | SatelliteConfig | AudioConfig | DabConfig;
  counters: { sweeps: number; signals: number; devices: number; planes: number };
  /** Devices seen in this scan (keys), for the counter. */
  seenKeys: Set<string>;
  signals: Signal[];
  /** Last stderr lines (satdump logs there). */
  satLog: string[];
  /** Hunt mode: the live meter, for the end-of-scan summary. */
  huntMeter?: LevelMeter;
  huntSamples?: number;
  /** DAB mode: the Docker client process (the dongle owner `proc` is rtl_tcp). */
  containerProc?: SdrProcess;
  /** Last log lines of the mode (docker/welle-cli output), for the UI. */
  log: string[];
}

/**
 * Sole owner of the dongle. Serialises every mode change so at most one rtl_* process is alive,
 * and always waits for the previous process to release the USB interface before starting the next.
 */
export class SdrManager extends EventEmitter<{ message: [WsMessage]; audio: [Uint8Array] }> {
  private active: Active | null = null;
  private queue: Promise<void> = Promise.resolve();
  private dongle: DongleInfo = { state: 'unknown', name: null, tuner: null, message: null, checkedAt: null };
  private lastError: Status['lastError'] = null;
  private tools: Record<Tool, boolean> = { rtl_test: false, rtl_power: false, rtl_433: false, rtl_adsb: false, rtl_sdr: false, rtl_fm: false, rtl_tcp: false, satdump: false, docker: false };

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

  private satdumpBin: string | null = null;

  async detectTools(): Promise<void> {
    for (const t of Object.keys(this.tools) as Tool[]) {
      if (t === 'satdump') {
        this.satdumpBin = findSatdump();
        this.tools.satdump = this.satdumpBin !== null;
        continue;
      }
      if (t === 'docker') {
        // Docker counts as available only if the daemon runs and the decoders image is built.
        try {
          await execFileP('docker', ['image', 'inspect', DAB_IMAGE], { timeout: 8000 });
          this.tools.docker = true;
        } catch {
          this.tools.docker = false;
        }
        continue;
      }
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
        : req.mode === 'hunt' ? validateHuntConfig(req.config)
        : req.mode === 'audio' ? validateAudioConfig(req.config)
        : req.mode === 'dab' ? validateDabConfig(req.config) : null;
      if (err) throw new Error(err);
      const tool: Tool = req.mode === 'survey' ? 'rtl_power' : req.mode === 'devices' ? 'rtl_433' : req.mode === 'hunt' ? 'rtl_sdr'
        : req.mode === 'satellite' ? 'satdump' : req.mode === 'audio' ? 'rtl_fm' : req.mode === 'dab' ? 'rtl_tcp' : 'rtl_adsb';
      if (!this.tools[tool]) throw new Error(`No trobo "${tool}". Instal·la'l amb brew install librtlsdr rtl_433.`);
      if (req.mode === 'dab' && !this.tools.docker) throw new Error(`Docker no està en marxa o falta la imatge ${DAB_IMAGE} (docker build -t ${DAB_IMAGE} docker/decoders).`);
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
    else if (req.mode === 'satellite') this.startSatellite(req.config);
    else if (req.mode === 'audio') this.startAudio(req.config);
    else if (req.mode === 'dab') await this.startDab(req.config);
    else this.startAdsb(req.config);
    this.dongle = { ...this.dongle, state: 'in-use', message: null };
    this.emitStatus();
  }

  private async stopActive(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.containerProc) await this.stopContainer(a.containerProc);
    await a.proc.stop();
    this.db.endScan(a.scanId, this.scanSummary(a));
    if (a.mode === 'satellite') this.finishSatellite(a, 'cancelled');
    if (this.dongle.state === 'in-use') this.dongle = { ...this.dongle, state: 'connected' };
  }

  private scanSummary(a: Active): Record<string, unknown> | undefined {
    if (a.mode === 'hunt' && a.huntMeter) {
      return { maxDbfs: Number.isFinite(a.huntMeter.maxDbfs) ? a.huntMeter.maxDbfs : null, maxAt: a.huntMeter.maxAt, samples: a.huntSamples ?? 0 };
    }
    return undefined;
  }

  /** Marks the capture finished and collects the decoded images (SatDump writes them at the end). */
  private finishSatellite(a: Active, statusIfNoImages: 'cancelled' | 'failed'): void {
    const cfg = a.config as SatelliteConfig;
    const cap = this.db.getSatCapture(cfg.captureId);
    if (!cap) return;
    const images = listImages(cap.dir);
    const status = images.length ? 'done' : statusIfNoImages;
    const log = a.satLog.slice(-40).join('\n');
    const updated = this.db.updateSatCapture(cap.id, { status, images, log });
    if (updated) this.emit('message', { type: 'satellite:capture', capture: updated });
  }

  /** Called when a child exits by itself (error, USB unplugged, ...). */
  private onChildExit(a: Active, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.active !== a) return; // we stopped it deliberately
    this.active = null;
    this.db.endScan(a.scanId, this.scanSummary(a));
    if (this.dongle.state === 'in-use') this.dongle = { ...this.dongle, state: 'connected' };
    if (a.mode === 'satellite') {
      // satdump exits by itself when the timeout ends: that's the normal end of a capture.
      this.finishSatellite(a, code === 0 ? 'failed' : 'failed');
      this.emitStatus();
      return;
    }
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
      counters: { sweeps: 0, signals: 0, devices: 0, planes: 0 }, seenKeys: new Set(), signals: [], satLog: [], log: [],
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
          active.huntSamples = (active.huntSamples ?? 0) + 1;
          this.emit('message', { type: 'hunt:level', level, maxDbfs: meter.maxDbfs, maxAt: meter.maxAt });
        }
      },
    });
    ref.a = this.newActive('hunt', config, proc, scanId);
    ref.a.huntMeter = meter;
    this.active = ref.a;
  }

  // ---------- satellite ----------

  private startSatellite(config: SatelliteConfig): void {
    const cap = this.db.getSatCapture(config.captureId);
    if (!cap) throw new Error('Captura no trobada');
    const scanId = this.db.createScan('satellite', config);
    const ref: { a: Active | null } = { a: null };
    const base = this.baseHandlers(() => ref.a!);
    const proc = new SdrProcess(this.satdumpBin ?? 'satdump', satdumpArgs(config, cap.dir), {
      ...base,
      onStderr: (l) => {
        base.onStderr(l);
        const a = ref.a;
        if (a) { a.satLog.push(l.replace(/\x1b\[[0-9;]*m/g, '')); if (a.satLog.length > 200) a.satLog.shift(); }
      },
      onLine: (l) => {
        const a = ref.a;
        if (a) { a.satLog.push(l.replace(/\x1b\[[0-9;]*m/g, '')); if (a.satLog.length > 200) a.satLog.shift(); }
      },
    });
    ref.a = this.newActive('satellite', config, proc, scanId);
    this.active = ref.a;
    const running = this.db.updateSatCapture(cap.id, { status: 'running' });
    if (running) this.emit('message', { type: 'satellite:capture', capture: running });
  }

  // ---------- audio (FM broadcast) ----------

  private startAudio(config: AudioConfig): void {
    const scanId = this.db.createScan('audio', config);
    const ref: { a: Active | null } = { a: null };
    const args = ['-f', String(config.freqHz), '-M', 'wbfm', '-s', '200k', '-r', String(AUDIO_SAMPLE_RATE), '-E', 'deemp'];
    if (config.gainDb !== null) args.push('-g', String(config.gainDb));
    args.push('-');
    const proc = new SdrProcess('rtl_fm', args, {
      ...this.baseHandlers(() => ref.a!),
      binary: true,
      onData: (chunk) => {
        if (ref.a && this.active === ref.a) this.emit('audio', chunk);
      },
    });
    ref.a = this.newActive('audio', config, proc, scanId);
    this.active = ref.a;
  }

  // ---------- DAB (welle-cli in Docker over rtl_tcp) ----------

  currentLog(): string[] {
    return this.active?.log ?? [];
  }

  private async stopContainer(proc: SdrProcess): Promise<void> {
    // `docker run` is only a client: removing the container is what actually frees rtl_tcp.
    try { await execFileP('docker', ['rm', '-f', DAB_CONTAINER], { timeout: 15_000 }); } catch { /* already gone */ }
    await proc.stop();
  }

  private async startDab(config: DabConfig): Promise<void> {
    const scanId = this.db.createScan('dab', config);
    const ref: { a: Active | null } = { a: null };
    // rtl_tcp prints "Signal caught, exiting!" on every client disconnect (our port probe, welle retunes) and keeps listening.
    const NOISE = /Signal caught, exiting!|comm recv bye|all threads dead|listening\.\.\./;
    const pushLog = (l: string) => { const a = ref.a; if (a && !NOISE.test(l)) { a.log.push(l); if (a.log.length > 100) a.log.shift(); } };
    const tcpArgs = ['-a', '0.0.0.0', '-p', String(RTL_TCP_PORT)];
    if (config.gainDb !== null) tcpArgs.push('-g', String(config.gainDb));
    const base = this.baseHandlers(() => ref.a!);
    const proc = new SdrProcess('rtl_tcp', tcpArgs, { ...base, onStderr: (l) => { base.onStderr(l); pushLog(`rtl_tcp: ${l}`); }, onLine: (l) => pushLog(`rtl_tcp: ${l}`) });
    ref.a = this.newActive('dab', config, proc, scanId);
    this.active = ref.a;
    const active = ref.a;
    if (!(await waitForPort(RTL_TCP_PORT, 6000))) {
      pushLog('rtl_tcp no escolta al port; s’atura.');
      return; // onChildExit/fail will have reported the reason (busy/missing)
    }
    if (this.active !== active) return;
    try { await execFileP('docker', ['rm', '-f', DAB_CONTAINER], { timeout: 15_000 }); } catch { /* none */ }
    const dockerArgs = [
      'run', '--rm', '--name', DAB_CONTAINER, '-p', `127.0.0.1:${DAB_WEB_PORT}:${DAB_WEB_PORT}`, DAB_IMAGE,
      'welle-cli', '-c', config.channel, '-w', String(DAB_WEB_PORT), '-F', `rtl_tcp,host.docker.internal:${RTL_TCP_PORT}`, '-g', '-1', '-T',
    ];
    const container = new SdrProcess('docker', dockerArgs, {
      onLine: (l) => pushLog(`welle: ${l}`),
      onStderr: (l) => pushLog(`welle: ${l}`),
      onError: (e) => this.fail(e.code === 'tool-missing' ? 'tool-missing' : 'unknown', e.code === 'tool-missing' ? 'No trobo "docker".' : e.message),
      onExit: (code) => {
        if (this.active === active) {
          pushLog(`El contenidor ha acabat (codi ${code ?? '?'}).`);
          void this.setMode({ mode: 'idle' });
        }
      },
    });
    active.containerProc = container;
    this.emitStatus();
  }

  // ---------- shutdown ----------

  async shutdown(): Promise<void> {
    const a = this.active;
    this.active = null;
    if (a) this.db.endScan(a.scanId, this.scanSummary(a));
    if (a?.containerProc) await this.stopContainer(a.containerProc);
    await stopAll();
  }
}
