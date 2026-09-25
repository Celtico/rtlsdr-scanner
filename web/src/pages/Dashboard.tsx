import { Badge, Box, Button, Card, HStack, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { Chart, useChart } from '@chakra-ui/charts';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { LuActivity, LuClock, LuPlane, LuPlay } from 'react-icons/lu';
import { MdSensors } from 'react-icons/md';
import { DEFAULT_DEVICES, DEFAULT_SURVEY } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatAgo, formatDuration, formatMHz } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { RssiBar } from '@/components/RssiBar';

export function Dashboard() {
  const { status, signals, devices, planes, setMode, busy } = useSdr();
  const now = useNow();
  const [scanTimeMs, setScanTimeMs] = useState(0);
  const [baseAt, setBaseAt] = useState(Date.now());

  useEffect(() => {
    api.summary().then((s) => { setScanTimeMs(s.scanTimeMs); setBaseAt(Date.now()); }).catch(() => undefined);
  }, [status?.mode, status?.scanId]);

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
  const idle = status?.mode === 'idle';

  return (
    <Stack gap="6">
      <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="4">
        <StatCard label="Senyals detectats" value={signals.length} help="darrer escombrat" icon={<LuActivity />} />
        <StatCard label="Dispositius únics" value={devices.length} help={`${own} probablement meus`} icon={<MdSensors />} palette="green" />
        <StatCard label="Avions" value={planes.length} help="ADS-B 1090 MHz" icon={<LuPlane />} palette="blue" />
        <StatCard label="Temps d’escaneig" value={formatDuration(scanTime)} help="acumulat" icon={<LuClock />} palette="purple" />
      </SimpleGrid>

      {idle && (
        <Card.Root variant="subtle">
          <Card.Body>
            <HStack justify="space-between" flexWrap="wrap" gap="3">
              <Text color="fg.muted">El dongle està lliure. Què vols fer?</Text>
              <HStack flexWrap="wrap">
                <Button size="sm" colorPalette="brand" onClick={() => setMode({ mode: 'survey', config: DEFAULT_SURVEY })} loading={busy}><LuPlay /> Escombrat complet</Button>
                <Button size="sm" colorPalette="green" variant="subtle" onClick={() => setMode({ mode: 'devices', config: DEFAULT_DEVICES })} loading={busy}><MdSensors /> Dispositius 433/868</Button>
                <Button size="sm" colorPalette="blue" variant="subtle" onClick={() => setMode({ mode: 'adsb', config: { gainDb: null } })} loading={busy}><LuPlane /> Avions</Button>
              </HStack>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}

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
