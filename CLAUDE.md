# RTL-SDR Scanner

Aplicació local per descobrir i identificar senyals de ràdio a casa amb un **RTL-SDR Blog V3** (RTL2832U + R820T2, ~500 kHz–1,7 GHz) connectat per USB a un MacBook. Només **recepció**.

## Idioma i estil
- Respon sempre en **català**. Directe i pràctic, sense explicar conceptes bàsics.
- Textos de la UI en català. Codi, noms de variables i commits en anglès.

## Stack
- **Monorepo pnpm** amb dos paquets:
  - `server/` — Node 22+, TypeScript (ESM), **Fastify** + `@fastify/websocket`. Llança les eines SDR com a processos fills i emet esdeveniments en temps real.
  - `web/` — **Vite + React + TypeScript**, **Chakra UI v3**, **react-icons**, **@chakra-ui/charts** (Recharts).
- Persistència: **SQLite** (`better-sqlite3`) a `data/sdr.db`. Mai dades en JSON soltes com a font de veritat.
- Eines externes (Homebrew): `librtlsdr` (`rtl_test`, `rtl_power`, `rtl_adsb`), `rtl_433`. Opcional: `dump1090` si `rtl_adsb` no n'hi ha prou.
- Referència: `reference/sdr-scan.mjs` és un prototip CLI que funciona (parser de `rtl_power`, detecció de pics, taula de bandes, dedup de `rtl_433`, descodificador d'indicatius ADS-B). Reutilitza'n la lògica, no el reescriguis des de zero.

## Estructura
```
server/src/
  index.ts            # Fastify, rutes REST + WS
  sdr/manager.ts      # ÚNIC propietari del dongle: cua/lock, start/stop, cleanup
  sdr/survey.ts       # rtl_power → bins → pics
  sdr/devices.ts      # rtl_433 -F json → dispositius
  sdr/adsb.ts         # rtl_adsb/dump1090 → avions
  sdr/bands.ts        # taula de bandes ES/UE (compartida amb web via /api/bands)
  db.ts               # esquema i queries SQLite
web/src/
  components/ui/      # snippets de la CLI de Chakra (provider, toaster, tooltip)
  pages/              # Dashboard, Espectre, Dispositius, Avions, Històric
  components/         # peces reutilitzables
  hooks/useSdrSocket.ts
  theme.ts            # createSystem amb tokens
data/                 # sdr.db + exportacions (a .gitignore)
reference/            # prototips
```

## Regles del dongle (crític)
- **Només un procés pot fer servir el dongle alhora.** Tot passa per `sdr/manager.ts`: un sol mode actiu (`idle | survey | devices | adsb`). En canviar de mode, atura l'anterior i espera que alliberi l'USB.
- Mata els processos fills amb `SIGINT` i, si no han acabat en 3 s, amb `SIGKILL`. Neteja en `SIGINT`/`SIGTERM` del servidor i en `uncaughtException`. No deixis mai processos `rtl_*` orfes.
- Detecta i mostra a la UI els errors típics: `usb_claim_interface error`, `No supported devices found`, dongle ocupat.
- Abans d'afirmar que alguna cosa funciona amb maquinari real, **prova-ho** (`rtl_test -t`, execucions curtes de 30–60 s).

## UI
- Fes servir la skill **chakra-ui-builder** (`.claude/skills/chakra-ui-builder`) per a qualsevol component, tema o gràfic. Llegeix-ne les referències (`charts.md`, `theming.md`) quan pertoqui.
- Chakra **v3**: `colorPalette` (no `colorScheme`), `disabled` (no `isDisabled`), `Field.Root`, `createSystem` (no `extendTheme`). Tokens semàntics (`bg.subtle`, `fg.muted`, `border`) en lloc de colors fixos.
- **Tema fosc (nit) per defecte sempre.** L'app arrenca en fosc; no forcis mai el clar ni el segueixis del sistema. Deixa un botó opcional per canviar a clar, però el valor inicial és fosc.
- Icones **només de `react-icons`**. Fes-les servir amb coherència:
  - `react-icons/lu` (Lucide) per a la UI general.
  - `react-icons/md` o `react-icons/tb` quan Lucide no tingui la icona (antena, avió, sensor…).
  - Un sol conjunt per concepte a tota l'app.
- Els botons amb només icona porten `aria-label` + `Tooltip`.
- Inputs a 16px globalment (regla de la skill).
- Responsive: com a mínim `base` i `md`.
- Heatmap de l'espectre (waterfall): `<canvas>` propi, no Recharts. Recharts no pot pintar milers de bins × temps.

## Dades i privacitat
- **Només recepció.** No s'implementa res que transmeti.
- No desxifris ni intentis descodificar senyals xifrats (mòbil, TETRA, alarmes, claus de cotxe). Per a aquestes bandes, mostra només "activitat detectada".
- No escoltis ni gravis àudio de comunicacions privades. L'àudio de radiodifusió (FM) sí que es permet.
- WiFi i Bluetooth (2,4/5 GHz) queden fora de rang: no els ofereixis a la UI.

## Ordres
```
pnpm i
pnpm dev          # server (:4000) + web (:5173) en paral·lel
pnpm build
pnpm typecheck
pnpm lint
```
Abans de donar una tasca per acabada: `pnpm typecheck` i `pnpm lint` han de passar, i la pantalla afectada s'ha d'obrir sense errors a la consola.

## Convencions
- TypeScript `strict`. Res de `any` sense justificar-ho.
- Tipus compartits server↔web a `server/src/types.ts`, exportats i importats des de web (alias de path).
- Missatges WS tipats com a unió discriminada: `{ type: 'survey:sweep' | 'device:new' | 'device:update' | 'adsb:plane' | 'status' | 'error', ... }`.
- Freqüències sempre en **Hz (enter)** internament. Converteix a MHz només en mostrar-les.
