import { describe, expect, it } from 'vitest';
import { ChannelMeter, LevelMeter, powerDbfs, rtlSdrArgs, validateHuntConfig } from '../src/sdr/hunt.js';
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
    expect(rtlSdrArgs(DEFAULT_HUNT)).toEqual(['-f', '867800000', '-s', '2400000', '-g', '29.7', '-']);
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

describe('DAB helpers', () => {
  it('maps band III frequencies to the nearest block', async () => {
    const { dabChannelFor, DAB_CHANNELS } = await import('../src/types.js');
    expect(DAB_CHANNELS.length).toBe(38);
    expect(dabChannelFor(213_360_000)).toBe('10C');
    expect(dabChannelFor(213_000_000)).toBe('10C');
    expect(dabChannelFor(218_640_000)).toBe('11B');
    expect(dabChannelFor(100_000_000)).toBeNull();
    expect(dabChannelFor(174_500_000)).toBe('5A');
    expect(dabChannelFor(174_000_000)).toBeNull(); // 928 kHz off-centre: outside a block
  });
});

describe('ChannelMeter (EU868, 8 channels in one 2.4 MS/s window)', () => {
  const FS = 2_400_000;
  const CENTER = 867_800_000;
  const CH = [867_100_000, 867_300_000, 867_500_000, 867_700_000, 867_900_000, 868_100_000, 868_300_000, 868_500_000];
  function tone(nSamples: number, offsetHz: number, amp: number, noise = 0.01): Uint8Array {
    const buf = new Uint8Array(nSamples * 2);
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < nSamples; i++) {
      const ph = (2 * Math.PI * offsetHz * i) / FS;
      buf[i * 2] = Math.round(127.5 + 127.5 * (amp * Math.cos(ph) + noise * rnd()));
      buf[i * 2 + 1] = Math.round(127.5 + 127.5 * (amp * Math.sin(ph) + noise * rnd()));
    }
    return buf;
  }

  it('a tone at 868.3 MHz lights up only that channel', () => {
    const m = new ChannelMeter(CENTER, FS, CH, () => 1000);
    const res = m.push(tone(240_000, 868_300_000 - CENTER, 0.3)); // exactly one 100 ms block
    expect(res.length).toBe(1);
    const chans = res[0]!.level.channels!;
    const strongest = chans.reduce((a, b) => (b.dbfs > a.dbfs ? b : a));
    expect(strongest.freqHz).toBe(868_300_000);
    expect(res[0]!.level.strongestHz).toBe(868_300_000);
    expect(strongest.dbfs).toBeGreaterThan(-15);
    for (const c of chans) if (c.freqHz !== 868_300_000) expect(c.dbfs).toBeLessThan(strongest.dbfs - 18);
  });

  it('detects a burst in a channel above its floor and tracks the max', () => {
    let t = 0;
    const m = new ChannelMeter(CENTER, FS, CH, () => (t += 100));
    // 300 ms of realistic noise (floor ≈ −35 dBFS per channel) to settle the floor, then a 30 ms burst at 867.3 MHz
    m.push(tone(720_000, 0, 0, 0.3));
    const quiet = tone(240_000, 0, 0, 0.3);
    const burst = tone(72_000, 867_300_000 - CENTER, 0.4, 0.3);
    quiet.set(burst, 48_000 * 2);
    const res = m.push(quiet);
    expect(res.length).toBe(1);
    const bursts = res[0]!.bursts;
    expect(bursts.length).toBe(1);
    expect(bursts[0]!.freqHz).toBe(867_300_000);
    expect(bursts[0]!.aboveFloorDb).toBeGreaterThan(8);
    expect(m.maxHz).toBe(867_300_000);
    expect(res[0]!.level.peakDbfs).toBeGreaterThan(res[0]!.level.dbfs); // peak sub-block above the block mean
  });

  it('EU868 config validation', () => {
    expect(validateHuntConfig({ mode: 'eu868', freqHz: 867_800_000, gainDb: 29.7, sampleRate: 2_400_000 })).toBeNull();
    expect(validateHuntConfig({ mode: 'eu868', freqHz: 867_800_000, gainDb: 29.7, sampleRate: 250_000 })).toMatch(/2,4/);
  });
});
