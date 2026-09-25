import { Alert, Badge, Box, Button, Card, HStack, IconButton, Input, NativeSelect, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { Chart, useChart } from '@chakra-ui/charts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { LuActivity, LuBookmark, LuCircleStop, LuPlay, LuTrash2, LuTriangleAlert, LuZap } from 'react-icons/lu';
import { DEFAULT_SURVEY, type Scan } from '@shared/types';
import { useSdr } from '@/store';
import { api, type EmiResponse } from '@/lib/api';
import { formatAgo, formatDateTime, formatHzShort, formatMHz, formatTime } from '@/lib/format';
import { toaster } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';
import { useUnits } from '@/lib/units';
import { UnitsToggle } from '@/components/UnitsToggle';
import { CalibrationCard } from '@/components/CalibrationCard';

const PRESETS = [
  { label: 'EMI VHF (24–250 MHz, pas 10 kHz): fonts commutades, PLC, pantalles', fromHz: 24e6, toHz: 250e6, stepHz: 10e3 },
  { label: 'EMI complet (24–1700 MHz, pas 100 kHz)', fromHz: 24e6, toHz: 1700e6, stepHz: 100e3 },
  { label: 'EMI UHF (250–1000 MHz, pas 20 kHz)', fromHz: 250e6, toHz: 1000e6, stepHz: 20e3 },
];

export function Noise() {
  const { status, setMode, stop, busy } = useSdr();
  const [scans, setScans] = useState<Scan[]>([]);
  const [scanId, setScanId] = useState<number | null>(null);
  const [data, setData] = useState<EmiResponse | null>(null);
  const [label, setLabel] = useState('');
  const [preset, setPreset] = useState(0);
  const running = status?.mode === 'survey';
  const u = useUnits();

  const loadScans = useCallback(async () => {
    const all = (await api.scans()).filter((s) => s.kind === 'survey' && s.sweeps > 0);
    setScans(all);
    setScanId((cur) => (cur && all.some((s) => s.id === cur) ? cur : all[0]?.id ?? null));
  }, []);
  useEffect(() => { void loadScans(); }, [loadScans, status?.mode]);
  useEffect(() => {
    if (running && status.scanId) setScanId(status.scanId);
  }, [running, status?.scanId]);

  const load = useCallback(async () => {
    if (scanId == null) { setData(null); return; }
    try { setData(await api.emi(scanId)); } catch { /* keep */ }
  }, [scanId]);
  useEffect(() => { void load(); }, [load, status?.counters.sweeps]);

  const report = data?.report ?? null;
  const scanGain = useMemo(() => { const s = scans.find((x) => x.id === scanId); return s && 'gainDb' in s.config ? s.config.gainDb : null; }, [scans, scanId]);
  const cv = useCallback((db: number) => u.value(db, scanGain), [u, scanGain]);
  const chunkRows = useMemo(() => (report?.chunks ?? []).map((c) => {
    const d = data?.delta?.find((x) => x.fromHz === c.fromHz);
    return { mhz: `${Math.round(c.fromHz / 1e6)}`, floor: cv(c.floorDb), baseline: d?.baselineDb != null ? cv(d.baselineDb) : null, p90: cv(c.p90Db) };
  }), [report, data, cv]);
  const chunkChart = useChart({ data: chunkRows, series: [{ name: 'floor', color: 'brand.solid', label: 'Soroll ara' }, { name: 'baseline', color: 'gray.solid', label: 'Línia base' }] });
  const trendRows = useMemo(() => (data?.trend ?? []).map((t) => ({ ts: t.ts, floor: cv(t.floorDb) })), [data, cv]);
  const trendChart = useChart({ data: trendRows, series: [{ name: 'floor', color: 'orange.solid', label: 'Soroll de fons' }] });
  const bandRows = useMemo(() => (report?.bands ?? []).slice().sort((a, b) => b.aboveMinDb - a.aboveMinDb), [report]);
  const deltaSorted = useMemo(() => (data?.delta ?? []).slice().sort((a, b) => a.deltaDb - b.deltaDb), [data]);
  const bestDrop = deltaSorted[0] ?? null;
  const worstRise = deltaSorted[deltaSorted.length - 1] ?? null;

  const startPreset = () => {
    const p = PRESETS[preset]!;
    void setMode({ mode: 'survey', config: { ...DEFAULT_SURVEY, fromHz: p.fromHz, toHz: p.toHz, stepHz: p.stepHz, intervalS: 5 } });
  };
  const setBaseline = async () => {
    if (scanId == null) return;
    try {
      await api.emiSetBaseline(scanId, label || `Escaneig ${scanId}`);
      toaster.create({ title: 'Línia base fixada', description: 'Ara desendolla aparells, fes un altre escombrat i compara.', type: 'success', duration: 4000 });
      await load();
    } catch (e) { toaster.create({ title: 'No s’ha pogut fixar', description: (e as Error).message, type: 'error' }); }
  };
  const clearBaseline = async () => { await api.emiClearBaseline(); await load(); };

  return (
    <Stack gap="4">
      <Alert.Root status="warning" variant="subtle">
        <Alert.Indicator><LuTriangleAlert /></Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Què mesura (i què no) aquesta secció</Alert.Title>
          <Alert.Description>
            Mostra <b>on</b> el soroll de fons de ràdio és més alt del normal a casa i <b>quin tipus d’aparell</b> hi encaixa: fonts d’alimentació commutades, PLC, pantalles, motors.
            Són dB relatius d’un receptor sense calibrar entre 24 MHz i 1,7 GHz: <b>no</b> són V/m ni µW/m², <b>no</b> es poden comparar amb límits de salut (ICNIRP), i no cobreix ni els 50 Hz de la xarxa ni WiFi/mòbil a 2,4 GHz.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <Stack gap="3">
            <HStack justify="space-between" flexWrap="wrap" gap="3" align="end">
              <HStack gap="3" flexWrap="wrap" align="end">
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb="1">Escombrat a analitzar</Text>
                  <NativeSelect.Root size="sm" w="80">
                    <NativeSelect.Field aria-label="Escombrat" value={scanId ?? ''} onChange={(e) => setScanId(Number(e.target.value))}>
                      {scans.map((s) => 'fromHz' in s.config && (
                        <option key={s.id} value={s.id}>#{s.id} · {formatDateTime(s.startedAt)} · {formatHzShort(s.config.fromHz)}–{formatHzShort(s.config.toHz)} · {s.sweeps} esc.</option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb="1">Nou escombrat EMI</Text>
                  <HStack>
                    <NativeSelect.Root size="sm" w="96" disabled={running}>
                      <NativeSelect.Field aria-label="Preajust EMI" value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
                        {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                    {running ? (
                      <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
                    ) : (
                      <Button size="sm" colorPalette="brand" onClick={startPreset} loading={busy}><LuPlay /> Escombra</Button>
                    )}
                  </HStack>
                </Box>
              </HStack>
              <HStack gap="2" flexWrap="wrap" align="end">
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb="1">Línia base (abans/després)</Text>
                  <HStack>
                    <Input size="sm" w="44" placeholder="p. ex. tot endollat" value={label} onChange={(e) => setLabel(e.target.value)} />
                    <Button size="sm" variant="subtle" colorPalette="brand" onClick={setBaseline} disabled={scanId == null}><LuBookmark /> Fixa aquest escaneig</Button>
                    {data?.baseline && (
                      <Tooltip content="Esborra la línia base">
                        <IconButton aria-label="Esborra la línia base" size="sm" variant="ghost" colorPalette="red" onClick={clearBaseline}><LuTrash2 /></IconButton>
                      </Tooltip>
                    )}
                  </HStack>
                </Box>
              </HStack>
            </HStack>
            {data?.baseline && (
              <Text fontSize="xs" color="fg.muted">
                Línia base: escaneig #{data.baseline.scanId} «{data.baseline.label || 'sense nom'}», {formatAgo(data.baseline.takenAt)}.
                {data.delta ? ' Comparant per trams.' : ' No es pot comparar: l’escombrat triat té un rang o pas diferent.'}
              </Text>
            )}
            {!data?.baseline && (
              <Text fontSize="xs" color="fg.muted">Per trobar l’aparell que embruta l’espectre: fixa una línia base amb tot endollat, desendolla un aparell, repeteix el mateix escombrat i mira què baixa.</Text>
            )}
          </Stack>
        </Card.Body>
      </Card.Root>

      {!report ? (
        <Card.Root size="sm"><Card.Body><Text color="fg.muted" py="6" textAlign="center">Cap escombrat per analitzar. Llança un escombrat EMI.</Text></Card.Body></Card.Root>
      ) : (
        <>
          <SimpleGrid columns={{ base: 2, md: 4 }} gap="3">
            <Card.Root size="sm"><Card.Body><HStack justify="space-between"><Text fontSize="xs" color="fg.muted">Soroll de fons global</Text><UnitsToggle gainDb={scanGain} /></HStack><Text fontSize="2xl" fontWeight="bold">{u.fmt(report.floorDb, scanGain)}</Text><Text fontSize="xs" color="fg.muted">tram més net {u.fmt(report.minChunkFloorDb, scanGain)} · {report.sweeps} escombrats{u.units === 'dbm' ? ` · per bin de ${formatHzShort(report.stepHz)}` : ''}</Text></Card.Body></Card.Root>
            <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Pintes d’espuris</Text><Text fontSize="2xl" fontWeight="bold" color={report.combs.length ? 'orange.fg' : 'fg'}>{report.combs.length}</Text><Text fontSize="xs" color="fg.muted">fonts commutades probables</Text></Card.Body></Card.Root>
            <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Trams de banda ampla</Text><Text fontSize="2xl" fontWeight="bold" color={report.broadband.length ? 'orange.fg' : 'fg'}>{report.broadband.length}</Text><Text fontSize="xs" color="fg.muted">soroll pujat ≥ 6 dB en ≥ 15 MHz</Text></Card.Body></Card.Root>
            <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Portadores fixes</Text><Text fontSize="2xl" fontWeight="bold">{report.carriers.length}</Text><Text fontSize="xs" color="fg.muted">fora de bandes de servei</Text></Card.Body></Card.Root>
          </SimpleGrid>

          {data?.delta && (bestDrop || worstRise) && (
            <Card.Root size="sm" variant="subtle" colorPalette={bestDrop && bestDrop.deltaDb <= -3 ? 'green' : 'gray'}>
              <Card.Body>
                <HStack gap="3" flexWrap="wrap">
                  <Box color="colorPalette.fg"><LuZap /></Box>
                  <Text fontSize="sm">
                    Respecte a la línia base: {bestDrop && bestDrop.deltaDb <= -3 ? <>el tram <b>{formatHzShort(bestDrop.fromHz)}–{formatHzShort(bestDrop.toHz)}</b> ha baixat <b>{Math.abs(bestDrop.deltaDb)} dB</b> (l’aparell que has desendollat hi feia soroll)</> : 'cap tram ha baixat més de 3 dB'}
                    {worstRise && worstRise.deltaDb >= 3 && <>; el tram <b>{formatHzShort(worstRise.fromHz)}–{formatHzShort(worstRise.toHz)}</b> ha pujat {worstRise.deltaDb} dB</>}.
                  </Text>
                </HStack>
              </Card.Body>
            </Card.Root>
          )}

          <Card.Root size="sm" minW="0" overflow="hidden">
            <Card.Header>
              <Card.Title>Perfil del soroll de fons</Card.Title>
              <Card.Description>Percentil 20 de cada tram (ignora els senyals que hi ha a sobre), en {u.unitLabel}. Els trams alts són els contaminats.{data?.delta ? ' En gris, la línia base.' : ''} {u.units === 'dbm' && <Text as="span" color="orange.fg">{u.note(scanGain)}.</Text>}</Card.Description>
            </Card.Header>
            <Card.Body>
              <Chart.Root chart={chunkChart} h="64">
                <BarChart responsive data={chunkChart.data} margin={{ left: -10, right: 8 }}>
                  <CartesianGrid stroke={chunkChart.color('border')} vertical={false} />
                  <XAxis dataKey={chunkChart.key('mhz')} stroke={chunkChart.color('border')} fontSize={10} minTickGap={24} tickFormatter={(v: string) => `${v} M`} />
                  <YAxis stroke={chunkChart.color('border')} fontSize={10} domain={['auto', 'auto']} />
                  <RTooltip content={<Chart.Tooltip />} cursor={{ fill: chunkChart.color('bg.muted') }} />
                  <ReferenceLine y={cv(report.minChunkFloorDb)} stroke={chunkChart.color('fg.muted')} strokeDasharray="4 4" />
                  {data?.delta && <Bar dataKey={chunkChart.key('baseline')} fill={chunkChart.color('gray.solid')} isAnimationActive={false} name="Línia base" />}
                  <Bar dataKey={chunkChart.key('floor')} fill={chunkChart.color('brand.solid')} isAnimationActive={false} name="Soroll ara" />
                </BarChart>
              </Chart.Root>
            </Card.Body>
          </Card.Root>

          <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4">
            <Card.Root size="sm" minW="0" overflow="hidden">
              <Card.Header><Card.Title>Fonts detectades</Card.Title><Card.Description>Patrons típics d’interferència local i la seva causa probable.</Card.Description></Card.Header>
              <Card.Body>
                {report.combs.length + report.broadband.length + report.carriers.length === 0 ? (
                  <Text color="fg.muted" fontSize="sm">Cap patró clar d’EMI en aquest escombrat. Bon senyal.</Text>
                ) : (
                  <Stack gap="3" fontSize="sm">
                    {report.combs.map((c, i) => (
                      <HStack key={`c${i}`} align="flex-start" gap="3">
                        <Badge colorPalette="orange" variant="subtle" minW="20" justifyContent="center">pinta</Badge>
                        <Box><Text fontWeight="semibold">{c.count} espuris cada {formatHzShort(c.spacingHz)} entre {formatMHz(c.fromHz, 2)} i {formatMHz(c.toHz, 2)} (+{c.meanExcessDb} dB)</Text><Text color="fg.muted">{c.source}</Text></Box>
                      </HStack>
                    ))}
                    {report.broadband.map((b, i) => (
                      <HStack key={`b${i}`} align="flex-start" gap="3">
                        <Badge colorPalette="red" variant="subtle" minW="20" justifyContent="center">banda ampla</Badge>
                        <Box><Text fontWeight="semibold">{formatHzShort(b.fromHz)}–{formatHzShort(b.toHz)}: soroll +{b.riseDb} dB</Text><Text color="fg.muted">{b.source}</Text></Box>
                      </HStack>
                    ))}
                    {report.carriers.slice(0, 8).map((c, i) => (
                      <HStack key={`p${i}`} align="flex-start" gap="3">
                        <Badge colorPalette="gray" variant="subtle" minW="20" justifyContent="center">portadora</Badge>
                        <Box><Text fontWeight="semibold" fontFamily="mono">{formatMHz(c.freqHz)} · +{c.excessDb} dB sobre el fons{u.units === 'dbm' ? ` (≈ ${u.fmt(report.floorDb + c.excessDb, scanGain)})` : ''} · {formatHzShort(c.widthHz)}</Text><Text color="fg.muted">{c.source}</Text></Box>
                      </HStack>
                    ))}
                  </Stack>
                )}
              </Card.Body>
            </Card.Root>

            <Card.Root size="sm" minW="0" overflow="hidden">
              <Card.Header><Card.Title>Evolució del soroll durant l’escombrat</Card.Title><Card.Description>Soroll de fons global de cada passada. Per veure dia/nit, deixa un escombrat llarg en marxa.</Card.Description></Card.Header>
              <Card.Body>
                {trendRows.length > 1 ? (
                  <Chart.Root chart={trendChart} h="48">
                    <LineChart responsive data={trendChart.data} margin={{ left: -10, right: 8 }}>
                      <CartesianGrid stroke={trendChart.color('border')} vertical={false} />
                      <XAxis dataKey={trendChart.key('ts')} tickFormatter={(v: number) => formatTime(v)} stroke={trendChart.color('border')} fontSize={10} minTickGap={40} />
                      <YAxis stroke={trendChart.color('border')} fontSize={10} domain={['auto', 'auto']} />
                      <RTooltip content={<Chart.Tooltip hideLabel />} />
                      <Line type="monotone" dataKey={trendChart.key('floor')} stroke={trendChart.color('orange.solid')} strokeWidth={2} dot={false} isAnimationActive={false} name="dB" />
                    </LineChart>
                  </Chart.Root>
                ) : <Text color="fg.muted" fontSize="sm">Calen almenys dues passades.</Text>}
              </Card.Body>
            </Card.Root>
          </SimpleGrid>

          <CalibrationCard scans={scans} />

          <Card.Root size="sm" minW="0" overflow="hidden">
            <Card.Header><Card.Title>Soroll per banda</Card.Title><Card.Description>Ordenat pel que sobresurt del tram més net. Les bandes de mòbil i TDT pugen per les emissions dels operadors, no per contaminació local.</Card.Description></Card.Header>
            <Card.Body p="0">
              <Box overflowX="auto">
                <Table.Root size="sm">
                  <Table.Header><Table.Row><Table.ColumnHeader>Banda</Table.ColumnHeader><Table.ColumnHeader textAlign="end">Soroll</Table.ColumnHeader><Table.ColumnHeader textAlign="end">Sobre el mínim</Table.ColumnHeader><Table.ColumnHeader>Lectura</Table.ColumnHeader></Table.Row></Table.Header>
                  <Table.Body>
                    {bandRows.map((b) => (
                      <Table.Row key={`${b.band}-${b.fromHz}`}>
                        <Table.Cell><HStack gap="2"><Box color="fg.muted"><LuActivity /></Box><Text>{b.band}</Text></HStack></Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{u.fmt(b.floorDb, scanGain)}</Table.Cell>
                        <Table.Cell textAlign="end"><Badge colorPalette={b.aboveMinDb >= 10 ? 'red' : b.aboveMinDb >= 5 ? 'orange' : 'green'} variant="subtle">+{b.aboveMinDb} dB</Badge></Table.Cell>
                        <Table.Cell fontSize="xs" color="fg.muted">{b.restricted || /TDT|FM|DAB/.test(b.band) ? 'emissions dels operadors (no és soroll local)' : b.aboveMinDb >= 10 ? 'molt per sobre del mínim: revisa aparells propers' : b.aboveMinDb >= 5 ? 'lleugerament contaminada' : 'neta'}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            </Card.Body>
          </Card.Root>
        </>
      )}
    </Stack>
  );
}
