# RTL-SDR Scanner

Aplicació web local per descobrir quins senyals de ràdio hi ha a casa amb un **RTL-SDR Blog V3** i, quan es pot, quin dispositiu els emet i quines dades envia. Només recepció.

- **Espectre**: escombrats amb `rtl_power`, waterfall en temps real, detecció de pics sobre el soroll de fons i classificació per banda (ES/UE).
- **Dispositius**: `rtl_433` saltant entre 433,92 i 868,3 MHz. Dedup per model+id+canal, històric de lectures, àlies, filtre «probablement meu / veïns».
- **Avions**: ADS-B a 1090 MHz amb `rtl_adsb` (ICAO, indicatiu, altitud, posició, velocitat).
- **Històric**: tots els escaneigs es desen a SQLite i es poden tornar a obrir i exportar (CSV/JSON).

## Requisits

- macOS amb Homebrew, Node 22+ i pnpm.
- Eines SDR: `brew install librtlsdr rtl_433`.
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

Variables opcionals del servidor: `PORT` (4000), `SDR_DB` (ruta de la base de dades, per defecte `data/sdr.db`), `SDR_DEBUG=1` (mostra el stderr de les eines `rtl_*`).

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
  sdr/bands.ts      taula de bandes
server/test/        tests + fixtures capturades amb el dongle
web/src/
  pages/            Dashboard, Spectrum, Devices, Planes, History
  components/       Waterfall (canvas), SignalsTable, DeviceDrawer, Layout…
  store.tsx         estat global alimentat pel WebSocket
```

## API

| Mètode | Ruta | Descripció |
| --- | --- | --- |
| GET | `/api/status` | mode actiu, estat del dongle, comptadors |
| POST | `/api/mode` | `{ mode: 'idle' \| 'survey' \| 'devices' \| 'adsb', config }` |
| POST | `/api/dongle/check` | executa `rtl_test -t` (només en mode inactiu) |
| GET | `/api/bands` | taula de bandes |
| GET | `/api/signals?scanId=` | senyals detectats |
| GET | `/api/sweeps?scanId=&limit=` | escombrats (per tornar a obrir un waterfall) |
| GET | `/api/devices` | dispositius rtl_433 |
| GET | `/api/devices/:id/history` | lectures d'un dispositiu |
| PATCH | `/api/devices/:id` | `{ alias }` |
| GET | `/api/planes?scanId=` | avions |
| GET | `/api/scans`, `/api/scans/:id`, DELETE `/api/scans/:id` | històric |
| GET | `/api/export/:kind?format=csv\|json&scanId=&deviceId=` | `signals`, `devices`, `planes`, `sweeps`, `readings` |
| WS | `/ws` | `status`, `survey:sweep`, `survey:signals`, `device:new`, `device:update`, `adsb:plane`, `error` |

## Notes d'ús

- Només un procés pot fer servir el dongle. Canviar de mode atura l'anterior i espera que alliberi l'USB.
- `rtl_power` amb pas d'1 MHz fa un salt per MHz (1676 salts de 24 a 1700 MHz): la primera passada triga uns minuts. Amb passos petits (10–100 kHz) cada salt cobreix 2,4 MHz i va molt més ràpid.
- Bandes xifrades (mòbil, TETRA) només mostren «activitat detectada». No es descodifica ni es grava àudio de comunicacions privades.
