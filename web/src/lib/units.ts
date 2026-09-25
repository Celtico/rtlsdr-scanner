import { useCallback, useMemo } from 'react';
import { offsetFor, type OffsetInfo } from '@shared/sdr/calibration';
import { useSdr } from '@/store';

export interface Units {
  units: 'rel' | 'dbm';
  setUnits: (u: 'rel' | 'dbm') => void;
  /** Offset info for a given tuner gain (null gain → estimate at 40 dB). */
  offset: (gainDb: number | null) => OffsetInfo;
  /** Converts a relative dB reading; returns the number to show (unchanged in 'rel'). */
  value: (db: number, gainDb: number | null) => number;
  /** Formats with unit. */
  fmt: (db: number | null | undefined, gainDb: number | null, digits?: number) => string;
  unitLabel: string;
  /** Short note on how trustworthy the dBm values are for that gain. */
  note: (gainDb: number | null) => string;
}

export function useUnits(): Units {
  const { units, setUnits, calibration } = useSdr();
  const offset = useCallback((gainDb: number | null) => offsetFor(calibration, gainDb ?? 40), [calibration]);
  const value = useCallback((db: number, gainDb: number | null) => (units === 'dbm' ? Math.round((db + offset(gainDb).offsetDb) * 10) / 10 : db), [units, offset]);
  const fmt = useCallback((db: number | null | undefined, gainDb: number | null, digits = 1) => (db == null || !Number.isFinite(db) ? '—' : `${value(db, gainDb).toFixed(digits)} ${units === 'dbm' ? 'dBm' : 'dB'}`), [units, value]);
  const note = useCallback((gainDb: number | null) => {
    const o = offset(gainDb);
    if (units !== 'dbm') return 'dB relatius al receptor';
    return o.source === 'calibrated' ? `dBm calibrat a ${o.fromGainDb} dB de guany (±${o.uncertaintyDb} dB)`
      : o.source === 'derived' ? `dBm derivat del calibratge a ${o.fromGainDb} dB (±${o.uncertaintyDb.toFixed(0)} dB)`
      : 'dBm estimat amb valors típics del R820T (±6 dB): calibra amb una referència per afinar';
  }, [units, offset]);
  return useMemo(() => ({ units, setUnits, offset, value, fmt, unitLabel: units === 'dbm' ? 'dBm' : 'dB', note }), [units, setUnits, offset, value, fmt, note]);
}
