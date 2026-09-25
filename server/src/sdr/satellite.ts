import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, propagate, radiansToDegrees, twoline2satrec, type SatRec } from 'satellite.js';
import type { SatelliteConfig, SatInfo, SatPass } from '../types.js';

/** Low-earth-orbit weather satellites we can receive at 137 MHz. Frequencies from the SatDump pipelines. */
export const SATELLITES: SatInfo[] = [
  { name: 'NOAA 15', catnr: 25338, freqHz: 137_620_000, pipeline: 'noaa_apt', kind: 'APT', note: 'APT analògic. NOAA anuncia la retirada dels POES; pot haver deixat d’emetre.' },
  { name: 'NOAA 19', catnr: 33591, freqHz: 137_100_000, pipeline: 'noaa_apt', kind: 'APT', note: 'APT analògic. NOAA anuncia la retirada dels POES; pot haver deixat d’emetre.' },
  { name: 'METEOR-M2 3', catnr: 57166, freqHz: 137_900_000, pipeline: 'meteor_m2-x_lrpt', kind: 'LRPT', note: 'LRPT digital a 72k. Sovint apagat sobre Europa; comprova l’estat a la comunitat.' },
  { name: 'METEOR-M2 4', catnr: 59051, freqHz: 137_100_000, pipeline: 'meteor_m2-x_lrpt', kind: 'LRPT', note: 'LRPT digital a 72k. Comparteix 137,1 MHz amb NOAA 19.' },
];

export const TLE_MAX_AGE_MS = 12 * 3600 * 1000;

export interface TleSet { fetchedAt: number; tles: Record<string, [string, string]> }

/** Loads the TLE cache or fetches fresh ones from Celestrak (one request per satellite by catalog number). */
export async function loadTles(cachePath: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<TleSet> {
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as TleSet;
      if (now - cached.fetchedAt < TLE_MAX_AGE_MS && SATELLITES.every((s) => cached.tles[s.name])) return cached;
    } catch { /* refetch */ }
  }
  const tles: Record<string, [string, string]> = {};
  for (const s of SATELLITES) {
    const res = await fetchImpl(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${s.catnr}&FORMAT=tle`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Celestrak ${res.status} per ${s.name}`);
    const lines = (await res.text()).split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const l1 = lines.find((l) => l.startsWith('1 '));
    const l2 = lines.find((l) => l.startsWith('2 '));
    if (!l1 || !l2) throw new Error(`TLE no vàlid per ${s.name}`);
    tles[s.name] = [l1, l2];
  }
  const set = { fetchedAt: now, tles };
  mkdirSync(join(cachePath, '..'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(set, null, 2));
  return set;
}

export interface Observer { lat: number; lon: number; altM?: number }

function lookAngles(satrec: SatRec, date: Date, obs: Observer): { elevation: number; azimuth: number } | null {
  const pv = propagate(satrec, date);
  if (!pv || typeof pv.position === 'boolean') return null;
  const gmst = gstime(date);
  const ecf = eciToEcf(pv.position, gmst);
  const la = ecfToLookAngles({ latitude: degreesToRadians(obs.lat), longitude: degreesToRadians(obs.lon), height: (obs.altM ?? 200) / 1000 }, ecf);
  return { elevation: radiansToDegrees(la.elevation), azimuth: (radiansToDegrees(la.azimuth) + 360) % 360 };
}

/**
 * Predicts passes above `minElevation` degrees in the next `hours`, stepping 20 s and refining AOS/LOS to ~1 s.
 */
export function predictPasses(name: string, tle: [string, string], obs: Observer, from: number, hours = 24, minElevation = 10): SatPass[] {
  const satrec = twoline2satrec(tle[0], tle[1]);
  const step = 20_000;
  const end = from + hours * 3600_000;
  const passes: SatPass[] = [];
  let t = from;
  let inPass = false;
  let aos = 0;
  let maxEl = -90;
  let maxAt = 0;
  let aosAz = 0;
  const refine = (a: number, b: number, wantAbove: boolean): number => {
    // binary search the crossing of the horizon between a (below/above) and b
    let lo = a;
    let hi = b;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const el = lookAngles(satrec, new Date(mid), obs)?.elevation ?? -90;
      if ((el > 0) === wantAbove) hi = mid; else lo = mid;
    }
    return Math.round((lo + hi) / 2);
  };
  while (t <= end) {
    const la = lookAngles(satrec, new Date(t), obs);
    if (!la) break;
    if (!inPass && la.elevation > 0) {
      inPass = true;
      aos = t === from ? t : refine(t - step, t, true);
      maxEl = la.elevation;
      maxAt = t;
      aosAz = la.azimuth;
    } else if (inPass && la.elevation > maxEl) {
      maxEl = la.elevation;
      maxAt = t;
    }
    if (inPass && la.elevation <= 0) {
      const los = refine(t - step, t, false);
      const losAz = lookAngles(satrec, new Date(los - 1000), obs)?.azimuth ?? la.azimuth;
      if (maxEl >= minElevation) {
        passes.push({
          id: `${name}@${aos}`, satellite: name, aos, los, maxElevationDeg: Math.round(maxEl * 10) / 10, maxElevationAt: maxAt,
          aosAzimuthDeg: Math.round(aosAz), losAzimuthDeg: Math.round(losAz), durationS: Math.round((los - aos) / 1000),
        });
      }
      inPass = false;
    }
    t += step;
  }
  return passes;
}

export function predictAll(tles: TleSet, obs: Observer, from = Date.now(), hours = 24, minElevation = 10): SatPass[] {
  return SATELLITES.flatMap((s) => {
    const tle = tles.tles[s.name];
    return tle ? predictPasses(s.name, tle, obs, from, hours, minElevation) : [];
  }).sort((a, b) => a.aos - b.aos);
}

/**
 * The Homebrew cask links /opt/homebrew/bin/satdump to the app bundle, but through the symlink SatDump
 * looks for its config in /usr/local/share and fails. Calling the bundle binary directly works.
 */
export const SATDUMP_CANDIDATES = [
  process.env.SATDUMP_BIN,
  '/Applications/SatDump.app/Contents/MacOS/satdump',
  '/opt/homebrew/opt/satdump/bin/satdump',
  '/usr/local/bin/satdump',
].filter((p): p is string => !!p);

export function findSatdump(): string | null {
  return SATDUMP_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** `satdump live <pipeline> <dir> --source rtlsdr ...`: decodes at the end of the timeout. */
export function satdumpArgs(c: SatelliteConfig, dir: string): string[] {
  return [
    'live', c.pipeline, dir,
    '--source', 'rtlsdr', '--samplerate', '1.024e6', '--frequency', String(c.freqHz), '--gain', String(c.gainDb),
    '--timeout', String(c.timeoutS), '--finish_processing',
  ];
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** Relative paths of all images under a capture directory, newest first. */
export function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: { rel: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (IMAGE_RE.test(e.name)) out.push({ rel: relative(dir, p), mtime: statSync(p).mtimeMs });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.rel);
}

export function satInfo(name: string): SatInfo | undefined {
  return SATELLITES.find((s) => s.name === name);
}
