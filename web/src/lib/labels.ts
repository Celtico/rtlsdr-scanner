import type { Mode } from '@shared/types';

export const MODE_LABEL: Record<Mode, string> = {
  idle: 'Inactiu',
  survey: 'Escombrat',
  devices: 'Dispositius',
  adsb: 'ADS-B',
  hunt: 'Hunt',
  satellite: 'Satèl·lit',
  audio: 'Ràdio FM',
};
