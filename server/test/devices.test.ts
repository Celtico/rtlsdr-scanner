import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeviceDedup, deviceKey, parseRtl433Line, rtl433Args } from '../src/sdr/devices.js';
import { isLikelyOwn } from '../src/db.js';
import { DEFAULT_DEVICES } from '../src/types.js';

// Captured with: rtl_433 -f 433.92M -f 868.3M -H 30 -F json -M level -M time:iso -T 90
const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/rtl_433.jsonl'), 'utf8').split('\n').filter(Boolean);

describe('parseRtl433Line', () => {
  it('parses a real Somfy-RTS message', () => {
    const m = parseRtl433Line(FIXTURE[0]!);
    expect(m).not.toBeNull();
    expect(m!.model).toBe('Somfy-RTS');
    expect(m!.deviceId).toBe('10000001');
    expect(m!.channel).toBeNull();
    expect(m!.key).toBe('Somfy-RTS|10000001|');
    expect(m!.freqHz).toBe(433_535_000);
    expect(m!.rssi).toBeCloseTo(0.609);
    expect(m!.snr).toBeCloseTo(14.844);
    expect(m!.data).toEqual({ control: '? (14)', counter: 0, retransmission: 1 });
    expect(new Date(m!.ts).getHours()).toBe(10);
    expect(new Date(m!.ts).getSeconds()).toBe(33);
  });

  it('ignores non-JSON and JSON without model', () => {
    expect(parseRtl433Line('Found Rafael Micro R820T tuner')).toBeNull();
    expect(parseRtl433Line('{"time":"x"}')).toBeNull();
    expect(parseRtl433Line('')).toBeNull();
  });

  it('keeps channel in the key', () => {
    const m = parseRtl433Line('{"time":"2026-09-25T11:00:00","model":"Nexus-TH","id":42,"channel":2,"temperature_C":21.5,"humidity":55}');
    expect(m!.key).toBe('Nexus-TH|42|2');
    expect(deviceKey('Nexus-TH', '42', '2')).toBe(m!.key);
    expect(m!.data).toEqual({ temperature_C: 21.5, humidity: 55 });
  });
});

describe('DeviceDedup', () => {
  it('dedups the 4 fixture messages into one device with count 4 and history', () => {
    const d = new DeviceDedup();
    let news = 0;
    for (const line of FIXTURE) {
      const m = parseRtl433Line(line);
      if (!m) continue;
      const { isNew } = d.push(m);
      if (isNew) news++;
    }
    expect(news).toBe(1);
    expect(d.entries.size).toBe(1);
    const e = d.entries.get('Somfy-RTS|10000001|')!;
    expect(e.count).toBe(4);
    expect(e.history.length).toBe(4);
    expect(e.firstSeen).toBeLessThan(e.lastSeen);
    expect(e.rssi).toBeCloseTo(0.638);
    expect(e.freqHz).toBe(433_523_000);
  });

  it('separates devices by model, id and channel', () => {
    const d = new DeviceDedup();
    d.push(parseRtl433Line('{"model":"A","id":1,"channel":1}')!);
    d.push(parseRtl433Line('{"model":"A","id":1,"channel":2}')!);
    d.push(parseRtl433Line('{"model":"A","id":2}')!);
    d.push(parseRtl433Line('{"model":"B","id":1}')!);
    d.push(parseRtl433Line('{"model":"A","id":1,"channel":1}')!);
    expect(d.entries.size).toBe(4);
    expect(d.entries.get('A|1|1')!.count).toBe(2);
  });
});

describe('likelyOwn heuristic', () => {
  it('strong and stable RSSI with enough readings is "mine"', () => {
    expect(isLikelyOwn(4, 0.6, 0.02)).toBe(true);
    expect(isLikelyOwn(2, 0.6, 0.02)).toBe(false);
    expect(isLikelyOwn(10, -15, 1)).toBe(false);
    expect(isLikelyOwn(10, -3, 6)).toBe(false);
    expect(isLikelyOwn(10, null, null)).toBe(false);
  });
});

describe('rtl433Args', () => {
  it('hops between frequencies', () => {
    expect(rtl433Args(DEFAULT_DEVICES)).toEqual(['-f', '433920000', '-f', '868300000', '-H', '60', '-F', 'json', '-M', 'level', '-M', 'time:iso']);
    expect(rtl433Args({ freqsHz: [433_920_000], hopS: 60 })).not.toContain('-H');
  });
});
