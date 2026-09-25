import type { Sweep } from '../types.js';
import { BANDS, bandOf } from './bands.js';
import { median } from './survey.js';

/**
 * Local EMI ("electromagnetic pollution") analysis from rtl_power sweeps.
 * Everything is relative dB from an uncalibrated receiver: it tells you WHERE the noise floor is raised and
 * what kind of source that pattern suggests, never field strength or health limits.
 */

export interface NoiseChunk { fromHz: number; toHz: number; floorDb: number; p50Db: number; p90Db: number; bins: number }

export interface BandNoise { band: string; fromHz: number; toHz: number; floorDb: number; aboveMinDb: number; restricted: boolean }

export interface Comb {
  spacingHz: number;
  fromHz: number;
  toHz: number;
  count: number;
  meanExcessDb: number;
  /** Likely source given the spacing. */
  source: string;
}

export interface BroadbandRegion { fromHz: number; toHz: number; riseDb: number; source: string }

export interface Carrier { freqHz: number; excessDb: number; widthHz: number; band: string | null; source: string }

export interface EmiReport {
  lowHz: number;
  stepHz: number;
  sweeps: number;
  /** Overall noise floor (20th percentile of all bins) and its spread. */
  floorDb: number;
  minChunkFloorDb: number;
  chunks: NoiseChunk[];
  bands: BandNoise[];
  combs: Comb[];
  broadband: BroadbandRegion[];
  carriers: Carrier[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Median across sweeps per bin: removes bursts, keeps the steady floor and steady spurs. */
export function medianSpectrum(sweeps: readonly Sweep[]): { lowHz: number; stepHz: number; dbs: number[] } | null {
  if (!sweeps.length) return null;
  const ref = sweeps[sweeps.length - 1]!;
  const same = sweeps.filter((s) => s.lowHz === ref.lowHz && Math.abs(s.stepHz - ref.stepHz) < 1e-6 && s.dbs.length === ref.dbs.length);
  const n = ref.dbs.length;
  const dbs = new Array<number>(n);
  const col: number[] = [];
  for (let i = 0; i < n; i++) {
    col.length = 0;
    for (const s of same) { const v = s.dbs[i]!; if (Number.isFinite(v)) col.push(v); }
    dbs[i] = col.length ? median(col) : NaN;
  }
  return { lowHz: ref.lowHz, stepHz: ref.stepHz, dbs };
}

/** Noise floor per chunk (20th percentile ignores signals sitting on top of the floor). */
export function noiseChunks(lowHz: number, stepHz: number, dbs: readonly number[], chunkHz: number): NoiseChunk[] {
  const out: NoiseChunk[] = [];
  const perChunk = Math.max(1, Math.round(chunkHz / stepHz));
  for (let i = 0; i < dbs.length; i += perChunk) {
    const vals = dbs.slice(i, i + perChunk).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length < 3) continue;
    out.push({
      fromHz: Math.round(lowHz + i * stepHz), toHz: Math.round(lowHz + Math.min(dbs.length, i + perChunk) * stepHz),
      floorDb: r1(percentile(vals, 0.2)), p50Db: r1(percentile(vals, 0.5)), p90Db: r1(percentile(vals, 0.9)), bins: vals.length,
    });
  }
  return out;
}

export function bandNoise(lowHz: number, stepHz: number, dbs: readonly number[], minFloorDb: number): BandNoise[] {
  const out: BandNoise[] = [];
  for (const b of BANDS) {
    const i0 = Math.max(0, Math.ceil((b.fromHz - lowHz) / stepHz));
    const i1 = Math.min(dbs.length, Math.floor((b.toHz - lowHz) / stepHz));
    if (i1 - i0 < 3) continue;
    const vals = dbs.slice(i0, i1).filter((v) => Number.isFinite(v)).sort((a, b2) => a - b2);
    if (vals.length < 3) continue;
    const floor = percentile(vals, 0.2);
    out.push({ band: b.name, fromHz: b.fromHz, toHz: b.toHz, floorDb: r1(floor), aboveMinDb: r1(floor - minFloorDb), restricted: !!b.restricted });
  }
  return out;
}

/**
 * Local floor by moving 20th percentile (wider than the signal detector's median so spurs don't lift it).
 * Evaluated every `stride` bins and held in between: the floor varies slowly, the full version is O(n·w·log w).
 */
function localFloor(dbs: readonly number[], window: number): number[] {
  const out = new Array<number>(dbs.length);
  const stride = Math.max(1, Math.floor(window / 8));
  let last = NaN;
  for (let i = 0; i < dbs.length; i += stride) {
    const seg = dbs.slice(Math.max(0, i - window), i + window + 1).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    last = seg.length ? percentile(seg, 0.2) : last;
    for (let j = i; j < Math.min(dbs.length, i + stride); j++) out[j] = last;
  }
  return out;
}

interface Spur { idx: number; freqHz: number; excess: number }

function findSpurs(lowHz: number, stepHz: number, dbs: readonly number[], thresholdDb: number): { spurs: Spur[]; floor: number[] } {
  const window = Math.max(10, Math.round(2_000_000 / stepHz));
  const floor = localFloor(dbs, window);
  const spurs: Spur[] = [];
  for (let i = 1; i < dbs.length - 1; i++) {
    const v = dbs[i]!;
    if (!Number.isFinite(v)) continue;
    const ex = v - floor[i]!;
    if (ex > thresholdDb && v >= (dbs[i - 1] ?? -Infinity) && v >= (dbs[i + 1] ?? -Infinity)) spurs.push({ idx: i, freqHz: lowHz + i * stepHz, excess: ex });
  }
  return { spurs, floor };
}

function combSource(spacingHz: number): string {
  if (spacingHz < 15_000) return 'harmònics d’un oscil·lador de baixa freqüència (inversor, làmpada fluorescent)';
  if (spacingHz < 300_000) return 'font d’alimentació commutada: carregador, driver de LED, alimentador d’ordinador o de router';
  if (spacingHz < 3_000_000) return 'convertidor DC-DC ràpid, controlador de pantalla o bus digital (USB, HDMI, Ethernet)';
  return 'rellotge digital i els seus harmònics (processador, memòria, oscil·lador de quars)';
}

/**
 * Combs: spurs at (nearly) equal spacing, typical of switching supplies. We histogram the spacing between
 * consecutive spurs and keep spacings with ≥ minCount members that form an unbroken run.
 */
export function detectCombs(lowHz: number, stepHz: number, dbs: readonly number[], thresholdDb = 6, minCount = 5): Comb[] {
  const { spurs } = findSpurs(lowHz, stepHz, dbs, thresholdDb);
  if (spurs.length < minCount) return [];
  const tol = Math.max(stepHz * 1.5, 500);
  const combs: Comb[] = [];
  const used = new Set<number>();
  // candidate spacings from consecutive spurs
  const spacings = new Map<number, { n: number; sum: number }>();
  for (let i = 1; i < spurs.length; i++) {
    const d = spurs[i]!.freqHz - spurs[i - 1]!.freqHz;
    if (d < stepHz * 2 || d > 5_000_000) continue;
    const key = Math.round(d / tol);
    const e = spacings.get(key) ?? { n: 0, sum: 0 };
    e.n += 1; e.sum += d;
    spacings.set(key, e);
  }
  const candidates = [...spacings.values()].filter((e) => e.n >= minCount - 1).sort((a, b) => b.n - a.n).map((e) => e.sum / e.n);
  for (const spacing of candidates) {
    // walk runs of spurs separated by ~spacing
    let run: Spur[] = [];
    const flush = () => {
      // A run whose spurs mostly belong to a comb already reported (at a multiple of its spacing) is a duplicate.
      const fresh = run.filter((s) => !used.has(s.idx)).length;
      if (run.length >= minCount && fresh > run.length / 2) {
        run.forEach((s) => used.add(s.idx));
        combs.push({
          spacingHz: Math.round(spacing), fromHz: Math.round(run[0]!.freqHz), toHz: Math.round(run[run.length - 1]!.freqHz), count: run.length,
          meanExcessDb: r1(run.reduce((a, s) => a + s.excess, 0) / run.length), source: combSource(spacing),
        });
      }
      run = [];
    };
    for (let i = 0; i < spurs.length; i++) {
      const s = spurs[i]!;
      if (!run.length) { run.push(s); continue; }
      const gap = s.freqHz - run[run.length - 1]!.freqHz;
      const k = Math.round(gap / spacing);
      if (k >= 1 && k <= 2 && Math.abs(gap - k * spacing) <= tol) run.push(s);
      else if (gap > spacing * 2.5) { flush(); run.push(s); }
    }
    flush();
  }
  return combs.sort((a, b) => b.count - a.count).slice(0, 8);
}

/** Contiguous chunks whose floor sits clearly above the quietest chunks: broadband noise (PLC, motors, switching). */
export function detectBroadband(chunks: readonly NoiseChunk[], riseDb = 6, minSpanHz = 15_000_000): BroadbandRegion[] {
  if (chunks.length < 4) return [];
  const floors = chunks.map((c) => c.floorDb).sort((a, b) => a - b);
  const base = percentile(floors, 0.25);
  const out: BroadbandRegion[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const seg = chunks.slice(start, end);
    const span = seg[seg.length - 1]!.toHz - seg[0]!.fromHz;
    if (span >= minSpanHz) {
      const rise = seg.reduce((a, c) => a + c.floorDb, 0) / seg.length - base;
      out.push({ fromHz: seg[0]!.fromHz, toHz: seg[seg.length - 1]!.toHz, riseDb: r1(rise), source: broadbandSource(seg[0]!.fromHz, seg[seg.length - 1]!.toHz) });
    }
    start = -1;
  };
  chunks.forEach((c, i) => {
    if (c.floorDb - base >= riseDb) { if (start < 0) start = i; } else flush(i);
  });
  flush(chunks.length);
  return out;
}

function broadbandSource(fromHz: number, toHz: number): string {
  if (toHz <= 90_000_000) return 'PLC (Ethernet per la xarxa elèctrica), carregadors o motors: soroll de banda ampla per sota de 90 MHz';
  if (fromHz >= 700_000_000 && toHz <= 1_000_000_000) return 'estacions base de mòbil: no és soroll local, és trànsit LTE/5G';
  if (fromHz >= 1_600_000_000) return 'pèrdua de sensibilitat del tuner al límit superior, no una font real';
  return 'font de banda ampla propera (commutació, motor, pantalla) o desensibilització per una emissora molt forta';
}

/** Steady narrow carriers outside broadcast/service bands: monitors, PCs, chargers, harmonics of the dongle. */
export function detectCarriers(lowHz: number, stepHz: number, dbs: readonly number[], thresholdDb = 12): Carrier[] {
  const { spurs } = findSpurs(lowHz, stepHz, dbs, thresholdDb);
  const out: Carrier[] = [];
  const edge = Math.max(3, Math.round(50_000 / stepHz)); // rtl_power's first/last bins of a hop are filter roll-off artefacts
  for (const s of spurs) {
    if (s.idx < edge || s.idx >= dbs.length - edge) continue;
    const band = bandOf(s.freqHz);
    if (band && (band.broadcast || band.restricted)) continue;
    if (band && /ISM|Radioaficionats|aèria|marina|PMR|ADS-B|GNSS|Satèl·lits|Comptadors/.test(band.name)) continue;
    // width: bins above half the excess around the peak
    let w = 1;
    for (let j = s.idx + 1; j < dbs.length && (dbs[j]! - (dbs[s.idx]! - s.excess)) > s.excess / 2; j++) w++;
    for (let j = s.idx - 1; j >= 0 && (dbs[j]! - (dbs[s.idx]! - s.excess)) > s.excess / 2; j--) w++;
    const mhz = s.freqHz / 1e6;
    const source = Math.abs(mhz / 28.8 - Math.round(mhz / 28.8)) < 0.02 ? 'harmònic del rellotge de 28,8 MHz del propi dongle'
      : w * stepHz < 50_000 ? 'portadora fixa: oscil·lador d’un aparell (monitor, PC, carregador, router)'
      : 'senyal estable sense assignació coneguda';
    out.push({ freqHz: Math.round(s.freqHz), excessDb: r1(s.excess), widthHz: Math.round(w * stepHz), band: band?.name ?? null, source });
  }
  // Keep the strongest of any group of peaks closer than their width (one wide signal shows several local maxima).
  const kept: Carrier[] = [];
  for (const c of out.sort((a, b) => b.excessDb - a.excessDb)) {
    if (!kept.some((k) => Math.abs(k.freqHz - c.freqHz) <= Math.max(k.widthHz, c.widthHz))) kept.push(c);
    if (kept.length >= 20) break;
  }
  return kept;
}

export function analyzeEmi(sweeps: readonly Sweep[], chunkHz?: number): EmiReport | null {
  const spec = medianSpectrum(sweeps);
  if (!spec) return null;
  const span = spec.stepHz * spec.dbs.length;
  const chunk = chunkHz ?? (span > 500_000_000 ? 20_000_000 : span > 100_000_000 ? 5_000_000 : 1_000_000);
  const chunks = noiseChunks(spec.lowHz, spec.stepHz, spec.dbs, chunk);
  const all = spec.dbs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const floorDb = r1(percentile(all, 0.2));
  const minChunkFloorDb = chunks.length ? r1(Math.min(...chunks.map((c) => c.floorDb))) : floorDb;
  return {
    lowHz: spec.lowHz, stepHz: spec.stepHz, sweeps: sweeps.length, floorDb, minChunkFloorDb, chunks,
    bands: bandNoise(spec.lowHz, spec.stepHz, spec.dbs, minChunkFloorDb),
    combs: detectCombs(spec.lowHz, spec.stepHz, spec.dbs),
    broadband: detectBroadband(chunks),
    carriers: detectCarriers(spec.lowHz, spec.stepHz, spec.dbs),
  };
}

export interface ChunkDelta { fromHz: number; toHz: number; baselineDb: number; currentDb: number; deltaDb: number }

/** Per-chunk floor difference between two reports on the same grid (positive = noisier now). */
export function compareReports(baseline: EmiReport, current: EmiReport): ChunkDelta[] {
  const out: ChunkDelta[] = [];
  for (const c of current.chunks) {
    const b = baseline.chunks.find((x) => Math.abs(x.fromHz - c.fromHz) < 1000 && Math.abs(x.toHz - c.toHz) < 1000);
    if (b) out.push({ fromHz: c.fromHz, toHz: c.toHz, baselineDb: b.floorDb, currentDb: c.floorDb, deltaDb: r1(c.floorDb - b.floorDb) });
  }
  return out;
}

/** Overall floor of each sweep over time (for the day/night trend). */
export function floorTrend(sweeps: readonly Sweep[]): { ts: number; floorDb: number }[] {
  return sweeps.map((s) => {
    const vals = s.dbs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return { ts: s.ts, floorDb: r1(percentile(vals, 0.2)) };
  });
}

const r1 = (x: number) => Math.round(x * 10) / 10;
