// Shared types between server and web. Frequencies are always integer Hz.

export type Mode = 'idle' | 'survey' | 'devices' | 'adsb' | 'hunt' | 'satellite' | 'audio' | 'dab';

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

/**
 * Hunt mode: live RSSI several times per second from rtl_sdr raw IQ.
 * 'single': one frequency, bandwidth = sampleRate (250 kHz suits one LoRa channel).
 * 'eu868': the 8 LoRaWAN EU868 channels (867.1–868.5 MHz) in one 2.4 MHz window centred at 867.8 MHz.
 */
export interface HuntConfig {
  mode: 'single' | 'eu868';
  freqHz: number;
  gainDb: number;
  sampleRate: number;
}

/** LoRaWAN EU868 channel plan used by ChirpStack (8 channels, 125 kHz each). */
export const EU868_CHANNELS_HZ = [867_100_000, 867_300_000, 867_500_000, 867_700_000, 867_900_000, 868_100_000, 868_300_000, 868_500_000];
export const EU868_CENTER_HZ = 867_800_000;
export const EU868_SAMPLE_RATE = 2_400_000;

export interface HuntChannel {
  freqHz: number;
  /** Mean power of the 100 ms block in this channel (dBFS). */
  dbfs: number;
  /** Highest 10 ms sub-block in this channel (dBFS): catches LoRa bursts. */
  peakDbfs: number;
}

export interface HuntBurst {
  ts: number;
  freqHz: number;
  peakDbfs: number;
  /** dB above that channel's floor. */
  aboveFloorDb: number;
}

/** Satellite capture: SatDump live pipeline for one pass. */
export interface SatelliteConfig {
  captureId: number;
  satellite: string;
  freqHz: number;
  pipeline: string;
  gainDb: number;
  timeoutS: number;
}

/** Broadcast audio (FM band only): rtl_fm wide-band FM → 48 kHz mono PCM streamed to the browser. */
export interface AudioConfig {
  freqHz: number;
  gainDb: number | null;
}

/** DAB/DAB+ via welle-cli inside Docker, fed by rtl_tcp on the host. */
export interface DabConfig {
  /** Band III block, e.g. "10C". */
  channel: string;
  /** rtl_tcp gain in dB, or null for automatic. */
  gainDb: number | null;
}

export type ModeConfig =
  | { mode: 'idle' }
  | { mode: 'audio'; config: AudioConfig }
  | { mode: 'dab'; config: DabConfig }
  | { mode: 'survey'; config: SurveyConfig }
  | { mode: 'devices'; config: DevicesConfig }
  | { mode: 'adsb'; config: AdsbConfig }
  | { mode: 'hunt'; config: HuntConfig }
  | { mode: 'satellite'; config: SatelliteConfig };

export interface Status {
  mode: Mode;
  dongle: DongleInfo;
  scanId: number | null;
  startedAt: number | null;
  config: SurveyConfig | DevicesConfig | AdsbConfig | HuntConfig | SatelliteConfig | AudioConfig | DabConfig | null;
  lastError: { code: SdrErrorCode; message: string; at: number } | null;
  counters: { sweeps: number; signals: number; devices: number; planes: number };
  tools: Record<'rtl_test' | 'rtl_power' | 'rtl_433' | 'rtl_adsb' | 'rtl_sdr' | 'rtl_fm' | 'rtl_tcp' | 'satdump' | 'docker', boolean>;
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
  /** Heuristic: strong and stable RSSI => probably the user's own device (overridden by `owner`). */
  likelyOwn: boolean;
  /** Manual override of the ownership heuristic. */
  owner: 'own' | 'other' | null;
  /** Manual bearing (degrees from north) found with a directional antenna; null = unknown direction. */
  bearingDeg: number | null;
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
  /** Country of registration from the ICAO 24-bit address block. */
  country: string | null;
}

/** One live RSSI sample from hunt mode. In 'eu868' mode dbfs/peakDbfs are the strongest channel's. */
export interface HuntLevel {
  ts: number;
  /** Mean power of the block in dBFS (0 = full scale). */
  dbfs: number;
  /** Highest 10 ms sub-block power in dBFS, catches short bursts. */
  peakDbfs: number;
  /** Per-channel levels (eu868 mode only). */
  channels?: HuntChannel[];
  /** Channel with the highest peak in this block (eu868 mode only). */
  strongestHz?: number;
}

export type ScanKind = 'survey' | 'devices' | 'adsb' | 'hunt' | 'satellite' | 'audio' | 'dab';

export interface SatInfo {
  /** Key used in configs and TLE cache, e.g. "NOAA 19". */
  name: string;
  catnr: number;
  freqHz: number;
  pipeline: string;
  kind: 'APT' | 'LRPT';
  note: string | null;
}

export interface SatPass {
  id: string;
  satellite: string;
  aos: number;
  los: number;
  maxElevationDeg: number;
  maxElevationAt: number;
  aosAzimuthDeg: number;
  losAzimuthDeg: number;
  durationS: number;
}

export type SatCaptureStatus = 'scheduled' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SatCapture {
  id: number;
  satellite: string;
  aos: number;
  los: number;
  maxElevationDeg: number;
  freqHz: number;
  pipeline: string;
  gainDb: number;
  status: SatCaptureStatus;
  dir: string;
  images: string[];
  log: string | null;
  createdAt: number;
}

export interface Scan {
  id: number;
  kind: ScanKind;
  startedAt: number;
  endedAt: number | null;
  config: SurveyConfig | DevicesConfig | AdsbConfig | HuntConfig | SatelliteConfig | AudioConfig | DabConfig;
  /** Per-kind result summary written when the scan ends (hunt: { maxDbfs, maxAt, samples }). */
  summary: Record<string, unknown> | null;
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
  | { type: 'hunt:level'; level: HuntLevel; maxDbfs: number; maxAt: number | null }
  | { type: 'hunt:burst'; burst: HuntBurst }
  | { type: 'satellite:capture'; capture: SatCapture }
  | { type: 'error'; code: SdrErrorCode; message: string }
  | { type: 'log'; line: string };

export const DEFAULT_SURVEY: SurveyConfig = {
  fromHz: 24_000_000,
  toHz: 1_700_000_000,
  // rtl_power makes one 1-bin hop per MHz with a 1 MHz step (1676 hops, ~73 s/pass); any step <= 500 kHz
  // uses full 2.8 MHz hops (599 hops, ~23 s/pass). Measured on an RTL-SDR Blog V3.
  stepHz: 100_000,
  gainDb: 40,
  intervalS: 10,
  thresholdDb: 10,
};

export const DEFAULT_DEVICES: DevicesConfig = {
  freqsHz: [433_920_000, 868_300_000],
  hopS: 60,
};

export const DEFAULT_ADSB: AdsbConfig = { gainDb: null };

export const AUDIO_SAMPLE_RATE = 48_000;
/** Only broadcast radio may be listened to (see CLAUDE.md): the FM band. */
export const FM_BAND = { fromHz: 87_500_000, toHz: 108_000_000 };

/** DAB band III blocks (centre frequency in Hz). */
export const DAB_CHANNELS: { name: string; freqHz: number }[] = [
  ['5A', 174.928], ['5B', 176.64], ['5C', 178.352], ['5D', 180.064], ['6A', 181.936], ['6B', 183.648], ['6C', 185.36], ['6D', 187.072],
  ['7A', 188.928], ['7B', 190.64], ['7C', 192.352], ['7D', 194.064], ['8A', 195.936], ['8B', 197.648], ['8C', 199.36], ['8D', 201.072],
  ['9A', 202.928], ['9B', 204.64], ['9C', 206.352], ['9D', 208.064], ['10A', 209.936], ['10B', 211.648], ['10C', 213.36], ['10D', 215.072],
  ['11A', 216.928], ['11B', 218.64], ['11C', 220.352], ['11D', 222.064], ['12A', 223.936], ['12B', 225.648], ['12C', 227.36], ['12D', 229.072],
  ['13A', 230.784], ['13B', 232.496], ['13C', 234.208], ['13D', 235.776], ['13E', 237.488], ['13F', 239.2],
].map(([name, mhz]) => ({ name: name as string, freqHz: Math.round((mhz as number) * 1e6) }));

/** Nearest DAB block for a frequency inside band III (±0.9 MHz), else null. */
export function dabChannelFor(freqHz: number): string | null {
  let best: { name: string; d: number } | null = null;
  for (const c of DAB_CHANNELS) {
    const d = Math.abs(c.freqHz - freqHz);
    if (d <= 900_000 && (!best || d < best.d)) best = { name: c.name, d };
  }
  return best?.name ?? null;
}

export const DEFAULT_DAB: DabConfig = { channel: '10C', gainDb: null };
/** rtl_tcp port on the host and welle-cli web port published by the container. */
export const RTL_TCP_PORT = 1234;
export const DAB_WEB_PORT = 7979;
export const DAB_IMAGE = 'rtlsdr-decoders';
export const DAB_CONTAINER = 'sdr-dab';

export const DEFAULT_HUNT: HuntConfig = { mode: 'eu868', freqHz: EU868_CENTER_HZ, gainDb: 29.7, sampleRate: EU868_SAMPLE_RATE };

/** Home position for the radar view (Lleida). */
export const DEFAULT_HOME = { lat: 41.62, lon: 0.62 };
