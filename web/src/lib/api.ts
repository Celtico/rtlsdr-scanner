import type { Band, Device, ModeConfig, Plane, Reading, SatCapture, SatInfo, SatPass, Scan, Signal, Status, Sweep } from '@shared/types';
import type { AuditVerdict } from '@shared/sdr/audit';
import type { ChunkDelta, EmiReport } from '@shared/sdr/emi';
import type { CalScale, Calibration } from '@shared/sdr/calibration';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one: Fastify rejects an empty body with content-type JSON (400).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined ?? {}) };
  if (init?.body != null) headers['content-type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export interface AuditEntry {
  device: Device;
  verdict: AuditVerdict;
  activityByHour: number[];
  routineHours: number[];
  activeDays: number;
}

/** Subset of welle-cli's /mux.json that the UI uses. */
export interface DabMux {
  ensemble?: { id?: string; label?: { label?: string } };
  demodulator?: { snr?: number; fic?: { numcrcerrors?: number }; frequencycorrection?: number };
  services?: { sid: number | string; label: { label: string }; dls?: { label?: string }; components?: { subchannel?: { bitrate?: number; protection?: string } }[] }[];
}

export interface EmiResponse {
  scanId: number | null;
  report: EmiReport | null;
  trend: { ts: number; floorDb: number }[];
  baseline: { scanId: number; takenAt: number; label: string } | null;
  delta: ChunkDelta[] | null;
}

export interface DevicePatch { alias?: string | null; owner?: 'own' | 'other' | null; bearingDeg?: number | null }

export const api = {
  status: () => request<Status>('/api/status'),
  checkDongle: () => request<Status['dongle']>('/api/dongle/check', { method: 'POST' }),
  setMode: (mc: ModeConfig) => request<Status>('/api/mode', { method: 'POST', body: JSON.stringify(mc) }),
  bands: () => request<Band[]>('/api/bands'),
  signals: (scanId?: number) => request<{ scanId: number | null; signals: Signal[] }>(`/api/signals${scanId ? `?scanId=${scanId}` : ''}`),
  sweeps: (scanId?: number, limit = 300) => request<{ scanId: number | null; sweeps: Sweep[] }>(`/api/sweeps?limit=${limit}${scanId ? `&scanId=${scanId}` : ''}`),
  devices: () => request<Device[]>('/api/devices'),
  deviceHistory: (id: number) => request<{ device: Device; readings: Reading[] }>(`/api/devices/${id}/history`),
  patchDevice: (id: number, patch: DevicePatch) => request<Device>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  setAlias: (id: number, alias: string | null) => request<Device>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ alias }) }),
  audit: () => request<AuditEntry[]>('/api/audit'),
  calibration: () => request<Calibration>('/api/calibration'),
  calibrationReading: (scanId: number, freqHz: number) => request<{ scanId: number; gainDb: number; freqHz: number; measuredDb: number; stepHz: number }>(`/api/calibration/reading?scanId=${scanId}&freqHz=${freqHz}`),
  calibrationAdd: (b: { scale?: CalScale; gainDb: number; freqHz: number; measuredDb: number; refDbm: number; note: string }) => request<Calibration>('/api/calibration', { method: 'POST', body: JSON.stringify(b) }),
  calibrationRemove: (gainDb: number, scale: CalScale = 'power') => request<Calibration>(`/api/calibration/${gainDb}?scale=${scale}`, { method: 'DELETE' }),
  emi: (scanId?: number) => request<EmiResponse>(`/api/emi${scanId ? `?scanId=${scanId}` : ''}`),
  emiSetBaseline: (scanId: number, label: string) => request<{ scanId: number }>('/api/emi/baseline', { method: 'POST', body: JSON.stringify({ scanId, label }) }),
  emiClearBaseline: () => request<{ ok: true }>('/api/emi/baseline', { method: 'DELETE' }),
  dabMux: () => request<{ running: boolean; ready?: boolean; mux: DabMux | null; log: string[] }>('/api/dab/mux'),
  dabChannel: (channel: string) => request<{ channel: string }>('/api/dab/channel', { method: 'POST', body: JSON.stringify({ channel }) }),
  dabMp3Url: (sid: string) => `/api/dab/mp3/${encodeURIComponent(sid)}`,
  satAntenna: () => request<{ markdown: string }>('/api/satellite/antenna'),
  satInfo: () => request<{ satellites: SatInfo[]; satdump: boolean; dir: string }>('/api/satellite/info'),
  satPasses: (lat: number, lon: number, hours = 24) => request<{ tleFetchedAt: number; passes: (SatPass & { captureId: number | null })[] }>(`/api/satellite/passes?lat=${lat}&lon=${lon}&hours=${hours}`),
  satCaptures: () => request<SatCapture[]>('/api/satellite/captures'),
  satSchedule: (b: { satellite: string; aos?: number; los?: number; maxElevationDeg?: number; gainDb?: number; now?: boolean }) => request<SatCapture>('/api/satellite/captures', { method: 'POST', body: JSON.stringify(b) }),
  satCancel: (id: number) => request<SatCapture | { ok: true }>(`/api/satellite/captures/${id}`, { method: 'DELETE' }),
  satImageUrl: (id: number, rel: string) => `/api/satellite/files/${id}/${rel.split('/').map(encodeURIComponent).join('/')}`,
  planes: (scanId?: number) => request<Plane[]>(`/api/planes${scanId ? `?scanId=${scanId}` : ''}`),
  scans: () => request<Scan[]>('/api/scans'),
  scan: (id: number) => request<Scan>(`/api/scans/${id}`),
  deleteScan: (id: number) => request<{ ok: true }>(`/api/scans/${id}`, { method: 'DELETE' }),
  summary: () => request<{ signals: number; devices: number; ownDevices: number; planes: number; scanTimeMs: number; recentDevices: Device[] }>('/api/summary'),
  exportUrl: (kind: 'signals' | 'devices' | 'planes' | 'sweeps' | 'readings', format: 'csv' | 'json', params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return `/api/export/${kind}?${q.toString()}`;
  },
};
