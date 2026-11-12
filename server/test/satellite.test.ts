import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listImages, loadTles, parseTleList, predictPasses, satdumpArgs, SATELLITES, skyName, skyTracks, TLE_MAX_AGE_MS } from '../src/sdr/satellite.js';

// TLEs fetched from Celestrak on 2026-09-25.
const NOAA19: [string, string] = [
  '1 33591U 09005A   26267.85938994  .00000016  00000+0  32435-4 0  9990',
  '2 33591  98.9433 338.7612 0014787 107.5531 252.7258 14.13486849908565',
];
const LLEIDA = { lat: 41.62, lon: 0.62 };
const EPOCH = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('predictPasses', () => {
  it('finds several NOAA 19 passes over Lleida in 24 h with sane geometry', () => {
    const passes = predictPasses('NOAA 19', NOAA19, LLEIDA, EPOCH, 24, 10);
    // A sun-synchronous LEO satellite passes a mid-latitude site 4–8 times a day above 10°.
    expect(passes.length).toBeGreaterThanOrEqual(3);
    expect(passes.length).toBeLessThanOrEqual(10);
    for (const p of passes) {
      expect(p.aos).toBeGreaterThanOrEqual(EPOCH);
      expect(p.los).toBeGreaterThan(p.aos);
      expect(p.durationS).toBeGreaterThan(120);
      expect(p.durationS).toBeLessThan(20 * 60);
      expect(p.maxElevationDeg).toBeGreaterThanOrEqual(10);
      expect(p.maxElevationDeg).toBeLessThanOrEqual(90);
      expect(p.maxElevationAt).toBeGreaterThanOrEqual(p.aos);
      expect(p.maxElevationAt).toBeLessThanOrEqual(p.los);
      expect(p.aosAzimuthDeg).toBeGreaterThanOrEqual(0);
      expect(p.aosAzimuthDeg).toBeLessThan(360);
    }
    // Sorted and non-overlapping.
    for (let i = 1; i < passes.length; i++) expect(passes[i]!.aos).toBeGreaterThan(passes[i - 1]!.los);
  });

  it('a polar orbiter passes roughly every ~100 min while visible', () => {
    const passes = predictPasses('NOAA 19', NOAA19, LLEIDA, EPOCH, 24, 0);
    const gaps = passes.slice(1).map((p, i) => (p.aos - passes[i]!.los) / 60_000);
    // consecutive visible passes are ~85–105 min apart (one orbit) or many hours apart (other side of the day)
    expect(gaps.some((g) => g > 80 && g < 110)).toBe(true);
  });
});

describe('loadTles', () => {
  it('uses the cache when fresh and refetches per satellite when stale', async () => {
    const dir = join(tmpdir(), `tle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'tle.json');
    const fresh = { fetchedAt: EPOCH, tles: Object.fromEntries(SATELLITES.map((s) => [s.name, NOAA19])) };
    writeFileSync(path, JSON.stringify(fresh));
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls++;
      const catnr = String(url).match(/CATNR=(\d+)/)?.[1];
      const sat = SATELLITES.find((s) => String(s.catnr) === catnr)!;
      return new Response(`${sat.name}\n${NOAA19[0]}\n${NOAA19[1]}\n`);
    }) as typeof fetch;
    const cached = await loadTles(path, fetchImpl, EPOCH + 1000);
    expect(calls).toBe(0);
    expect(cached.fetchedAt).toBe(EPOCH);
    const refreshed = await loadTles(path, fetchImpl, EPOCH + TLE_MAX_AGE_MS + 1);
    expect(calls).toBe(SATELLITES.length);
    expect(refreshed.fetchedAt).toBe(EPOCH + TLE_MAX_AGE_MS + 1);
    expect(refreshed.tles['NOAA 19']).toEqual(NOAA19);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('satdump integration helpers', () => {
  it('builds the live command', () => {
    const args = satdumpArgs({ captureId: 1, satellite: 'NOAA 19', freqHz: 137_100_000, pipeline: 'noaa_apt', gainDb: 40.2, timeoutS: 600 }, '/tmp/x');
    expect(args.slice(0, 3)).toEqual(['live', 'noaa_apt', '/tmp/x']);
    expect(args).toContain('--source');
    expect(args[args.indexOf('--frequency') + 1]).toBe('137100000');
    expect(args[args.indexOf('--timeout') + 1]).toBe('600');
  });

  it('lists images recursively, newest first', () => {
    const dir = join(tmpdir(), `sat-${Date.now()}`);
    mkdirSync(join(dir, 'MSU-MR'), { recursive: true });
    writeFileSync(join(dir, 'a.png'), 'x');
    writeFileSync(join(dir, 'MSU-MR', 'b.jpg'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const imgs = listImages(dir);
    expect(imgs.sort()).toEqual(['MSU-MR/b.jpg', 'a.png']);
    expect(listImages(join(dir, 'missing'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sky view', () => {
  it('parses Celestrak three-line lists and shortens names', () => {
    const list = parseTleList(`GPS BIIR-2  (PRN 13)    \n${NOAA19[0]}\n${NOAA19[1]}\nISS (ZARYA)\n${NOAA19[0]}\n${NOAA19[1]}\n`);
    expect(list.map((t) => skyName(t.name))).toEqual(['GPS 13', 'ISS']);
    expect(list[0]!.tle).toEqual(NOAA19);
  });

  it('returns a track only while the satellite is above the horizon', () => {
    const pass = predictPasses('NOAA 19', NOAA19, LLEIDA, EPOCH, 24, 20)[0]!;
    const sat = [{ name: 'NOAA 19', group: 'weather' as const, freqHz: 137_100_000, tle: NOAA19 }];
    const during = skyTracks(sat, LLEIDA, pass.aos, pass.los);
    expect(during).toHaveLength(1);
    const top = Math.max(...during[0]!.track.map((p) => p[2]));
    expect(Math.abs(top - pass.maxElevationDeg)).toBeLessThan(1.5);
    // Twenty minutes after it sets it is on the other side of the Earth.
    expect(skyTracks(sat, LLEIDA, pass.los + 20 * 60_000, pass.los + 25 * 60_000)).toHaveLength(0);
  });
});
