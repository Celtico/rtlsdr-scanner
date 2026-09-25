/**
 * Level-2 calibration: rtl_power's relative dB → dBm at the antenna connector.
 * offset(gain) = reference dBm − reading at that gain. One entry per tuner gain; other gains are derived by
 * shifting with the gain difference (the R820T gain steps are close to real dB).
 */

/** Which reading scale an entry calibrates: rtl_power's relative dB ('power') or rtl_sdr raw-IQ dBFS ('iq', Hunt). */
export type CalScale = 'power' | 'iq';

export interface CalibrationEntry {
  scale?: CalScale;
  gainDb: number;
  freqHz: number;
  measuredDb: number;
  refDbm: number;
  /** refDbm − measuredDb */
  offsetDb: number;
  note: string;
  at: number;
}

export interface Calibration { entries: CalibrationEntry[] }

export interface OffsetInfo {
  offsetDb: number;
  /** 'calibrated' = an entry at this gain; 'derived' = shifted from another gain; 'estimated' = generic R820T guess. */
  source: 'calibrated' | 'derived' | 'estimated';
  uncertaintyDb: number;
  fromGainDb: number | null;
}

/**
 * Generic estimate for an RTL-SDR Blog V3 with rtl_power: at 40 dB of gain, a floor reading of about −42 dB
 * in a 10 kHz bin corresponds to the receiver noise (~−128 dBm/10 kHz), so the offset is ≈ −86 dB.
 * Good to ±6 dB across units; only for orientation.
 */
export const ESTIMATED_OFFSET_AT_40 = -86;
/**
 * Raw-IQ scale (Hunt): 0 dBFS of the 8-bit ADC is roughly −30 dBm at the antenna with the tuner at maximum gain
 * (49.6 dB). Much rougher than the rtl_power estimate: ±10 dB. Calibrate with a reference to compare with a gateway.
 */
export const ESTIMATED_IQ_OFFSET_AT_MAX_GAIN = -30;
const MAX_GAIN = 49.6;

export function entryScale(e: CalibrationEntry): CalScale {
  return e.scale ?? 'power';
}

export function offsetFor(cal: Calibration | null, gainDb: number, scale: CalScale = 'power'): OffsetInfo {
  const entries = (cal?.entries ?? []).filter((e) => entryScale(e) === scale);
  const exact = entries.find((e) => Math.abs(e.gainDb - gainDb) < 0.05);
  if (exact) return { offsetDb: r1(exact.offsetDb), source: 'calibrated', uncertaintyDb: 3, fromGainDb: exact.gainDb };
  if (entries.length) {
    const nearest = entries.reduce((a, b) => (Math.abs(b.gainDb - gainDb) < Math.abs(a.gainDb - gainDb) ? b : a));
    const shift = nearest.gainDb - gainDb; // more gain → higher reading → more negative offset
    return { offsetDb: r1(nearest.offsetDb + shift), source: 'derived', uncertaintyDb: 3 + Math.min(6, Math.abs(shift) / 5), fromGainDb: nearest.gainDb };
  }
  if (scale === 'iq') return { offsetDb: r1(ESTIMATED_IQ_OFFSET_AT_MAX_GAIN - (gainDb - MAX_GAIN)), source: 'estimated', uncertaintyDb: 10, fromGainDb: null };
  return { offsetDb: r1(ESTIMATED_OFFSET_AT_40 - (gainDb - 40)), source: 'estimated', uncertaintyDb: 6, fromGainDb: null };
}

export function toDbm(relativeDb: number, offset: OffsetInfo): number {
  return r1(relativeDb + offset.offsetDb);
}

/** Upsert by (scale, gain): one reference per gain and scale is enough; the latest wins. */
export function upsertEntry(cal: Calibration | null, e: Omit<CalibrationEntry, 'offsetDb' | 'at'>): Calibration {
  const scale = e.scale ?? 'power';
  const entry: CalibrationEntry = { ...e, scale, offsetDb: r1(e.refDbm - e.measuredDb), at: Date.now() };
  const rest = (cal?.entries ?? []).filter((x) => !(entryScale(x) === scale && Math.abs(x.gainDb - e.gainDb) < 0.05));
  return { entries: [...rest, entry].sort((a, b) => a.gainDb - b.gainDb) };
}

export function removeEntry(cal: Calibration | null, gainDb: number, scale: CalScale = 'power'): Calibration {
  return { entries: (cal?.entries ?? []).filter((x) => !(entryScale(x) === scale && Math.abs(x.gainDb - gainDb) < 0.05)) };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
