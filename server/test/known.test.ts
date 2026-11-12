import { describe, expect, it } from 'vitest';
import { mergeKnownSignals } from '../src/sdr/known.js';
import type { Signal } from '../src/types.js';

const sig = (scanId: number, freqMHz: number, excessDb: number, widthKHz = 200, seen = scanId * 1000): Signal => ({
  id: `${scanId}-${freqMHz}`, scanId, freqHz: freqMHz * 1e6, widthHz: widthKHz * 1e3, peakDb: -20, floorDb: -40, excessDb,
  dutyPct: 100, band: null, restricted: false, firstSeen: seen, lastSeen: seen + 500,
});

describe('mergeKnownSignals', () => {
  it('merges the same station across runs and keeps the strongest detection', () => {
    const known = mergeKnownSignals([sig(1, 100.0, 12), sig(2, 100.05, 20), sig(3, 99.98, 15), sig(2, 433.9, 9, 20)]);
    expect(known).toHaveLength(2);
    expect(known[0]).toMatchObject({ freqHz: 100.05e6, excessDb: 20, scans: 3, firstSeen: 1000, lastSeen: 3500 });
    expect(known[1]).toMatchObject({ freqHz: 433.9e6, scans: 1 });
  });

  it('keeps neighbouring stations apart', () => {
    // FM stations 400 kHz apart, each 200 kHz wide.
    expect(mergeKnownSignals([sig(1, 100.0, 12), sig(1, 100.4, 14), sig(2, 100.4, 11)])).toHaveLength(2);
  });

  it('returns nothing for nothing', () => {
    expect(mergeKnownSignals([])).toEqual([]);
  });
});
