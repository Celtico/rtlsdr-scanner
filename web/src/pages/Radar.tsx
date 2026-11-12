import { Badge, Box, Button, Card, Field, HStack, Input, NativeSelect, SegmentGroup, SimpleGrid, Skeleton, Stack, Text } from '@chakra-ui/react';
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { LuHouse, LuPlane, LuPlay } from 'react-icons/lu';
import { MdSensors } from 'react-icons/md';
import { DEFAULT_HOME } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { distanceKm } from '@/lib/geo';
import { RadarCanvas, type RadarFilter } from '@/components/RadarCanvas';
import { altitudeColor } from '@/lib/radar';

// three.js only loads when the 3D view is opened.
const Radar3D = lazy(() => import('@/components/Radar3D').then((m) => ({ default: m.Radar3D })));

const HOME_KEY = 'sdr-home';

function readHome(): { lat: number; lon: number } {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) ?? 'null') as { lat: number; lon: number } | null;
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
  } catch { /* ignore */ }
  return DEFAULT_HOME;
}

const RANGES = [25, 50, 100, 200, 400];

export function Radar() {
  const { planes, devices, trails, status, setMode, busy } = useSdr();
  const now = useNow(2000);
  const [home, setHome] = useState(readHome);
  const [latTxt, setLatTxt] = useState(String(home.lat));
  const [lonTxt, setLonTxt] = useState(String(home.lon));
  const [filter, setFilter] = useState<RadarFilter>('all');
  const [range, setRange] = useState<'auto' | number>('auto');
  const [view, setView] = useState<'2d' | '3d'>('2d');

  useEffect(() => {
    try { localStorage.setItem(HOME_KEY, JSON.stringify(home)); } catch { /* ignore */ }
  }, [home]);

  const applyHome = () => {
    const lat = Number(latTxt);
    const lon = Number(lonTxt);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) setHome({ lat, lon });
  };

  const positioned = useMemo(() => planes.filter((p) => p.lat != null && p.lon != null), [planes]);
  const autoRange = useMemo(() => {
    const maxKm = positioned.reduce((m, p) => Math.max(m, distanceKm(home.lat, home.lon, p.lat!, p.lon!)), 0);
    return RANGES.find((r) => r >= maxKm * 1.1) ?? RANGES[RANGES.length - 1]!;
  }, [positioned, home]);
  const rangeKm = range === 'auto' ? autoRange : range;
  const shownDevices = useMemo(() => [...devices].sort((a, b) => (b.rssi ?? -99) - (a.rssi ?? -99)).slice(0, 16), [devices]);
  const adsbRunning = status?.mode === 'adsb';

  return (
    <Stack gap="4">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <Stack gap="3">
            <HStack justify="space-between" flexWrap="wrap" gap="3">
              <SegmentGroup.Root value={filter} onValueChange={(e) => setFilter((e.value ?? 'all') as RadarFilter)} size="sm">
                <SegmentGroup.Indicator />
                <SegmentGroup.Items items={[
                  { value: 'all', label: 'Tot' },
                  { value: 'planes', label: `Avions (${positioned.length})` },
                  { value: 'devices', label: `Dispositius (${shownDevices.length})` },
                ]} />
              </SegmentGroup.Root>
              <HStack gap="3" flexWrap="wrap">
                <SegmentGroup.Root value={view} onValueChange={(e) => setView(e.value === '3d' ? '3d' : '2d')} size="sm" aria-label="Vista del radar">
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Items items={[{ value: '2d', label: 'Planta' }, { value: '3d', label: '3D' }]} />
                </SegmentGroup.Root>
                <Field.Root orientation="horizontal" w="auto">
                  <Field.Label fontSize="sm">Abast</Field.Label>
                  <NativeSelect.Root size="sm" w="32">
                    <NativeSelect.Field value={String(range)} onChange={(e) => setRange(e.target.value === 'auto' ? 'auto' : Number(e.target.value))} aria-label="Abast del radar">
                      <option value="auto">Auto ({autoRange} km)</option>
                      {RANGES.map((r) => <option key={r} value={r}>{r} km</option>)}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Field.Root>
                {!adsbRunning && (
                  <Button size="sm" colorPalette="brand" variant="subtle" onClick={() => setMode({ mode: 'adsb', config: { gainDb: null } })} loading={busy}>
                    <LuPlay /> Escolta avions
                  </Button>
                )}
              </HStack>
            </HStack>
            <HStack gap="2" flexWrap="wrap" align="end">
              <Box color="fg.muted"><LuHouse /></Box>
              <Field.Root w="36">
                <Field.Label fontSize="xs">Casa · latitud</Field.Label>
                <Input size="sm" value={latTxt} onChange={(e) => setLatTxt(e.target.value)} inputMode="decimal" onBlur={applyHome} onKeyDown={(e) => { if (e.key === 'Enter') applyHome(); }} />
              </Field.Root>
              <Field.Root w="36">
                <Field.Label fontSize="xs">longitud</Field.Label>
                <Input size="sm" value={lonTxt} onChange={(e) => setLonTxt(e.target.value)} inputMode="decimal" onBlur={applyHome} onKeyDown={(e) => { if (e.key === 'Enter') applyHome(); }} />
              </Field.Root>
              <Button size="sm" variant="outline" onClick={() => { setLatTxt(String(DEFAULT_HOME.lat)); setLonTxt(String(DEFAULT_HOME.lon)); setHome(DEFAULT_HOME); }}>Lleida</Button>
            </HStack>
          </Stack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, xl: 3 }} gap="4">
        <Box gridColumn={{ base: 'auto', xl: 'span 2' }}>
          {view === '3d' ? (
            <Suspense fallback={<Skeleton h="560px" rounded="l2" />}>
              <Radar3D home={home} rangeKm={rangeKm} planes={planes} trails={trails} devices={shownDevices} filter={filter} now={now} />
            </Suspense>
          ) : (
            <RadarCanvas home={home} rangeKm={rangeKm} planes={planes} trails={trails} devices={shownDevices} filter={filter} now={now} />
          )}
        </Box>
        <Card.Root size="sm">
          <Card.Header>
            <Card.Title>Llegenda</Card.Title>
          </Card.Header>
          <Card.Body>
            <Stack gap="4" fontSize="sm">
              <Box>
                <HStack mb="1"><Box color="fg"><LuPlane /></Box><Text fontWeight="semibold">Avions: posició real</Text></HStack>
                <Text color="fg.muted">Situats per rumb i distància calculats des de casa amb la posició GPS que emeten (ADS-B). Fletxa = rumb. Els anells són quilòmetres.</Text>
                <HStack mt="2" gap="2" flexWrap="wrap">
                  {[['< 5.000 ft', 2000], ['5–15k', 10000], ['15–30k', 20000], ['30–40k', 35000], ['> 40k', 45000]].map(([l, ft]) => (
                    <HStack key={String(l)} gap="1"><Box w="3" h="3" rounded="full" bg={altitudeColor(Number(ft))} /><Text fontSize="xs" color="fg.muted">{l}</Text></HStack>
                  ))}
                </HStack>
              </Box>
              <Box>
                <HStack mb="1"><Box color="fg"><MdSensors /></Box><Text fontWeight="semibold">Dispositius: només distància estimada</Text></HStack>
                <Text color="fg.muted">Sensors, comandaments i similars no emeten posició. Es col·loquen en anells puntejats segons la força del senyal (RSSI): com més fort, més a prop del centre. <b>La direcció és desconeguda</b>: es dibuixen al sector ombrejat del sud, que no vol dir que siguin al sud.</Text>
                <Text color="fg.muted" mt="1">Si trobes el pic amb una antena directiva, fixa la direcció al detall del dispositiu i es dibuixarà en aquell angle (quadrat ple).</Text>
                <HStack mt="2" gap="3"><Badge colorPalette="brand" variant="outline">meu</Badge><Badge colorPalette="gray" variant="outline">veí</Badge></HStack>
              </Box>
              {!positioned.length && (
                <Text color="fg.muted" fontSize="xs">Cap avió amb posició encara. Cal rebre una trama parell i una senar del mateix avió en menys de 10 s.</Text>
              )}
            </Stack>
          </Card.Body>
        </Card.Root>
      </SimpleGrid>
    </Stack>
  );
}
