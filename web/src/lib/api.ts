import type { Band, Device, ModeConfig, Plane, Reading, SatCapture, SatInfo, SatPass, Scan, Signal, Status, Sweep } from '@shared/types';
import type { AuditVerdict } from '@shared/sdr/audit';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
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
  satInfo: () => request<{ satellites: SatInfo[]; satdump: boolean; dir: string }>('/api/satellite/info'),
  satPasses: (lat: number, lon: number, hours = 24) => request<{ tleFetchedAt: number; passes: (SatPass & { captureId: number | null })[] }>(`/api/satellite/passes?lat=${lat}&lon=${lon}&hours=${hours}`),
  satCaptures: () => request<SatCapture[]>('/api/satellite/captures'),
  satSchedule: (b: { satellite: string; aos?: number; los?: number; maxElevationDeg?: number; gainDb?: number; now?: boolean }) => request<SatCapture>('/api/satellite/captures', { method: 'POST', body: JSON.stringify(b) }),
  satCancel: (id: number) => request<SatCapture | { ok: true }>(`/api/satellite/captures/${id}`, { method: 'DELETE' }),
  satImageUrl: (id: number, rel: string) => `/api/satellite/files/${id}/${rel.split('/').map(encodeURIComponent).join('/')}`,
  planes: (scanId?: number) => request<Plane[]>(`/api/planes${scanId ? `?scanId=${scanId}` : ''}`),
  scans: () => request<Scan[]>('/api/scans'),
  deleteScan: (id: number) => request<{ ok: true }>(`/api/scans/${id}`, { method: 'DELETE' }),
  summary: () => request<{ signals: number; devices: number; ownDevices: number; planes: number; scanTimeMs: number; recentDevices: Device[] }>('/api/summary'),
  exportUrl: (kind: 'signals' | 'devices' | 'planes' | 'sweeps' | 'readings', format: 'csv' | 'json', params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    return `/api/export/${kind}?${q.toString()}`;
  },
};
