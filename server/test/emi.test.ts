import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeEmi, compareReports, detectBroadband, detectCarriers, detectCombs, floorTrend, medianSpectrum, noiseChunks } from '../src/sdr/emi.js';
import { SweepAssembler } from '../src/sdr/survey.js';
import type { Sweep } from '../src/types.js';

function synthetic(lowHz: number, stepHz: number, n: number, floor: number, mutate: (dbs: number[]) => void, ts = 0): Sweep {
  const dbs = new Array<number>(n).fill(floor).map((v, i) => v + Math.sin(i * 12.9898) * 0.8); // ±0.8 dB ripple
  mutate(dbs);
  return { scanId: 1, ts, lowHz, stepHz, dbs };
}

describe('noise chunks and broadband', () => {
  it('finds a raised floor region', () => {
    // 24–124 MHz at 10 kHz; floor -40, raised by 10 dB between 40 and 70 MHz (PLC-like)
    const s = synthetic(24e6, 10e3, 10_000, -40, (d) => { for (let i = 1600; i < 4600; i++) d[i]! += 10; });
    const chunks = noiseChunks(s.lowHz, s.stepHz, s.dbs, 5e6);
    expect(chunks.length).toBe(20);
    const bb = detectBroadband(chunks);
    expect(bb.length).toBe(1);
    expect(bb[0]!.fromHz).toBeGreaterThanOrEqual(39e6);
    expect(bb[0]!.toHz).toBeLessThanOrEqual(71e6);
    expect(bb[0]!.riseDb).toBeGreaterThan(8);
    expect(bb[0]!.source).toMatch(/PLC/);
  });
});

describe('detectCombs', () => {
  it('detects a 100 kHz switching-supply comb and ignores random spurs', () => {
    const s = synthetic(24e6, 10e3, 10_000, -40, (d) => {
      for (let k = 0; k < 12; k++) d[3000 + k * 10]! += 15; // 54.0, 54.1, … 55.1 MHz
      d[500]! += 20; d[7777]! += 18; // isolated carriers
    });
    const combs = detectCombs(s.lowHz, s.stepHz, s.dbs);
    expect(combs.length).toBe(1);
    expect(combs[0]!.spacingHz).toBe(100_000);
    expect(combs[0]!.count).toBe(12);
    expect(combs[0]!.fromHz).toBe(54_000_000);
    expect(combs[0]!.source).toMatch(/commutada/);
  });

  it('a clean spectrum has no combs', () => {
    const s = synthetic(24e6, 10e3, 5000, -40, () => undefined);
    expect(detectCombs(s.lowHz, s.stepHz, s.dbs)).toEqual([]);
  });
});

describe('detectCarriers', () => {
  it('flags steady carriers outside service bands and recognises dongle harmonics', () => {
    const s = synthetic(280e6, 10e3, 5000, -40, (d) => { d[800]! += 20; /* 288.0 MHz = 28.8 × 10 */ d[4000]! += 16; /* 320 MHz */ });
    const c = detectCarriers(s.lowHz, s.stepHz, s.dbs);
    expect(c.map((x) => x.freqHz)).toEqual([288_000_000, 320_000_000]);
    expect(c[0]!.source).toMatch(/28,8/);
    expect(c[1]!.source).toMatch(/portadora fixa/);
  });
});

describe('analyzeEmi on the real 400–470 MHz fixture', () => {
  const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/rtl_power_400_470.csv'), 'utf8').split('\n').filter(Boolean);
  const a = new SweepAssembler(1, 470_000_000);
  const sweeps: Sweep[] = [];
  for (const l of FIXTURE) { const s = a.push(l); if (s) sweeps.push(s); }

  it('produces a coherent report', () => {
    const r = analyzeEmi(sweeps)!;
    expect(r.sweeps).toBe(6);
    expect(r.chunks.length).toBeGreaterThan(10);
    expect(r.floorDb).toBeLessThan(-20);
    for (const c of r.chunks) { expect(c.floorDb).toBeLessThanOrEqual(c.p50Db); expect(c.p50Db).toBeLessThanOrEqual(c.p90Db); }
    expect(r.bands.some((b) => b.band.startsWith('ISM 433'))).toBe(true);
    // TETRA 390–400 sits in the fixture: it must show as raised band noise or carriers, not crash
    expect(Array.isArray(r.carriers)).toBe(true);
  });

  it('compares against itself with zero deltas and builds a trend', () => {
    const r = analyzeEmi(sweeps)!;
    const d = compareReports(r, r);
    expect(d.length).toBe(r.chunks.length);
    expect(d.every((x) => x.deltaDb === 0)).toBe(true);
    const t = floorTrend(sweeps);
    expect(t.length).toBe(6);
    expect(t[1]!.ts - t[0]!.ts).toBe(5000);
  });

  it('medianSpectrum ignores sweeps on a different grid', () => {
    const other: Sweep = { scanId: 2, ts: 0, lowHz: 1, stepHz: 1, dbs: [1, 2, 3] };
    const m = medianSpectrum([other, ...sweeps])!;
    expect(m.dbs.length).toBe(sweeps[0]!.dbs.length);
  });
});
