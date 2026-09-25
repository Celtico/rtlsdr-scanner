import { FM_BAND, dabChannelFor, type Signal } from '@shared/types';

export function isFmBroadcast(s: Signal): boolean {
  return s.freqHz >= FM_BAND.fromHz && s.freqHz <= FM_BAND.toHz;
}

/** Signals that carry audio/video we cannot decode here, with the reason. */
export function mediaNote(s: Signal): string | null {
  if (!s.band) return null;
  if (s.band.startsWith('TDT')) return 'Vídeo TDT (DVB-T): l’app no el descodifica. Cal un receptor DVB-T o VLC amb un driver de TV.';
  if (s.band.startsWith('DAB')) return `Ràdio digital DAB${dabChannelFor(s.freqHz) ? ` (bloc ${dabChannelFor(s.freqHz)})` : ''}: obre la secció DAB, que la descodifica amb welle-cli en Docker.`;
  if (s.band.startsWith('Ràdio AM')) return 'Ona mitjana: cal el mode de mostreig directe del V3; no disponible aquí.';
  return null;
}


/** Route to open for a signal we can decode elsewhere in the app (DAB → /dab?ch=). */
export function mediaRoute(s: Signal): string | null {
  if (s.band?.startsWith('DAB')) {
    const ch = dabChannelFor(s.freqHz);
    return ch ? `/dab?ch=${ch}` : '/dab';
  }
  return null;
}
