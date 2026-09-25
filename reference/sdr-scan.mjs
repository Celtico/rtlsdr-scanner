#!/usr/bin/env node
// sdr-scan.mjs — Escàner RTL-SDR per a Mac (Node 18+, sense dependències)
//
// Requisits:  brew install librtlsdr rtl_433
//
// Ús:
//   node sdr-scan.mjs survey  [--from 24M] [--to 1700M] [--step 1M] [--interval 10] [--duration 30m]
//   node sdr-scan.mjs analyze survey.csv [--threshold 10]
//   node sdr-scan.mjs devices [--freqs 433.92M,868.3M] [--hop 60] [--duration 30m]
//   node sdr-scan.mjs adsb    [--duration 10m]
//
// Ctrl+C atura qualsevol mode i desa els resultats igualment.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

// ---------- Bandes conegudes (Espanya / Europa) ----------
const BANDS = [
  [0.5, 1.7, 'Ràdio AM (ona mitjana)'],
  [26.96, 27.41, 'CB 27 MHz'],
  [87.5, 108, 'Ràdio FM'],
  [108, 118, 'Radionavegació aèria (VOR/ILS)'],
  [118, 137, 'Banda aèria (veu AM)'],
  [137, 138, 'Satèl·lits meteorològics (NOAA/Meteor)'],
  [144, 146, 'Radioaficionats 2 m'],
  [156, 162.1, 'VHF marina / AIS'],
  [169.4, 169.8, 'Comptadors intel·ligents / pagers (169 MHz)'],
  [174, 240, 'DAB ràdio digital'],
  [380, 400, 'TETRA (emergències, xifrat)'],
  [430, 433.05, 'Radioaficionats 70 cm'],
  [433.05, 434.79, 'ISM 433 MHz (sensors, comandaments, meteo)'],
  [434.79, 440, 'Radioaficionats 70 cm'],
  [446, 446.2, 'PMR446 (walkies)'],
  [470, 694, 'TDT (televisió)'],
  [703, 733, 'Mòbil 5G/LTE 700 (pujada)'],
  [758, 788, 'Mòbil 5G/LTE 700 (baixada)'],
  [791, 821, 'Mòbil LTE 800 (baixada)'],
  [832, 862, 'Mòbil LTE 800 (pujada)'],
  [863, 870, 'ISM 868 MHz (sensors, alarmes, LoRa)'],
  [880, 915, 'Mòbil GSM/LTE 900 (pujada)'],
  [925, 960, 'Mòbil GSM/LTE 900 (baixada)'],
  [1085, 1095, 'ADS-B avions (1090 MHz)'],
  [1559, 1610, 'GNSS (GPS/Galileo)'],
  [1710, 1785, 'Mòbil LTE 1800 (pujada)'],
];
const bandOf = (mhz) => BANDS.find(([a, b]) => mhz >= a && mhz <= b)?.[2] ?? '—';

// ---------- Utilitats ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}
function durMs(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([smh]?)$/);
  if (!m) throw new Error(`Durada invàlida: ${s}`);
  return +m[1] * { s: 1e3, m: 6e4, h: 36e5, '': 1e3 }[m[2]];
}
const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function run(bin, args, { duration, onLine, onEnd }) {
  console.log(`▶ ${bin} ${args.join(' ')}`);
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (e) => {
    if (e.code === 'ENOENT') console.error(`✖ No trobo "${bin}". Instal·la'l: brew install librtlsdr rtl_433`);
    else console.error(e);
    process.exit(1);
  });
  if (onLine) readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', (l) => {
    if (/usb_claim_interface|No supported devices|Failed to open/i.test(l)) console.error(`⚠ ${l}\n  (Comprova que el dongle està connectat i que cap altre programa l'està fent servir)`);
    else if (process.env.DEBUG) console.error(`  ${l}`);
  });
  let done = false;
  const finish = () => { if (done) return; done = true; child.kill('SIGINT'); setTimeout(() => { onEnd?.(); process.exit(0); }, 800); };
  if (duration) setTimeout(finish, durMs(duration));
  process.on('SIGINT', finish);
  child.on('exit', () => finish());
}

// ---------- 1. SURVEY: escombrat d'espectre ----------
function survey(o) {
  const from = o.from ?? '24M', to = o.to ?? '1700M', step = o.step ?? '1M';
  const out = o.out ?? `survey-${stamp()}.csv`;
  const args = ['-f', `${from}:${to}:${step}`, '-i', String(o.interval ?? 10), '-g', String(o.gain ?? 40)];
  if (o.duration) args.push('-e', String(o.duration));
  args.push(out);
  console.log(`Escombrant ${from}–${to}. Deixa-ho córrer (com més estona, millor). Ctrl+C per aturar.`);
  run('rtl_power', args, { onEnd: () => analyze({ _: [out], threshold: o.threshold }) });
}

// ---------- 2. ANALYZE: detecció de pics + heatmap ----------
function analyze(o) {
  const file = o._[0];
  if (!file) return console.error('Indica el CSV: node sdr-scan.mjs analyze survey.csv');
  const th = +(o.threshold ?? 10);
  const bins = new Map();   // Hz -> [dB...]
  const sweeps = new Map(); // "data hora" -> Map(Hz -> dB)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 7) continue;
    const ts = `${p[0]} ${p[1]}`, low = +p[2], step = +p[4];
    if (!sweeps.has(ts)) sweeps.set(ts, new Map());
    p.slice(6).forEach((v, i) => {
      const db = +v; if (!Number.isFinite(db)) return;
      const f = Math.round(low + i * step);
      (bins.get(f) ?? bins.set(f, []).get(f)).push(db);
      sweeps.get(ts).set(f, db);
    });
  }
  const freqs = [...bins.keys()].sort((a, b) => a - b);
  if (!freqs.length) return console.error('El CSV és buit o no té format rtl_power.');
  const stepHz = freqs.length > 1 ? freqs[1] - freqs[0] : 1e6;
  const med = freqs.map((f) => median(bins.get(f)));

  // Soroll de fons local (mediana mòbil de ±40 bins)
  const W = 40;
  const floor = med.map((_, i) => median(med.slice(Math.max(0, i - W), i + W + 1)));

  const stats = freqs.map((f, i) => {
    const arr = bins.get(f), mx = Math.max(...arr);
    const duty = arr.filter((d) => d > floor[i] + th).length / arr.length;
    return { f, max: mx, med: med[i], floor: floor[i], excess: mx - floor[i], duty };
  });

  // Agrupar bins actius contigus en senyals
  const peaks = [];
  let cur = null;
  for (const s of stats) {
    if (s.excess > th) {
      if (cur && s.f - cur.end <= stepHz * 1.5) { cur.end = s.f; cur.items.push(s); }
      else { cur = { start: s.f, end: s.f, items: [s] }; peaks.push(cur); }
    } else cur = null;
  }
  const signals = peaks.map((p) => {
    const top = p.items.reduce((a, b) => (b.excess > a.excess ? b : a));
    const mhz = top.f / 1e6;
    return {
      mhz: +mhz.toFixed(3),
      ampleKHz: Math.round((p.end - p.start + stepHz) / 1e3),
      picDb: +top.max.toFixed(1),
      sobreSorollDb: +top.excess.toFixed(1),
      actiuPct: Math.round(Math.max(...p.items.map((x) => x.duty)) * 100),
      banda: bandOf(mhz),
    };
  }).sort((a, b) => b.sobreSorollDb - a.sobreSorollDb);

  console.log(`\n${sweeps.size} escombrats · ${freqs.length} bins · ${signals.length} senyals > ${th} dB sobre el soroll\n`);
  console.log(`${pad('MHz', 11)}${pad('Ample', 10)}${pad('+dB', 7)}${pad('Actiu', 7)}Banda probable`);
  console.log('─'.repeat(75));
  for (const s of signals.slice(0, 50)) console.log(`${pad(s.mhz, 11)}${pad(s.ampleKHz + ' kHz', 10)}${pad(s.sobreSorollDb, 7)}${pad(s.actiuPct + '%', 7)}${s.banda}`);
  console.log('\n"Actiu" = % del temps que el senyal estava encès (100% = emissora contínua, baix = ràfegues/dispositius).');

  const base = file.replace(/\.csv$/, '');
  writeFileSync(`${base}-senyals.json`, JSON.stringify(signals, null, 2));
  writeHeatmap(`${base}-heatmap.html`, freqs, [...sweeps.entries()].sort(), signals);
  console.log(`\n✔ ${base}-senyals.json\n✔ ${base}-heatmap.html  (obre'l al navegador)`);
}

function writeHeatmap(path, freqs, sweepList, signals) {
  const MAXC = 1400, group = Math.ceil(freqs.length / MAXC);
  const cols = [];
  for (let i = 0; i < freqs.length; i += group) cols.push(freqs.slice(i, i + group));
  const rows = sweepList.map(([, m]) => cols.map((g) => {
    let v = -Infinity; for (const f of g) { const d = m.get(f); if (d !== undefined && d > v) v = d; }
    return Number.isFinite(v) ? Math.round(v) : null;
  }));
  const data = { cols: cols.map((g) => g[0] / 1e6), times: sweepList.map(([t]) => t), rows, bands: BANDS, signals: signals.slice(0, 30) };
  writeFileSync(path, `<!doctype html><meta charset="utf-8"><title>Espectre RTL-SDR</title>
<style>body{font:13px system-ui;margin:16px;background:#111;color:#ddd}canvas{width:100%;image-rendering:pixelated;border:1px solid #333}
#tip{position:fixed;background:#000c;padding:4px 8px;border-radius:4px;pointer-events:none;display:none}table{border-collapse:collapse;margin-top:12px}td,th{padding:2px 10px;border-bottom:1px solid #333;text-align:left}</style>
<h3>Espectre al llarg del temps (eix X = freqüència, eix Y = temps)</h3><canvas id=c></canvas><div id=tip></div>
<table><tr><th>MHz</th><th>+dB</th><th>Actiu</th><th>Banda</th></tr>${signals.slice(0, 30).map((s) => `<tr><td>${s.mhz}</td><td>${s.sobreSorollDb}</td><td>${s.actiuPct}%</td><td>${s.banda}</td></tr>`).join('')}</table>
<script>const D=${JSON.stringify(data)};
const c=document.getElementById('c'),x=c.getContext('2d'),W=D.cols.length,H=Math.max(D.rows.length,1),S=Math.max(1,Math.floor(300/H));
c.width=W;c.height=H*S;const all=D.rows.flat().filter(v=>v!==null).sort((a,b)=>a-b),lo=all[Math.floor(all.length*.05)],hi=all[Math.floor(all.length*.995)];
const col=t=>{t=Math.max(0,Math.min(1,t));return 'hsl('+(240-240*t)+',100%,'+(10+45*t)+'%)'};
D.rows.forEach((r,y)=>r.forEach((v,i)=>{x.fillStyle=v===null?'#000':col((v-lo)/(hi-lo));x.fillRect(i,y*S,1,S)}));
const tip=document.getElementById('tip');c.onmousemove=e=>{const b=c.getBoundingClientRect(),i=Math.floor((e.clientX-b.left)/b.width*W),y=Math.floor((e.clientY-b.top)/b.height*H);
const f=D.cols[i],v=D.rows[y]?.[i],bd=D.bands.find(([a,z])=>f>=a&&f<=z);tip.style.display='block';tip.style.left=e.clientX+12+'px';tip.style.top=e.clientY+12+'px';
tip.textContent=f.toFixed(2)+' MHz · '+v+' dB · '+(D.times[y]||'')+(bd?' · '+bd[2]:'')};c.onmouseleave=()=>tip.style.display='none';</script>`);
}

// ---------- 3. DEVICES: rtl_433 (sensors 433/868 MHz) ----------
function devices(o) {
  const freqs = String(o.freqs ?? '433.92M,868.3M').split(',');
  const args = [];
  freqs.forEach((f) => args.push('-f', f));
  if (freqs.length > 1) args.push('-H', String(o.hop ?? 60));
  args.push('-F', 'json', '-M', 'level', '-M', 'time:iso');
  const seen = new Map();
  console.log('Escoltant dispositius… (els nous apareixen a mesura que emeten; molts sensors emeten cada 30–60 s)\n');
  run('rtl_433', args, {
    duration: o.duration,
    onLine: (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const key = [m.model, m.id ?? '', m.channel ?? ''].join('|');
      const { time, model, id, channel, freq, rssi, snr, mic, mod, ...dades } = m;
      const d = seen.get(key) ?? { model, id, channel, vist: 0, primer: time, freqMHz: freq };
      Object.assign(d, { vist: d.vist + 1, darrer: time, rssi, dades });
      if (!seen.has(key)) {
        seen.set(key, d);
        console.log(`🆕 ${model}${id !== undefined ? ` id=${id}` : ''}${channel !== undefined ? ` ch=${channel}` : ''} @ ${freq ?? '?'} MHz → ${JSON.stringify(dades)}`);
      }
    },
    onEnd: () => {
      const list = [...seen.values()].sort((a, b) => b.vist - a.vist);
      console.log(`\n${list.length} dispositius únics:\n`);
      for (const d of list) console.log(`${pad(d.model, 34)}${pad('id=' + (d.id ?? '-'), 12)}${pad(d.vist + 'x', 6)}${JSON.stringify(d.dades).slice(0, 80)}`);
      const out = `dispositius-${stamp()}.json`;
      writeFileSync(out, JSON.stringify(list, null, 2));
      console.log(`\n✔ ${out}`);
    },
  });
}

// ---------- 4. ADSB: avions a 1090 MHz ----------
function adsb(o) {
  const planes = new Map();
  console.log('Escoltant avions a 1090 MHz… (millor amb l\'antena vertical i a prop d\'una finestra)\n');
  run('rtl_adsb', [], {
    duration: o.duration ?? '10m',
    onLine: (line) => {
      const hex = line.trim().replace(/^\*|;$/g, '');
      if (hex.length !== 28) return;              // només missatges llargs (112 bits)
      const df = parseInt(hex.slice(0, 2), 16) >> 3;
      if (df !== 17 && df !== 18) return;         // Extended Squitter
      const icao = hex.slice(2, 8).toLowerCase();
      const tc = parseInt(hex.slice(8, 10), 16) >> 3;
      const p = planes.get(icao) ?? { icao, msgs: 0, callsign: null };
      p.msgs++;
      if (tc >= 1 && tc <= 4) p.callsign = decodeCallsign(hex.slice(8, 22)) || p.callsign;
      if (!planes.has(icao)) { planes.set(icao, p); console.log(`✈ ${icao}`); }
      else if (p.callsign && !p._shown) { p._shown = true; console.log(`  ${icao} = ${p.callsign}`); }
    },
    onEnd: () => {
      console.log(`\n${planes.size} avions detectats:\n`);
      for (const p of [...planes.values()].sort((a, b) => b.msgs - a.msgs))
        console.log(`${pad(p.icao, 8)}${pad(p.callsign ?? '', 10)}${pad(p.msgs + ' msg', 10)}https://globe.adsbexchange.com/?icao=${p.icao}`);
    },
  });
}
function decodeCallsign(me) {
  const CH = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';
  const bits = BigInt('0x' + me).toString(2).padStart(56, '0').slice(8);
  let s = '';
  for (let i = 0; i < 48; i += 6) s += CH[parseInt(bits.slice(i, i + 6), 2)];
  return s.replace(/[#\s]/g, '');
}

// ---------- Main ----------
const [cmd = 'help', ...rest] = process.argv.slice(2);
const o = parseArgs(rest);
({ survey, analyze, devices, adsb }[cmd] ?? (() => {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}))(o);
