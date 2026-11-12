import type { KnownSignal, Signal } from '../types.js';

/** Two detections closer than this are the same signal even when both are narrow. */
const MIN_HALF_WIDTH_HZ = 50_000;

const halfWidth = (s: Signal) => Math.max(s.widthHz / 2, MIN_HALF_WIDTH_HZ);

/**
 * Every signal found in any sweep run, merged across runs: detections whose frequency ranges overlap are
 * one signal. Each is described by its strongest detection, plus in how many runs it showed up and when.
 * Levels of runs made with different gains are not comparable, which is why the strongest is chosen by
 * its height over that run's own noise floor.
 */
export function mergeKnownSignals(signals: Signal[]): KnownSignal[] {
  const sorted = [...signals].sort((a, b) => a.freqHz - b.freqHz);
  const out: KnownSignal[] = [];
  let group: Signal[] = [];
  let hi = -Infinity;
  const flush = () => {
    if (group.length === 0) return;
    const best = group.reduce((a, b) => (b.excessDb > a.excessDb ? b : a));
    out.push({
      ...best,
      id: `known-${best.freqHz}`,
      firstSeen: Math.min(...group.map((s) => s.firstSeen)),
      lastSeen: Math.max(...group.map((s) => s.lastSeen)),
      scans: new Set(group.map((s) => s.scanId)).size,
    });
    group = [];
    hi = -Infinity;
  };
  for (const s of sorted) {
    if (s.freqHz - halfWidth(s) > hi) flush();
    group.push(s);
    hi = Math.max(hi, s.freqHz + halfWidth(s));
  }
  flush();
  return out.sort((a, b) => b.excessDb - a.excessDb);
}
