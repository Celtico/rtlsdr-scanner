import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crcOk, decodeAltitude, decodeCallsign, decodeCpr, decodePosition, decodeVelocity, parseAdsbLine, PlaneTracker } from '../src/sdr/adsb.js';

// Captured with: rtl_adsb (60 s). Most frames are noise; the CRC check must reject them.
const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/rtl_adsb.txt'), 'utf8').split('\n').filter(Boolean);

// Reference frames from "The 1090MHz Riddle" (J. Sun), CRC-valid.
const CALLSIGN_FRAME = '8d4840d6202cc371c32ce0576098'; // KLM1023
const POS_EVEN = '8d40621d58c382d690c8ac2863a7';
const POS_ODD = '8d40621d58c386435cc412692ad6';
const VEL_FRAME = '8d485020994409940838175b284f';

describe('parseAdsbLine', () => {
  it('accepts rtl_adsb long frames of DF17/18 only', () => {
    expect(parseAdsbLine(`*${CALLSIGN_FRAME};`)).toBe(CALLSIGN_FRAME);
    expect(parseAdsbLine('*5d4840d6202cc3;')).toBeNull();
    expect(parseAdsbLine('')).toBeNull();
    const all = FIXTURE.map(parseAdsbLine);
    expect(all.every((h) => h === null || h.length === 28)).toBe(true);
  });
});

describe('crcOk', () => {
  it('accepts reference frames and rejects the noisy fixture frames', () => {
    expect(crcOk(CALLSIGN_FRAME)).toBe(true);
    expect(crcOk(POS_EVEN)).toBe(true);
    expect(crcOk(VEL_FRAME)).toBe(true);
    expect(crcOk(CALLSIGN_FRAME.replace(/^8d/, '8e'))).toBe(false);
    const valid = FIXTURE.map(parseAdsbLine).filter((h): h is string => !!h).filter(crcOk);
    // 60 s indoors in Lleida with the stock antenna: at most a handful of real frames.
    expect(valid.length).toBeLessThan(FIXTURE.length / 2);
  });
});

describe('decoders', () => {
  it('callsign', () => {
    expect(decodeCallsign(CALLSIGN_FRAME.slice(8, 22))).toBe('KLM1023');
  });
  it('altitude', () => {
    expect(decodeAltitude(POS_EVEN.slice(8, 22))).toBe(38000);
  });
  it('global CPR position', () => {
    // Reference result assumes the even frame is the most recent one.
    const even = decodeCpr(POS_EVEN.slice(8, 22), 2000);
    const odd = decodeCpr(POS_ODD.slice(8, 22), 1000);
    expect(even.odd).toBe(false);
    expect(odd.odd).toBe(true);
    const pos = decodePosition(even, odd);
    expect(pos).not.toBeNull();
    expect(pos!.lat).toBeCloseTo(52.2572, 3);
    expect(pos!.lon).toBeCloseTo(3.91937, 3);
  });
  it('velocity', () => {
    const v = decodeVelocity(VEL_FRAME.slice(8, 22));
    expect(v).not.toBeNull();
    expect(v!.speedKt).toBe(159);
    expect(v!.headingDeg).toBe(183);
    expect(v!.verticalRateFpm).toBe(-832);
  });
});

describe('PlaneTracker', () => {
  it('accumulates callsign, altitude, position and velocity per ICAO', () => {
    const t = new PlaneTracker();
    const r1 = t.push(CALLSIGN_FRAME, 1000);
    expect(r1?.isNew).toBe(true);
    expect(r1?.plane.callsign).toBe('KLM1023');
    t.push(POS_ODD, 2000);
    const r3 = t.push(POS_EVEN, 3000);
    expect(r3?.plane.icao).toBe('40621d');
    expect(r3?.plane.altitudeFt).toBe(38000);
    expect(r3?.plane.lat).toBeCloseTo(52.2572, 3);
    const r4 = t.push(VEL_FRAME, 4000);
    expect(r4?.plane.speedKt).toBe(159);
    expect(t.planes.size).toBe(3);
    expect(t.push('8e4840d6202cc371c32ce0576098', 5000)).toBeNull();
  });
});
