export function formatMHz(hz: number, digits = 3): string {
  return `${(hz / 1e6).toFixed(digits)} MHz`;
}

export function formatHzShort(hz: number): string {
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(hz % 1e9 === 0 ? 0 : 2)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(hz % 1e6 === 0 ? 0 : 3).replace(/\.?0+$/, '')} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(hz % 1e3 === 0 ? 0 : 2).replace(/\.?0+$/, '')} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function formatWidth(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  return `${Math.round(hz / 1e3)} kHz`;
}

export function formatDb(db: number | null | undefined, digits = 1): string {
  return db == null ? '—' : `${db.toFixed(digits)} dB`;
}

export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'ara mateix';
  if (s < 60) return `fa ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `fa ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `fa ${h} h`;
  return `fa ${Math.round(h / 24)} dies`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('ca-ES', { dateStyle: 'short', timeStyle: 'medium' });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Human labels for common rtl_433 fields. */
const FIELD_LABELS: Record<string, { label: string; unit?: string }> = {
  temperature_C: { label: 'Temperatura', unit: '°C' },
  temperature_F: { label: 'Temperatura', unit: '°F' },
  temperature_1_C: { label: 'Temperatura 1', unit: '°C' },
  temperature_2_C: { label: 'Temperatura 2', unit: '°C' },
  humidity: { label: 'Humitat', unit: '%' },
  battery_ok: { label: 'Bateria' },
  battery_V: { label: 'Bateria', unit: 'V' },
  battery_mV: { label: 'Bateria', unit: 'mV' },
  pressure_hPa: { label: 'Pressió', unit: 'hPa' },
  pressure_kPa: { label: 'Pressió', unit: 'kPa' },
  wind_avg_km_h: { label: 'Vent mitjà', unit: 'km/h' },
  wind_max_km_h: { label: 'Ratxa', unit: 'km/h' },
  wind_dir_deg: { label: 'Direcció vent', unit: '°' },
  rain_mm: { label: 'Pluja', unit: 'mm' },
  rain_mm_h: { label: 'Pluja', unit: 'mm/h' },
  uv: { label: 'UV' },
  light_lux: { label: 'Llum', unit: 'lx' },
  moisture: { label: 'Humitat sòl', unit: '%' },
  power_W: { label: 'Potència', unit: 'W' },
  energy_kWh: { label: 'Energia', unit: 'kWh' },
  consumption: { label: 'Consum' },
  state: { label: 'Estat' },
  event: { label: 'Esdeveniment' },
  button: { label: 'Botó' },
  control: { label: 'Ordre' },
  counter: { label: 'Comptador' },
  code: { label: 'Codi' },
  retransmission: { label: 'Retransmissió' },
  type: { label: 'Tipus' },
  subtype: { label: 'Subtipus' },
  cmd: { label: 'Ordre' },
  learn: { label: 'Aprenentatge' },
  tamper: { label: 'Manipulació' },
  motion: { label: 'Moviment' },
  contact_open: { label: 'Obert' },
  alarm: { label: 'Alarma' },
  co2_ppm: { label: 'CO₂', unit: 'ppm' },
  pm2_5_ug_m3: { label: 'PM2.5', unit: 'µg/m³' },
  pm10_ug_m3: { label: 'PM10', unit: 'µg/m³' },
  depth_cm: { label: 'Profunditat', unit: 'cm' },
  distance_m: { label: 'Distància', unit: 'm' },
  pressure_PSI: { label: 'Pressió pneumàtic', unit: 'PSI' },
  pressure_bar: { label: 'Pressió pneumàtic', unit: 'bar' },
  status: { label: 'Estat' },
  flags: { label: 'Flags' },
  mic: { label: 'Integritat' },
};

export interface FormattedField { key: string; label: string; value: string; numeric: number | null }

export function formatReading(data: Record<string, unknown>): FormattedField[] {
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([key, v]) => {
      const meta = FIELD_LABELS[key];
      const label = meta?.label ?? key.replace(/_/g, ' ');
      let value: string;
      let numeric: number | null = null;
      if (key === 'battery_ok') {
        value = v === 1 || v === true ? 'OK' : 'Baixa';
      } else if (typeof v === 'number') {
        numeric = v;
        value = `${Number.isInteger(v) ? v : v.toFixed(2).replace(/\.?0+$/, '')}${meta?.unit ? ` ${meta.unit}` : ''}`;
      } else if (typeof v === 'boolean') {
        value = v ? 'Sí' : 'No';
      } else {
        value = String(v);
      }
      return { key, label, value, numeric };
    });
}

/** Numeric fields worth charting over time, in preference order. */
export const CHARTABLE_FIELDS = ['temperature_C', 'humidity', 'pressure_hPa', 'wind_avg_km_h', 'rain_mm', 'battery_V', 'power_W', 'light_lux', 'moisture', 'co2_ppm'];

export function fieldLabel(key: string): string {
  const meta = FIELD_LABELS[key];
  return meta ? `${meta.label}${meta.unit ? ` (${meta.unit})` : ''}` : key;
}
