import { Badge, Box, Button, Card, Field, HStack, Input, NativeSelect, Progress, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuCircleStop, LuCrosshair, LuPlay, LuVolume2, LuVolumeX } from 'react-icons/lu';
import { DEFAULT_HUNT, type HuntConfig } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { useHuntFeed, HUNT_WINDOW_MS } from '@/lib/huntFeed';
import { formatAgo, formatTime } from '@/lib/format';

const GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6];
const PRESETS = [
  { label: 'LoRa 868,1 MHz', hz: 868_100_000 },
  { label: 'LoRa 868,3 MHz', hz: 868_300_000 },
  { label: 'LoRa 868,5 MHz', hz: 868_500_000 },
  { label: 'ISM 433,92 MHz', hz: 433_920_000 },
];
const MIN_DB = -60;
const MAX_DB = 0;

function LevelChart({ levels, floor }: { levels: { ts: number; dbfs: number; peakDbfs: number }[]; floor: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => { const cw = e[0]?.contentRect.width; if (cw) setW(Math.floor(cw)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = 160;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(c);
    ctx.fillStyle = cs.getPropertyValue('--h-bg') || '#111';
    ctx.fillRect(0, 0, w, h);
    const now = levels[levels.length - 1]?.ts ?? Date.now();
    const x = (ts: number) => w - ((now - ts) / HUNT_WINDOW_MS) * w;
    const y = (db: number) => h - 4 - ((Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * (h - 8);
    ctx.strokeStyle = cs.getPropertyValue('--h-muted') || '#666';
    ctx.globalAlpha = 0.3;
    for (let db = MIN_DB; db <= MAX_DB; db += 10) { ctx.beginPath(); ctx.moveTo(0, y(db)); ctx.lineTo(w, y(db)); ctx.stroke(); }
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = cs.getPropertyValue('--h-muted') || '#666';
    ctx.font = '10px system-ui';
    for (let db = MIN_DB; db <= MAX_DB; db += 20) ctx.fillText(`${db}`, 2, y(db) - 2);
    ctx.globalAlpha = 1;
    // floor line
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = cs.getPropertyValue('--h-muted') || '#666';
    ctx.beginPath(); ctx.moveTo(0, y(floor)); ctx.lineTo(w, y(floor)); ctx.stroke();
    ctx.setLineDash([]);
    // peak (light) and mean (accent)
    const draw = (key: 'peakDbfs' | 'dbfs', color: string, alpha: number, width: number) => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width;
      ctx.beginPath();
      levels.forEach((l, i) => { const px = x(l.ts); const py = y(l[key]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw('peakDbfs', '#f97316', 0.6, 1);
    draw('dbfs', cs.getPropertyValue('--h-accent') || '#36cfc9', 1, 1.6);
  }, [levels, floor, w]);
  return (
    <Box ref={wrap} rounded="md" overflow="hidden" borderWidth="1px" borderColor="border" css={{ '--h-bg': 'var(--chakra-colors-bg-panel)', '--h-muted': 'var(--chakra-colors-fg-muted)', '--h-accent': 'var(--chakra-colors-brand-solid)' }}>
      <canvas ref={ref} style={{ width: w, height: 160, display: 'block' }} />
    </Box>
  );
}

/** Metal-detector style tone: pitch rises with signal above the floor. */
function useTone(enabled: boolean, dbAboveFloor: number | null) {
  const ctxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  useEffect(() => {
    if (!enabled) {
      oscRef.current?.stop();
      oscRef.current = null;
      void ctxRef.current?.close();
      ctxRef.current = null;
      return;
    }
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 200;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    ctxRef.current = ctx; oscRef.current = osc; gainRef.current = gain;
    return () => { osc.stop(); void ctx.close(); };
  }, [enabled]);
  useEffect(() => {
    const osc = oscRef.current;
    const ctx = ctxRef.current;
    if (!osc || !ctx) return;
    const rel = Math.max(0, Math.min(1, (dbAboveFloor ?? 0) / 40));
    const f = 200 + rel * rel * 2200;
    osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.03);
    gainRef.current?.gain.setTargetAtTime(0.03 + rel * 0.12, ctx.currentTime, 0.05);
  }, [dbAboveFloor]);
}

export function Hunt() {
  const { status, setMode, stop, busy } = useSdr();
  const feed = useHuntFeed();
  const now = useNow(1000);
  const running = status?.mode === 'hunt';
  const runningCfg = running && status.config && 'sampleRate' in status.config ? status.config : null;
  const [freqTxt, setFreqTxt] = useState(String(DEFAULT_HUNT.freqHz / 1e6));
  const [gain, setGain] = useState(DEFAULT_HUNT.gainDb);
  const [bw, setBw] = useState(DEFAULT_HUNT.sampleRate);
  const [sound, setSound] = useState(false);
  useEffect(() => { if (runningCfg) { setFreqTxt(String(runningCfg.freqHz / 1e6)); setGain(runningCfg.gainDb); setBw(runningCfg.sampleRate); } }, [runningCfg]);

  const floor = useMemo(() => {
    if (feed.levels.length < 10) return feed.latest?.dbfs ?? -50;
    const sorted = feed.levels.map((l) => l.dbfs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.1)]!;
  }, [feed.levels, feed.latest]);
  const current = feed.latest?.dbfs ?? null;
  const above = current === null ? null : current - floor;
  useTone(sound && running, above);

  const start = () => {
    const cfg: HuntConfig = { freqHz: Math.round(Number(freqTxt) * 1e6), gainDb: gain, sampleRate: bw };
    void setMode({ mode: 'hunt', config: cfg });
  };
  const pct = current === null ? 0 : Math.max(0, Math.min(100, ((current - MIN_DB) / (MAX_DB - MIN_DB)) * 100));
  const stale = feed.latest ? now - feed.latest.ts > 2000 : true;

  return (
    <Stack gap="4">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <Stack gap="3">
            <HStack gap="3" flexWrap="wrap" align="end">
              <Field.Root w="44">
                <Field.Label>Freqüència (MHz)</Field.Label>
                <Input size="sm" value={freqTxt} onChange={(e) => setFreqTxt(e.target.value)} inputMode="decimal" disabled={running} />
              </Field.Root>
              <Field.Root w="auto">
                <Field.Label>Preajust</Field.Label>
                <NativeSelect.Root size="sm" disabled={running}>
                  <NativeSelect.Field aria-label="Preajust de freqüència" value="" onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) setFreqTxt(String(p.hz / 1e6)); }}>
                    <option value="" disabled>Tria…</option>
                    {PRESETS.map((p, i) => <option key={p.hz} value={i}>{p.label}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              <Field.Root w="28">
                <Field.Label>Guany (dB)</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field aria-label="Guany" value={String(gain)} onChange={(e) => { const g = Number(e.target.value); setGain(g); if (running) void setMode({ mode: 'hunt', config: { freqHz: Math.round(Number(freqTxt) * 1e6), gainDb: g, sampleRate: bw } }); }}>
                    {GAINS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
                <Field.HelperText>A prop del sensor, abaixa’l per no saturar.</Field.HelperText>
              </Field.Root>
              <Field.Root w="36">
                <Field.Label>Amplada</Field.Label>
                <NativeSelect.Root size="sm" disabled={running}>
                  <NativeSelect.Field aria-label="Amplada de banda" value={String(bw)} onChange={(e) => setBw(Number(e.target.value))}>
                    <option value="250000">250 kHz (LoRa)</option>
                    <option value="1024000">1 MHz</option>
                    <option value="2048000">2 MHz</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              <Box flex="1" />
              <Button size="sm" variant={sound ? 'solid' : 'outline'} colorPalette="brand" onClick={() => setSound((s) => !s)} disabled={!running}>
                {sound ? <LuVolume2 /> : <LuVolumeX />} So
              </Button>
              {running ? (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              ) : (
                <Button size="sm" colorPalette="brand" onClick={start} loading={busy}><LuPlay /> Inicia</Button>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              LoRa no es descodifica: només se’n mesura la potència per localitzar el sensor. Els LoRa emeten a ràfegues espaiades (segons o minuts): mou-te a poc a poc i fixa’t en el pic màxim.
              Amb una antena directiva (Yagi 868) la direcció és molt més clara que amb la vareta.
            </Text>
          </Stack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, md: 3 }} gap="4">
        <Card.Root size="sm" gridColumn={{ base: 'auto', md: 'span 2' }}>
          <Card.Body>
            <HStack justify="space-between" align="flex-start" flexWrap="wrap">
              <Box>
                <Text fontSize="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">RSSI ara</Text>
                <HStack align="baseline" gap="2">
                  <Text fontSize={{ base: '5xl', md: '7xl' }} fontWeight="bold" fontVariantNumeric="tabular-nums" lineHeight="1" color={stale ? 'fg.muted' : 'fg'}>
                    {current === null ? '—' : current.toFixed(1)}
                  </Text>
                  <Text fontSize="xl" color="fg.muted">dBFS</Text>
                </HStack>
                <Text fontSize="sm" color="fg.muted" mt="1">
                  {above === null ? 'Sense dades' : `${above >= 0 ? '+' : ''}${above.toFixed(1)} dB sobre el soroll de fons (${floor.toFixed(1)} dBFS)`}
                </Text>
              </Box>
              <Box textAlign="right">
                <Text fontSize="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">Pic màxim</Text>
                <Text fontSize="3xl" fontWeight="bold" fontVariantNumeric="tabular-nums" color="orange.fg">
                  {Number.isFinite(feed.maxDbfs) ? feed.maxDbfs.toFixed(1) : '—'}
                </Text>
                <Text fontSize="xs" color="fg.muted">{feed.maxAt ? `${formatTime(feed.maxAt)} · ${formatAgo(feed.maxAt, now)}` : 'encara cap'}</Text>
              </Box>
            </HStack>
            <Progress.Root value={pct} size="lg" colorPalette={pct > 75 ? 'red' : pct > 45 ? 'orange' : 'brand'} mt="4" aria-label="Nivell RSSI">
              <Progress.Track><Progress.Range /></Progress.Track>
            </Progress.Root>
            <HStack justify="space-between" fontSize="xs" color="fg.muted" mt="1"><Text>{MIN_DB} dBFS</Text><Text>{MAX_DB} dBFS</Text></HStack>
          </Card.Body>
        </Card.Root>
        <Card.Root size="sm">
          <Card.Body>
            <Stack gap="2" fontSize="sm">
              <HStack><Box color="brand.fg"><LuCrosshair /></Box><Text fontWeight="semibold">Com buscar</Text></HStack>
              <Text color="fg.muted">1. Activa el so i camina a poc a poc. El to puja de freqüència com més fort és el senyal.</Text>
              <Text color="fg.muted">2. Quan el pic màxim pugi, atura’t i espera la següent ràfega per confirmar.</Text>
              <Text color="fg.muted">3. Si el nivell arriba prop de 0 dBFS, abaixa el guany: saturat no notaràs diferències.</Text>
              {running && runningCfg && <Badge colorPalette="brand" variant="subtle" alignSelf="flex-start">{(runningCfg.freqHz / 1e6).toFixed(3)} MHz · {runningCfg.sampleRate / 1000} kHz · {runningCfg.gainDb} dB</Badge>}
            </Stack>
          </Card.Body>
        </Card.Root>
      </SimpleGrid>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Header>
          <HStack justify="space-between" flexWrap="wrap">
            <Card.Title>Últims 60 s</Card.Title>
            <HStack gap="3" fontSize="xs" color="fg.muted">
              <HStack gap="1"><Box w="3" h="2px" bg="brand.solid" /><Text>mitjana (100 ms)</Text></HStack>
              <HStack gap="1"><Box w="3" h="2px" bg="#f97316" /><Text>pic (10 ms)</Text></HStack>
              <HStack gap="1"><Box w="3" h="0" borderTopWidth="1px" borderStyle="dashed" borderColor="fg.muted" /><Text>soroll de fons</Text></HStack>
            </HStack>
          </HStack>
        </Card.Header>
        <Card.Body pt="0">
          {feed.levels.length ? <LevelChart levels={feed.levels} floor={floor} /> : <Text color="fg.muted" py="6" textAlign="center">Inicia el mode Hunt per veure el nivell en viu.</Text>}
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
