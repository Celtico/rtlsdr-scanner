import { useCallback, useMemo } from 'react';
import { offsetFor, type CalScale, type OffsetInfo } from '@shared/sdr/calibration';
import { useSdr } from '@/store';

export interface Units {
  units: 'rel' | 'dbm';
  setUnits: (u: 'rel' | 'dbm') => void;
  /** Offset info for a tuner gain and reading scale (null gain → 40 dB for rtl_power, 29.7 for IQ). */
  offset: (gainDb: number | null, scale?: CalScale) => OffsetInfo;
  /** Converts a reading; unchanged in 'rel'. */
  value: (db: number, gainDb: number | null, scale?: CalScale) => number;
  /** Formats with unit. */
  fmt: (db: number | null | undefined, gainDb: number | null, digits?: number, scale?: CalScale) => string;
  /** Unit label for a scale. */
  label: (scale?: CalScale) => string;
  /** Short note on how trustworthy the dBm values are for that gain/scale. */
  note: (gainDb: number | null, scale?: CalScale) => string;
}

const defaultGain = (scale: CalScale) => (scale === 'iq' ? 29.7 : 40);

export function useUnits(): Units {
  const { units, setUnits, calibration } = useSdr();
  const offset = useCallback((gainDb: number | null, scale: CalScale = 'power') => offsetFor(calibration, gainDb ?? defaultGain(scale), scale), [calibration]);
  const value = useCallback((db: number, gainDb: number | null, scale: CalScale = 'power') => (units === 'dbm' ? Math.round((db + offset(gainDb, scale).offsetDb) * 10) / 10 : db), [units, offset]);
  const label = useCallback((scale: CalScale = 'power') => (units === 'dbm' ? 'dBm' : scale === 'iq' ? 'dBFS' : 'dB'), [units]);
  const fmt = useCallback((db: number | null | undefined, gainDb: number | null, digits = 1, scale: CalScale = 'power') => (db == null || !Number.isFinite(db) ? '—' : `${value(db, gainDb, scale).toFixed(digits)} ${label(scale)}`), [value, label]);
  const note = useCallback((gainDb: number | null, scale: CalScale = 'power') => {
    const o = offset(gainDb, scale);
    if (units !== 'dbm') return scale === 'iq' ? 'dBFS: dB respecte a la plena escala del convertidor' : 'dB relatius al receptor';
    return o.source === 'calibrated' ? `dBm calibrat a ${o.fromGainDb} dB de guany (±${o.uncertaintyDb} dB)`
      : o.source === 'derived' ? `dBm derivat del calibratge a ${o.fromGainDb} dB (±${o.uncertaintyDb.toFixed(0)} dB)`
      : scale === 'iq' ? 'dBm estimat (±10 dB): calibra el Hunt amb una referència per comparar-lo amb el gateway'
      : 'dBm estimat amb valors típics del R820T (±6 dB): calibra amb una referència per afinar';
  }, [units, offset]);
  return useMemo(() => ({ units, setUnits, offset, value, fmt, label, note }), [units, setUnits, offset, value, fmt, label, note]);
}
