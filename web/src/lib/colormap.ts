// Shared by the 2D waterfall and the 3D landscape, so both read the same way.

// Colour LUT: dark → blue → cyan → yellow → red → white.
const STOPS: [number, [number, number, number]][] = [
  [0, [8, 10, 30]], [0.2, [20, 40, 140]], [0.4, [0, 170, 200]], [0.6, [230, 220, 40]], [0.8, [235, 70, 20]], [1, [255, 255, 255]],
];

/** 256 RGB triplets (0–255). */
export const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let a = STOPS[0]!;
  let b = STOPS[STOPS.length - 1]!;
  for (let s = 0; s < STOPS.length - 1; s++) {
    if (t >= STOPS[s]![0] && t <= STOPS[s + 1]![0]) { a = STOPS[s]!; b = STOPS[s + 1]!; break; }
  }
  const f = (t - a[0]) / (b[0] - a[0] || 1);
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = a[1][c]! + (b[1][c]! - a[1][c]!) * f;
}

/** Max-pool a sweep into `cols` columns of `group` bins each (NaN where there is no data). */
export function downsample(dbs: readonly number[], group: number, cols: number): Float32Array {
  const out = new Float32Array(cols).fill(NaN);
  for (let c = 0; c < cols; c++) {
    let v = -Infinity;
    const end = Math.min(dbs.length, (c + 1) * group);
    for (let i = c * group; i < end; i++) {
      const d = dbs[i]!;
      if (d > v) v = d;
    }
    out[c] = Number.isFinite(v) ? v : NaN;
  }
  return out;
}

/** dB range that keeps the noise floor dark and the strongest signals near the top of the scale. */
export function displayRange(rows: readonly Float32Array[]): { lo: number; hi: number } {
  const all: number[] = [];
  for (const r of rows.slice(-40)) for (let i = 0; i < r.length; i += 3) if (Number.isFinite(r[i]!)) all.push(r[i]!);
  if (!all.length) return { lo: -60, hi: 0 };
  all.sort((a, b) => a - b);
  const lo = all[Math.floor(all.length * 0.05)]!;
  const hi = all[Math.floor(all.length * 0.995)]!;
  return { lo, hi: hi - lo < 10 ? lo + 10 : hi };
}
