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
import {
  DEFAULT_ADSB, DEFAULT_DEVICES, DEFAULT_SURVEY,
  type AdsbConfig, type DevicesConfig, type ModeConfig, type SurveyConfig, type WsMessage,
} from './types.js';

const PORT = Number(process.env.PORT ?? 4000);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.SDR_DB ?? resolve(ROOT, 'data', 'sdr.db');

const db = new Db(DB_PATH);
db.closeDanglingScans();
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
    default:
      throw Object.assign(new Error('mode ha de ser idle | survey | devices | adsb'), { statusCode: 400 });
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

app.patch<{ Params: { id: string }; Body: { alias?: string | null } }>('/api/devices/:id', async (req, reply) => {
  const id = Number(req.params.id);
  const alias = typeof req.body?.alias === 'string' ? req.body.alias.trim() || null : null;
  const device = db.setDeviceAlias(id, alias);
  if (!device) return reply.code(404).send({ error: 'Dispositiu no trobat' });
  broadcast({ type: 'device:update', device });
  return device;
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
