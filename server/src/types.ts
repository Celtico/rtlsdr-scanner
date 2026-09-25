// Shared types between server and web. Frequencies are always integer Hz.

export type Mode = 'idle' | 'survey' | 'devices' | 'adsb';

export type DongleState = 'unknown' | 'connected' | 'in-use' | 'busy' | 'missing' | 'error';

export type SdrErrorCode = 'busy' | 'missing' | 'tool-missing' | 'exit' | 'unknown';

export interface DongleInfo {
  state: DongleState;
  name: string | null;
  tuner: string | null;
  message: string | null;
  checkedAt: number | null;
}

export interface SurveyConfig {
  fromHz: number;
  toHz: number;
  stepHz: number;
  gainDb: number;
  intervalS: number;
  thresholdDb: number;
}

export interface DevicesConfig {
  freqsHz: number[];
  hopS: number;
}

export interface AdsbConfig {
  gainDb: number | null;
}

export type ModeConfig =
  | { mode: 'idle' }
  | { mode: 'survey'; config: SurveyConfig }
  | { mode: 'devices'; config: DevicesConfig }
  | { mode: 'adsb'; config: AdsbConfig };

export interface Status {
  mode: Mode;
  dongle: DongleInfo;
  scanId: number | null;
  startedAt: number | null;
  config: SurveyConfig | DevicesConfig | AdsbConfig | null;
  lastError: { code: SdrErrorCode; message: string; at: number } | null;
  counters: { sweeps: number; signals: number; devices: number; planes: number };
  tools: Record<'rtl_test' | 'rtl_power' | 'rtl_433' | 'rtl_adsb', boolean>;
}

export interface Band {
  fromHz: number;
  toHz: number;
  name: string;
  /** Encrypted or private traffic: only "activity detected" is shown. */
  restricted?: boolean;
  /** Broadcast audio permitted (FM). */
  broadcast?: boolean;
}

export interface Sweep {
  scanId: number;
  ts: number;
  lowHz: number;
  /** Bin width. May be fractional: rtl_power fits the requested step to its FFT size. */
  stepHz: number;
  /** dB per bin, index i => lowHz + i * stepHz. */
  dbs: number[];
}

export interface Signal {
  id: string;
  scanId: number;
  freqHz: number;
  widthHz: number;
  peakDb: number;
  floorDb: number;
  excessDb: number;
  dutyPct: number;
  band: string | null;
  restricted: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface Device {
  id: number;
  key: string;
  model: string;
  deviceId: string | null;
  channel: string | null;
  freqHz: number | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  rssi: number | null;
  snr: number | null;
  rssiAvg: number | null;
  rssiStd: number | null;
  /** Heuristic: strong and stable RSSI => probably the user's own device. */
  likelyOwn: boolean;
  lastData: Record<string, unknown>;
  alias: string | null;
}

export interface Reading {
  id: number;
  deviceId: number;
  ts: number;
  rssi: number | null;
  snr: number | null;
  data: Record<string, unknown>;
}

export interface Plane {
  icao: string;
  callsign: string | null;
  firstSeen: number;
  lastSeen: number;
  msgs: number;
  altitudeFt: number | null;
  lat: number | null;
  lon: number | null;
  speedKt: number | null;
  headingDeg: number | null;
  verticalRateFpm: number | null;
}

export type ScanKind = 'survey' | 'devices' | 'adsb';

export interface Scan {
  id: number;
  kind: ScanKind;
  startedAt: number;
  endedAt: number | null;
  config: SurveyConfig | DevicesConfig | AdsbConfig;
  sweeps: number;
  signals: number;
  devices: number;
  planes: number;
}

export type WsMessage =
  | { type: 'status'; status: Status }
  | { type: 'survey:sweep'; sweep: Sweep }
  | { type: 'survey:signals'; scanId: number; signals: Signal[] }
  | { type: 'device:new'; device: Device }
  | { type: 'device:update'; device: Device }
  | { type: 'adsb:plane'; plane: Plane }
  | { type: 'error'; code: SdrErrorCode; message: string }
  | { type: 'log'; line: string };

export const DEFAULT_SURVEY: SurveyConfig = {
  fromHz: 24_000_000,
  toHz: 1_700_000_000,
  stepHz: 1_000_000,
  gainDb: 40,
  intervalS: 10,
  thresholdDb: 10,
};

export const DEFAULT_DEVICES: DevicesConfig = {
  freqsHz: [433_920_000, 868_300_000],
  hopS: 60,
};

export const DEFAULT_ADSB: AdsbConfig = { gainDb: null };
