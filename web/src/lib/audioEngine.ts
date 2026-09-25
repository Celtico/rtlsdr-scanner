import { useEffect, useState } from 'react';
import { AUDIO_SAMPLE_RATE } from '@shared/types';
import { api } from '@/lib/api';

/**
 * Plays the server's raw PCM stream (s16le mono 48 kHz) with Web Audio, scheduling one AudioBuffer per chunk
 * back to back. The AudioContext is created inside the click handler so autoplay policies are satisfied.
 */
export interface AudioState {
  freqHz: number | null;
  playing: boolean;
  buffering: boolean;
  volume: number;
  error: string | null;
}

let state: AudioState = { freqHz: null, playing: false, buffering: false, volume: 0.8, error: null };
const listeners = new Set<(s: AudioState) => void>();
function set(patch: Partial<AudioState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let abort: AbortController | null = null;
let nextTime = 0;
const LEAD_S = 0.25; // initial buffer before the first sample plays

export const audioEngine = {
  async play(freqHz: number): Promise<void> {
    audioEngine.stopStream();
    set({ freqHz, playing: true, buffering: true, error: null });
    try {
      if (!ctx) {
        ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
        gain = ctx.createGain();
        gain.connect(ctx.destination);
      }
      gain!.gain.value = state.volume;
      await ctx.resume();
      await api.setMode({ mode: 'audio', config: { freqHz, gainDb: null } });
      abort = new AbortController();
      const res = await fetch('/api/audio/stream', { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      nextTime = ctx.currentTime + LEAD_S;
      const reader = res.body.getReader();
      let carry = new Uint8Array(0);
      const pump = async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          let bytes = value;
          if (carry.length) {
            const merged = new Uint8Array(carry.length + bytes.length);
            merged.set(carry); merged.set(bytes, carry.length);
            bytes = merged;
          }
          const usable = bytes.length - (bytes.length % 2);
          carry = bytes.subarray(usable);
          const n = usable / 2;
          if (!n || !ctx || !gain) continue;
          const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
          const buf = ctx.createBuffer(1, n, AUDIO_SAMPLE_RATE);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(gain);
          // If we fell behind (tab throttled), resync instead of piling up latency.
          if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
          src.start(nextTime);
          nextTime += buf.duration;
          if (state.buffering) set({ buffering: false });
        }
      };
      pump().then(() => { if (state.playing) set({ playing: false, buffering: false }); }).catch((e: Error) => {
        if (e.name !== 'AbortError') set({ playing: false, buffering: false, error: e.message });
      });
    } catch (e) {
      set({ playing: false, buffering: false, error: (e as Error).message });
    }
  },

  /** Stops the local stream only (the server mode is left to the caller). */
  stopStream(): void {
    abort?.abort();
    abort = null;
  },

  async stop(): Promise<void> {
    audioEngine.stopStream();
    set({ playing: false, buffering: false });
    try { await api.setMode({ mode: 'idle' }); } catch { /* server may already be idle */ }
  },

  setVolume(v: number): void {
    set({ volume: v });
    if (gain) gain.gain.value = v;
  },

  /** Called when the server left audio mode for another reason (another mode started). */
  serverStopped(): void {
    if (state.playing) { audioEngine.stopStream(); set({ playing: false, buffering: false }); }
  },
};

export function useAudioEngine(): AudioState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
