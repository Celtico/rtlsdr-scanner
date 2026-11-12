import { Box, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Band, Sweep } from '@shared/types';
import { formatMHz, formatTime } from '@/lib/format';
import { LUT, displayRange, downsample } from '@/lib/colormap';

const MAX_COLS = 1600;
const SPECTRUM_H = 110;
const BAND_H = 18;
const AXIS_H = 20;
const MIN_WF_H = 180;
const MAX_WF_H = 900;
/** Row height adapts: few sweeps get tall rows, many sweeps get 3 px rows. */
const rowHeightFor = (rows: number) => Math.max(3, Math.min(20, Math.floor(MIN_WF_H / Math.max(1, rows))));

interface Grid { lowHz: number; stepHz: number; cols: number; group: number; bins: number }

export interface WaterfallProps {
  sweeps: Sweep[];
  bands: Band[];
  markedHz: number | null;
  onPick?: (freqHz: number) => void;
  /** When set, the dB grid and tooltip show dBm = value + offset. */
  dbOffset?: number | null;
}

interface Tip { x: number; y: number; freqHz: number; db: number | null; ts: number | null; band: Band | null }

export function Waterfall({ sweeps, bands, markedHz, onPick, dbOffset = null }: WaterfallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [cssW, setCssW] = useState(800);

  const grid = useMemo<Grid | null>(() => {
    const s = sweeps[sweeps.length - 1];
    if (!s) return null;
    const bins = s.dbs.length;
    const group = Math.max(1, Math.ceil(bins / MAX_COLS));
    return { lowHz: s.lowHz, stepHz: s.stepHz, bins, group, cols: Math.ceil(bins / group) };
  }, [sweeps]);

  const rows = useMemo(() => (grid ? sweeps.map((s) => downsample(s.dbs, grid.group, grid.cols)) : []), [sweeps, grid]);

  const range = useMemo(() => displayRange(rows), [rows]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setCssW(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ROW_H = rowHeightFor(rows.length);
  const wfH = Math.min(MAX_WF_H, Math.max(MIN_WF_H, rows.length * ROW_H));
  const totalH = SPECTRUM_H + BAND_H + AXIS_H + wfH;

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(totalH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW;
    const hzToX = (hz: number) => ((hz - grid.lowHz) / (grid.stepHz * grid.bins)) * W;
    const styles = getComputedStyle(canvas);
    const fg = styles.getPropertyValue('--wf-fg') || '#ccc';
    const muted = styles.getPropertyValue('--wf-muted') || '#777';
    const panel = styles.getPropertyValue('--wf-bg') || '#111';
    const accent = styles.getPropertyValue('--wf-accent') || '#36cfc9';

    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, W, totalH);

    // --- spectrum (latest sweep + max hold) ---
    const latest = rows[rows.length - 1];
    if (latest) {
      const maxHold = new Float32Array(grid.cols).fill(-Infinity);
      for (const r of rows.slice(-60)) for (let i = 0; i < r.length; i++) if (r[i]! > maxHold[i]!) maxHold[i] = r[i]!;
      const yOf = (db: number) => SPECTRUM_H - 4 - ((db - range.lo) / (range.hi - range.lo)) * (SPECTRUM_H - 10);
      // grid lines
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      for (let db = Math.ceil(range.lo / 10) * 10; db <= range.hi; db += 10) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = muted;
        ctx.font = '10px system-ui';
        ctx.fillText(dbOffset === null ? `${db} dB` : `${Math.round(db + dbOffset)} dBm`, 4, y - 2);
        ctx.globalAlpha = 0.25;
      }
      ctx.globalAlpha = 1;
      // max hold
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let c = 0; c < grid.cols; c++) {
        const v = maxHold[c]!;
        if (!Number.isFinite(v)) continue;
        const x = (c / grid.cols) * W;
        const y = yOf(v);
        if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      // latest
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let c = 0; c < grid.cols; c++) {
        const v = latest[c]!;
        if (!Number.isFinite(v)) continue;
        const x = (c / grid.cols) * W;
        const y = yOf(v);
        if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // --- band strip ---
    const bandY = SPECTRUM_H;
    const hiHz = grid.lowHz + grid.stepHz * grid.bins;
    ctx.font = '10px system-ui';
    for (const b of bands) {
      if (b.toHz < grid.lowHz || b.fromHz > hiHz) continue;
      const x0 = Math.max(0, hzToX(b.fromHz));
      const x1 = Math.min(W, hzToX(b.toHz));
      ctx.fillStyle = b.restricted ? '#a33' : b.broadcast ? '#3a7' : accent;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x0, bandY, Math.max(1, x1 - x0), BAND_H);
      ctx.globalAlpha = 1;
      if (x1 - x0 > 60) {
        ctx.fillStyle = fg;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, bandY, x1 - x0, BAND_H); ctx.clip();
        ctx.fillText(b.name, x0 + 3, bandY + 13);
        ctx.restore();
      }
    }

    // --- axis ---
    const axisY = SPECTRUM_H + BAND_H;
    ctx.fillStyle = muted;
    ctx.font = '10px system-ui';
    const spanHz = hiHz - grid.lowHz;
    const ticks = Math.max(2, Math.floor(W / 90));
    const rawStep = spanHz / ticks;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const tickHz = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? mag * 10;
    for (let hz = Math.ceil(grid.lowHz / tickHz) * tickHz; hz <= hiHz; hz += tickHz) {
      const x = hzToX(hz);
      ctx.fillRect(Math.round(x), axisY, 1, 4);
      const label = hz >= 1e9 ? `${(hz / 1e9).toFixed(2)} G` : `${(hz / 1e6).toFixed(spanHz < 5e6 ? 2 : spanHz < 50e6 ? 1 : 0)} M`;
      ctx.fillText(label, x + 2, axisY + 14);
    }

    // --- waterfall ---
    const wfY = SPECTRUM_H + BAND_H + AXIS_H;
    if (rows.length) {
      const img = ctx.createImageData(grid.cols, rows.length);
      const d = img.data;
      const scale = 255 / (range.hi - range.lo);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        for (let c = 0; c < grid.cols; c++) {
          const v = row[c]!;
          const o = (r * grid.cols + c) * 4;
          if (!Number.isFinite(v)) { d[o + 3] = 255; continue; }
          const i = Math.max(0, Math.min(255, Math.round((v - range.lo) * scale)));
          d[o] = LUT[i * 3]!; d[o + 1] = LUT[i * 3 + 1]!; d[o + 2] = LUT[i * 3 + 2]!; d[o + 3] = 255;
        }
      }
      const off = document.createElement('canvas');
      off.width = grid.cols;
      off.height = rows.length;
      off.getContext('2d')!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, wfY, W, rows.length * ROW_H);
    }

    // --- marker ---
    if (markedHz !== null && markedHz >= grid.lowHz && markedHz <= hiHz) {
      const x = Math.round(hzToX(markedHz)) + 0.5;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, totalH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      const label = formatMHz(markedHz);
      const tw = ctx.measureText(label).width;
      const lx = x + 6 + tw > W ? x - tw - 6 : x + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(lx - 2, 2, tw + 4, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx, 13);
    }
  }, [rows, grid, range, bands, markedHz, cssW, totalH, ROW_H, dbOffset]);

  const locate = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Tip | null => {
    if (!grid) return null;
    const ROW_H = rowHeightFor(rows.length);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const frac = Math.max(0, Math.min(0.9999, x / rect.width));
    const freqHz = Math.round(grid.lowHz + frac * grid.stepHz * grid.bins);
    const col = Math.floor(frac * grid.cols);
    const wfY = SPECTRUM_H + BAND_H + AXIS_H;
    let db: number | null = null;
    let ts: number | null = null;
    if (y >= wfY) {
      const r = Math.floor((y - wfY) / ROW_H);
      const row = rows[r];
      if (row) { db = Number.isFinite(row[col]!) ? row[col]! : null; ts = sweeps[r]?.ts ?? null; }
    } else {
      const row = rows[rows.length - 1];
      if (row) { db = Number.isFinite(row[col]!) ? row[col]! : null; ts = sweeps[sweeps.length - 1]?.ts ?? null; }
    }
    const band = bands.find((b) => freqHz >= b.fromHz && freqHz <= b.toHz) ?? null;
    return { x, y, freqHz, db, ts, band };
  }, [grid, rows, sweeps, bands]);

  if (!grid) {
    return (
      <Box ref={wrapRef} h="72" rounded="md" borderWidth="1px" borderColor="border" bg="bg.subtle" display="grid" placeItems="center">
        <Text color="fg.muted">Encara no hi ha escombrats. Inicia un escombrat per veure el waterfall.</Text>
      </Box>
    );
  }

  return (
    <Box
      ref={wrapRef}
      position="relative"
      rounded="md"
      overflow="hidden"
      borderWidth="1px"
      borderColor="border"
      css={{
        '--wf-fg': 'var(--chakra-colors-fg)',
        '--wf-muted': 'var(--chakra-colors-fg-muted)',
        '--wf-bg': 'var(--chakra-colors-bg-panel)',
        '--wf-accent': 'var(--chakra-colors-brand-solid)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: cssW, height: totalH, display: 'block', cursor: 'crosshair' }}
        onMouseMove={(e) => setTip(locate(e))}
        onMouseLeave={() => setTip(null)}
        onClick={(e) => { const t = locate(e); if (t && onPick) onPick(t.freqHz); }}
      />
      {tip && (
        <Box
          position="absolute"
          left={Math.min(tip.x + 12, cssW - 220)}
          top={tip.y + 12}
          pointerEvents="none"
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border"
          rounded="md"
          px="2"
          py="1"
          fontSize="xs"
          shadow="md"
          whiteSpace="nowrap"
        >
          <Text fontWeight="semibold" fontFamily="mono">{formatMHz(tip.freqHz)}</Text>
          <Text color="fg.muted">{tip.db === null ? '—' : dbOffset === null ? `${tip.db.toFixed(1)} dB` : `${(tip.db + dbOffset).toFixed(1)} dBm`}{tip.ts ? ` · ${formatTime(tip.ts)}` : ''}</Text>
          {tip.band && <Text color={tip.band.restricted ? 'orange.fg' : 'brand.fg'}>{tip.band.name}</Text>}
        </Box>
      )}
    </Box>
  );
}
