import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Device, Plane, Reading, SatCapture, SatCaptureStatus, Scan, ScanKind, Signal, Sweep } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  low_hz INTEGER NOT NULL,
  step_hz REAL NOT NULL,
  dbs BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS sweeps_scan ON sweeps(scan_id, ts);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT NOT NULL,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  freq_hz INTEGER NOT NULL,
  width_hz INTEGER NOT NULL,
  peak_db REAL NOT NULL,
  floor_db REAL NOT NULL,
  excess_db REAL NOT NULL,
  duty_pct INTEGER NOT NULL,
  band TEXT,
  restricted INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (scan_id, id)
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  device_id TEXT,
  channel TEXT,
  freq_hz INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  rssi REAL,
  snr REAL,
  last_data TEXT NOT NULL DEFAULT '{}',
  alias TEXT
);
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  scan_id INTEGER,
  ts INTEGER NOT NULL,
  rssi REAL,
  snr REAL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_device ON readings(device_id, ts);
CREATE TABLE IF NOT EXISTS planes (
  icao TEXT PRIMARY KEY,
  callsign TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  msgs INTEGER NOT NULL DEFAULT 0,
  altitude_ft INTEGER,
  lat REAL,
  lon REAL,
  speed_kt REAL,
  heading_deg REAL,
  vertical_rate_fpm INTEGER,
  scan_id INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sat_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  satellite TEXT NOT NULL,
  aos INTEGER NOT NULL,
  los INTEGER NOT NULL,
  max_elevation_deg REAL NOT NULL,
  freq_hz INTEGER NOT NULL,
  pipeline TEXT NOT NULL,
  gain_db REAL NOT NULL,
  status TEXT NOT NULL,
  dir TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  log TEXT,
  created_at INTEGER NOT NULL
);
`;

/** Columns added after the first release; applied idempotently at startup. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['devices', 'owner', 'ALTER TABLE devices ADD COLUMN owner TEXT'],
  ['devices', 'bearing_deg', 'ALTER TABLE devices ADD COLUMN bearing_deg REAL'],
  ['planes', 'country', 'ALTER TABLE planes ADD COLUMN country TEXT'],
  ['scans', 'summary', 'ALTER TABLE scans ADD COLUMN summary TEXT'],
];

interface ScanRow {
  id: number;
  kind: ScanKind;
  started_at: number;
  ended_at: number | null;
  config: string;
  summary: string | null;
  sweeps: number;
  signals: number;
  devices: number;
  planes: number;
}
interface SweepRow { scan_id: number; ts: number; low_hz: number; step_hz: number; dbs: Buffer }
interface SignalRow {
  id: string; scan_id: number; freq_hz: number; width_hz: number; peak_db: number; floor_db: number;
  excess_db: number; duty_pct: number; band: string | null; restricted: number; first_seen: number; last_seen: number;
}
interface DeviceRow {
  id: number; key: string; model: string; device_id: string | null; channel: string | null; freq_hz: number | null;
  first_seen: number; last_seen: number; count: number; rssi: number | null; snr: number | null; last_data: string;
  alias: string | null; rssi_avg: number | null; rssi_std: number | null; owner: 'own' | 'other' | null; bearing_deg: number | null;
}
interface ReadingRow { id: number; device_id: number; ts: number; rssi: number | null; snr: number | null; data: string }
interface PlaneRow {
  icao: string; callsign: string | null; first_seen: number; last_seen: number; msgs: number; altitude_ft: number | null;
  lat: number | null; lon: number | null; speed_kt: number | null; heading_deg: number | null; vertical_rate_fpm: number | null;
  country: string | null;
}

const SCAN_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM sweeps WHERE scan_id = s.id) AS sweeps,
    (SELECT COUNT(*) FROM signals WHERE scan_id = s.id) AS signals,
    (SELECT COUNT(DISTINCT device_id) FROM readings WHERE scan_id = s.id) AS devices,
    (SELECT COUNT(*) FROM planes WHERE scan_id = s.id) AS planes
  FROM scans s`;

const DEVICE_SELECT = `
  SELECT d.*,
    (SELECT AVG(rssi) FROM readings r WHERE r.device_id = d.id AND r.rssi IS NOT NULL) AS rssi_avg,
    (SELECT AVG(rssi * rssi) - AVG(rssi) * AVG(rssi) FROM readings r WHERE r.device_id = d.id AND r.rssi IS NOT NULL) AS rssi_var
  FROM devices d`;

function scanFromRow(r: ScanRow): Scan {
  return {
    id: r.id, kind: r.kind, startedAt: r.started_at, endedAt: r.ended_at, config: JSON.parse(r.config),
    summary: r.summary ? JSON.parse(r.summary) : null, sweeps: r.sweeps, signals: r.signals, devices: r.devices, planes: r.planes,
  };
}

/** RSSI strong (rtl_433 level, 0 dB = full scale) and stable across readings => probably in the same home. */
export function isLikelyOwn(count: number, rssiAvg: number | null, rssiStd: number | null): boolean {
  if (rssiAvg === null || count < 3) return false;
  return rssiAvg > -8 && (rssiStd ?? 99) < 3;
}

function deviceFromRow(r: DeviceRow & { rssi_var?: number | null }): Device {
  const rssiStd = r.rssi_var != null ? Math.sqrt(Math.max(0, r.rssi_var)) : null;
  return {
    id: r.id, key: r.key, model: r.model, deviceId: r.device_id, channel: r.channel, freqHz: r.freq_hz,
    firstSeen: r.first_seen, lastSeen: r.last_seen, count: r.count, rssi: r.rssi, snr: r.snr,
    rssiAvg: r.rssi_avg, rssiStd,
    likelyOwn: r.owner === 'own' ? true : r.owner === 'other' ? false : isLikelyOwn(r.count, r.rssi_avg, rssiStd),
    owner: r.owner ?? null, bearingDeg: r.bearing_deg ?? null,
    lastData: JSON.parse(r.last_data), alias: r.alias,
  };
}

interface SatCaptureRow {
  id: number; satellite: string; aos: number; los: number; max_elevation_deg: number; freq_hz: number; pipeline: string;
  gain_db: number; status: SatCaptureStatus; dir: string; images: string; log: string | null; created_at: number;
}

function satCaptureFromRow(r: SatCaptureRow): SatCapture {
  return {
    id: r.id, satellite: r.satellite, aos: r.aos, los: r.los, maxElevationDeg: r.max_elevation_deg, freqHz: r.freq_hz,
    pipeline: r.pipeline, gainDb: r.gain_db, status: r.status, dir: r.dir, images: JSON.parse(r.images), log: r.log, createdAt: r.created_at,
  };
}

function planeFromRow(r: PlaneRow): Plane {
  return {
    icao: r.icao, callsign: r.callsign, firstSeen: r.first_seen, lastSeen: r.last_seen, msgs: r.msgs,
    altitudeFt: r.altitude_ft, lat: r.lat, lon: r.lon, speedKt: r.speed_kt, headingDeg: r.heading_deg,
    verticalRateFpm: r.vertical_rate_fpm, country: r.country ?? null,
  };
}

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- scans ----
  createScan(kind: ScanKind, config: unknown): number {
    const r = this.db.prepare('INSERT INTO scans (kind, started_at, config) VALUES (?, ?, ?)')
      .run(kind, Date.now(), JSON.stringify(config));
    return Number(r.lastInsertRowid);
  }

  endScan(id: number, summary?: Record<string, unknown>): void {
    this.db.prepare('UPDATE scans SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
    if (summary) this.db.prepare('UPDATE scans SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
  }

  /** Mark scans left open by a crash as ended. */
  closeDanglingScans(): void {
    this.db.prepare('UPDATE scans SET ended_at = started_at WHERE ended_at IS NULL').run();
  }

  listScans(): Scan[] {
    return (this.db.prepare(`${SCAN_SELECT} ORDER BY s.started_at DESC`).all() as ScanRow[]).map(scanFromRow);
  }

  getScan(id: number): Scan | null {
    const r = this.db.prepare(`${SCAN_SELECT} WHERE s.id = ?`).get(id) as ScanRow | undefined;
    return r ? scanFromRow(r) : null;
  }

  latestScan(kind: ScanKind): Scan | null {
    const r = this.db.prepare(`${SCAN_SELECT} WHERE s.kind = ? ORDER BY s.started_at DESC LIMIT 1`).get(kind) as ScanRow | undefined;
    return r ? scanFromRow(r) : null;
  }

  deleteScan(id: number): void {
    this.db.prepare('DELETE FROM scans WHERE id = ?').run(id);
  }

  // ---- sweeps ----
  insertSweep(s: Sweep): void {
    const buf = Buffer.from(new Float32Array(s.dbs).buffer);
    this.db.prepare('INSERT INTO sweeps (scan_id, ts, low_hz, step_hz, dbs) VALUES (?, ?, ?, ?, ?)')
      .run(s.scanId, s.ts, s.lowHz, s.stepHz, buf);
  }

  listSweeps(scanId: number, limit = 400): Sweep[] {
    const rows = this.db.prepare('SELECT scan_id, ts, low_hz, step_hz, dbs FROM sweeps WHERE scan_id = ? ORDER BY ts DESC LIMIT ?')
      .all(scanId, limit) as SweepRow[];
    return rows.reverse().map((r) => {
      const f32 = new Float32Array(r.dbs.buffer, r.dbs.byteOffset, r.dbs.byteLength / 4);
      return { scanId: r.scan_id, ts: r.ts, lowHz: r.low_hz, stepHz: r.step_hz, dbs: Array.from(f32) };
    });
  }

  // ---- signals ----
  replaceSignals(scanId: number, signals: Signal[]): void {
    const del = this.db.prepare('DELETE FROM signals WHERE scan_id = ?');
    const ins = this.db.prepare(`INSERT INTO signals
      (id, scan_id, freq_hz, width_hz, peak_db, floor_db, excess_db, duty_pct, band, restricted, first_seen, last_seen)
      VALUES (@id, @scanId, @freqHz, @widthHz, @peakDb, @floorDb, @excessDb, @dutyPct, @band, @restricted, @firstSeen, @lastSeen)`);
    this.db.transaction(() => {
      del.run(scanId);
      for (const s of signals) ins.run({ ...s, restricted: s.restricted ? 1 : 0 });
    })();
  }

  listSignals(scanId?: number): Signal[] {
    const rows = (scanId == null
      ? this.db.prepare('SELECT * FROM signals ORDER BY excess_db DESC').all()
      : this.db.prepare('SELECT * FROM signals WHERE scan_id = ? ORDER BY excess_db DESC').all(scanId)) as SignalRow[];
    return rows.map((r) => ({
      id: r.id, scanId: r.scan_id, freqHz: r.freq_hz, widthHz: r.width_hz, peakDb: r.peak_db, floorDb: r.floor_db,
      excessDb: r.excess_db, dutyPct: r.duty_pct, band: r.band, restricted: r.restricted === 1,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
    }));
  }

  // ---- devices ----
  upsertDevice(input: {
    key: string; model: string; deviceId: string | null; channel: string | null; freqHz: number | null;
    ts: number; rssi: number | null; snr: number | null; data: Record<string, unknown>; scanId: number | null;
  }): { device: Device; isNew: boolean } {
    const existing = this.db.prepare('SELECT id FROM devices WHERE key = ?').get(input.key) as { id: number } | undefined;
    const dataJson = JSON.stringify(input.data);
    const id = this.db.transaction(() => {
      let devId: number;
      if (existing) {
        devId = existing.id;
        this.db.prepare(`UPDATE devices SET last_seen = ?, count = count + 1, rssi = ?, snr = ?, last_data = ?,
          freq_hz = COALESCE(?, freq_hz) WHERE id = ?`).run(input.ts, input.rssi, input.snr, dataJson, input.freqHz, devId);
      } else {
        const r = this.db.prepare(`INSERT INTO devices (key, model, device_id, channel, freq_hz, first_seen, last_seen, count, rssi, snr, last_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .run(input.key, input.model, input.deviceId, input.channel, input.freqHz, input.ts, input.ts, input.rssi, input.snr, dataJson);
        devId = Number(r.lastInsertRowid);
      }
      this.db.prepare('INSERT INTO readings (device_id, scan_id, ts, rssi, snr, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(devId, input.scanId, input.ts, input.rssi, input.snr, dataJson);
      return devId;
    })();
    return { device: this.getDevice(id)!, isNew: !existing };
  }

  getDevice(id: number): Device | null {
    const r = this.db.prepare(`${DEVICE_SELECT} WHERE d.id = ?`).get(id) as DeviceRow | undefined;
    return r ? deviceFromRow(r) : null;
  }

  listDevices(): Device[] {
    return (this.db.prepare(`${DEVICE_SELECT} ORDER BY d.last_seen DESC`).all() as DeviceRow[]).map(deviceFromRow);
  }

  setDeviceAlias(id: number, alias: string | null): Device | null {
    this.db.prepare('UPDATE devices SET alias = ? WHERE id = ?').run(alias, id);
    return this.getDevice(id);
  }

  updateDeviceMeta(id: number, patch: { alias?: string | null; owner?: 'own' | 'other' | null; bearingDeg?: number | null }): Device | null {
    if (patch.alias !== undefined) this.db.prepare('UPDATE devices SET alias = ? WHERE id = ?').run(patch.alias, id);
    if (patch.owner !== undefined) this.db.prepare('UPDATE devices SET owner = ? WHERE id = ?').run(patch.owner, id);
    if (patch.bearingDeg !== undefined) this.db.prepare('UPDATE devices SET bearing_deg = ? WHERE id = ?').run(patch.bearingDeg, id);
    return this.getDevice(id);
  }

  /** Readings per hour of day (local time) for each device: [deviceId → 24 counts]. */
  deviceActivityByHour(): Record<number, number[]> {
    const rows = this.db.prepare('SELECT device_id, ts FROM readings').all() as { device_id: number; ts: number }[];
    const out: Record<number, number[]> = {};
    for (const r of rows) {
      const arr = (out[r.device_id] ??= new Array<number>(24).fill(0));
      arr[new Date(r.ts).getHours()]! += 1;
    }
    return out;
  }

  /** Days with at least one reading per device, to judge whether a routine is statistically meaningful. */
  deviceActiveDays(): Record<number, number> {
    const rows = this.db.prepare("SELECT device_id, COUNT(DISTINCT date(ts / 1000, 'unixepoch', 'localtime')) AS days FROM readings GROUP BY device_id").all() as { device_id: number; days: number }[];
    return Object.fromEntries(rows.map((r) => [r.device_id, r.days]));
  }

  deviceHistory(id: number, limit = 500): Reading[] {
    const rows = this.db.prepare('SELECT * FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT ?').all(id, limit) as ReadingRow[];
    return rows.reverse().map((r) => ({ id: r.id, deviceId: r.device_id, ts: r.ts, rssi: r.rssi, snr: r.snr, data: JSON.parse(r.data) }));
  }

  countDevices(scanId?: number): number {
    if (scanId === undefined) return (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
    return (this.db.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM readings WHERE scan_id = ?').get(scanId) as { n: number }).n;
  }

  // ---- planes ----
  upsertPlane(p: Plane, scanId: number | null): void {
    this.db.prepare(`INSERT INTO planes (icao, callsign, first_seen, last_seen, msgs, altitude_ft, lat, lon, speed_kt, heading_deg, vertical_rate_fpm, scan_id, country)
      VALUES (@icao, @callsign, @firstSeen, @lastSeen, @msgs, @altitudeFt, @lat, @lon, @speedKt, @headingDeg, @verticalRateFpm, @scanId, @country)
      ON CONFLICT(icao) DO UPDATE SET
        callsign = COALESCE(excluded.callsign, planes.callsign),
        country = COALESCE(excluded.country, planes.country),
        last_seen = excluded.last_seen,
        msgs = planes.msgs + excluded.msgs,
        altitude_ft = COALESCE(excluded.altitude_ft, planes.altitude_ft),
        lat = COALESCE(excluded.lat, planes.lat),
        lon = COALESCE(excluded.lon, planes.lon),
        speed_kt = COALESCE(excluded.speed_kt, planes.speed_kt),
        heading_deg = COALESCE(excluded.heading_deg, planes.heading_deg),
        vertical_rate_fpm = COALESCE(excluded.vertical_rate_fpm, planes.vertical_rate_fpm),
        scan_id = excluded.scan_id`).run({ ...p, scanId });
  }

  listPlanes(scanId?: number): Plane[] {
    const rows = (scanId === undefined
      ? this.db.prepare('SELECT * FROM planes ORDER BY last_seen DESC').all()
      : this.db.prepare('SELECT * FROM planes WHERE scan_id = ? ORDER BY last_seen DESC').all(scanId)) as PlaneRow[];
    return rows.map(planeFromRow);
  }

  /** Fills `country` for rows created before the column existed. */
  backfillPlaneCountries(lookup: (icao: string) => string | null): number {
    const rows = this.db.prepare('SELECT icao FROM planes WHERE country IS NULL').all() as { icao: string }[];
    const upd = this.db.prepare('UPDATE planes SET country = ? WHERE icao = ?');
    let n = 0;
    for (const r of rows) { const c = lookup(r.icao); if (c) { upd.run(c, r.icao); n++; } }
    return n;
  }

  countPlanes(scanId?: number): number {
    if (scanId === undefined) return (this.db.prepare('SELECT COUNT(*) AS n FROM planes').get() as { n: number }).n;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM planes WHERE scan_id = ?').get(scanId) as { n: number }).n;
  }

  // ---- settings ----
  getSetting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  // ---- satellite captures ----
  createSatCapture(c: Omit<SatCapture, 'id' | 'images' | 'log' | 'createdAt' | 'status'> & { status?: SatCaptureStatus }): SatCapture {
    const r = this.db.prepare(`INSERT INTO sat_captures (satellite, aos, los, max_elevation_deg, freq_hz, pipeline, gain_db, status, dir, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.satellite, c.aos, c.los, c.maxElevationDeg, c.freqHz, c.pipeline, c.gainDb, c.status ?? 'scheduled', c.dir, Date.now());
    return this.getSatCapture(Number(r.lastInsertRowid))!;
  }

  getSatCapture(id: number): SatCapture | null {
    const r = this.db.prepare('SELECT * FROM sat_captures WHERE id = ?').get(id) as SatCaptureRow | undefined;
    return r ? satCaptureFromRow(r) : null;
  }

  listSatCaptures(): SatCapture[] {
    return (this.db.prepare('SELECT * FROM sat_captures ORDER BY aos DESC').all() as SatCaptureRow[]).map(satCaptureFromRow);
  }

  updateSatCapture(id: number, patch: { status?: SatCaptureStatus; images?: string[]; log?: string | null }): SatCapture | null {
    if (patch.status !== undefined) this.db.prepare('UPDATE sat_captures SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.images !== undefined) this.db.prepare('UPDATE sat_captures SET images = ? WHERE id = ?').run(JSON.stringify(patch.images), id);
    if (patch.log !== undefined) this.db.prepare('UPDATE sat_captures SET log = ? WHERE id = ?').run(patch.log, id);
    return this.getSatCapture(id);
  }

  deleteSatCapture(id: number): void {
    this.db.prepare('DELETE FROM sat_captures WHERE id = ?').run(id);
  }

  /** Captures left "running" by a crash become failed. */
  failRunningSatCaptures(): void {
    this.db.prepare("UPDATE sat_captures SET status = 'failed', log = COALESCE(log, '') || '\nInterromput (el servidor s’ha reiniciat)' WHERE status = 'running'").run();
  }

  /** Total scanning time in ms across all scans. */
  totalScanTimeMs(): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS t FROM scans').get(Date.now()) as { t: number };
    return r.t;
  }
}
