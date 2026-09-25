import { EU868_SAMPLE_RATE, type HuntBurst, type HuntChannel, type HuntConfig, type HuntLevel } from '../types.js';

/**
 * Hunt mode reads raw 8-bit IQ from `rtl_sdr` and turns it into a power level several times per second.
 * Bandwidth = sample rate (250 kHz by default), so it measures the whole channel around the frequency,
 * which is what a LoRa/ISM burst occupies. Nothing is demodulated or decoded.
 */

export const BLOCK_MS = 100;
const SUB_MS = 10;

/** Mean power of interleaved unsigned 8-bit IQ samples, in dBFS (0 dBFS = |IQ| at full scale). */
export function powerDbfs(buf: Uint8Array, start = 0, end = buf.length): number {
  let acc = 0;
  let n = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const re = (buf[i]! - 127.5) / 127.5;
    const im = (buf[i + 1]! - 127.5) / 127.5;
    acc += re * re + im * im;
    n++;
  }
  if (!n) return -Infinity;
  return 10 * Math.log10(Math.max(acc / n, 1e-12));
}

/** Splits a stream of IQ bytes into fixed-size blocks and reports mean and peak power per block. */
export class LevelMeter {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  readonly blockBytes: number;
  readonly subBytes: number;
  maxDbfs = -Infinity;
  maxAt: number | null = null;

  constructor(sampleRate: number, private readonly now: () => number = Date.now) {
    this.blockBytes = Math.round((sampleRate * BLOCK_MS) / 1000) * 2;
    this.subBytes = Math.round((sampleRate * SUB_MS) / 1000) * 2;
  }

  /** Feed bytes; returns the levels of every completed block. */
  push(chunk: Uint8Array): HuntLevel[] {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < this.blockBytes) return [];
    const all = this.pending.length === 1 ? this.pending[0]! : concat(this.pending, this.pendingBytes);
    const out: HuntLevel[] = [];
    let off = 0;
    while (all.length - off >= this.blockBytes) {
      const end = off + this.blockBytes;
      let peak = -Infinity;
      for (let s = off; s + this.subBytes <= end; s += this.subBytes) {
        const p = powerDbfs(all, s, s + this.subBytes);
        if (p > peak) peak = p;
      }
      const ts = this.now();
      const level: HuntLevel = { ts, dbfs: round1(powerDbfs(all, off, end)), peakDbfs: round1(peak) };
      if (level.peakDbfs > this.maxDbfs) { this.maxDbfs = level.peakDbfs; this.maxAt = ts; }
      out.push(level);
      off = end;
    }
    const rest = all.subarray(off);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    return out;
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function rtlSdrArgs(c: HuntConfig): string[] {
  return ['-f', String(c.freqHz), '-s', String(c.sampleRate), '-g', String(c.gainDb), '-'];
}

export function validateHuntConfig(c: HuntConfig): string | null {
  if (c.freqHz < 24_000_000 || c.freqHz > 1_766_000_000) return 'La freqüència ha d’estar entre 24 i 1766 MHz.';
  if (c.gainDb < 0 || c.gainDb > 50) return 'El guany ha d’estar entre 0 i 50 dB.';
  if (c.mode === 'eu868') {
    if (c.sampleRate !== EU868_SAMPLE_RATE) return 'El mode EU868 fa servir 2,4 MS/s.';
    return null;
  }
  if (![250_000, 1_024_000, 2_048_000].includes(c.sampleRate)) return 'Amplada de banda no vàlida.';
  return null;
}

// ---------- EU868 multichannel meter ----------

/**
 * Channelizer for the 8 LoRaWAN EU868 channels inside one 2.4 MS/s window centred at 867.8 MHz.
 * Each channel is mixed to baseband with a complex tone (offset is a multiple of 100 kHz, so the tone repeats
 * every 24 samples) and low-passed with two cascaded 13-sample boxcars (a triangular window: −8 dB at the channel
 * edge, −23 dB on the adjacent channel 200 kHz away), then its power is measured per 10 ms.
 * No FFT and no dependencies; ~20 M complex multiplies per second, fine for Node.
 */
export class ChannelMeter {
  readonly channels: number[];
  private readonly cos: Float32Array[];
  private readonly sin: Float32Array[];
  private readonly period: number;
  private readonly box: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  readonly blockBytes: number;
  readonly subBytes: number;
  /** Per-channel floor (slow minimum tracker of sub-block power), for burst detection. */
  readonly floor: number[];
  maxDbfs = -Infinity;
  maxAt: number | null = null;
  maxHz: number | null = null;

  constructor(readonly centerHz: number, readonly sampleRate: number, channelsHz: number[], private readonly now: () => number = Date.now) {
    this.channels = channelsHz;
    // offsets are multiples of 100 kHz and the sample rate is 2.4 MHz: the mixing tone has a 24-sample period
    this.period = Math.round(sampleRate / 100_000);
    this.box = Math.max(1, Math.round(sampleRate / 185_000));
    this.cos = channelsHz.map((f) => {
      const k = Math.round((f - centerHz) / 100_000);
      return Float32Array.from({ length: this.period }, (_, n) => Math.cos((-2 * Math.PI * k * n) / this.period));
    });
    this.sin = channelsHz.map((f) => {
      const k = Math.round((f - centerHz) / 100_000);
      return Float32Array.from({ length: this.period }, (_, n) => Math.sin((-2 * Math.PI * k * n) / this.period));
    });
    this.blockBytes = Math.round((sampleRate * BLOCK_MS) / 1000) * 2;
    this.subBytes = Math.round((sampleRate * SUB_MS) / 1000) * 2;
    this.floor = channelsHz.map(() => Infinity);
  }

  /** Power (dBFS) of each channel over [start, end) bytes of interleaved u8 IQ. */
  channelPowers(buf: Uint8Array, start: number, end: number): number[] {
    const out = new Array<number>(this.channels.length);
    const n = (end - start) >> 1;
    for (let c = 0; c < this.channels.length; c++) {
      const cs = this.cos[c]!;
      const sn = this.sin[c]!;
      let accI = 0;
      let accQ = 0;
      let count = 0;
      let sumP = 0;
      let groups = 0;
      let prevI = 0;
      let prevQ = 0;
      let havePrev = false;
      for (let i = 0; i < n; i++) {
        const re = (buf[start + i * 2]! - 127.5) / 127.5;
        const im = (buf[start + i * 2 + 1]! - 127.5) / 127.5;
        const ph = i % this.period;
        // (re + j im) * (cos + j sin)
        accI += re * cs[ph]! - im * sn[ph]!;
        accQ += re * sn[ph]! + im * cs[ph]!;
        if (++count === this.box) {
          const bi = accI / this.box;
          const bq = accQ / this.box;
          // second boxcar stage: average of two consecutive groups (triangular window)
          if (havePrev) {
            const ti = (bi + prevI) / 2;
            const tq = (bq + prevQ) / 2;
            sumP += ti * ti + tq * tq;
            groups++;
          }
          prevI = bi; prevQ = bq; havePrev = true;
          accI = 0; accQ = 0; count = 0;
        }
      }
      out[c] = groups ? 10 * Math.log10(Math.max(sumP / groups, 1e-12)) : -Infinity;
    }
    return out;
  }

  /** Feed bytes; returns levels for completed 100 ms blocks plus any bursts detected inside them. */
  push(chunk: Uint8Array, burstThresholdDb = 8): { level: HuntLevel; bursts: HuntBurst[] }[] {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < this.blockBytes) return [];
    const all = this.pending.length === 1 ? this.pending[0]! : concat(this.pending, this.pendingBytes);
    const out: { level: HuntLevel; bursts: HuntBurst[] }[] = [];
    let off = 0;
    const nCh = this.channels.length;
    while (all.length - off >= this.blockBytes) {
      const end = off + this.blockBytes;
      const peak = new Array<number>(nCh).fill(-Infinity);
      const mean = new Array<number>(nCh).fill(0);
      let subs = 0;
      for (let s = off; s + this.subBytes <= end; s += this.subBytes) {
        const p = this.channelPowers(all, s, s + this.subBytes);
        for (let c = 0; c < nCh; c++) {
          if (p[c]! > peak[c]!) peak[c] = p[c]!;
          mean[c]! += p[c]!;
          // slow floor tracker: follows drops quickly, rises slowly
          const f = this.floor[c]!;
          this.floor[c] = !Number.isFinite(f) ? p[c]! : p[c]! < f ? p[c]! : f + 0.02;
        }
        subs++;
      }
      const ts = this.now();
      const channels: HuntChannel[] = this.channels.map((f, c) => ({ freqHz: f, dbfs: round1(mean[c]! / Math.max(1, subs)), peakDbfs: round1(peak[c]!) }));
      let best = 0;
      for (let c = 1; c < nCh; c++) if (peak[c]! > peak[best]!) best = c;
      const bursts: HuntBurst[] = [];
      for (let c = 0; c < nCh; c++) {
        const above = peak[c]! - this.floor[c]!;
        if (above >= burstThresholdDb) bursts.push({ ts, freqHz: this.channels[c]!, peakDbfs: round1(peak[c]!), aboveFloorDb: round1(above) });
      }
      const level: HuntLevel = { ts, dbfs: channels[best]!.dbfs, peakDbfs: channels[best]!.peakDbfs, channels, strongestHz: this.channels[best]! };
      if (level.peakDbfs > this.maxDbfs) { this.maxDbfs = level.peakDbfs; this.maxAt = ts; this.maxHz = this.channels[best]!; }
      out.push({ level, bursts });
      off = end;
    }
    const rest = all.subarray(off);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    return out;
  }
}
