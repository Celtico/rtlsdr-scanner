import type { Band } from '../types.js';

const M = 1_000_000;
const k = 1_000;

/** Known bands in Spain / EU, sorted by frequency. Shared with the web via /api/bands. */
export const BANDS: Band[] = [
  { fromHz: 500 * k, toHz: 1_700 * k, name: 'Ràdio AM (ona mitjana)', broadcast: true },
  { fromHz: 26.96 * M, toHz: 27.41 * M, name: 'CB 27 MHz' },
  { fromHz: 87.5 * M, toHz: 108 * M, name: 'Ràdio FM', broadcast: true },
  { fromHz: 108 * M, toHz: 118 * M, name: 'Radionavegació aèria (VOR/ILS)' },
  { fromHz: 118 * M, toHz: 137 * M, name: 'Banda aèria (veu AM)' },
  { fromHz: 137 * M, toHz: 138 * M, name: 'Satèl·lits meteorològics (NOAA/Meteor)' },
  { fromHz: 144 * M, toHz: 146 * M, name: 'Radioaficionats 2 m' },
  { fromHz: 156 * M, toHz: 162.1 * M, name: 'VHF marina / AIS' },
  { fromHz: 169.4 * M, toHz: 169.8 * M, name: 'Comptadors intel·ligents / pagers (169 MHz)' },
  { fromHz: 174 * M, toHz: 240 * M, name: 'DAB ràdio digital', broadcast: true },
  { fromHz: 380 * M, toHz: 400 * M, name: 'TETRA (emergències, xifrat)', restricted: true },
  { fromHz: 430 * M, toHz: 433.05 * M, name: 'Radioaficionats 70 cm' },
  { fromHz: 433.05 * M, toHz: 434.79 * M, name: 'ISM 433 MHz (sensors, comandaments, meteo)' },
  { fromHz: 434.79 * M, toHz: 440 * M, name: 'Radioaficionats 70 cm' },
  { fromHz: 446 * M, toHz: 446.2 * M, name: 'PMR446 (walkies)' },
  { fromHz: 470 * M, toHz: 694 * M, name: 'TDT (televisió)', broadcast: true },
  { fromHz: 703 * M, toHz: 733 * M, name: 'Mòbil 5G/LTE 700 (pujada)', restricted: true },
  { fromHz: 758 * M, toHz: 788 * M, name: 'Mòbil 5G/LTE 700 (baixada)', restricted: true },
  { fromHz: 791 * M, toHz: 821 * M, name: 'Mòbil LTE 800 (baixada)', restricted: true },
  { fromHz: 832 * M, toHz: 862 * M, name: 'Mòbil LTE 800 (pujada)', restricted: true },
  { fromHz: 863 * M, toHz: 870 * M, name: 'ISM 868 MHz (sensors, alarmes, LoRa)' },
  { fromHz: 880 * M, toHz: 915 * M, name: 'Mòbil GSM/LTE 900 (pujada)', restricted: true },
  { fromHz: 925 * M, toHz: 960 * M, name: 'Mòbil GSM/LTE 900 (baixada)', restricted: true },
  { fromHz: 1_085 * M, toHz: 1_095 * M, name: 'ADS-B avions (1090 MHz)' },
  { fromHz: 1_559 * M, toHz: 1_610 * M, name: 'GNSS (GPS/Galileo)' },
  { fromHz: 1_710 * M, toHz: 1_785 * M, name: 'Mòbil LTE 1800 (pujada)', restricted: true },
].map((b) => ({ ...b, fromHz: Math.round(b.fromHz), toHz: Math.round(b.toHz) }));

export function bandOf(freqHz: number): Band | null {
  return BANDS.find((b) => freqHz >= b.fromHz && freqHz <= b.toHz) ?? null;
}
