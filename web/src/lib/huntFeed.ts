import { useEffect, useState } from 'react';
import type { HuntBurst, HuntLevel } from '@shared/types';

/**
 * Hunt levels arrive ~10×/s. They are kept out of React context so only the Hunt page re-renders:
 * a ring buffer of the last 60 s plus a tiny subscription API.
 */
export const HUNT_WINDOW_MS = 60_000;

export interface HuntState {
  levels: HuntLevel[];
  latest: HuntLevel | null;
  maxDbfs: number;
  maxAt: number | null;
  /** Newest first. */
  bursts: HuntBurst[];
}

let state: HuntState = { levels: [], latest: null, maxDbfs: -Infinity, maxAt: null, bursts: [] };
const listeners = new Set<(s: HuntState) => void>();

export function pushHuntLevel(level: HuntLevel, maxDbfs: number, maxAt: number | null): void {
  const cutoff = level.ts - HUNT_WINDOW_MS;
  const levels = state.levels.length && state.levels[0]!.ts < cutoff
    ? [...state.levels.filter((l) => l.ts >= cutoff), level]
    : [...state.levels, level];
  state = { ...state, levels, latest: level, maxDbfs, maxAt };
  for (const l of listeners) l(state);
}

export function pushHuntBurst(burst: HuntBurst): void {
  state = { ...state, bursts: [burst, ...state.bursts].slice(0, 200) };
  for (const l of listeners) l(state);
}

export function resetHunt(): void {
  state = { levels: [], latest: null, maxDbfs: -Infinity, maxAt: null, bursts: [] };
  for (const l of listeners) l(state);
}

export function useHuntFeed(): HuntState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
