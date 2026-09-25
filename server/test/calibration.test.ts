import { describe, expect, it } from 'vitest';
import { offsetFor, removeEntry, toDbm, upsertEntry } from '../src/sdr/calibration.js';

describe('calibration', () => {
  it('estimates when there is no reference and shifts with gain', () => {
    const at40 = offsetFor(null, 40);
    expect(at40).toMatchObject({ source: 'estimated', offsetDb: -86, uncertaintyDb: 6 });
    expect(offsetFor(null, 49.6).offsetDb).toBeCloseTo(-95.6, 1);
    expect(offsetFor({ entries: [] }, 20).offsetDb).toBe(-66);
  });

  it('uses the exact gain entry and derives others', () => {
    // FM station read at 7.9 dB with 40.2 dB of gain; a meter says −70 dBm.
    let cal = upsertEntry(null, { gainDb: 40.2, freqHz: 107_400_000, measuredDb: 7.9, refDbm: -70, note: 'FM' });
    expect(cal.entries[0]!.offsetDb).toBeCloseTo(-77.9, 1);
    const exact = offsetFor(cal, 40.2);
    expect(exact.source).toBe('calibrated');
    expect(toDbm(7.9, exact)).toBe(-70);
    expect(toDbm(-42, exact)).toBeCloseTo(-119.9, 1);
    const derived = offsetFor(cal, 20.7);
    expect(derived.source).toBe('derived');
    expect(derived.offsetDb).toBeCloseTo(-77.9 + 19.5, 1);
    expect(derived.fromGainDb).toBe(40.2);
    // second reference at another gain replaces nothing, adds one; same gain replaces
    cal = upsertEntry(cal, { gainDb: 20.7, freqHz: 107_400_000, measuredDb: -12, refDbm: -70, note: '' });
    cal = upsertEntry(cal, { gainDb: 40.2, freqHz: 90_000_000, measuredDb: 5, refDbm: -72, note: 'v2' });
    expect(cal.entries.length).toBe(2);
    expect(cal.entries.find((e) => e.gainDb === 40.2)!.note).toBe('v2');
    expect(removeEntry(cal, 40.2).entries.length).toBe(1);
  });
});
