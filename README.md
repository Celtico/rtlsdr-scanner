# RTL-SDR Scanner

Aplicació web local per descobrir quins senyals de ràdio hi ha a casa amb un **RTL-SDR Blog V3** i, quan es pot, quin dispositiu els emet i quines dades envia. Només recepció.

- **Espectre**: escombrats amb `rtl_power`, waterfall en temps real, detecció de pics sobre el soroll de fons i classificació per banda (ES/UE).
- **Dispositius**: `rtl_433` saltant entre 433,92 i 868,3 MHz. Dedup per model+id+canal, històric de lectures, àlies, filtre «probablement meu / veïns».
- **Avions**: ADS-B a 1090 MHz amb `rtl_adsb` (ICAO, país pel bloc ICAO, indicatiu, altitud, posició, velocitat, rumb).
- **Radar**: vista en planta centrada a casa (Lleida per defecte, configurable). Avions per posició real amb estela; la resta de dispositius en anells per RSSI amb direcció desconeguda (o manual, si l'has trobada amb una antena directiva).
- **Auditoria**: superfície d'exposició de ràdio de casa: què emet en clar, què és identificable per ID, rutines horàries i recomanacions. Només metadades dels dispositius propis.
- **Hunt**: RSSI en viu (10×/s) en una freqüència fixa amb `rtl_sdr` (IQ cru, 250 kHz), pic màxim i to sonor tipus detector de metalls per localitzar sensors LoRa a 868 MHz.
- **Satèl·lits**: passos de NOAA-15/19 (APT) i Meteor-M2 3/4 (LRPT) sobre casa amb TLE de Celestrak (SGP4 via `satellite.js`), programació de captures que llancen **SatDump** pel `manager` i galeria de les imatges descodificades a `data/satellite/`.
- **Històric**: tots els escaneigs es desen a SQLite i es poden tornar a obrir i exportar (CSV/JSON).

## Requisits

- macOS amb Homebrew, Node 22+ i pnpm.
- Eines SDR: `brew install librtlsdr rtl_433`.
- Satèl·lits (opcional): `brew install satdump` (cask; deixa `SatDump.app` a `/Applications`). El servidor crida el binari del bundle directament, perquè pel symlink de Homebrew SatDump no troba la seva configuració. Si el tens en un altre lloc: `SATDUMP_BIN=/ruta/satdump`.
- Comprova el dongle: `rtl_test -t` ha de llistar `Realtek, RTL2838UHIDIR`.

## Ordres

```bash
pnpm i
pnpm dev          # server (http://localhost:4000) + web (http://localhost:5173)
pnpm build
pnpm typecheck
pnpm lint
pnpm test         # vitest (server), amb fixtures reals del dongle
```

Variables opcionals del servidor: `PORT` (4000), `SDR_DB` (ruta de la base de dades, per defecte `data/sdr.db`), `SDR_SAT_DIR` (captures de satèl·lit, per defecte `data/satellite`), `SATDUMP_BIN`, `SDR_DEBUG=1` (mostra el stderr de les eines `rtl_*`).

## Estructura

```
server/src/
  index.ts          Fastify: REST + WebSocket /ws
  db.ts             esquema i consultes SQLite (better-sqlite3)
  types.ts          tipus compartits amb el web
  sdr/manager.ts    únic propietari del dongle: un sol mode actiu, cua, SIGINT→SIGKILL
  sdr/process.ts    llançament de processos rtl_* i detecció d'errors USB
  sdr/survey.ts     parser de rtl_power, assemblador d'escombrats, detecció de pics
  sdr/devices.ts    parser de rtl_433 i dedup
  sdr/adsb.ts       descodificador Mode S / ADS-B (CRC, indicatiu, altitud, CPR, velocitat)
  sdr/icao.ts       blocs d'adreces ICAO → país
  sdr/hunt.ts       mesurador de potència a partir de l'IQ de rtl_sdr
  sdr/audit.ts      classificació d'exposició (en clar / ID / codi variable) i rutines
  sdr/satellite.ts  TLE (Celestrak, cau 12 h), predicció de passos SGP4, ordre de SatDump, galeria
  sdr/bands.ts      taula de bandes
server/test/        tests + fixtures capturades amb el dongle
web/src/
  pages/            Dashboard, Spectrum, Devices, Planes, Radar, Audit, Hunt, Satellites, History
  components/       Waterfall i RadarCanvas (canvas), SignalsTable, DeviceDrawer, Layout…
  store.tsx         estat global alimentat pel WebSocket
```

## API

| Mètode | Ruta | Descripció |
| --- | --- | --- |
| GET | `/api/status` | mode actiu, estat del dongle, comptadors |
| POST | `/api/mode` | `{ mode: 'idle' \| 'survey' \| 'devices' \| 'adsb' \| 'hunt', config }` (el mode `satellite` es llança des de les captures) |
| POST | `/api/dongle/check` | executa `rtl_test -t` (només en mode inactiu) |
| GET | `/api/bands` | taula de bandes |
| GET | `/api/signals?scanId=` | senyals detectats |
| GET | `/api/sweeps?scanId=&limit=` | escombrats (per tornar a obrir un waterfall) |
| GET | `/api/devices` | dispositius rtl_433 |
| GET | `/api/devices/:id/history` | lectures d'un dispositiu |
| PATCH | `/api/devices/:id` | `{ alias?, owner?: 'own' \| 'other' \| null, bearingDeg? }` |
| GET | `/api/audit` | exposició, activitat per hora i rutines dels dispositius propis |
| GET | `/api/satellite/info`, `/api/satellite/passes?lat&lon&hours`, `/api/satellite/captures` | satèl·lits, passos previstos, captures |
| POST / DELETE | `/api/satellite/captures[/:id]` | programa (o llança amb `now: true`) i cancel·la captures |
| GET | `/api/satellite/files/:id/*` | imatges d'una captura |
| GET | `/api/planes?scanId=` | avions |
| GET | `/api/scans`, `/api/scans/:id`, DELETE `/api/scans/:id` | històric |
| GET | `/api/export/:kind?format=csv\|json&scanId=&deviceId=` | `signals`, `devices`, `planes`, `sweeps`, `readings` |
| WS | `/ws` | `status`, `survey:sweep`, `survey:signals`, `device:new`, `device:update`, `adsb:plane`, `hunt:level`, `satellite:capture`, `error` |

## Notes d'ús

- Només un procés pot fer servir el dongle. Canviar de mode atura l'anterior i espera que alliberi l'USB.
- `rtl_power` amb pas d'1 MHz fa un salt d'un sol bin per MHz (1676 salts de 24 a 1700 MHz, ~73 s per passada). Amb passos ≤ 500 kHz cada salt cobreix 2,8 MHz (599 salts, ~23 s per passada), per això el pas per defecte és 100 kHz.
- Bandes xifrades (mòbil, TETRA) només mostren «activitat detectada». No es descodifica ni es grava àudio de comunicacions privades.
- Satèl·lits: el planificador llança la captura 20 s abans de l'AOS i pren el dongle encara que hi hagi un altre mode actiu. SatDump descodifica en acabar el temps del pas i sempre genera imatges (encara que només hi hagi soroll): mira'n la qualitat a la galeria. Amb la vareta els resultats són pobres; cal una V-dipole de 137 MHz (2 braços de 53,4 cm a 120°) o una QFH.
