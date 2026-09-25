import type { HuntConfig, HuntLevel } from '../types.js';

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
  if (![250_000, 1_024_000, 2_048_000].includes(c.sampleRate)) return 'Amplada de banda no vàlida.';
  return null;
}
