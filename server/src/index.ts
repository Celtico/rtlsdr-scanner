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
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { normalize, sep } from 'node:path';
import {
  DEFAULT_ADSB, DEFAULT_DEVICES, DEFAULT_HOME, DEFAULT_HUNT, DEFAULT_SURVEY,
  type AdsbConfig, type DevicesConfig, type HuntConfig, type ModeConfig, type SatCapture, type SurveyConfig, type WsMessage,
} from './types.js';

const PORT = Number(process.env.PORT ?? 4000);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.SDR_DB ?? resolve(ROOT, 'data', 'sdr.db');

const SAT_DIR = process.env.SDR_SAT_DIR ?? resolve(ROOT, 'data', 'satellite');
const TLE_PATH = resolve(ROOT, 'data', 'tle.json');

const db = new Db(DB_PATH);
db.closeDanglingScans();
db.failRunningSatCaptures();
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
