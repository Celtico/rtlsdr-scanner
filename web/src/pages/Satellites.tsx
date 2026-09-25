import { Alert, Badge, Box, Button, Card, Field, HStack, IconButton, Image, Input, NativeSelect, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LuCalendarClock, LuCircleStop, LuHouse, LuImage, LuInfo, LuPlay, LuRefreshCw, LuSatellite, LuTrash2, LuX } from 'react-icons/lu';
import { DEFAULT_HOME, type SatCapture, type SatInfo, type SatPass } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatAgo, formatDateTime, formatDuration, formatMHz, formatTime } from '@/lib/format';
import { compassLabel } from '@/lib/geo';
import { toaster } from '@/components/ui/toaster';
import { Markdown } from '@/components/Markdown';
import { Tooltip } from '@/components/ui/tooltip';

const HOME_KEY = 'sdr-home';
function readHome(): { lat: number; lon: number } {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) ?? 'null') as { lat: number; lon: number } | null;
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
  } catch { /* ignore */ }
  return DEFAULT_HOME;
}

const STATUS: Record<SatCapture['status'], { label: string; palette: string }> = {
  scheduled: { label: 'Programada', palette: 'blue' },
  running: { label: 'Capturant', palette: 'brand' },
  done: { label: 'Imatges', palette: 'green' },
  failed: { label: 'Sense imatges', palette: 'red' },
  cancelled: { label: 'Cancel·lada', palette: 'gray' },
};

function elevationPalette(el: number): string {
  return el >= 50 ? 'green' : el >= 25 ? 'yellow' : 'gray';
}

export function Satellites() {
  const { status, satCaptures, stop, busy } = useSdr();
  const now = useNow(10_000);
  const [home, setHome] = useState(readHome);
  const [latTxt, setLatTxt] = useState(String(home.lat));
  const [lonTxt, setLonTxt] = useState(String(home.lon));
  const [sats, setSats] = useState<SatInfo[]>([]);
  const [satdump, setSatdump] = useState<boolean | null>(null);
  const [passes, setPasses] = useState<(SatPass & { captureId: number | null })[] | null>(null);
  const [tleAt, setTleAt] = useState<number | null>(null);
  const [passErr, setPassErr] = useState<string | null>(null);
  const [sort, setSort] = useState<'time' | 'elevation'>('elevation');
  const [gain, setGain] = useState(40.2);
  const [openCapture, setOpenCapture] = useState<SatCapture | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [antenna, setAntenna] = useState<string | null>(null);
  useEffect(() => { api.satAntenna().then((r) => setAntenna(r.markdown)).catch(() => setAntenna(null)); }, []);

  useEffect(() => { try { localStorage.setItem(HOME_KEY, JSON.stringify(home)); } catch { /* ignore */ } }, [home]);

  const loadPasses = useCallback(async () => {
    setPassErr(null);
    try {
      const r = await api.satPasses(home.lat, home.lon);
      setPasses(r.passes);
      setTleAt(r.tleFetchedAt);
    } catch (e) {
      setPassErr((e as Error).message);
      setPasses([]);
    }
  }, [home]);

  useEffect(() => {
    api.satInfo().then((i) => { setSats(i.satellites); setSatdump(i.satdump); }).catch(() => setSatdump(false));
  }, []);
  useEffect(() => { void loadPasses(); }, [loadPasses, satCaptures.length]);

  const applyHome = () => {
    const lat = Number(latTxt);
    const lon = Number(lonTxt);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) setHome({ lat, lon });
  };

  const sorted = useMemo(() => {
    const list = (passes ?? []).filter((p) => p.los > now);
    return sort === 'elevation' ? [...list].sort((a, b) => b.maxElevationDeg - a.maxElevationDeg) : list;
  }, [passes, sort, now]);

  const schedule = async (p: SatPass) => {
    try {
      await api.satSchedule({ satellite: p.satellite, aos: p.aos, los: p.los, maxElevationDeg: p.maxElevationDeg, gainDb: gain });
      toaster.create({ title: 'Captura programada', description: `${p.satellite} a les ${formatTime(p.aos)}`, type: 'success', duration: 3000 });
      await loadPasses();
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut programar', description: (e as Error).message, type: 'error', closable: true });
    }
  };
  const cancel = async (id: number) => {
    try {
      await api.satCancel(id);
      await loadPasses();
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut cancel·lar', description: (e as Error).message, type: 'error' });
    }
  };
  const captureNow = async (s: SatInfo) => {
    try {
      await api.satSchedule({ satellite: s.name, now: true, gainDb: gain });
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut iniciar', description: (e as Error).message, type: 'error', closable: true });
    }
  };

  const running = status?.mode === 'satellite';
  const runningCfg = running && status.config && 'captureId' in status.config ? status.config : null;
  const withImages = satCaptures.filter((c) => c.images.length);

  return (
    <Stack gap="4">
      <Alert.Root status="warning" variant="subtle">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Amb l’antena vareta els resultats seran pobres</Alert.Title>
          <Alert.Description>
            Per a imatges decents cal una antena de 137 MHz: una <b>V-dipole</b> (dos braços de 53,4 cm en V a 120°, horitzontal, obertura nord-sud) o una QFH. Les mides i el muntatge són a la targeta «Antena V-dipole» d’aquesta pàgina (font: <code>reference/antena-137mhz.md</code>).
            Passos amb elevació màxima alta (&gt; 40°) i sense edificis al voltant. SatDump descodifica en acabar el pas.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>

      {satdump === false && (
        <Alert.Root status="error" variant="subtle">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>SatDump no està instal·lat</Alert.Title>
            <Alert.Description>Instal·la’l amb <code>brew install satdump</code> i reinicia el servidor. La predicció de passos funciona igualment.</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <HStack justify="space-between" flexWrap="wrap" gap="3" align="end">
            <HStack gap="2" flexWrap="wrap" align="end">
              <Box color="fg.muted" pb="2"><LuHouse /></Box>
              <Field.Root w="32"><Field.Label fontSize="xs">Latitud</Field.Label><Input size="sm" value={latTxt} onChange={(e) => setLatTxt(e.target.value)} inputMode="decimal" onBlur={applyHome} onKeyDown={(e) => { if (e.key === 'Enter') applyHome(); }} /></Field.Root>
              <Field.Root w="32"><Field.Label fontSize="xs">Longitud</Field.Label><Input size="sm" value={lonTxt} onChange={(e) => setLonTxt(e.target.value)} inputMode="decimal" onBlur={applyHome} onKeyDown={(e) => { if (e.key === 'Enter') applyHome(); }} /></Field.Root>
              <Field.Root w="28">
                <Field.Label fontSize="xs">Guany (dB)</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field aria-label="Guany" value={String(gain)} onChange={(e) => setGain(Number(e.target.value))}>
                    {[20.7, 29.7, 33.8, 40.2, 44.5, 49.6].map((g) => <option key={g} value={g}>{g}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              <Field.Root w="36">
                <Field.Label fontSize="xs">Ordena per</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field aria-label="Ordre" value={sort} onChange={(e) => setSort(e.target.value as 'time' | 'elevation')}>
                    <option value="elevation">Elevació màxima</option>
                    <option value="time">Hora</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
            </HStack>
            <HStack>
              {tleAt && <Text fontSize="xs" color="fg.muted">TLE de Celestrak {formatAgo(tleAt, now)}</Text>}
              <Tooltip content="Torna a calcular els passos">
                <IconButton aria-label="Actualitza" size="sm" variant="ghost" onClick={loadPasses}><LuRefreshCw /></IconButton>
              </Tooltip>
              {running && runningCfg && (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura {runningCfg.satellite}</Button>
              )}
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, xl: 3 }} gap="4">
        <Card.Root size="sm" minW="0" overflow="hidden" gridColumn={{ base: 'auto', xl: 'span 2' }}>
          <Card.Header>
            <Card.Title>Propers passos (24 h)</Card.Title>
            <Card.Description>NOAA-15/19 (APT) i Meteor-M2 3/4 (LRPT) sobre casa, elevació mínima 10°. Com més alta l’elevació, millor la imatge.</Card.Description>
          </Card.Header>
          <Card.Body p="0">
            {passErr && <Text color="red.fg" p="4" fontSize="sm">{passErr}</Text>}
            {passes === null ? (
              <Text color="fg.muted" p="6" textAlign="center">Calculant passos…</Text>
            ) : sorted.length ? (
              <Box overflowX="auto">
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Satèl·lit</Table.ColumnHeader>
                      <Table.ColumnHeader>Inici</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">Durada</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">Elev. màx.</Table.ColumnHeader>
                      <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Trajecte</Table.ColumnHeader>
                      <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Freq.</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">Captura</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {sorted.map((p) => {
                      const info = sats.find((s) => s.name === p.satellite);
                      const cap = p.captureId != null ? satCaptures.find((c) => c.id === p.captureId) : undefined;
                      const inProgress = p.aos <= now && p.los > now;
                      return (
                        <Table.Row key={p.id}>
                          <Table.Cell>
                            <HStack gap="2"><Text fontWeight="semibold">{p.satellite}</Text>{info && <Badge variant="outline" size="sm">{info.kind}</Badge>}{inProgress && <Badge colorPalette="brand" size="sm">ara</Badge>}</HStack>
                          </Table.Cell>
                          <Table.Cell whiteSpace="nowrap">{formatDateTime(p.aos)}</Table.Cell>
                          <Table.Cell textAlign="end">{Math.round(p.durationS / 60)} min</Table.Cell>
                          <Table.Cell textAlign="end"><Badge colorPalette={elevationPalette(p.maxElevationDeg)} variant="subtle">{p.maxElevationDeg.toFixed(0)}°</Badge></Table.Cell>
                          <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontSize="xs" color="fg.muted">{compassLabel(p.aosAzimuthDeg)} ({p.aosAzimuthDeg}°) → {compassLabel(p.losAzimuthDeg)} ({p.losAzimuthDeg}°)</Table.Cell>
                          <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontFamily="mono" fontSize="xs">{info ? formatMHz(info.freqHz) : '—'}</Table.Cell>
                          <Table.Cell textAlign="end">
                            {cap ? (
                              <HStack justify="flex-end" gap="1">
                                <Badge colorPalette={STATUS[cap.status].palette} variant="subtle">{STATUS[cap.status].label}</Badge>
                                {(cap.status === 'scheduled' || cap.status === 'running') && (
                                  <Tooltip content="Cancel·la">
                                    <IconButton aria-label="Cancel·la" size="xs" variant="ghost" colorPalette="red" onClick={() => cancel(cap.id)}><LuX /></IconButton>
                                  </Tooltip>
                                )}
                              </HStack>
                            ) : (
                              <Button size="xs" variant="subtle" colorPalette="brand" onClick={() => schedule(p)} disabled={satdump === false}>
                                {inProgress ? <><LuPlay /> Captura ara</> : <><LuCalendarClock /> Programa</>}
                              </Button>
                            )}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </Box>
            ) : (
              <Text color="fg.muted" p="6" textAlign="center">Cap pas per sobre de 10° en les properes 24 h.</Text>
            )}
          </Card.Body>
        </Card.Root>

        <Stack gap="4">
          <Card.Root size="sm">
            <Card.Header><Card.Title>Satèl·lits</Card.Title></Card.Header>
            <Card.Body>
              <Stack gap="3">
                {sats.map((s) => (
                  <Box key={s.name} fontSize="sm">
                    <HStack justify="space-between">
                      <HStack gap="2"><Box color="brand.fg"><LuSatellite /></Box><Text fontWeight="semibold">{s.name}</Text><Badge variant="outline" size="sm">{s.kind}</Badge></HStack>
                      <Tooltip content="Captura 15 min ara mateix (prova de l’equip)">
                        <IconButton aria-label={`Captura ara ${s.name}`} size="xs" variant="ghost" onClick={() => captureNow(s)} disabled={satdump === false || running}><LuPlay /></IconButton>
                      </Tooltip>
                    </HStack>
                    <Text fontSize="xs" color="fg.muted" fontFamily="mono">{formatMHz(s.freqHz)} · {s.pipeline}</Text>
                    {s.note && <Text fontSize="xs" color="fg.muted">{s.note}</Text>}
                  </Box>
                ))}
              </Stack>
            </Card.Body>
          </Card.Root>
          {antenna && (
            <Card.Root size="sm" minW="0" overflow="hidden">
              <Card.Header><Card.Title>Antena V-dipole per a 137 MHz</Card.Title><Card.Description>Mides i muntatge (reference/antena-137mhz.md).</Card.Description></Card.Header>
              <Card.Body pt="0"><Markdown text={antenna} /></Card.Body>
            </Card.Root>
          )}
          <Card.Root size="sm" variant="subtle">
            <Card.Body>
              <HStack align="flex-start" gap="2" fontSize="xs" color="fg.muted">
                <Box mt="0.5"><LuInfo /></Box>
                <Text>
                  <b>1698 MHz</b>: l’escombrat va detectar activitat a 1698 MHz, la banda HRPT dels satèl·lits meteorològics (imatges d’alta resolució). Rebre-la demana una parabòlica amb seguiment i un LNA: queda fora d’aquesta secció.
                </Text>
              </HStack>
            </Card.Body>
          </Card.Root>
        </Stack>
      </SimpleGrid>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Header>
          <HStack justify="space-between" flexWrap="wrap">
            <Box>
              <Card.Title>Galeria</Card.Title>
              <Card.Description>Imatges descodificades per SatDump a <code>data/satellite/</code>.</Card.Description>
            </Box>
            <Text fontSize="xs" color="fg.muted">{satCaptures.length} captures · {withImages.length} amb imatges</Text>
          </HStack>
        </Card.Header>
        <Card.Body>
          {satCaptures.length ? (
            <Stack gap="4">
              {satCaptures.map((c) => (
                <Box key={c.id} borderWidth="1px" borderColor="border" rounded="md" p="3">
                  <HStack justify="space-between" flexWrap="wrap" gap="2">
                    <HStack gap="2" flexWrap="wrap">
                      <Text fontWeight="semibold">{c.satellite}</Text>
                      <Badge colorPalette={STATUS[c.status].palette} variant="subtle">{STATUS[c.status].label}</Badge>
                      <Text fontSize="sm" color="fg.muted">{formatDateTime(c.aos)} · {formatDuration(c.los - c.aos)} · elev. {c.maxElevationDeg.toFixed(0)}° · {formatMHz(c.freqHz)} · guany {c.gainDb} dB</Text>
                    </HStack>
                    <HStack gap="1">
                      {c.log && (
                        <Button size="xs" variant="ghost" onClick={() => setOpenCapture(openCapture?.id === c.id ? null : c)}>{openCapture?.id === c.id ? 'Amaga el registre' : 'Registre'}</Button>
                      )}
                      {c.status !== 'running' && (
                        <Tooltip content={c.status === 'scheduled' ? 'Cancel·la' : 'Elimina de la llista'}>
                          <IconButton aria-label="Elimina" size="xs" variant="ghost" colorPalette="red" onClick={() => cancel(c.id)}><LuTrash2 /></IconButton>
                        </Tooltip>
                      )}
                    </HStack>
                  </HStack>
                  {openCapture?.id === c.id && c.log && (
                    <Box as="pre" mt="2" fontSize="xs" bg="bg.subtle" p="2" rounded="sm" overflowX="auto" maxH="48" overflowY="auto" whiteSpace="pre-wrap">{c.log}</Box>
                  )}
                  {c.images.length ? (
                    <SimpleGrid columns={{ base: 2, md: 4, lg: 6 }} gap="2" mt="3">
                      {c.images.map((img) => (
                        <Box key={img} as="button" onClick={() => setImage(api.satImageUrl(c.id, img))} rounded="sm" overflow="hidden" borderWidth="1px" borderColor="border" bg="bg.subtle" cursor="zoom-in">
                          <Image src={api.satImageUrl(c.id, img)} alt={`${c.satellite} ${img}`} w="full" h="28" objectFit="cover" loading="lazy" />
                          <Text fontSize="10px" color="fg.muted" px="1" truncate>{img.split('/').pop()}</Text>
                        </Box>
                      ))}
                    </SimpleGrid>
                  ) : (
                    c.status === 'done' ? null : <HStack mt="2" gap="1" fontSize="xs" color="fg.muted"><LuImage /><Text>{c.status === 'running' ? 'Capturant… les imatges apareixen en acabar el pas.' : c.status === 'scheduled' ? `Es llançarà automàticament a les ${formatTime(c.aos)}.` : 'Cap imatge.'}</Text></HStack>
                  )}
                </Box>
              ))}
            </Stack>
          ) : (
            <Text color="fg.muted" py="6" textAlign="center">Encara no hi ha cap captura. Programa un pas de la llista.</Text>
          )}
        </Card.Body>
      </Card.Root>

      {image && (
        <Box position="fixed" inset="0" bg="blackAlpha.800" zIndex="modal" display="grid" placeItems="center" p="4" onClick={() => setImage(null)} cursor="zoom-out">
          <Image src={image} alt="Imatge de satèl·lit" maxW="100%" maxH="100%" objectFit="contain" />
        </Box>
      )}
    </Stack>
  );
}
