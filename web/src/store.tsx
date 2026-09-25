/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Band, Device, ModeConfig, Plane, SatCapture, Signal, Status, Sweep, WsMessage } from '@shared/types';
import { api } from '@/lib/api';
import { useSdrSocket } from '@/hooks/useSdrSocket';
import { toaster } from '@/components/ui/toaster';
import { pushHuntBurst, pushHuntLevel, resetHunt } from '@/lib/huntFeed';
import type { Calibration } from '@shared/sdr/calibration';

const MAX_SWEEPS = 300;

export interface TrailPoint { lat: number; lon: number; ts: number }

export interface SdrStore {
  connected: boolean;
  /** Last positions per ICAO (client-side only), for the radar trail. */
  trails: ReadonlyMap<string, TrailPoint[]>;
  status: Status | null;
  bands: Band[];
  sweeps: Sweep[];
  signals: Signal[];
  signalsScanId: number | null;
  devices: Device[];
  planes: Plane[];
  satCaptures: SatCapture[];
  /** Tuner gain of the scan the current signals/sweeps belong to (for dBm conversion). */
  signalsGainDb: number | null;
  calibration: Calibration | null;
  units: 'rel' | 'dbm';
  setUnits: (u: 'rel' | 'dbm') => void;
  refreshCalibration: () => Promise<void>;
  busy: boolean;
  setMode: (mc: ModeConfig) => Promise<boolean>;
  stop: () => Promise<boolean>;
  refreshDevices: () => Promise<void>;
  refreshPlanes: () => Promise<void>;
  updateDevice: (d: Device) => void;
  loadScanSweeps: (scanId: number) => Promise<void>;
}

const Ctx = createContext<SdrStore | null>(null);

export function SdrProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [bands, setBands] = useState<Band[]>([]);
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalsScanId, setSignalsScanId] = useState<number | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [satCaptures, setSatCaptures] = useState<SatCapture[]>([]);
  const [signalsGainDb, setSignalsGainDb] = useState<number | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [units, setUnitsState] = useState<'rel' | 'dbm'>(() => { try { return localStorage.getItem('sdr-units') === 'dbm' ? 'dbm' : 'rel'; } catch { return 'rel'; } });
  const setUnits = useCallback((u: 'rel' | 'dbm') => { setUnitsState(u); try { localStorage.setItem('sdr-units', u); } catch { /* ignore */ } }, []);
  const refreshCalibration = useCallback(async () => { try { setCalibration(await api.calibration()); } catch { /* keep */ } }, []);
  const [busy, setBusy] = useState(false);
  const lastErrorAt = useRef(0);
  const trailsRef = useRef(new Map<string, TrailPoint[]>());

  const upsertDevice = useCallback((d: Device) => {
    setDevices((prev) => {
      const i = prev.findIndex((x) => x.id === d.id);
      if (i === -1) return [d, ...prev];
      const next = [...prev];
      next[i] = d;
      return next;
    });
  }, []);

  const onMessage = useCallback((m: WsMessage) => {
    switch (m.type) {
      case 'status':
        setStatus(m.status);
        if (m.status.mode === 'survey' && m.status.config && 'fromHz' in m.status.config) setSignalsGainDb(m.status.config.gainDb);
        break;
      case 'survey:sweep':
        setSweeps((prev) => {
          const base = prev.length && prev[0]!.scanId !== m.sweep.scanId ? [] : prev;
          const next = [...base, m.sweep];
          return next.length > MAX_SWEEPS ? next.slice(next.length - MAX_SWEEPS) : next;
        });
        break;
      case 'survey:signals':
        setSignals(m.signals);
        setSignalsScanId(m.scanId);
        break;
      case 'device:new':
        upsertDevice(m.device);
        toaster.create({
          title: `Nou dispositiu: ${m.device.model}`,
          description: m.device.deviceId ? `id ${m.device.deviceId}` : undefined,
          type: 'info',
          duration: 4000,
        });
        break;
      case 'device:update':
        upsertDevice(m.device);
        break;
      case 'hunt:level':
        pushHuntLevel(m.level, m.maxDbfs, m.maxAt);
        break;
      case 'hunt:burst':
        pushHuntBurst(m.burst);
        break;
      case 'satellite:capture':
        setSatCaptures((prev) => {
          const i = prev.findIndex((c) => c.id === m.capture.id);
          if (i === -1) return [m.capture, ...prev].sort((a, b) => b.aos - a.aos);
          const next = [...prev];
          next[i] = m.capture;
          return next;
        });
        if (m.capture.status === 'done') toaster.create({ title: `Captura de ${m.capture.satellite} acabada`, description: `${m.capture.images.length} imatges`, type: 'success', duration: 6000 });
        break;
      case 'adsb:plane':
        if (m.plane.lat != null && m.plane.lon != null) {
          const t = trailsRef.current.get(m.plane.icao) ?? [];
          const last = t[t.length - 1];
          if (!last || last.lat !== m.plane.lat || last.lon !== m.plane.lon) {
            trailsRef.current.set(m.plane.icao, [...t.slice(-39), { lat: m.plane.lat, lon: m.plane.lon, ts: m.plane.lastSeen }]);
          }
        }
        setPlanes((prev) => {
          const i = prev.findIndex((p) => p.icao === m.plane.icao);
          if (i === -1) return [m.plane, ...prev];
          const next = [...prev];
          next[i] = { ...next[i]!, ...m.plane, msgs: Math.max(next[i]!.msgs, m.plane.msgs) };
          return next;
        });
        break;
      case 'error': {
        // The same error can arrive from several stderr lines; throttle the toasts.
        const now = Date.now();
        if (now - lastErrorAt.current > 2000) {
          lastErrorAt.current = now;
          toaster.create({ title: 'Error del dongle', description: m.message, type: 'error', duration: 8000, closable: true });
        }
        break;
      }
      case 'log':
        break;
    }
  }, [upsertDevice]);

  const { connected } = useSdrSocket(onMessage);

  const refreshDevices = useCallback(async () => setDevices(await api.devices()), []);
  const refreshPlanes = useCallback(async () => setPlanes(await api.planes()), []);

  const loadScanSweeps = useCallback(async (scanId: number) => {
    const [sw, sg, scan] = await Promise.all([api.sweeps(scanId), api.signals(scanId), api.scan(scanId).catch(() => null)]);
    setSweeps(sw.sweeps);
    setSignals(sg.signals);
    setSignalsScanId(scanId);
    if (scan && 'gainDb' in scan.config && 'fromHz' in scan.config) setSignalsGainDb(scan.config.gainDb);
  }, []);

  // Initial load.
  useEffect(() => {
    void (async () => {
      try {
        const [st, b] = await Promise.all([api.status(), api.bands()]);
        setStatus(st);
        setBands(b);
        void refreshCalibration();
        await Promise.all([refreshDevices(), refreshPlanes(), api.satCaptures().then(setSatCaptures)]);
        const sg = await api.signals();
        setSignals(sg.signals);
        setSignalsScanId(sg.scanId);
        if (sg.scanId != null) {
          const [sw, scan] = await Promise.all([api.sweeps(sg.scanId), api.scan(sg.scanId).catch(() => null)]);
          setSweeps(sw.sweeps);
          if (scan && 'gainDb' in scan.config && 'fromHz' in scan.config) setSignalsGainDb(scan.config.gainDb);
        }
      } catch (e) {
        toaster.create({ title: 'No es pot contactar amb el servidor', description: (e as Error).message, type: 'error' });
      }
    })();
  }, [refreshDevices, refreshPlanes, refreshCalibration]);

  const setMode = useCallback(async (mc: ModeConfig) => {
    setBusy(true);
    try {
      const st = await api.setMode(mc);
      setStatus(st);
      if (mc.mode === 'survey') {
        setSweeps([]);
        setSignals([]);
        setSignalsScanId(st.scanId);
        setSignalsGainDb(mc.config.gainDb);
      }
      if (mc.mode === 'hunt') resetHunt();
      return true;
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut canviar de mode', description: (e as Error).message, type: 'error', closable: true });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => setMode({ mode: 'idle' }), [setMode]);

  const value = useMemo<SdrStore>(() => ({
    connected, status, bands, sweeps, signals, signalsScanId, devices, planes, satCaptures, busy, trails: trailsRef.current,
    signalsGainDb, calibration, units, setUnits, refreshCalibration,
    setMode, stop, refreshDevices, refreshPlanes, updateDevice: upsertDevice, loadScanSweeps,
  }), [connected, status, bands, sweeps, signals, signalsScanId, devices, planes, satCaptures, busy, setMode, stop, refreshDevices, refreshPlanes, upsertDevice, loadScanSweeps, signalsGainDb, calibration, units, setUnits, refreshCalibration]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSdr(): SdrStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSdr fora de SdrProvider');
  return v;
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
