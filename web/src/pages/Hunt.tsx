import { Badge, Box, Button, Card, Field, HStack, Input, NativeSelect, Progress, SegmentGroup, SimpleGrid, Slider, Stack, Table, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuCircleStop, LuCrosshair, LuHeadphones, LuPlay, LuVolume2, LuVolumeX } from 'react-icons/lu';
import { DEFAULT_HUNT, EU868_CHANNELS_HZ, type HuntConfig } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { useHuntFeed, HUNT_WINDOW_MS } from '@/lib/huntFeed';
import { formatAgo, formatTime } from '@/lib/format';
import { useUnits } from '@/lib/units';
import { UnitsToggle } from '@/components/UnitsToggle';
import { HuntCalibration } from '@/components/HuntCalibration';

const GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6];
const SINGLE_PRESETS = [
  { label: 'LoRa 868,1 MHz', hz: 868_100_000 },
  { label: 'LoRa 868,3 MHz', hz: 868_300_000 },
  { label: 'LoRa 868,5 MHz', hz: 868_500_000 },
  { label: 'ISM 433,92 MHz', hz: 433_920_000 },
];
const MIN_DB = -70;
const MAX_DB = 0;

function LevelChart({ levels, floor, offset = 0 }: { levels: { ts: number; dbfs: number; peakDbfs: number }[]; floor: number; offset?: number }) {
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
    for (let db = MIN_DB; db <= MAX_DB; db += 20) ctx.fillText(`${Math.round(db + offset)}`, 2, y(db) - 2);
    ctx.globalAlpha = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = cs.getPropertyValue('--h-muted') || '#666';
    ctx.beginPath(); ctx.moveTo(0, y(floor)); ctx.lineTo(w, y(floor)); ctx.stroke();
    ctx.setLineDash([]);
    const draw = (key: 'peakDbfs' | 'dbfs', color: string, alpha: number, width: number) => {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width;
      ctx.beginPath();
      levels.forEach((l, i) => { const px = x(l.ts); const py = y(l[key]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw('peakDbfs', '#f97316', 0.6, 1);
    draw('dbfs', cs.getPropertyValue('--h-accent') || '#36cfc9', 1, 1.6);
  }, [levels, floor, w, offset]);
  return (
    <Box ref={wrap} rounded="md" overflow="hidden" borderWidth="1px" borderColor="border" css={{ '--h-bg': 'var(--chakra-colors-bg-panel)', '--h-muted': 'var(--chakra-colors-fg-muted)', '--h-accent': 'var(--chakra-colors-brand-solid)' }}>
      <canvas ref={ref} style={{ width: w, height: 160, display: 'block' }} />
    </Box>
  );
}

/**
 * Metal-detector tone through Web Audio: pitch rises with signal above the floor. A short "tick" marks each burst.
 * The AudioContext is created on the user's click (autoplay policy).
 */
function useTone(enabled: boolean, dbAboveFloor: number | null, volume: number, burstKey: number) {
  const ctxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  useEffect(() => {
    if (!enabled) {
      oscRef.current?.stop();
      oscRef.current = null;
      void ctxRef.current?.close();
      ctxRef.current = null;
      return;
    }
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 200;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(master);
    osc.start();
    ctxRef.current = ctx; oscRef.current = osc; gainRef.current = gain; masterRef.current = master;
    return () => { osc.stop(); void ctx.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => { if (masterRef.current && ctxRef.current) masterRef.current.gain.setTargetAtTime(volume, ctxRef.current.currentTime, 0.05); }, [volume]);
  useEffect(() => {
    const osc = oscRef.current;
    const ctx = ctxRef.current;
    if (!osc || !ctx) return;
    const rel = Math.max(0, Math.min(1, (dbAboveFloor ?? 0) / 40));
    osc.frequency.setTargetAtTime(200 + rel * rel * 2200, ctx.currentTime, 0.03);
    gainRef.current?.gain.setTargetAtTime(0.03 + rel * 0.15, ctx.currentTime, 0.05);
  }, [dbAboveFloor]);
  // burst tick
  useEffect(() => {
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master || !burstKey) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 1800;
    g.gain.value = 0.25;
    o.connect(g).connect(master);
    o.start();
    g.gain.setTargetAtTime(0, ctx.currentTime + 0.05, 0.03);
    o.stop(ctx.currentTime + 0.25);
  }, [burstKey]);
}

export function Hunt() {
  const { status, setMode, stop, busy } = useSdr();
  const feed = useHuntFeed();
  const now = useNow(1000);
  const u = useUnits();
  const running = status?.mode === 'hunt';
  const runningCfg = running && status.config && 'sampleRate' in status.config ? status.config : null;
  const [mode, setModeSel] = useState<'eu868' | 'single'>(DEFAULT_HUNT.mode);
  const [freqTxt, setFreqTxt] = useState('868.1');
  const [gain, setGain] = useState(DEFAULT_HUNT.gainDb);
  const [bw, setBw] = useState(250_000);
  const [sound, setSound] = useState(false);
  const [volume, setVolume] = useState(0.6);
  useEffect(() => {
    if (runningCfg) { setModeSel(runningCfg.mode); setGain(runningCfg.gainDb); if (runningCfg.mode === 'single') { setFreqTxt(String(runningCfg.freqHz / 1e6)); setBw(runningCfg.sampleRate); } }
  }, [runningCfg]);

  const floor = useMemo(() => {
    if (feed.levels.length < 10) return feed.latest?.dbfs ?? -55;
    const sorted = feed.levels.map((l) => l.dbfs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.1)]!;
  }, [feed.levels, feed.latest]);
  const current = feed.latest?.peakDbfs ?? null;
  const above = current === null ? null : current - floor;
  const cv = (db: number) => u.value(db, gain, 'iq');
  const unit = u.label('iq');
  const dbOffset = u.units === 'dbm' ? u.offset(gain, 'iq').offsetDb : 0;
  useTone(sound && running, above, volume, feed.bursts[0]?.ts ?? 0);

  const buildConfig = (g = gain): HuntConfig => (mode === 'eu868'
    ? { mode: 'eu868', freqHz: DEFAULT_HUNT.freqHz, gainDb: g, sampleRate: DEFAULT_HUNT.sampleRate }
    : { mode: 'single', freqHz: Math.round(Number(freqTxt) * 1e6), gainDb: g, sampleRate: bw });
  const start = () => { void setMode({ mode: 'hunt', config: buildConfig() }); };
  const changeGain = (g: number) => { setGain(g); if (running) void setMode({ mode: 'hunt', config: buildConfig(g) }); };
  const pct = current === null ? 0 : Math.max(0, Math.min(100, ((current - MIN_DB) / (MAX_DB - MIN_DB)) * 100));
  const stale = feed.latest ? now - feed.latest.ts > 2000 : true;
  const channels = feed.latest?.channels ?? null;
  const chMax = channels ? Math.max(...channels.map((c) => c.peakDbfs)) : null;

  return (
    <Stack gap="4">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <Stack gap="3">
            <HStack gap="3" flexWrap="wrap" align="end">
              <Field.Root w="auto">
                <Field.Label>Què vigilar</Field.Label>
                <SegmentGroup.Root size="sm" value={mode} onValueChange={(e) => setModeSel(e.value === 'single' ? 'single' : 'eu868')} disabled={running}>
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Items items={[{ value: 'eu868', label: 'LoRaWAN EU868 (8 canals alhora)' }, { value: 'single', label: 'Una freqüència' }]} />
                </SegmentGroup.Root>
              </Field.Root>
              {mode === 'single' && (
                <>
                  <Field.Root w="40">
                    <Field.Label>Freqüència (MHz)</Field.Label>
                    <Input size="sm" value={freqTxt} onChange={(e) => setFreqTxt(e.target.value)} inputMode="decimal" disabled={running} />
                  </Field.Root>
                  <Field.Root w="auto">
                    <Field.Label>Preajust</Field.Label>
                    <NativeSelect.Root size="sm" disabled={running}>
                      <NativeSelect.Field aria-label="Preajust de freqüència" value="" onChange={(e) => { const p = SINGLE_PRESETS[Number(e.target.value)]; if (p) setFreqTxt(String(p.hz / 1e6)); }}>
                        <option value="" disabled>Tria…</option>
                        {SINGLE_PRESETS.map((p, i) => <option key={p.hz} value={i}>{p.label}</option>)}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
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
                </>
              )}
              <Field.Root w="28">
                <Field.Label>Guany (dB)</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field aria-label="Guany" value={String(gain)} onChange={(e) => changeGain(Number(e.target.value))}>
                    {GAINS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
                <Field.HelperText>A prop del sensor, abaixa’l per no saturar.</Field.HelperText>
              </Field.Root>
              <Box flex="1" />
              {running ? (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              ) : (
                <Button size="sm" colorPalette="brand" onClick={start} loading={busy}><LuPlay /> Inicia</Button>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              {mode === 'eu868'
                ? 'Finestra única de 2,4 MHz centrada a 867,8 MHz: els 8 canals de ChirpStack (867,1 … 868,5 MHz) alhora, sense saltar. El sensor va canviant de canal a cada emissió; així no te’n perds cap.'
                : 'Una sola freqüència amb l’amplada triada.'}
              {' '}LoRa/LoRaWAN no es descodifica ni es pot filtrar per DevAddr: qualsevol emissió LoRa al canal compta. A la pràctica, la que es repeteix cada ~10 min és la del sensor.
            </Text>
          </Stack>
        </Card.Body>
      </Card.Root>

      {/* Sound: the main guide */}
      <Card.Root size="sm" minW="0" overflow="hidden" colorPalette="brand" variant={sound ? 'subtle' : 'outline'}>
        <Card.Body>
          <HStack gap="4" flexWrap="wrap" align="center">
            <Button size="lg" variant={sound ? 'solid' : 'outline'} colorPalette="brand" onClick={() => setSound((s) => !s)} disabled={!running} minW="52">
              {sound ? <LuVolume2 /> : <LuVolumeX />} {sound ? 'So activat' : 'Activa el so (guia principal)'}
            </Button>
            <HStack gap="2" minW="56">
              <Box color="fg.muted"><LuHeadphones /></Box>
              <Slider.Root size="sm" w="40" min={0} max={1} step={0.05} value={[volume]} onValueChange={(e) => setVolume(e.value[0] ?? 0.6)} aria-label={['Volum']}>
                <Slider.Control><Slider.Track><Slider.Range /></Slider.Track><Slider.Thumbs /></Slider.Control>
              </Slider.Root>
              <Text fontSize="xs" color="fg.muted">{Math.round(volume * 100)} %</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted" flex="1" minW="60">
              To continu que puja de freqüència com més fort és el senyal (tipus detector de metalls) i un «tic» agut a cada ràfega. Posa’t auriculars i camina a poc a poc sense mirar la pantalla.
            </Text>
          </HStack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, md: 3 }} gap="4">
        <Card.Root size="sm" gridColumn={{ base: 'auto', md: 'span 2' }}>
          <Card.Body>
            <HStack justify="space-between" align="flex-start" flexWrap="wrap">
              <Box>
                <HStack gap="3"><Text fontSize="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">RSSI ara{channels && feed.latest?.strongestHz ? ` · canal ${(feed.latest.strongestHz / 1e6).toFixed(1)} MHz` : ''}</Text><UnitsToggle gainDb={gain} scale="iq" /></HStack>
                <HStack align="baseline" gap="2">
                  <Text fontSize={{ base: '6xl', md: '8xl' }} fontWeight="bold" fontVariantNumeric="tabular-nums" lineHeight="1" color={stale ? 'fg.muted' : 'fg'}>
                    {current === null ? '—' : cv(current).toFixed(1)}
                  </Text>
                  <Text fontSize="xl" color="fg.muted">{unit}</Text>
                </HStack>
                <Text fontSize="sm" color="fg.muted" mt="1">
                  {above === null ? 'Sense dades' : `${above >= 0 ? '+' : ''}${above.toFixed(1)} dB sobre el soroll de fons (${cv(floor).toFixed(1)} ${unit})`}
                  {u.units === 'dbm' && <Text as="span" color="orange.fg"> · {u.note(gain, 'iq')}</Text>}
                </Text>
              </Box>
              <Box textAlign="right">
                <Text fontSize="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">Pic màxim</Text>
                <Text fontSize="4xl" fontWeight="bold" fontVariantNumeric="tabular-nums" color="orange.fg">
                  {Number.isFinite(feed.maxDbfs) ? `${cv(feed.maxDbfs).toFixed(1)} ${unit}` : '—'}
                </Text>
                <Text fontSize="xs" color="fg.muted">{feed.maxAt ? `${formatTime(feed.maxAt)} · ${formatAgo(feed.maxAt, now)}` : 'encara cap'}</Text>
              </Box>
            </HStack>
            <Progress.Root value={pct} size="lg" colorPalette={pct > 75 ? 'red' : pct > 45 ? 'orange' : 'brand'} mt="4" aria-label="Nivell RSSI">
              <Progress.Track><Progress.Range /></Progress.Track>
            </Progress.Root>
            <HStack justify="space-between" fontSize="xs" color="fg.muted" mt="1"><Text>{Math.round(MIN_DB + dbOffset)} {unit}</Text><Text>{Math.round(MAX_DB + dbOffset)} {unit}</Text></HStack>
            {channels && (
              <Box mt="4">
                <Text fontSize="xs" color="fg.muted" mb="2">Els 8 canals EU868 (pic dels últims 100 ms)</Text>
                <HStack gap="2" align="end" h="24">
                  {channels.map((c) => {
                    const h = Math.max(4, ((Math.max(MIN_DB, c.peakDbfs) - MIN_DB) / (MAX_DB - MIN_DB)) * 88);
                    const hot = chMax !== null && c.peakDbfs >= chMax - 0.5 && c.peakDbfs - floor > 6;
                    return (
                      <Box key={c.freqHz} flex="1" textAlign="center">
                        <Box mx="auto" w="full" h={`${h}px`} bg={hot ? 'orange.solid' : 'brand.solid'} opacity={hot ? 1 : 0.6} rounded="sm" transition="height 0.1s" />
                        <Text fontSize="10px" color="fg.muted" mt="1">{(c.freqHz / 1e6).toFixed(1)}</Text>
                        <Text fontSize="10px" fontVariantNumeric="tabular-nums" color={hot ? 'orange.fg' : 'fg.muted'}>{cv(c.peakDbfs).toFixed(0)}</Text>
                      </Box>
                    );
                  })}
                </HStack>
              </Box>
            )}
          </Card.Body>
        </Card.Root>
        <Card.Root size="sm">
          <Card.Body>
            <Stack gap="2" fontSize="sm">
              <HStack><Box color="brand.fg"><LuCrosshair /></Box><Text fontWeight="semibold">Com buscar</Text></HStack>
              <Text color="fg.muted">1. Activa el so, auriculars, i camina a poc a poc amb el portàtil a la mà.</Text>
              <Text color="fg.muted">2. Cada ~10 min el sensor emet una ràfega («tic»): fixa’t on ha pujat el pic i cap a on anaves.</Text>
              <Text color="fg.muted">3. Referència: el gateway el sent a −101 dBm. A prop del sensor l’RSSI pujarà molt per sobre; si el nivell s’acosta a 0 dBFS ({Math.round(dbOffset)} dBm amb el calibratge actual), abaixa el guany.</Text>
              <Text color="fg.muted">4. Direcció: amb una Yagi 868 és clara. Amb la vareta, gira sobre tu mateix tapant l’antena amb el cos: el mínim apunta cap on és el sensor.</Text>
              {running && runningCfg && (
                <Badge colorPalette="brand" variant="subtle" alignSelf="flex-start">
                  {runningCfg.mode === 'eu868' ? '867,1–868,5 MHz · 8 canals · 2,4 MS/s' : `${(runningCfg.freqHz / 1e6).toFixed(3)} MHz · ${runningCfg.sampleRate / 1000} kHz`} · {runningCfg.gainDb} dB
                </Badge>
              )}
            </Stack>
          </Card.Body>
        </Card.Root>
      </SimpleGrid>

      <SimpleGrid columns={{ base: 1, lg: 3 }} gap="4">
        <Card.Root size="sm" minW="0" overflow="hidden" gridColumn={{ base: 'auto', lg: 'span 2' }}>
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
            {feed.levels.length ? <LevelChart levels={feed.levels} floor={floor} offset={dbOffset} /> : <Text color="fg.muted" py="6" textAlign="center">Inicia el mode Hunt per veure el nivell en viu.</Text>}
          </Card.Body>
        </Card.Root>
        <Card.Root size="sm" minW="0" overflow="hidden">
          <Card.Header><Card.Title>Ràfegues detectades</Card.Title><Card.Description>Canal on ha caigut cada emissió i el seu RSSI.</Card.Description></Card.Header>
          <Card.Body p="0">
            {feed.bursts.length ? (
              <Box overflowY="auto" maxH="72">
                <Table.Root size="sm">
                  <Table.Header><Table.Row><Table.ColumnHeader>Hora</Table.ColumnHeader><Table.ColumnHeader>Canal</Table.ColumnHeader><Table.ColumnHeader textAlign="end">RSSI ({unit})</Table.ColumnHeader><Table.ColumnHeader textAlign="end">+fons</Table.ColumnHeader></Table.Row></Table.Header>
                  <Table.Body>
                    {feed.bursts.slice(0, 40).map((b, i) => (
                      <Table.Row key={`${b.ts}-${b.freqHz}-${i}`}>
                        <Table.Cell fontVariantNumeric="tabular-nums">{formatTime(b.ts)}</Table.Cell>
                        <Table.Cell fontFamily="mono">{(b.freqHz / 1e6).toFixed(1)} MHz</Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" fontWeight="semibold">{cv(b.peakDbfs).toFixed(1)}</Table.Cell>
                        <Table.Cell textAlign="end"><Badge colorPalette={b.aboveFloorDb >= 20 ? 'red' : b.aboveFloorDb >= 12 ? 'orange' : 'gray'} variant="subtle">+{b.aboveFloorDb.toFixed(0)} dB</Badge></Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            ) : (
              <Text color="fg.muted" p="4" fontSize="sm">{running ? 'Esperant la primera ràfega…' : 'Cap ràfega encara.'} {EU868_CHANNELS_HZ.length} canals vigilats en mode EU868.</Text>
            )}
          </Card.Body>
        </Card.Root>
      </SimpleGrid>

      <HuntCalibration running={running} gainDb={gain} readingDbfs={feed.latest?.peakDbfs ?? null} readingHz={feed.latest?.strongestHz ?? (runningCfg?.mode === 'single' ? runningCfg.freqHz : null)} />
    </Stack>
  );
}
