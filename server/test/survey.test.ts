import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  binStats, detectPeaks, noiseFloor, parsePowerLine, parsePowerTimestamp, rtlPowerArgs, SignalTracker, SweepAssembler, validateSurveyConfig,
} from '../src/sdr/survey.js';
import { DEFAULT_SURVEY } from '../src/types.js';

// Captured with: rtl_power -f 400M:470M:10k -i 5 -g 40 -e 30s (RTL-SDR Blog V3, Lleida)
const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/rtl_power_400_470.csv'), 'utf8').split('\n').filter(Boolean);

describe('parsePowerLine', () => {
  it('parses a real rtl_power line', () => {
    const l = parsePowerLine(FIXTURE[0]!);
    expect(l).not.toBeNull();
    expect(l!.ts).toBe('2026-09-25 10:56:54');
    expect(l!.lowHz).toBe(400_000_000);
    expect(l!.highHz).toBe(402_800_000);
    expect(l!.stepHz).toBeCloseTo(5468.75);
    expect(l!.samples).toBe(80);
    expect(l!.dbs.length).toBe(512);
    expect(l!.dbs[0]).toBeCloseTo(-39.73);
  });

  it('rejects garbage', () => {
    expect(parsePowerLine('')).toBeNull();
    expect(parsePowerLine('hello,world')).toBeNull();
    expect(parsePowerLine('2026-01-01, 00:00:00, x, y, z, 1, -10')).toBeNull();
  });

  it('parses timestamps as local time', () => {
    const ts = parsePowerTimestamp('2026-09-25 10:56:54');
    expect(new Date(ts).getHours()).toBe(10);
    expect(new Date(ts).getMinutes()).toBe(56);
  });
});

describe('SweepAssembler', () => {
  it('groups the fixture into 6 sweeps of 12800 bins covering 400–470 MHz', () => {
    const a = new SweepAssembler(1);
    const sweeps = [];
    for (const line of FIXTURE) {
      const s = a.push(line);
      if (s) sweeps.push(s);
    }
    const last = a.flush();
    if (last) sweeps.push(last);
    expect(sweeps.length).toBe(6);
    const s0 = sweeps[0]!;
    expect(s0.lowHz).toBe(400_000_000);
    expect(s0.stepHz).toBeCloseTo(5468.75);
    expect(s0.dbs.length).toBe(25 * 512);
    expect(s0.lowHz + s0.dbs.length * s0.stepHz).toBeCloseTo(470_000_000);
    expect(s0.dbs.every((d) => Number.isFinite(d))).toBe(true);
    expect(sweeps[1]!.ts - s0.ts).toBe(5000);
  });
});

describe('peak detection', () => {
  it('noiseFloor is a moving median', () => {
    const med = [0, 0, 0, 50, 0, 0, 0];
    const floor = noiseFloor(med, 2);
    expect(floor[3]).toBe(0);
  });

  it('finds a synthetic carrier above a flat floor', () => {
    const n = 200;
    const sweep = new Array<number>(n).fill(-40);
    sweep[100] = -10;
    sweep[101] = -12;
    const stats = binStats(100_000_000, 1000, [sweep, sweep, sweep], { thresholdDb: 10 });
    const peaks = detectPeaks(stats, 1000, 10);
    expect(peaks.length).toBe(1);
    expect(peaks[0]!.top.freqHz).toBe(100_100_000);
    expect(peaks[0]!.items.length).toBe(2);
    expect(peaks[0]!.top.excess).toBeCloseTo(30);
  });

  it('duty cycle reflects how often a bin is above threshold', () => {
    const n = 50;
    const quiet = new Array<number>(n).fill(-40);
    const burst = [...quiet];
    burst[10] = -5;
    const stats = binStats(0, 1000, [quiet, burst, quiet, quiet], { thresholdDb: 10 });
    expect(stats[10]!.duty).toBeCloseTo(0.25);
  });

  it('SignalTracker finds real signals in the 400–470 MHz fixture and classifies bands', () => {
    const a = new SweepAssembler(1);
    const t = new SignalTracker(1, { thresholdDb: 10 });
    let signals: ReturnType<SignalTracker['push']> = [];
    for (const line of FIXTURE) {
      const s = a.push(line);
      if (s) signals = t.push(s);
    }
    const last = a.flush();
    if (last) signals = t.push(last);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.excessDb).toBeGreaterThanOrEqual(signals[signals.length - 1]!.excessDb);
    for (const s of signals) {
      expect(s.freqHz).toBeGreaterThanOrEqual(400_000_000);
      expect(s.freqHz).toBeLessThanOrEqual(470_000_000);
      expect(s.dutyPct).toBeGreaterThanOrEqual(0);
      expect(s.dutyPct).toBeLessThanOrEqual(100);
      expect(s.firstSeen).toBeLessThanOrEqual(s.lastSeen);
    }
    const ism = signals.filter((s) => s.freqHz >= 433_050_000 && s.freqHz <= 434_790_000);
    for (const s of ism) expect(s.band).toBe('ISM 433 MHz (sensors, comandaments, meteo)');
  });
});

describe('rtl_power args', () => {
  it('formats frequencies with M/k suffixes', () => {
    expect(rtlPowerArgs(DEFAULT_SURVEY)).toEqual(['-f', '24M:1700M:1M', '-i', '10', '-g', '40', '-']);
    expect(rtlPowerArgs({ ...DEFAULT_SURVEY, fromHz: 400_000_000, toHz: 470_000_000, stepHz: 10_000 })[1]).toBe('400M:470M:10k');
  });

  it('validates config', () => {
    expect(validateSurveyConfig(DEFAULT_SURVEY)).toBeNull();
    expect(validateSurveyConfig({ ...DEFAULT_SURVEY, toHz: 2_000_000_000 })).toMatch(/rang/);
    expect(validateSurveyConfig({ ...DEFAULT_SURVEY, stepHz: 100 })).toMatch(/pas/);
  });
});
