import { Box, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Device, Plane } from '@shared/types';
import type { TrailPoint } from '@/store';
import { bearingDeg, compassLabel, distanceKm } from '@/lib/geo';
import { DEV_R_MAX, UNKNOWN_SECTOR, altitudeColor, rssiToRadius } from '@/lib/radar';

export type RadarFilter = 'all' | 'planes' | 'devices';

export interface RadarCanvasProps {
  home: { lat: number; lon: number };
  rangeKm: number;
  planes: Plane[];
  trails: ReadonlyMap<string, TrailPoint[]>;
  devices: Device[];
  filter: RadarFilter;
  now: number;
}

interface Hit { kind: 'plane' | 'device'; x: number; y: number; label: string; sub: string }

export function RadarCanvas({ home, rangeKm, planes, trails, devices, filter, now }: RadarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(600);
  const [tip, setTip] = useState<Hit | null>(null);
  const hitsRef = useRef<Hit[]>([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setSize(Math.max(280, Math.min(Math.floor(w), 760)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const placedPlanes = useMemo(() => planes
    .filter((p) => p.lat != null && p.lon != null)
    .map((p) => ({
      plane: p,
      km: distanceKm(home.lat, home.lon, p.lat!, p.lon!),
      brg: bearingDeg(home.lat, home.lon, p.lat!, p.lon!),
      live: now - p.lastSeen < 120_000,
    })), [planes, home, now]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(canvas);
    const fg = cs.getPropertyValue('--r-fg') || '#ddd';
    const muted = cs.getPropertyValue('--r-muted') || '#777';
    const panel = cs.getPropertyValue('--r-bg') || '#111';
    const accent = cs.getPropertyValue('--r-accent') || '#36cfc9';
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 22;
    const hits: Hit[] = [];
    const polar = (deg: number, frac: number) => {
      const a = ((deg - 90) * Math.PI) / 180;
      return { x: cx + Math.cos(a) * R * frac, y: cy + Math.sin(a) * R * frac };
    };

    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, size, size);

    // Unknown-direction sector
    if (filter !== 'planes') {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R * DEV_R_MAX * 1.08, ((UNKNOWN_SECTOR[0] - 90) * Math.PI) / 180, ((UNKNOWN_SECTOR[1] - 90) * Math.PI) / 180);
      ctx.closePath();
      ctx.fillStyle = muted;
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.restore();
    }

    // Distance rings (km) + compass
    ctx.strokeStyle = muted;
    ctx.fillStyle = muted;
    ctx.font = '11px system-ui';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    for (let i = 1; i <= 4; i++) {
      const f = i / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
      const label = `${Math.round((rangeKm * f) * 10) / 10} km`;
      ctx.fillText(label, cx + 4, cy - R * f + 12);
    }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = fg;
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - R - 8);
    ctx.fillText('S', cx, cy + R + 16);
    ctx.textAlign = 'left';
    ctx.fillText('E', cx + R + 6, cy + 4);
    ctx.textAlign = 'right';
    ctx.fillText('O', cx - R - 6, cy + 4);
    ctx.textAlign = 'left';

    // Home
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();

    // Devices: RSSI rings (dotted), placed in the neutral sector unless a manual bearing exists.
    if (filter !== 'planes') {
      const unknown = devices.filter((d) => d.bearingDeg === null);
      unknown.forEach((d, i) => {
        const frac = rssiToRadius(d.rssi);
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = d.likelyOwn ? accent : muted;
        ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.arc(cx, cy, R * frac, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const span = UNKNOWN_SECTOR[1] - UNKNOWN_SECTOR[0];
        const deg = UNKNOWN_SECTOR[0] + (span * (i + 1)) / (unknown.length + 1);
        const p = polar(deg, frac);
        // Alternate label side and nudge every other label down so similar-RSSI devices stay readable.
        drawDevice(ctx, p.x, p.y, d, fg, d.likelyOwn ? accent : muted, false, i % 2 === 0 ? 'right' : 'left', (i % 3) * 6);
        hits.push({ kind: 'device', x: p.x, y: p.y, label: d.alias ?? d.model, sub: `RSSI ${d.rssi?.toFixed(1) ?? '—'} dB · direcció desconeguda` });
      });
      for (const d of devices.filter((d) => d.bearingDeg !== null)) {
        const frac = rssiToRadius(d.rssi);
        const p = polar(d.bearingDeg!, frac);
        ctx.strokeStyle = d.likelyOwn ? accent : muted;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.globalAlpha = 1;
        drawDevice(ctx, p.x, p.y, d, fg, d.likelyOwn ? accent : muted, true, 'right', 0);
        hits.push({ kind: 'device', x: p.x, y: p.y, label: d.alias ?? d.model, sub: `RSSI ${d.rssi?.toFixed(1) ?? '—'} dB · direcció manual ${Math.round(d.bearingDeg!)}° (${compassLabel(d.bearingDeg!)})` });
      }
    }

    // Planes: real positions
    if (filter !== 'devices') {
      for (const { plane, km, brg, live } of placedPlanes) {
        const frac = Math.min(1, km / rangeKm);
        const p = polar(brg, frac);
        const color = altitudeColor(plane.altitudeFt);
        // trail
        const t = trails.get(plane.icao) ?? [];
        ctx.fillStyle = color;
        t.slice(0, -1).forEach((pt, i) => {
          const f = Math.min(1, distanceKm(home.lat, home.lon, pt.lat, pt.lon) / rangeKm);
          const q = polar(bearingDeg(home.lat, home.lon, pt.lat, pt.lon), f);
          ctx.globalAlpha = 0.15 + (0.5 * (i + 1)) / t.length;
          ctx.beginPath(); ctx.arc(q.x, q.y, 1.8, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = live ? 1 : 0.45;
        // arrow
        const hdg = plane.headingDeg ?? brg;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((hdg - 90) * Math.PI) / 180);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 5); ctx.lineTo(-3, 0); ctx.lineTo(-6, -5); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.fillStyle = fg;
        ctx.font = '11px system-ui';
        ctx.fillText(plane.callsign ?? plane.icao.toUpperCase(), p.x + 10, p.y + 4);
        ctx.globalAlpha = 1;
        hits.push({ kind: 'plane', x: p.x, y: p.y, label: `${plane.callsign ?? plane.icao.toUpperCase()}${plane.country ? ` · ${plane.country}` : ''}`, sub: `${km.toFixed(0)} km ${compassLabel(brg)} · ${plane.altitudeFt != null ? `${plane.altitudeFt.toLocaleString('ca-ES')} ft` : 'alt. ?'}${plane.speedKt != null ? ` · ${plane.speedKt} kt` : ''}` });
        if (km > rangeKm) {
          ctx.fillStyle = muted;
          ctx.font = '10px system-ui';
          ctx.fillText('fora de rang', p.x + 10, p.y + 16);
        }
      }
    }
    hitsRef.current = hits;
  }, [size, home, rangeKm, placedPlanes, trails, devices, filter]);

  return (
    <Box
      ref={wrapRef}
      position="relative"
      rounded="md"
      borderWidth="1px"
      borderColor="border"
      overflow="hidden"
      display="flex"
      justifyContent="center"
      css={{
        '--r-fg': 'var(--chakra-colors-fg)',
        '--r-muted': 'var(--chakra-colors-fg-muted)',
        '--r-bg': 'var(--chakra-colors-bg-panel)',
        '--r-accent': 'var(--chakra-colors-brand-solid)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block' }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const hit = hitsRef.current.find((h) => Math.hypot(h.x - x, h.y - y) < 12) ?? null;
          setTip(hit ? { ...hit, x, y } : null);
        }}
        onMouseLeave={() => setTip(null)}
      />
      {tip && (
        <Box position="absolute" left={Math.min(tip.x + 12, size - 220)} top={tip.y + 12} pointerEvents="none" bg="bg.panel" borderWidth="1px" borderColor="border" rounded="md" px="2" py="1" fontSize="xs" shadow="md" whiteSpace="nowrap">
          <Text fontWeight="semibold">{tip.label}</Text>
          <Text color="fg.muted">{tip.sub}</Text>
        </Box>
      )}
    </Box>
  );
}

function drawDevice(ctx: CanvasRenderingContext2D, x: number, y: number, d: Device, fg: string, color: string, solid: boolean, side: 'left' | 'right', dy: number) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(x - 5, y - 5, 10, 10);
  if (solid) ctx.fill(); else ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = '11px system-ui';
  const label = d.alias ?? `${d.model}${d.deviceId ? ` ${d.deviceId.slice(-4)}` : ''}`;
  ctx.textAlign = side === 'right' ? 'left' : 'right';
  ctx.fillText(label, side === 'right' ? x + 9 : x - 9, y + 4 + dy);
  ctx.textAlign = 'left';
}
