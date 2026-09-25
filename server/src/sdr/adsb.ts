import type { AdsbConfig, Plane } from '../types.js';

// ---------- Mode S / ADS-B (DF17) decoding of rtl_adsb output ----------

/** rtl_adsb prints `*<hex>;` per frame. Returns the 28-char hex of extended squitter frames only. */
export function parseAdsbLine(line: string): string | null {
  const hex = line.trim().replace(/^\*/, '').replace(/;$/, '').toLowerCase();
  if (hex.length !== 28 || !/^[0-9a-f]+$/.test(hex)) return null;
  const df = parseInt(hex.slice(0, 2), 16) >> 3;
  if (df !== 17 && df !== 18) return null;
  return hex;
}

/** Mode S CRC-24 (generator 0xFFF409). Valid DF17 frames leave a zero remainder. */
export function crcOk(hex: string): boolean {
  const bytes = Buffer.from(hex, 'hex');
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0xfff409;
    }
    crc &= 0xffffff;
  }
  return crc === 0;
}

function bits(me: string): string {
  return BigInt('0x' + me).toString(2).padStart(56, '0');
}

const CALLSIGN_CHARS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';

export function decodeCallsign(me: string): string | null {
  const b = bits(me).slice(8);
  let s = '';
  for (let i = 0; i < 48; i += 6) s += CALLSIGN_CHARS[parseInt(b.slice(i, i + 6), 2)] ?? '#';
  const cs = s.replace(/[#\s]/g, '');
  return cs.length ? cs : null;
}

/** Barometric altitude in feet from the 12-bit field (Q bit = 25 ft). Gray-coded 100 ft altitudes are ignored. */
export function decodeAltitude(me: string): number | null {
  const b = bits(me);
  const alt = b.slice(8, 20);
  const q = alt[7];
  if (q !== '1') return null;
  const n = parseInt(alt.slice(0, 7) + alt.slice(8), 2);
  return n * 25 - 1000;
}

export interface CprFrame { odd: boolean; lat: number; lon: number; ts: number }

export function decodeCpr(me: string, ts: number): CprFrame {
  const b = bits(me);
  return {
    odd: b[21] === '1',
    lat: parseInt(b.slice(22, 39), 2) / 131072,
    lon: parseInt(b.slice(39, 56), 2) / 131072,
    ts,
  };
}

const NZ = 15;

function nl(lat: number): number {
  if (lat === 0) return 59;
  const a = Math.abs(lat);
  if (a === 87) return 2;
  if (a > 87) return 1;
  const x = 1 - Math.cos(Math.PI / (2 * NZ));
  const y = Math.cos((Math.PI / 180) * lat) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - x / y));
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Globally unambiguous CPR position from an even/odd pair (< 10 s apart). */
export function decodePosition(even: CprFrame, odd: CprFrame): { lat: number; lon: number } | null {
  if (Math.abs(even.ts - odd.ts) > 10_000) return null;
  const dLatE = 360 / 60;
  const dLatO = 360 / 59;
  const j = Math.floor(59 * even.lat - 60 * odd.lat + 0.5);
  let latE = dLatE * (mod(j, 60) + even.lat);
  let latO = dLatO * (mod(j, 59) + odd.lat);
  if (latE >= 270) latE -= 360;
  if (latO >= 270) latO -= 360;
  if (nl(latE) !== nl(latO)) return null;
  const useOdd = odd.ts > even.ts;
  const lat = useOdd ? latO : latE;
  const nlv = nl(lat);
  const ni = Math.max(nlv - (useOdd ? 1 : 0), 1);
  const dLon = 360 / ni;
  const m = Math.floor(even.lon * (nlv - 1) - odd.lon * nlv + 0.5);
  let lon = dLon * (mod(m, ni) + (useOdd ? odd.lon : even.lon));
  if (lon >= 180) lon -= 360;
  if (Math.abs(lat) > 90) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

export interface Velocity { speedKt: number; headingDeg: number; verticalRateFpm: number | null }

/** Airborne velocity (TC 19, subtypes 1 and 2: ground speed). */
export function decodeVelocity(me: string): Velocity | null {
  const b = bits(me);
  const st = parseInt(b.slice(5, 8), 2);
  if (st !== 1 && st !== 2) return null;
  const dew = b[13] === '1' ? -1 : 1;
  const vew = parseInt(b.slice(14, 24), 2);
  const dns = b[24] === '1' ? -1 : 1;
  const vns = parseInt(b.slice(25, 35), 2);
  if (vew === 0 || vns === 0) return null;
  const scale = st === 2 ? 4 : 1;
  const ew = dew * (vew - 1) * scale;
  const ns = dns * (vns - 1) * scale;
  const speed = Math.sqrt(ew * ew + ns * ns);
  let heading = (Math.atan2(ew, ns) * 180) / Math.PI;
  if (heading < 0) heading += 360;
  const svr = b[36] === '1' ? -1 : 1;
  const vr = parseInt(b.slice(37, 46), 2);
  const verticalRateFpm = vr === 0 ? null : svr * (vr - 1) * 64;
  return { speedKt: Math.round(speed), headingDeg: Math.round(heading), verticalRateFpm };
}

export interface PlaneState extends Plane { cprEven: CprFrame | null; cprOdd: CprFrame | null }

/** Accumulates DF17 frames per ICAO address. */
export class PlaneTracker {
  readonly planes = new Map<string, PlaneState>();

  /** Returns the updated plane (and whether it's new) or null if the frame was ignored. */
  push(hex: string, ts: number, checkCrc = true): { plane: PlaneState; isNew: boolean; changed: boolean } | null {
    if (checkCrc && !crcOk(hex)) return null;
    const icao = hex.slice(2, 8);
    const me = hex.slice(8, 22);
    const tc = parseInt(me.slice(0, 2), 16) >> 3;
    const isNew = !this.planes.has(icao);
    const p: PlaneState = this.planes.get(icao) ?? {
      icao, callsign: null, firstSeen: ts, lastSeen: ts, msgs: 0, altitudeFt: null, lat: null, lon: null,
      speedKt: null, headingDeg: null, verticalRateFpm: null, cprEven: null, cprOdd: null,
    };
    p.msgs += 1;
    p.lastSeen = ts;
    let changed = isNew;
    if (tc >= 1 && tc <= 4) {
      const cs = decodeCallsign(me);
      if (cs && cs !== p.callsign) { p.callsign = cs; changed = true; }
    } else if (tc >= 9 && tc <= 18) {
      const alt = decodeAltitude(me);
      if (alt !== null && alt !== p.altitudeFt) { p.altitudeFt = alt; changed = true; }
      const cpr = decodeCpr(me, ts);
      if (cpr.odd) p.cprOdd = cpr; else p.cprEven = cpr;
      if (p.cprEven && p.cprOdd) {
        const pos = decodePosition(p.cprEven, p.cprOdd);
        if (pos && (pos.lat !== p.lat || pos.lon !== p.lon)) { p.lat = pos.lat; p.lon = pos.lon; changed = true; }
      }
    } else if (tc === 19) {
      const v = decodeVelocity(me);
      if (v) {
        if (v.speedKt !== p.speedKt || v.headingDeg !== p.headingDeg) changed = true;
        p.speedKt = v.speedKt;
        p.headingDeg = v.headingDeg;
        p.verticalRateFpm = v.verticalRateFpm;
      }
    }
    this.planes.set(icao, p);
    return { plane: p, isNew, changed };
  }
}

export function toPlane(p: PlaneState): Plane {
  return {
    icao: p.icao, callsign: p.callsign, firstSeen: p.firstSeen, lastSeen: p.lastSeen, msgs: p.msgs,
    altitudeFt: p.altitudeFt, lat: p.lat, lon: p.lon, speedKt: p.speedKt, headingDeg: p.headingDeg,
    verticalRateFpm: p.verticalRateFpm,
  };
}

export function rtlAdsbArgs(c: AdsbConfig): string[] {
  const args: string[] = [];
  if (c.gainDb !== null) args.push('-g', String(c.gainDb));
  return args;
}
