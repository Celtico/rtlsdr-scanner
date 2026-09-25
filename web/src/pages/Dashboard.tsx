import { Badge, Box, Button, Card, HStack, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { Chart, useChart } from '@chakra-ui/charts';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { LuActivity, LuCircleStop, LuClock, LuCrosshair, LuPlane, LuPlay, LuSatellite, LuShieldCheck } from 'react-icons/lu';
import { MdSensors } from 'react-icons/md';
import { TbRadar2 } from 'react-icons/tb';
import { DEFAULT_DEVICES, DEFAULT_HOME, DEFAULT_SURVEY, type Scan } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { api, type AuditEntry } from '@/lib/api';
import { formatAgo, formatDateTime, formatDuration, formatMHz, formatTime } from '@/lib/format';
import { distanceKm, compassLabel, bearingDeg } from '@/lib/geo';
import { MODE_LABEL } from '@/lib/labels';
import { StatCard } from '@/components/StatCard';
import { SummaryCard } from '@/components/SummaryCard';
import { RssiBar } from '@/components/RssiBar';

function readHome(): { lat: number; lon: number } {
  try {
    const v = JSON.parse(localStorage.getItem('sdr-home') ?? 'null') as { lat: number; lon: number } | null;
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
  } catch { /* ignore */ }
  return DEFAULT_HOME;
}

function describeConfig(status: NonNullable<ReturnType<typeof useSdr>['status']>): string {
  const c = status.config;
  if (!c) return '';
  if ('fromHz' in c) return `${formatMHz(c.fromHz, 0)} – ${formatMHz(c.toHz, 0)} · llindar ${c.thresholdDb} dB`;
  if ('freqsHz' in c) return c.freqsHz.map((f) => formatMHz(f, 2)).join(' + ');
  if ('captureId' in c) return `${c.satellite} · ${formatMHz(c.freqHz)}`;
  if ('sampleRate' in c) return `${formatMHz(c.freqHz)} · ${c.sampleRate / 1000} kHz`;
  if ('freqHz' in c) return `${formatMHz(c.freqHz, 1)} FM`;
  return '1090 MHz';
}

export function Dashboard() {
  const { status, signals, devices, planes, satCaptures, setMode, stop, busy } = useSdr();
  const now = useNow();
  const [scanTimeMs, setScanTimeMs] = useState(0);
  const [baseAt, setBaseAt] = useState(Date.now());
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [lastHunt, setLastHunt] = useState<Scan | null>(null);

  useEffect(() => {
    api.summary().then((s) => { setScanTimeMs(s.scanTimeMs); setBaseAt(Date.now()); }).catch(() => undefined);
    api.scans().then((scans) => setLastHunt(scans.find((s) => s.kind === 'hunt' && s.endedAt) ?? null)).catch(() => undefined);
  }, [status?.mode, status?.scanId]);
  useEffect(() => {
    api.audit().then(setAudit).catch(() => setAudit([]));
  }, [devices]);

  const scanTime = scanTimeMs + (status?.mode !== 'idle' ? now - baseAt : 0);

  const byBand = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of signals) {
      const k = s.band ?? 'Desconeguda';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([band, count]) => ({ band, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  }, [signals]);

  const chart = useChart({ data: byBand, series: [{ name: 'count', color: 'brand.solid', label: 'Senyals' }] });
  const recent = useMemo(() => [...devices].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, 6), [devices]);
  const own = devices.filter((d) => d.likelyOwn).length;
  const idle = !status || status.mode === 'idle';

  // Audit summary
  const auditPlain = (audit ?? []).filter((e) => e.verdict.exposure === 'plain').length;
  const auditId = (audit ?? []).filter((e) => e.verdict.trackableId).length;
  const auditTop = (audit ?? []).find((e) => e.verdict.priority === 'alta') ?? (audit ?? []).find((e) => e.verdict.priority === 'mitjana') ?? null;

  // Satellites summary
  const nextCapture = useMemo(() => satCaptures.filter((c) => c.status === 'scheduled' && c.los > now).sort((a, b) => a.aos - b.aos)[0] ?? null, [satCaptures, now]);
  const runningCapture = satCaptures.find((c) => c.status === 'running') ?? null;
  const lastImages = useMemo(() => satCaptures.filter((c) => c.images.length).sort((a, b) => b.aos - a.aos)[0] ?? null, [satCaptures]);

  // Radar summary
  const home = useMemo(readHome, []);
  const livePlanes = useMemo(() => planes.filter((p) => p.lat != null && p.lon != null && now - p.lastSeen < 120_000)
    .map((p) => ({ p, km: distanceKm(home.lat, home.lon, p.lat!, p.lon!), brg: bearingDeg(home.lat, home.lon, p.lat!, p.lon!) }))
    .sort((a, b) => a.km - b.km), [planes, home, now]);
  const nearest = livePlanes[0] ?? null;

  const huntSummary = lastHunt?.summary as { maxDbfs: number | null; maxAt: number | null; samples: number } | null | undefined;
  const huntCfg = lastHunt && 'sampleRate' in lastHunt.config ? lastHunt.config : null;

  return (
    <Stack gap="6">
      <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="4">
        <StatCard label="Senyals detectats" value={signals.length} help="darrer escombrat" icon={<LuActivity />} />
        <StatCard label="Dispositius únics" value={devices.length} help={`${own} probablement meus`} icon={<MdSensors />} palette="green" />
        <StatCard label="Avions" value={planes.length} help="ADS-B 1090 MHz" icon={<LuPlane />} palette="blue" />
        <StatCard label="Temps d’escaneig" value={formatDuration(scanTime)} help="acumulat" icon={<LuClock />} palette="purple" />
      </SimpleGrid>

      {/* Current activity */}
      <Card.Root variant="subtle" colorPalette={idle ? 'gray' : 'brand'}>
        <Card.Body>
          <HStack justify="space-between" flexWrap="wrap" gap="3">
            {idle ? (
              <Text color="fg.muted">El dongle està lliure. Què vols fer?</Text>
            ) : (
              <HStack gap="3" flexWrap="wrap">
                <Badge colorPalette="brand" variant="solid" size="lg">{MODE_LABEL[status.mode]}</Badge>
                <Text>{describeConfig(status)}</Text>
                {status.startedAt && <Text color="fg.muted" fontSize="sm">des de {formatTime(status.startedAt)} · {formatDuration(now - status.startedAt)}</Text>}
                {status.mode === 'survey' && <Text fontSize="sm" color="fg.muted">{status.counters.sweeps} escombrats · {status.counters.signals} senyals</Text>}
                {status.mode === 'devices' && <Text fontSize="sm" color="fg.muted">{status.counters.devices} dispositius en aquesta sessió</Text>}
                {status.mode === 'adsb' && <Text fontSize="sm" color="fg.muted">{status.counters.planes} avions en aquesta sessió</Text>}
              </HStack>
            )}
            <HStack flexWrap="wrap">
              {idle ? (
                <>
                  <Button size="sm" colorPalette="brand" onClick={() => setMode({ mode: 'survey', config: DEFAULT_SURVEY })} loading={busy}><LuPlay /> Escombrat complet</Button>
                  <Button size="sm" colorPalette="green" variant="subtle" onClick={() => setMode({ mode: 'devices', config: DEFAULT_DEVICES })} loading={busy}><MdSensors /> Dispositius 433/868</Button>
                  <Button size="sm" colorPalette="blue" variant="subtle" onClick={() => setMode({ mode: 'adsb', config: { gainDb: null } })} loading={busy}><LuPlane /> Avions</Button>
                </>
              ) : (
                <Button size="sm" colorPalette="red" variant="subtle" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              )}
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* Section summaries */}
      <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} gap="4">
        <SummaryCard title="Auditoria" to="/auditoria" icon={<LuShieldCheck />} palette={auditPlain ? 'red' : 'green'}>
          {audit === null ? (
            <Text color="fg.muted">Carregant…</Text>
          ) : audit.length ? (
            <Stack gap="1">
              <HStack gap="2" flexWrap="wrap">
                <Badge colorPalette={auditPlain ? 'red' : 'green'} variant="subtle">{auditPlain} en clar</Badge>
                <Badge colorPalette={auditId ? 'orange' : 'gray'} variant="subtle">{auditId} amb ID fix</Badge>
                <Badge colorPalette="green" variant="subtle">{audit.filter((e) => e.verdict.exposure === 'rolling').length} codi variable</Badge>
              </HStack>
              {auditTop ? (
                <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                  <b>Prioritat {auditTop.verdict.priority}</b> · {auditTop.device.alias ?? auditTop.device.model}: {auditTop.verdict.recommendation}
                </Text>
              ) : (
                <Text fontSize="xs" color="fg.muted">Cap acció recomanada: tot el que és teu va amb codi variable.</Text>
              )}
            </Stack>
          ) : (
            <Text color="fg.muted">Cap dispositiu marcat com a meu.</Text>
          )}
        </SummaryCard>

        <SummaryCard title="Satèl·lits" to="/satellits" icon={<LuSatellite />} palette="orange">
          <Stack gap="1">
            {runningCapture ? (
              <Text><Badge colorPalette="brand" variant="solid" size="sm">capturant</Badge> {runningCapture.satellite} fins a les {formatTime(runningCapture.los)}</Text>
            ) : nextCapture ? (
              <Text>Proper: <b>{nextCapture.satellite}</b> {formatDateTime(nextCapture.aos)} · {nextCapture.maxElevationDeg.toFixed(0)}°</Text>
            ) : (
              <Text color="fg.muted">Cap captura programada.</Text>
            )}
            <Text fontSize="xs" color="fg.muted">
              {lastImages ? `Última amb imatges: ${lastImages.satellite}, ${formatAgo(lastImages.aos, now)} (${lastImages.images.length} imatges)` : 'Encara cap imatge.'}
              {satCaptures.filter((c) => c.status === 'scheduled').length > 1 && ` · ${satCaptures.filter((c) => c.status === 'scheduled').length} programades`}
            </Text>
          </Stack>
        </SummaryCard>

        <SummaryCard title="Hunt" to="/hunt" icon={<LuCrosshair />} palette="purple">
          {status?.mode === 'hunt' ? (
            <Text><Badge colorPalette="brand" variant="solid" size="sm">en marxa</Badge> {describeConfig(status)}</Text>
          ) : lastHunt && huntCfg ? (
            <Stack gap="1">
              <Text>Última sessió: <b>{formatMHz(huntCfg.freqHz)}</b> · guany {huntCfg.gainDb} dB</Text>
              <Text fontSize="xs" color="fg.muted">
                {huntSummary?.maxDbfs != null ? `Pic màxim ${huntSummary.maxDbfs.toFixed(1)} dBFS${huntSummary.maxAt ? ` a les ${formatTime(huntSummary.maxAt)}` : ''}` : 'Sense pic registrat'} · {formatAgo(lastHunt.endedAt ?? lastHunt.startedAt, now)}
              </Text>
            </Stack>
          ) : (
            <Text color="fg.muted">Cap sessió encara. Per localitzar els LoRa de 868 MHz.</Text>
          )}
        </SummaryCard>

        <SummaryCard title="Radar" to="/radar" icon={<TbRadar2 />} palette="blue">
          <Stack gap="1">
            <Text><b>{livePlanes.length}</b> {livePlanes.length === 1 ? 'avió amb posició' : 'avions amb posició'} ara · {devices.length} dispositius en anells RSSI</Text>
            <Text fontSize="xs" color="fg.muted">
              {nearest ? `Més proper: ${nearest.p.callsign ?? nearest.p.icao.toUpperCase()} a ${nearest.km.toFixed(0)} km ${compassLabel(nearest.brg)}${nearest.p.altitudeFt != null ? `, ${nearest.p.altitudeFt.toLocaleString('ca-ES')} ft` : ''}` : status?.mode === 'adsb' ? 'Escoltant ADS-B, cap posició encara.' : 'Inicia ADS-B per veure avions al radar.'}
            </Text>
          </Stack>
        </SummaryCard>
      </SimpleGrid>

      <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4">
        <Card.Root>
          <Card.Header>
            <Card.Title>Senyals per banda</Card.Title>
            <Card.Description>Darrer escombrat de l’espectre</Card.Description>
          </Card.Header>
          <Card.Body>
            {byBand.length ? (
              <Chart.Root chart={chart} h="64">
                <BarChart responsive data={chart.data} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid stroke={chart.color('border')} horizontal={false} />
                  <XAxis type="number" allowDecimals={false} stroke={chart.color('border')} fontSize={11} />
                  <YAxis type="category" dataKey={chart.key('band')} width={170} stroke={chart.color('border')} fontSize={11} tickFormatter={(v: string) => (v.length > 26 ? `${v.slice(0, 25)}…` : v)} />
                  <RTooltip content={<Chart.Tooltip />} cursor={{ fill: chart.color('bg.muted') }} />
                  <Bar dataKey={chart.key('count')} fill={chart.color('brand.solid')} radius={4} isAnimationActive={false} name="Senyals" />
                </BarChart>
              </Chart.Root>
            ) : (
              <Box py="10" textAlign="center" color="fg.muted">
                <Text>Encara no hi ha cap escombrat.</Text>
                <Button asChild size="sm" mt="3" variant="outline"><RouterLink to="/espectre">Ves a l’espectre</RouterLink></Button>
              </Box>
            )}
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Últims dispositius nous</Card.Title>
            <Card.Description>Per ordre de primera detecció</Card.Description>
          </Card.Header>
          <Card.Body>
            {recent.length ? (
              <Stack gap="3">
                {recent.map((d) => (
                  <HStack key={d.id} justify="space-between" gap="3" flexWrap="wrap">
                    <Box minW="0">
                      <HStack gap="2">
                        <Text fontWeight="semibold" truncate>{d.alias ?? d.model}</Text>
                        {d.likelyOwn && <Badge colorPalette="green" variant="subtle" size="sm">meu</Badge>}
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {d.alias ? `${d.model} · ` : ''}{d.deviceId ? `id ${d.deviceId} · ` : ''}{d.freqHz ? formatMHz(d.freqHz) : ''} · vist {d.count}× · {formatAgo(d.lastSeen, now)}
                      </Text>
                    </Box>
                    <RssiBar rssi={d.rssi} />
                  </HStack>
                ))}
                <Button asChild size="sm" variant="ghost" alignSelf="flex-start"><RouterLink to="/dispositius">Tots els dispositius</RouterLink></Button>
              </Stack>
            ) : (
              <Box py="10" textAlign="center" color="fg.muted">
                <Text>Cap dispositiu detectat encara.</Text>
                <Text fontSize="sm">Molts sensors emeten cada 30–60 s; deixa el mode Dispositius uns minuts.</Text>
              </Box>
            )}
          </Card.Body>
        </Card.Root>
      </SimpleGrid>
    </Stack>
  );
}
