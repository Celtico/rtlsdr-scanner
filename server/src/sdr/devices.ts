import type { DevicesConfig } from '../types.js';

/** Fields rtl_433 adds that are metadata, not sensor readings. */
const META_FIELDS = new Set(['time', 'model', 'id', 'channel', 'freq', 'freq1', 'freq2', 'rssi', 'snr', 'noise', 'mic', 'mod', 'protocol']);

export interface Rtl433Message {
  key: string;
  model: string;
  deviceId: string | null;
  channel: string | null;
  freqHz: number | null;
  ts: number;
  rssi: number | null;
  snr: number | null;
  data: Record<string, unknown>;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

/** Parses one `rtl_433 -F json -M level -M time:iso` line. Returns null for non-JSON or messages without a model. */
export function parseRtl433Line(line: string): Rtl433Message | null {
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m.model !== 'string') return null;
  const deviceId = asStr(m.id);
  const channel = asStr(m.channel);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!META_FIELDS.has(k)) data[k] = v;
  const freqMHz = asNum(m.freq);
  const timeStr = typeof m.time === 'string' ? m.time : null;
  const ts = timeStr ? parseRtl433Time(timeStr) : Date.now();
  return {
    key: deviceKey(m.model, deviceId, channel),
    model: m.model,
    deviceId,
    channel,
    freqHz: freqMHz !== null ? Math.round(freqMHz * 1_000_000) : null,
    ts,
    rssi: asNum(m.rssi),
    snr: asNum(m.snr),
    data,
  };
}

/** rtl_433 `-M time:iso` prints local time "YYYY-MM-DDTHH:MM:SS" (or with a space). */
export function parseRtl433Time(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return Date.now();
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return d.getTime();
}

export function deviceKey(model: string, id: string | null, channel: string | null): string {
  return [model, id ?? '', channel ?? ''].join('|');
}

/** In-memory dedup used by tests and as a mirror of the DB upsert logic. */
export interface DedupEntry {
  key: string;
  model: string;
  deviceId: string | null;
  channel: string | null;
  freqHz: number | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  rssi: number | null;
  lastData: Record<string, unknown>;
  history: { ts: number; rssi: number | null; data: Record<string, unknown> }[];
}

export class DeviceDedup {
  readonly entries = new Map<string, DedupEntry>();

  push(m: Rtl433Message): { entry: DedupEntry; isNew: boolean } {
    const existing = this.entries.get(m.key);
    if (existing) {
      existing.lastSeen = m.ts;
      existing.count += 1;
      existing.rssi = m.rssi;
      existing.lastData = m.data;
      if (m.freqHz !== null) existing.freqHz = m.freqHz;
      existing.history.push({ ts: m.ts, rssi: m.rssi, data: m.data });
      return { entry: existing, isNew: false };
    }
    const entry: DedupEntry = {
      key: m.key, model: m.model, deviceId: m.deviceId, channel: m.channel, freqHz: m.freqHz,
      firstSeen: m.ts, lastSeen: m.ts, count: 1, rssi: m.rssi, lastData: m.data,
      history: [{ ts: m.ts, rssi: m.rssi, data: m.data }],
    };
    this.entries.set(m.key, entry);
    return { entry, isNew: true };
  }
}

export function rtl433Args(c: DevicesConfig): string[] {
  const args: string[] = [];
  for (const f of c.freqsHz) args.push('-f', String(f));
  if (c.freqsHz.length > 1) args.push('-H', String(c.hopS));
  args.push('-F', 'json', '-M', 'level', '-M', 'time:iso');
  return args;
}

export function validateDevicesConfig(c: DevicesConfig): string | null {
  if (!c.freqsHz.length || c.freqsHz.length > 4) return 'Cal entre 1 i 4 freqüències.';
  for (const f of c.freqsHz) if (f < 300_000_000 || f > 1_000_000_000) return 'rtl_433 només té sentit entre 300 i 1000 MHz.';
  if (c.freqsHz.length > 1 && (c.hopS < 5 || c.hopS > 600)) return 'El salt ha d’estar entre 5 i 600 s.';
  return null;
}
