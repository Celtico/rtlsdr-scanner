/** Devices sit on RSSI rings between these fractions of the radius (strong = close to the centre). */
export const DEV_R_MIN = 0.12;
export const DEV_R_MAX = 0.55;
/** Neutral sector (degrees) where devices with unknown direction are drawn. */
export const UNKNOWN_SECTOR: [number, number] = [150, 210];

export function rssiToRadius(rssi: number | null): number {
  const r = rssi === null ? -25 : Math.max(-25, Math.min(0, rssi));
  return DEV_R_MIN + ((-r) / 25) * (DEV_R_MAX - DEV_R_MIN);
}

export function altitudeColor(ft: number | null): string {
  if (ft === null) return '#9aa4b2';
  if (ft < 5_000) return '#4ade80';
  if (ft < 15_000) return '#facc15';
  if (ft < 30_000) return '#fb923c';
  if (ft < 40_000) return '#f87171';
  return '#c084fc';
}

