import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { WebSocket } from 'ws';
import { Db } from './db.js';
import { SdrManager } from './sdr/manager.js';
import { BANDS } from './sdr/bands.js';
import { killAllSync } from './sdr/process.js';
import { toCsv } from './export.js';
import { classifyDevice, routineHours } from './sdr/audit.js';
import { loadTles, predictAll, satInfo, SATELLITES } from './sdr/satellite.js';
import { analyzeEmi, compareReports, floorTrend, medianSpectrum, type EmiReport } from './sdr/emi.js';
import { removeEntry, upsertEntry, type Calibration } from './sdr/calibration.js';
import { icaoCountry } from './sdr/icao.js';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { normalize, sep } from 'node:path';
import {
  AUDIO_SAMPLE_RATE, DAB_CHANNELS, DAB_WEB_PORT, DEFAULT_ADSB, DEFAULT_DAB, DEFAULT_DEVICES, DEFAULT_HOME, DEFAULT_HUNT, DEFAULT_SURVEY,
  type AdsbConfig, type AudioConfig, type DabConfig, type DevicesConfig, type HuntConfig, type ModeConfig, type SatCapture, type SurveyConfig, type WsMessage,
} from './types.js';

const PORT = Number(process.env.PORT ?? 4000);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.SDR_DB ?? resolve(ROOT, 'data', 'sdr.db');

const SAT_DIR = process.env.SDR_SAT_DIR ?? resolve(ROOT, 'data', 'satellite');
const TLE_PATH = resolve(ROOT, 'data', 'tle.json');

const db = new Db(DB_PATH);
db.closeDanglingScans();
db.failRunningSatCaptures();
db.backfillPlaneCountries(icaoCountry);
const manager = new SdrManager(db);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);

// ---------- WebSocket ----------

const clients = new Set<WebSocket>();
function broadcast(msg: WsMessage): void {
  const json = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(json);
}
manager.on('message', broadcast);

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'status', status: manager.status() } satisfies WsMessage));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

// ---------- REST ----------

app.get('/api/status', async () => manager.status());

app.post('/api/dongle/check', async () => manager.probeDongle());

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function parseModeBody(body: unknown): ModeConfig {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const cfg = (b.config && typeof b.config === 'object' ? b.config : {}) as Record<string, unknown>;
  switch (b.mode) {
    case 'idle':
      return { mode: 'idle' };
    case 'survey': {
      const config: SurveyConfig = {
        fromHz: Math.round(num(cfg.fromHz, DEFAULT_SURVEY.fromHz)),
        toHz: Math.round(num(cfg.toHz, DEFAULT_SURVEY.toHz)),
        stepHz: Math.round(num(cfg.stepHz, DEFAULT_SURVEY.stepHz)),
        gainDb: num(cfg.gainDb, DEFAULT_SURVEY.gainDb),
        intervalS: num(cfg.intervalS, DEFAULT_SURVEY.intervalS),
        thresholdDb: num(cfg.thresholdDb, DEFAULT_SURVEY.thresholdDb),
      };
      return { mode: 'survey', config };
    }
    case 'devices': {
      const freqs = Array.isArray(cfg.freqsHz) ? cfg.freqsHz.map((f) => Math.round(num(f, 0))).filter((f) => f > 0) : DEFAULT_DEVICES.freqsHz;
      const config: DevicesConfig = { freqsHz: freqs.length ? freqs : DEFAULT_DEVICES.freqsHz, hopS: num(cfg.hopS, DEFAULT_DEVICES.hopS) };
      return { mode: 'devices', config };
    }
    case 'adsb': {
      const config: AdsbConfig = { gainDb: cfg.gainDb == null ? DEFAULT_ADSB.gainDb : num(cfg.gainDb, 0) };
      return { mode: 'adsb', config };
    }
    case 'hunt': {
      const config: HuntConfig = {
        freqHz: Math.round(num(cfg.freqHz, DEFAULT_HUNT.freqHz)),
        gainDb: num(cfg.gainDb, DEFAULT_HUNT.gainDb),
        sampleRate: Math.round(num(cfg.sampleRate, DEFAULT_HUNT.sampleRate)),
      };
      return { mode: 'hunt', config };
    }
    case 'audio': {
      // FM channels sit on a 100 kHz grid; snap so a click on a detected peak lands on the station.
      const config: AudioConfig = { freqHz: Math.round(num(cfg.freqHz, 0) / 100_000) * 100_000, gainDb: cfg.gainDb == null ? null : num(cfg.gainDb, 0) };
      return { mode: 'audio', config };
    }
    case 'dab': {
      const config: DabConfig = { channel: typeof cfg.channel === 'string' ? cfg.channel.toUpperCase() : DEFAULT_DAB.channel, gainDb: cfg.gainDb == null ? null : num(cfg.gainDb, 0) };
      return { mode: 'dab', config };
    }
    case 'satellite':
      throw Object.assign(new Error('El mode satellite es llança des de /api/satellite/captures'), { statusCode: 400 });
    default:
      throw Object.assign(new Error('mode ha de ser idle | survey | devices | adsb | hunt'), { statusCode: 400 });
  }
}

app.post('/api/mode', async (req, reply) => {
  const mc = parseModeBody(req.body);
  try {
    return await manager.setMode(mc);
  } catch (e) {
    reply.code(400);
    return { error: (e as Error).message };
  }
});

app.get('/api/bands', async () => BANDS);

app.get<{ Querystring: { scanId?: string } }>('/api/signals', async (req) => {
  const status = manager.status();
  const scanId = req.query.scanId ? Number(req.query.scanId) : status.mode === 'survey' ? status.scanId : db.latestScan('survey')?.id;
  if (scanId == null) return { scanId: null, signals: [] };
  if (status.mode === 'survey' && status.scanId === scanId) return { scanId, signals: manager.currentSignals() };
  return { scanId, signals: db.listSignals(scanId) };
});

app.get<{ Querystring: { scanId?: string; limit?: string } }>('/api/sweeps', async (req) => {
  const status = manager.status();
  const scanId = req.query.scanId ? Number(req.query.scanId) : status.mode === 'survey' ? status.scanId : db.latestScan('survey')?.id;
  if (scanId == null) return { scanId: null, sweeps: [] };
  return { scanId, sweeps: db.listSweeps(scanId, num(req.query.limit, 300)) };
});

app.get('/api/devices', async () => db.listDevices());

app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/devices/:id/history', async (req, reply) => {
  const id = Number(req.params.id);
  const device = db.getDevice(id);
  if (!device) return reply.code(404).send({ error: 'Dispositiu no trobat' });
  return { device, readings: db.deviceHistory(id, num(req.query.limit, 500)) };
});

app.patch<{ Params: { id: string }; Body: { alias?: string | null; owner?: 'own' | 'other' | null; bearingDeg?: number | null } }>('/api/devices/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const b = req.body ?? {};
  const patch: Parameters<Db['updateDeviceMeta']>[1] = {};
  if ('alias' in b) patch.alias = typeof b.alias === 'string' ? b.alias.trim() || null : null;
  if ('owner' in b) patch.owner = b.owner === 'own' || b.owner === 'other' ? b.owner : null;
  if ('bearingDeg' in b) {
    const v = b.bearingDeg == null ? null : num(b.bearingDeg, NaN);
    patch.bearingDeg = v === null ? null : Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
  }
  const device = db.updateDeviceMeta(id, patch);
  if (!device) return reply.code(404).send({ error: 'Dispositiu no trobat' });
  broadcast({ type: 'device:update', device });
  return device;
});

/** Home exposure audit: only the user's own devices, only metadata (never third parties' content). */
app.get('/api/audit', async () => {
  const own = db.listDevices().filter((d) => d.likelyOwn);
  const byHour = db.deviceActivityByHour();
  const days = db.deviceActiveDays();
  return own.map((d) => {
    const hours = byHour[d.id] ?? new Array<number>(24).fill(0);
    return {
      device: d,
      verdict: classifyDevice(d.model, d.deviceId, d.lastData),
      activityByHour: hours,
      routineHours: routineHours(hours),
      activeDays: days[d.id] ?? 0,
    };
  });
});

app.get<{ Querystring: { scanId?: string } }>('/api/planes', async (req) => {
  return db.listPlanes(req.query.scanId ? Number(req.query.scanId) : undefined);
});

app.get('/api/scans', async () => db.listScans());

app.get<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
  const scan = db.getScan(Number(req.params.id));
  if (!scan) return reply.code(404).send({ error: 'Escaneig no trobat' });
  return scan;
});

app.delete<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (manager.status().scanId === id) return reply.code(409).send({ error: 'Aquest escaneig està actiu' });
  db.deleteScan(id);
  return { ok: true };
});

app.get('/api/summary', async () => {
  const devices = db.listDevices();
  return {
    signals: db.latestScan('survey') ? db.listSignals(db.latestScan('survey')!.id).length : 0,
    devices: devices.length,
    ownDevices: devices.filter((d) => d.likelyOwn).length,
    planes: db.countPlanes(),
    scanTimeMs: db.totalScanTimeMs(),
    recentDevices: [...devices].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, 8),
  };
});

type ExportKind = 'signals' | 'devices' | 'planes' | 'sweeps' | 'readings';

app.get<{ Params: { kind: ExportKind }; Querystring: { format?: string; scanId?: string; deviceId?: string } }>(
  '/api/export/:kind',
  async (req, reply) => {
    const { kind } = req.params;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const scanId = req.query.scanId ? Number(req.query.scanId) : undefined;
    let rows: Record<string, unknown>[];
    switch (kind) {
      case 'signals': {
        const id = scanId ?? db.latestScan('survey')?.id;
        rows = id == null ? [] : (db.listSignals(id) as unknown as Record<string, unknown>[]);
        break;
      }
      case 'devices':
        rows = db.listDevices().map((d) => ({ ...d, lastData: JSON.stringify(d.lastData) }));
        break;
      case 'planes':
        rows = db.listPlanes(scanId) as unknown as Record<string, unknown>[];
        break;
      case 'sweeps': {
        const id = scanId ?? db.latestScan('survey')?.id;
        rows = id == null ? [] : db.listSweeps(id, 100_000).map((s) => ({
          ts: new Date(s.ts).toISOString(), lowHz: s.lowHz, stepHz: s.stepHz, bins: s.dbs.length,
          ...(format === 'csv' ? { dbs: s.dbs.join(' ') } : { dbs: s.dbs }),
        }));
        break;
      }
      case 'readings': {
        const deviceId = Number(req.query.deviceId);
        rows = Number.isFinite(deviceId)
          ? db.deviceHistory(deviceId, 100_000).map((r) => ({ ...r, ts: new Date(r.ts).toISOString(), data: JSON.stringify(r.data) }))
          : [];
        break;
      }
      default:
        return reply.code(400).send({ error: 'kind ha de ser signals | devices | planes | sweeps | readings' });
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
    const name = `${kind}${scanId ? `-scan${scanId}` : ''}-${stamp}.${format}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    if (format === 'csv') return reply.type('text/csv; charset=utf-8').send(toCsv(rows));
    return reply.type('application/json').send(JSON.stringify(rows, null, 2));
  },
);

// ---------- calibration (relative dB → dBm) ----------

app.get('/api/calibration', async () => db.getSetting<Calibration>('calibration') ?? { entries: [] });

/** Reading at a frequency in a scan (max within ±window of the median spectrum), to fill the calibration form. */
app.get<{ Querystring: { scanId?: string; freqHz?: string; windowHz?: string } }>('/api/calibration/reading', async (req, reply) => {
  const scanId = num(req.query.scanId, NaN);
  const freqHz = num(req.query.freqHz, NaN);
  if (!Number.isFinite(scanId) || !Number.isFinite(freqHz)) return reply.code(400).send({ error: 'scanId i freqHz obligatoris' });
  const scan = db.getScan(scanId);
  const spec = medianSpectrum(db.listSweeps(scanId, 40));
  if (!scan || !spec || !('gainDb' in scan.config) || !('fromHz' in scan.config)) return reply.code(404).send({ error: 'Escaneig sense escombrats' });
  const win = num(req.query.windowHz, 50_000);
  const i0 = Math.max(0, Math.floor((freqHz - win - spec.lowHz) / spec.stepHz));
  const i1 = Math.min(spec.dbs.length - 1, Math.ceil((freqHz + win - spec.lowHz) / spec.stepHz));
  if (i1 < i0) return reply.code(400).send({ error: 'La freqüència queda fora de l’escombrat' });
  let best = -Infinity;
  let bestHz = freqHz;
  for (let i = i0; i <= i1; i++) { const v = spec.dbs[i]!; if (Number.isFinite(v) && v > best) { best = v; bestHz = spec.lowHz + i * spec.stepHz; } }
  return { scanId, gainDb: scan.config.gainDb, freqHz: Math.round(bestHz), measuredDb: Math.round(best * 10) / 10, stepHz: spec.stepHz };
});

app.post<{ Body: { gainDb?: number; freqHz?: number; measuredDb?: number; refDbm?: number; note?: string } }>('/api/calibration', async (req, reply) => {
  const b = req.body ?? {};
  const gainDb = num(b.gainDb, NaN);
  const freqHz = num(b.freqHz, NaN);
  const measuredDb = num(b.measuredDb, NaN);
  const refDbm = num(b.refDbm, NaN);
  if (![gainDb, freqHz, measuredDb, refDbm].every(Number.isFinite)) return reply.code(400).send({ error: 'Calen guany, freqüència, lectura i referència' });
  if (refDbm > 10 || refDbm < -150) return reply.code(400).send({ error: 'Referència fora de rang (−150…+10 dBm)' });
  const cal = upsertEntry(db.getSetting<Calibration>('calibration'), { gainDb, freqHz: Math.round(freqHz), measuredDb, refDbm, note: typeof b.note === 'string' ? b.note.slice(0, 80) : '' });
  db.setSetting('calibration', cal);
  return cal;
});

app.delete<{ Params: { gain: string } }>('/api/calibration/:gain', async (req) => {
  const cal = removeEntry(db.getSetting<Calibration>('calibration'), num(req.params.gain, NaN));
  db.setSetting('calibration', cal);
  return cal;
});

// ---------- EMI / noise ----------

interface EmiBaseline { scanId: number; takenAt: number; label: string; report: EmiReport }
const emiCache = new Map<string, EmiReport>();

function emiReportFor(scanId: number): EmiReport | null {
  const sweeps = db.listSweeps(scanId, 40);
  if (!sweeps.length) return null;
  const key = `${scanId}:${sweeps.length}:${sweeps[sweeps.length - 1]!.ts}`;
  const cached = emiCache.get(key);
  if (cached) return cached;
  const report = analyzeEmi(sweeps);
  if (report) { emiCache.clear(); emiCache.set(key, report); }
  return report;
}

app.get<{ Querystring: { scanId?: string } }>('/api/emi', async (req) => {
  const status = manager.status();
  const scanId = req.query.scanId ? Number(req.query.scanId) : status.mode === 'survey' ? status.scanId : db.latestScan('survey')?.id;
  if (scanId == null) return { scanId: null, report: null, trend: [], baseline: null, delta: null };
  const report = emiReportFor(scanId);
  const baseline = db.getSetting<EmiBaseline>('emi.baseline');
  const trend = floorTrend(db.listSweeps(scanId, 400));
  const delta = report && baseline ? compareReports(baseline.report, report) : null;
  return { scanId, report, trend, baseline: baseline ? { scanId: baseline.scanId, takenAt: baseline.takenAt, label: baseline.label } : null, delta: delta && delta.length ? delta : null };
});

app.post<{ Body: { scanId?: number; label?: string } }>('/api/emi/baseline', async (req, reply) => {
  const scanId = num(req.body?.scanId, NaN);
  const report = Number.isFinite(scanId) ? emiReportFor(scanId) : null;
  if (!report) return reply.code(400).send({ error: 'Escaneig sense escombrats' });
  const baseline: EmiBaseline = { scanId, takenAt: Date.now(), label: typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 80) : '', report };
  db.setSetting('emi.baseline', baseline);
  return { scanId, takenAt: baseline.takenAt, label: baseline.label };
});

app.delete('/api/emi/baseline', async () => { db.deleteSetting('emi.baseline'); return { ok: true }; });

// ---------- audio stream ----------

/** Raw PCM (s16le mono, 48 kHz) of the FM station being demodulated. Several browsers may listen at once. */
app.get('/api/audio/stream', async (req, reply) => {
  if (manager.status().mode !== 'audio') return reply.code(409).send({ error: 'No hi ha cap emissora en reproducció' });
  reply.raw.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-sample-rate': String(AUDIO_SAMPLE_RATE),
    'x-channels': '1',
  });
  const onChunk = (chunk: Uint8Array) => { if (!reply.raw.writableEnded) reply.raw.write(chunk); };
  const onStatus = (m: WsMessage) => { if (m.type === 'status' && m.status.mode !== 'audio') reply.raw.end(); };
  manager.on('audio', onChunk);
  manager.on('message', onStatus);
  await new Promise<void>((resolve) => {
    const done = () => { manager.off('audio', onChunk); manager.off('message', onStatus); resolve(); };
    req.raw.on('close', done);
    reply.raw.on('close', done);
  });
  return reply;
});

// ---------- DAB (proxy to welle-cli's web server in the container) ----------

const WELLE = `http://127.0.0.1:${DAB_WEB_PORT}`;

app.get('/api/dab/channels', async () => DAB_CHANNELS);

app.get('/api/dab/mux', async () => {
  if (manager.status().mode !== 'dab') return { running: false, log: [] };
  try {
    const res = await fetch(`${WELLE}/mux.json`, { signal: AbortSignal.timeout(4000) });
    const mux: unknown = await res.json();
    return { running: true, ready: res.ok, mux, log: manager.currentLog().slice(-30) };
  } catch {
    return { running: true, ready: false, mux: null, log: manager.currentLog().slice(-30) };
  }
});

app.post<{ Body: { channel?: string } }>('/api/dab/channel', async (req, reply) => {
  const ch = String(req.body?.channel ?? '').toUpperCase();
  if (!DAB_CHANNELS.some((c) => c.name === ch)) return reply.code(400).send({ error: 'Bloc DAB desconegut' });
  if (manager.status().mode !== 'dab') return reply.code(409).send({ error: 'El mode DAB no està actiu' });
  const res = await fetch(`${WELLE}/channel`, { method: 'POST', body: ch, signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (!res || !res.ok) return reply.code(502).send({ error: 'welle-cli no ha acceptat el canvi de bloc' });
  return { channel: ch };
});

/** MP3 of one DAB service, streamed through so the browser only talks to this server. */
app.get<{ Params: { sid: string } }>('/api/dab/mp3/:sid', async (req, reply) => {
  if (manager.status().mode !== 'dab') return reply.code(409).send({ error: 'El mode DAB no està actiu' });
  const sid = req.params.sid.replace(/[^0-9a-fx]/gi, '');
  const ac = new AbortController();
  req.raw.on('close', () => ac.abort());
  const res = await fetch(`${WELLE}/mp3/${sid}`, { signal: ac.signal }).catch(() => null);
  if (!res || !res.ok || !res.body) return reply.code(502).send({ error: 'welle-cli no serveix aquest programa' });
  reply.raw.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (reply.raw.writableEnded) break;
      reply.raw.write(value);
    }
  } catch { /* client went away */ }
  reply.raw.end();
  return reply;
});

// ---------- satellites ----------

app.get('/api/satellite/info', async () => ({ satellites: SATELLITES, satdump: manager.status().tools.satdump, dir: SAT_DIR }));

app.get<{ Querystring: { lat?: string; lon?: string; hours?: string; minEl?: string } }>('/api/satellite/passes', async (req, reply) => {
  const obs = { lat: num(req.query.lat, DEFAULT_HOME.lat), lon: num(req.query.lon, DEFAULT_HOME.lon) };
  try {
    const tles = await loadTles(TLE_PATH);
    const passes = predictAll(tles, obs, Date.now(), num(req.query.hours, 24), num(req.query.minEl, 10));
    const scheduled = db.listSatCaptures().filter((c) => c.status === 'scheduled' || c.status === 'running');
    return {
      tleFetchedAt: tles.fetchedAt,
      passes: passes.map((p) => ({ ...p, captureId: scheduled.find((c) => c.satellite === p.satellite && Math.abs(c.aos - p.aos) < 120_000)?.id ?? null })),
    };
  } catch (e) {
    return reply.code(502).send({ error: `No s’han pogut obtenir els TLE: ${(e as Error).message}` });
  }
});

app.get('/api/satellite/captures', async () => db.listSatCaptures());

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function startCapture(cap: SatCapture): Promise<void> {
  const timeoutS = Math.max(60, Math.round((cap.los - Date.now()) / 1000));
  mkdirSync(cap.dir, { recursive: true });
  await manager.setMode({ mode: 'satellite', config: {
    captureId: cap.id, satellite: cap.satellite, freqHz: cap.freqHz, pipeline: cap.pipeline, gainDb: cap.gainDb, timeoutS,
  } });
}

app.post<{ Body: { satellite?: string; aos?: number; los?: number; maxElevationDeg?: number; freqHz?: number; gainDb?: number; pipeline?: string; now?: boolean } }>(
  '/api/satellite/captures',
  async (req, reply) => {
    const b = req.body ?? {};
    const info = satInfo(String(b.satellite));
    if (!info) return reply.code(400).send({ error: 'Satèl·lit desconegut' });
    if (!manager.status().tools.satdump) return reply.code(400).send({ error: 'SatDump no està instal·lat (brew install satdump).' });
    const nowMs = Date.now();
    const aos = b.now ? nowMs : num(b.aos, NaN);
    const los = b.now ? nowMs + 15 * 60_000 : num(b.los, NaN);
    if (!Number.isFinite(aos) || !Number.isFinite(los) || los <= aos) return reply.code(400).send({ error: 'Pas no vàlid' });
    if (los < nowMs) return reply.code(400).send({ error: 'Aquest pas ja ha acabat' });
    const dir = resolve(SAT_DIR, `${slug(info.name)}_${new Date(aos).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
    const cap = db.createSatCapture({
      satellite: info.name, aos, los, maxElevationDeg: num(b.maxElevationDeg, 0),
      freqHz: Math.round(num(b.freqHz, info.freqHz)), pipeline: typeof b.pipeline === 'string' && b.pipeline ? b.pipeline : info.pipeline,
      gainDb: num(b.gainDb, 40.2), dir, status: 'scheduled',
    });
    broadcast({ type: 'satellite:capture', capture: cap });
    if (b.now || aos - nowMs < 30_000) {
      try {
        await startCapture(cap);
      } catch (e) {
        const failed = db.updateSatCapture(cap.id, { status: 'failed', log: (e as Error).message });
        if (failed) broadcast({ type: 'satellite:capture', capture: failed });
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    return db.getSatCapture(cap.id);
  },
);

app.delete<{ Params: { id: string } }>('/api/satellite/captures/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const cap = db.getSatCapture(id);
  if (!cap) return reply.code(404).send({ error: 'Captura no trobada' });
  const st = manager.status();
  if (cap.status === 'running' && st.mode === 'satellite' && st.config && 'captureId' in st.config && st.config.captureId === id) {
    await manager.setMode({ mode: 'idle' }); // stopActive marks it cancelled/done
    return db.getSatCapture(id);
  }
  if (cap.status === 'scheduled') {
    const c = db.updateSatCapture(id, { status: 'cancelled' });
    if (c) broadcast({ type: 'satellite:capture', capture: c });
    return c;
  }
  db.deleteSatCapture(id);
  return { ok: true };
});

app.get<{ Params: { id: string; '*': string } }>('/api/satellite/files/:id/*', async (req, reply) => {
  const cap = db.getSatCapture(Number(req.params.id));
  if (!cap) return reply.code(404).send({ error: 'Captura no trobada' });
  const file = normalize(resolve(cap.dir, req.params['*']));
  if (!file.startsWith(cap.dir + sep) || !existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: 'Fitxer no trobat' });
  const ext = file.split('.').pop()?.toLowerCase();
  reply.type(ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  return reply.send(createReadStream(file));
});

/**
 * Scheduler: launches scheduled captures 20 s before AOS (takes the dongle from whatever is running).
 * Overlapping passes: the highest elevation goes first; the other one is marked failed once its LOS passes.
 */
const schedulerTimer = setInterval(() => {
  const nowMs = Date.now();
  const scheduled = db.listSatCaptures().filter((c) => c.status === 'scheduled').sort((a, b) => b.maxElevationDeg - a.maxElevationDeg);
  for (const cap of scheduled) {
    if (cap.los <= nowMs) {
      const c = db.updateSatCapture(cap.id, { status: 'failed', log: 'El pas ha passat sense captura' });
      if (c) broadcast({ type: 'satellite:capture', capture: c });
      continue;
    }
    if (cap.aos - nowMs <= 20_000 && manager.status().mode !== 'satellite') {
      startCapture(cap).catch((e: Error) => {
        const c = db.updateSatCapture(cap.id, { status: 'failed', log: e.message });
        if (c) broadcast({ type: 'satellite:capture', capture: c });
      });
    }
  }
}, 5_000);
schedulerTimer.unref();

// ---------- lifecycle ----------

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Aturant (${reason})…`);
  try {
    await manager.shutdown();
    for (const c of clients) c.close();
    await app.close();
    db.close();
  } finally {
    killAllSync();
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  app.log.error(e);
  killAllSync();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  app.log.error(e);
});

await manager.detectTools();
await app.listen({ port: PORT, host: '127.0.0.1' });
void manager.probeDongle();
