import { describe, expect, it } from 'vitest';
import { LevelMeter, powerDbfs, rtlSdrArgs, validateHuntConfig } from '../src/sdr/hunt.js';
import { icaoCountry } from '../src/sdr/icao.js';
import { classifyDevice, routineHours } from '../src/sdr/audit.js';
import { DEFAULT_HUNT } from '../src/types.js';

function iq(n: number, amplitude: number): Uint8Array {
  // Constant-amplitude tone: I = a, Q = 0 (in unsigned 8-bit, centre 127.5).
  const buf = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { buf[i * 2] = Math.round(127.5 + amplitude * 127.5); buf[i * 2 + 1] = 128; }
  return buf;
}

describe('hunt power meter', () => {
  it('full-scale tone is ~0 dBFS and silence is very low', () => {
    expect(powerDbfs(iq(1000, 1))).toBeCloseTo(0, 1);
    expect(powerDbfs(iq(1000, 0.1))).toBeCloseTo(-20, 0);
    expect(powerDbfs(iq(1000, 0))).toBeLessThan(-40);
  });

  it('LevelMeter emits one level per 100 ms block and tracks the peak burst', () => {
    let t = 0;
    const m = new LevelMeter(250_000, () => (t += 100));
    expect(m.blockBytes).toBe(50_000);
    expect(m.push(iq(10_000, 0.1))).toEqual([]); // 20 kB, not a full block yet
    const levels = m.push(iq(20_000, 0.1)); // 60 kB total → one block, 10 kB left over
    expect(levels.length).toBe(1);
    expect(levels[0]!.dbfs).toBeCloseTo(-20, 0);
    // A 10 ms burst at full scale inside the next block raises the peak but barely the mean.
    const burst = iq(25_000, 0.01);
    burst.set(iq(2_500, 1), 0);
    const l2 = m.push(burst)[0]!;
    expect(l2.peakDbfs).toBeCloseTo(0, 0);
    expect(l2.dbfs).toBeLessThan(-8);
    expect(m.maxDbfs).toBeCloseTo(0, 0);
    expect(m.maxAt).toBe(200);
  });

  it('args and validation', () => {
    expect(rtlSdrArgs(DEFAULT_HUNT)).toEqual(['-f', '868100000', '-s', '250000', '-g', '29.7', '-']);
    expect(validateHuntConfig(DEFAULT_HUNT)).toBeNull();
    expect(validateHuntConfig({ ...DEFAULT_HUNT, freqHz: 10 })).toMatch(/freqüència/);
  });
});

describe('icaoCountry', () => {
  it('maps known blocks', () => {
    expect(icaoCountry('4bc8c4')).toBe('Turquia');
    expect(icaoCountry('3443c3')).toBe('Espanya');
    expect(icaoCountry('4840d6')).toBe('Països Baixos');
    expect(icaoCountry('a12345')).toBe('Estats Units');
    expect(icaoCountry('000001')).toBeNull();
    expect(icaoCountry('zz')).toBeNull();
  });
});

describe('audit classification', () => {
  it('rolling-code remotes are low priority', () => {
    const v = classifyDevice('Somfy-RTS', '10000001', { control: '? (14)', counter: 0 });
    expect(v.exposure).toBe('rolling');
    expect(v.priority).toBe('baixa');
  });
  it('fixed-code remotes are exposed and high priority', () => {
    const v = classifyDevice('Generic-Remote', '12345', { cmd: 192, tristate: '0Z10X1Z01100' });
    expect(v.exposure).toBe('plain');
    expect(v.priority).toBe('alta');
  });
  it('weather sensors are plain but medium; door sensors high', () => {
    expect(classifyDevice('Nexus-TH', '42', { temperature_C: 21.5, humidity: 55 })).toMatchObject({ exposure: 'plain', priority: 'mitjana', readable: ['temperatura', 'humitat'] });
    expect(classifyDevice('Kerui-Security', '7', { contact_open: 1 }).priority).toBe('alta');
  });
  it('TPMS is id-only', () => {
    expect(classifyDevice('Schrader-TPMS', 'abc', { pressure_kPa: 220 }).exposure).toBe('id-only');
  });
  it('routineHours flags hours clearly above the mean', () => {
    const h = new Array<number>(24).fill(1);
    h[7] = 10; h[19] = 12;
    expect(routineHours(h)).toEqual([7, 19]);
    expect(routineHours(new Array<number>(24).fill(0))).toEqual([]);
  });
});
