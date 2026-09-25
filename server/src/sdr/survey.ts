import type { Signal, Sweep, SurveyConfig } from '../types.js';
import { bandOf } from './bands.js';

// ---------- rtl_power CSV parsing ----------

export interface PowerLine {
  /** "YYYY-MM-DD HH:MM:SS" as printed by rtl_power (local time). */
  ts: string;
  lowHz: number;
  highHz: number;
  stepHz: number;
  samples: number;
  dbs: number[];
}

/** Parses one rtl_power CSV line: date, time, Hz low, Hz high, Hz step, samples, dB, dB, ... */
export function parsePowerLine(line: string): PowerLine | null {
  const p = line.split(',');
  if (p.length < 7) return null;
  const lowHz = Number(p[2]);
  const highHz = Number(p[3]);
  const stepHz = Number(p[4]);
  const samples = Number(p[5]);
  if (!Number.isFinite(lowHz) || !Number.isFinite(highHz) || !Number.isFinite(stepHz) || stepHz <= 0) return null;
  // rtl_power prints one value more than (high-low)/step bins (the last one is a duplicate): keep exactly the bins.
  const expected = Math.max(1, Math.round((highHz - lowHz) / stepHz));
  const dbs: number[] = [];
  for (let i = 6; i < p.length && dbs.length < expected; i++) {
    const v = Number(p[i]);
    dbs.push(Number.isFinite(v) ? v : NaN);
  }
  return { ts: `${p[0]?.trim()} ${p[1]?.trim()}`, lowHz, highHz, stepHz, samples, dbs };
}

export function parsePowerTimestamp(ts: string): number {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Date.now();
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
}

/**
 * Groups rtl_power lines into full sweeps. rtl_power prints every hop of a sweep with the same timestamp,
 * so a change of timestamp closes the current sweep.
 */
export class SweepAssembler {
  private lines: PowerLine[] = [];
  private currentTs: string | null = null;

  /**
   * @param endHz upper end of the requested range: when a hop reaches it the sweep is closed immediately
   * instead of waiting for the next sweep's first line (a full-band pass can take minutes).
   */
  constructor(private readonly scanId: number, private readonly endHz: number | null = null) {}

  /** Feed one raw line; returns a completed sweep when one closes. */
  push(raw: string): Sweep | null {
    const line = parsePowerLine(raw);
    if (!line) return null;
    let done: Sweep | null = null;
    if (this.currentTs !== null && line.ts !== this.currentTs) done = this.flush();
    this.currentTs = line.ts;
    this.lines.push(line);
    if (this.endHz !== null && line.highHz >= this.endHz - line.stepHz) {
      const closed = this.flush();
      return done ?? closed;
    }
    return done;
  }

  /** Close the sweep being assembled (end of stream). */
  flush(): Sweep | null {
    if (!this.lines.length || this.currentTs === null) return null;
    const sweep = assembleSweep(this.scanId, this.lines, parsePowerTimestamp(this.currentTs));
    this.lines = [];
    this.currentTs = null;
    return sweep;
  }
}

export function assembleSweep(scanId: number, lines: PowerLine[], ts: number): Sweep | null {
  if (!lines.length) return null;
  const stepHz = lines[0]!.stepHz;
  let lowHz = Infinity;
  let highHz = -Infinity;
  for (const l of lines) {
    lowHz = Math.min(lowHz, l.lowHz);
    highHz = Math.max(highHz, l.lowHz + l.dbs.length * l.stepHz);
  }
  const n = Math.max(1, Math.round((highHz - lowHz) / stepHz));
  const dbs = new Array<number>(n).fill(NaN);
  for (const l of lines) {
    const offset = Math.round((l.lowHz - lowHz) / stepHz);
    for (let i = 0; i < l.dbs.length; i++) {
      const idx = offset + i;
      if (idx >= 0 && idx < n) dbs[idx] = Number.isFinite(l.dbs[i]!) ? Math.round(l.dbs[i]! * 10) / 10 : NaN;
    }
  }
  // stepHz may be fractional (rtl_power fits the requested step to its FFT size); lowHz is always integer.
  return { scanId, ts, lowHz: Math.round(lowHz), stepHz, dbs };
}

// ---------- Peak detection ----------

export function median(arr: readonly number[]): number {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1]! : NaN;
}

/** Local noise floor: moving median over ±window bins of the per-bin medians. */
export function noiseFloor(medians: readonly number[], window = 40): number[] {
  return medians.map((_, i) => median(medians.slice(Math.max(0, i - window), i + window + 1)));
}

export interface PeakOptions { thresholdDb: number; floorWindow?: number }

export interface BinStat { freqHz: number; max: number; med: number; floor: number; excess: number; duty: number }

export function binStats(lowHz: number, stepHz: number, history: readonly (readonly number[])[], opts: PeakOptions): BinStat[] {
  const n = history.length ? Math.max(...history.map((h) => h.length)) : 0;
  const med: number[] = new Array(n);
  const columns: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const col: number[] = [];
    for (const h of history) {
      const v = h[i];
      if (v !== undefined && Number.isFinite(v)) col.push(v);
    }
    columns[i] = col;
    med[i] = median(col);
  }
  const floor = noiseFloor(med, opts.floorWindow ?? 40);
  const stats: BinStat[] = [];
  for (let i = 0; i < n; i++) {
    const col = columns[i]!;
    if (!col.length) continue;
    const mx = Math.max(...col);
    const fl = floor[i]!;
    const duty = col.filter((d) => d > fl + opts.thresholdDb).length / col.length;
    stats.push({ freqHz: lowHz + i * stepHz, max: mx, med: med[i]!, floor: fl, excess: mx - fl, duty });
  }
  return stats;
}

export interface Peak { startHz: number; endHz: number; top: BinStat; items: BinStat[] }

/** Groups contiguous bins above threshold into peaks. */
export function detectPeaks(stats: readonly BinStat[], stepHz: number, thresholdDb: number): Peak[] {
  const peaks: Peak[] = [];
  let cur: Peak | null = null;
  for (const s of stats) {
    if (s.excess > thresholdDb) {
      if (cur && s.freqHz - cur.endHz <= stepHz * 1.5) {
        cur.endHz = s.freqHz;
        cur.items.push(s);
        if (s.excess > cur.top.excess) cur.top = s;
      } else {
        cur = { startHz: s.freqHz, endHz: s.freqHz, top: s, items: [s] };
        peaks.push(cur);
      }
    } else {
      cur = null;
    }
  }
  return peaks;
}

/** Signal id: frequency bucketed to the step so a signal keeps its identity between sweeps. */
export function signalId(freqHz: number, stepHz: number): string {
  return String(Math.round(freqHz / stepHz) * stepHz);
}

export function peaksToSignals(peaks: readonly Peak[], scanId: number, stepHz: number, now: number, previous: ReadonlyMap<string, Signal>): Signal[] {
  return peaks
    .map((p) => {
      const id = signalId(p.top.freqHz, stepHz);
      const band = bandOf(p.top.freqHz);
      return {
        id,
        scanId,
        freqHz: Math.round(p.top.freqHz),
        widthHz: Math.round(p.endHz - p.startHz + stepHz),
        peakDb: Math.round(p.top.max * 10) / 10,
        floorDb: Math.round(p.top.floor * 10) / 10,
        excessDb: Math.round(p.top.excess * 10) / 10,
        dutyPct: Math.round(Math.max(...p.items.map((x) => x.duty)) * 100),
        band: band?.name ?? null,
        restricted: band?.restricted ?? false,
        firstSeen: previous.get(id)?.firstSeen ?? now,
        lastSeen: now,
      } satisfies Signal;
    })
    .sort((a, b) => b.excessDb - a.excessDb);
}

/** Keeps a bounded history of sweeps and recomputes the signal list. */
export class SignalTracker {
  private history: number[][] = [];
  private lowHz = 0;
  private stepHz = 1;
  private known = new Map<string, Signal>();

  constructor(private readonly scanId: number, private readonly opts: PeakOptions, private readonly maxHistory = 120) {}

  push(sweep: Sweep): Signal[] {
    if (this.history.length && (sweep.lowHz !== this.lowHz || sweep.stepHz !== this.stepHz)) this.history = [];
    this.lowHz = sweep.lowHz;
    this.stepHz = sweep.stepHz;
    this.history.push(sweep.dbs);
    if (this.history.length > this.maxHistory) this.history.shift();
    const stats = binStats(this.lowHz, this.stepHz, this.history, this.opts);
    const peaks = detectPeaks(stats, this.stepHz, this.opts.thresholdDb);
    const signals = peaksToSignals(peaks, this.scanId, this.stepHz, sweep.ts, this.known);
    this.known = new Map(signals.map((s) => [s.id, s]));
    return signals;
  }

  get sweeps(): number {
    return this.history.length;
  }
}

// ---------- rtl_power arguments ----------

export function formatHz(hz: number): string {
  if (hz % 1_000_000 === 0) return `${hz / 1_000_000}M`;
  if (hz % 1_000 === 0) return `${hz / 1_000}k`;
  return String(hz);
}

export function rtlPowerArgs(c: SurveyConfig): string[] {
  return ['-f', `${formatHz(c.fromHz)}:${formatHz(c.toHz)}:${formatHz(c.stepHz)}`, '-i', String(c.intervalS), '-g', String(c.gainDb), '-'];
}

export function validateSurveyConfig(c: SurveyConfig): string | null {
  if (c.fromHz < 500_000 || c.toHz > 1_766_000_000) return 'El rang ha d’estar entre 0,5 MHz i 1766 MHz.';
  if (c.toHz - c.fromHz < 1_000_000) return 'El rang ha de tenir com a mínim 1 MHz.';
  if (c.stepHz < 1_000 || c.stepHz > 2_800_000) return 'El pas ha d’estar entre 1 kHz i 2,8 MHz.';
  const bins = (c.toHz - c.fromHz) / c.stepHz;
  if (bins > 200_000) return `Massa bins (${Math.round(bins)}). Augmenta el pas o redueix el rang.`;
  if (c.intervalS < 1 || c.intervalS > 600) return 'L’interval ha d’estar entre 1 i 600 s.';
  if (c.gainDb < 0 || c.gainDb > 50) return 'El guany ha d’estar entre 0 i 50 dB.';
  if (c.thresholdDb < 1 || c.thresholdDb > 60) return 'El llindar ha d’estar entre 1 i 60 dB.';
  return null;
}
