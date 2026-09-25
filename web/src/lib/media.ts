import { FM_BAND, type Signal } from '@shared/types';

export function isFmBroadcast(s: Signal): boolean {
  return s.freqHz >= FM_BAND.fromHz && s.freqHz <= FM_BAND.toHz;
}

/** Signals that carry audio/video we cannot decode here, with the reason. */
export function mediaNote(s: Signal): string | null {
  if (!s.band) return null;
  if (s.band.startsWith('TDT')) return 'Vídeo TDT (DVB-T): l’app no el descodifica. Cal un receptor DVB-T o VLC amb un driver de TV.';
  if (s.band.startsWith('DAB')) return 'Ràdio digital DAB: l’app no la descodifica. Prova welle.io amb el mateix dongle.';
  if (s.band.startsWith('Ràdio AM')) return 'Ona mitjana: cal el mode de mostreig directe del V3; no disponible aquí.';
  return null;
}

