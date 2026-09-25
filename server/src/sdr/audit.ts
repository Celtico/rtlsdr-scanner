/**
 * Home radio exposure audit: classifies what a neighbour with the same dongle can learn from each of
 * the user's own devices. Uses only what rtl_433 already decodes; never inspects third parties' traffic.
 */

export type Exposure = 'plain' | 'id-only' | 'rolling';

export interface AuditVerdict {
  exposure: Exposure;
  /** UI label. */
  label: string;
  /** What is readable. */
  readable: string[];
  /** Fixed identifier that allows presence tracking. */
  trackableId: boolean;
  /** Recommendation and priority. */
  priority: 'alta' | 'mitjana' | 'baixa';
  recommendation: string;
}

/** Protocols with rolling codes or challenge/response (content readable, but not replayable). */
const ROLLING = /Somfy-RTS|KeeLoq|Hormann|Nice-Flor|Came-TOP|Marantec|Kia|Ford|Toyota|Honda|Subaru|Tesla|Nissan|Hyundai|Chevrolet|Renault|Schrader-SMD3MA4|Somfy-IOHC|Abarth/i;
/** Fixed-code remotes: anyone can record and replay the exact same frame. */
const FIXED_REMOTE = /Generic-Remote|EV1527|PT2262|Smoke-GS558|Nexa|Proove|Kerui|Cardin|Chamberlain|SimpliSafe|Visonic|Interlogix|DSC-Security|Honeywell-Security|Bresser-Remote|X10|Silvercrest|Elro|Blyss|Kaku|Waveman|RFXcom/i;
/** Presence / identity beacons: no sensitive content but a fixed id that follows the owner around. */
const BEACON = /TPMS|Tire|Wheel|Bicycle|GT-TMBBQ|Hyundai-TPMS|Toyota-TPMS/i;

const SENSOR_FIELDS: Record<string, string> = {
  temperature_C: 'temperatura', temperature_F: 'temperatura', humidity: 'humitat', pressure_hPa: 'pressió',
  wind_avg_km_h: 'vent', rain_mm: 'pluja', battery_ok: 'estat de bateria', battery_V: 'bateria', power_W: 'consum elèctric',
  energy_kWh: 'energia', moisture: 'humitat del sòl', light_lux: 'llum', co2_ppm: 'CO₂', motion: 'moviment',
  contact_open: 'porta/finestra oberta', alarm: 'alarma', tamper: 'manipulació', state: 'estat', event: 'esdeveniment',
  button: 'botó premut', cmd: 'ordre', control: 'ordre', code: 'codi', tristate: 'codi', consumption: 'consum',
  depth_cm: 'nivell', pressure_PSI: 'pressió de pneumàtic', pressure_bar: 'pressió de pneumàtic',
};

export function classifyDevice(model: string, deviceId: string | null, data: Record<string, unknown>): AuditVerdict {
  const readable = Object.keys(data).filter((k) => k in SENSOR_FIELDS).map((k) => SENSOR_FIELDS[k]!);
  const uniq = [...new Set(readable)];
  const trackableId = deviceId !== null && deviceId !== '';

  if (ROLLING.test(model)) {
    return {
      exposure: 'rolling', label: 'Codi variable',
      readable: uniq.length ? uniq : ['ordre (no reproduïble)'], trackableId,
      priority: 'baixa',
      recommendation: 'Protocol amb codi variable: un veí pot veure que hi ha activitat i quin comandament és, però no pot repetir l’ordre. Res a canviar.',
    };
  }
  if (BEACON.test(model)) {
    return {
      exposure: 'id-only', label: 'Identificable per ID',
      readable: uniq, trackableId: true,
      priority: 'mitjana',
      recommendation: 'Emet un identificador fix que permet reconèixer el vehicle o l’objecte cada cop que passa. No es pot canviar; tingues-ho present si t’importa el seguiment.',
    };
  }
  if (FIXED_REMOTE.test(model) || 'tristate' in data || 'code' in data || 'cmd' in data) {
    return {
      exposure: 'plain', label: 'Exposat en clar',
      readable: uniq.length ? uniq : ['codi fix'], trackableId,
      priority: 'alta',
      recommendation: 'Comandament de codi fix: qualsevol pot gravar la trama i repetir-la (obrir la porta, activar l’endoll). Si controla un accés, substitueix-lo per un sistema amb codi variable (KeeLoq, Somfy RTS/io) o xifratge.',
    };
  }
  return {
    exposure: 'plain', label: 'Exposat en clar',
    readable: uniq.length ? uniq : ['dades del sensor'], trackableId,
    priority: uniq.some((r) => /porta|moviment|alarma|manipulació/.test(r)) ? 'alta' : 'mitjana',
    recommendation: uniq.some((r) => /porta|moviment|alarma|manipulació/.test(r))
      ? 'Sensor d’alarma o presència sense xifrar: un veí sap quan s’obre una porta o hi ha moviment. Canvia’l per un sistema d’alarma xifrat (Z-Wave S2, Zigbee 3.0, 868 MHz propietari amb xifratge).'
      : 'Sensor que emet les lectures en clar amb un ID fix. No revela res crític, però permet saber que és a casa teva. Si et molesta, opta per sensors Zigbee/Thread (xifrats).',
  };
}

/** Hour-of-day activity histogram → which hours reveal a routine (activity clearly above the daily mean). */
export function routineHours(byHour: readonly number[]): number[] {
  const total = byHour.reduce((a, b) => a + b, 0);
  if (total < 12) return [];
  const mean = total / 24;
  return byHour.map((n, h) => (n >= mean * 2 && n >= 3 ? h : -1)).filter((h) => h >= 0);
}
