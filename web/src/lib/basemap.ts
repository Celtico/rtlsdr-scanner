import { destination } from '@/lib/geo';

/**
 * A street map of the area around home, stitched from OpenStreetMap's standard tiles and darkened to sit
 * under the radar. No key is needed, and it is a couple of dozen tiles per view, well within the tile
 * usage policy. Loading it tells the tile server roughly which area is being looked at, so the map can
 * be switched off; without a connection the radar simply keeps its plain ground.
 */

export const BASEMAP_ATTRIBUTION = '© OpenStreetMap contributors';

const TILE_PX = 256;
/** The stitched image is at most this many tiles across. */
const MAX_TILES = 6;
const MAX_ZOOM = 13;
/** Turns the light map into a dark one while keeping water blue and woods green. */
const DARKEN = 'invert(1) hue-rotate(180deg) saturate(0.55) brightness(0.7) contrast(1.1)';

/** Web Mercator, as fractions of the world: x from 180°W, y from the top. */
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;

export interface Basemap {
  canvas: HTMLCanvasElement;
  /** Texture coordinates of a place (v grows upwards, as three.js expects). */
  uv: (lat: number, lon: number) => [number, number];
}

function loadTile(z: number, x: number, y: number, signal: AbortSignal): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    signal.addEventListener('abort', () => { img.src = ''; resolve(null); }, { once: true });
    const n = 2 ** z;
    img.src = `https://tile.openstreetmap.org/${z}/${((x % n) + n) % n}/${y}.png`;
  });
}

/** The map covering a circle of `rangeKm` around home, or null when no tile could be loaded. */
export async function loadBasemap(home: { lat: number; lon: number }, rangeKm: number, signal: AbortSignal): Promise<Basemap | null> {
  const reach = rangeKm * 1.03;
  const west = mercX(destination(home.lat, home.lon, 270, reach).lon);
  const east = mercX(destination(home.lat, home.lon, 90, reach).lon);
  const north = mercY(destination(home.lat, home.lon, 0, reach).lat);
  const south = mercY(destination(home.lat, home.lon, 180, reach).lat);
  // Too close to the date line or a pole for this simple stitching.
  if (!(east > west) || !(south > north) || !Number.isFinite(north + south)) return null;

  let z = MAX_ZOOM;
  const tiles = (zoom: number) => {
    const n = 2 ** zoom;
    return { x0: Math.floor(west * n), x1: Math.floor(east * n), y0: Math.floor(north * n), y1: Math.floor(south * n) };
  };
  while (z > 1) {
    const t = tiles(z);
    if (t.x1 - t.x0 < MAX_TILES && t.y1 - t.y0 < MAX_TILES) break;
    z--;
  }
  const { x0, x1, y0, y1 } = tiles(z);
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  const n = 2 ** z;

  const canvas = document.createElement('canvas');
  canvas.width = nx * TILE_PX;
  canvas.height = ny * TILE_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0e1114';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.filter = DARKEN;

  const jobs: Promise<boolean>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (ty < 0 || ty >= n) continue;
      jobs.push(loadTile(z, tx, ty, signal).then((img) => {
        if (!img) return false;
        ctx.drawImage(img, (tx - x0) * TILE_PX, (ty - y0) * TILE_PX, TILE_PX, TILE_PX);
        return true;
      }));
    }
  }
  const loaded = await Promise.all(jobs);
  if (signal.aborted || !loaded.some(Boolean)) return null;

  return {
    canvas,
    uv: (lat, lon) => [(mercX(lon) * n - x0) / nx, 1 - (mercY(lat) * n - y0) / ny],
  };
}
