import { Alert, Badge, Box, Button, Card, Field, HStack, IconButton, NativeSelect, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { LuCircleStop, LuContainer, LuPlay, LuRadioTower, LuVolume2 } from 'react-icons/lu';
import { DAB_CHANNELS, DEFAULT_DAB } from '@shared/types';
import { useSdr } from '@/store';
import { api, type DabMux } from '@/lib/api';
import { formatMHz } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';
import { toaster } from '@/components/ui/toaster';

export function Dab() {
  const { status, setMode, stop, busy } = useSdr();
  const [params] = useSearchParams();
  const [channel, setChannel] = useState(() => {
    const q = params.get('ch')?.toUpperCase();
    return q && DAB_CHANNELS.some((c) => c.name === q) ? q : DEFAULT_DAB.channel;
  });
  const [state, setState] = useState<{ running: boolean; ready?: boolean; mux: DabMux | null; log: string[] } | null>(null);
  const [playingSid, setPlayingSid] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const running = status?.mode === 'dab';
  const runningCfg = running && status.config && 'channel' in status.config ? status.config : null;
  const dockerOk = status?.tools.docker ?? false;

  const poll = useCallback(async () => {
    try { setState(await api.dabMux()); } catch { /* keep last */ }
  }, []);
  useEffect(() => {
    void poll();
    const t = setInterval(poll, running ? 2000 : 10_000);
    return () => clearInterval(t);
  }, [poll, running]);
  useEffect(() => { if (runningCfg) setChannel(runningCfg.channel); }, [runningCfg]);
  useEffect(() => { if (!running) { setPlayingSid(null); audioRef.current?.pause(); } }, [running]);

  const start = () => setMode({ mode: 'dab', config: { channel, gainDb: null } });
  const retune = async (ch: string) => {
    setChannel(ch);
    if (!running) return;
    try {
      await api.dabChannel(ch);
      setPlayingSid(null);
      audioRef.current?.pause();
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut canviar de bloc', description: (e as Error).message, type: 'error' });
    }
  };
  const play = (sid: string) => {
    const el = audioRef.current;
    if (!el) return;
    el.src = api.dabMp3Url(sid);
    void el.play().catch((e: Error) => toaster.create({ title: 'No es pot reproduir', description: e.message, type: 'error' }));
    setPlayingSid(sid);
  };
  const stopAudio = () => { audioRef.current?.pause(); setPlayingSid(null); };

  const mux = state?.mux ?? null;
  const services = useMemo(() => (mux?.services ?? []).slice().sort((a, b) => a.label.label.localeCompare(b.label.label, 'ca')), [mux]);
  const ensembleLabel = mux?.ensemble?.label?.label?.trim() ?? '';
  const snr = mux?.demodulator?.snr ?? null;
  const synced = !!mux && mux.demodulator?.fic != null && (mux.demodulator.snr ?? 0) > 3;
  const freq = DAB_CHANNELS.find((c) => c.name === channel)?.freqHz ?? 0;

  return (
    <Stack gap="4">
      <Alert.Root status="info" variant="subtle">
        <Alert.Indicator><LuContainer /></Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Descodificador en Docker, dongle al Mac</Alert.Title>
          <Alert.Description>
            El Mac només executa <code>rtl_tcp</code> (osmocom) i publica les mostres per xarxa; <code>welle-cli</code> corre al contenidor <code>rtlsdr-decoders</code> i descodifica DAB/DAB+.
            Cal Docker Desktop en marxa i la imatge construïda (<code>docker build -t rtlsdr-decoders docker/decoders</code>).
            {!dockerOk && <b> Ara mateix Docker no està disponible o falta la imatge.</b>}
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <HStack justify="space-between" flexWrap="wrap" gap="3" align="end">
            <HStack gap="3" flexWrap="wrap" align="end">
              <Field.Root w="40">
                <Field.Label>Bloc (banda III)</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field aria-label="Bloc DAB" value={channel} onChange={(e) => retune(e.target.value)}>
                    {DAB_CHANNELS.map((c) => <option key={c.name} value={c.name}>{c.name} · {(c.freqHz / 1e6).toFixed(3)} MHz</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              {running && (
                <HStack gap="2" flexWrap="wrap">
                  <Badge colorPalette={synced ? 'green' : 'orange'} variant="subtle">{synced ? 'Sincronitzat' : state?.ready ? 'Buscant senyal…' : 'Arrencant el contenidor…'}</Badge>
                  {snr != null && <Badge variant="outline">SNR {snr.toFixed(1)} dB</Badge>}
                  {ensembleLabel && <Badge colorPalette="brand" variant="solid">{ensembleLabel}</Badge>}
                </HStack>
              )}
            </HStack>
            <HStack>
              <Button asChild size="sm" variant="outline"><RouterLink to="/espectre">Escombra la banda III</RouterLink></Button>
              {running ? (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              ) : (
                <Button size="sm" colorPalette="brand" onClick={start} loading={busy} disabled={!dockerOk}><LuPlay /> Sintonitza {channel}</Button>
              )}
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, lg: 3 }} gap="4">
        <Card.Root size="sm" minW="0" overflow="hidden" gridColumn={{ base: 'auto', lg: 'span 2' }}>
          <Card.Header>
            <Card.Title>Programes {ensembleLabel ? `de ${ensembleLabel}` : `del bloc ${channel}`}</Card.Title>
            <Card.Description>{formatMHz(freq)} · l’àudio (MP3) arriba del contenidor a través del servidor.</Card.Description>
          </Card.Header>
          <Card.Body>
            {services.length ? (
              <Stack gap="2">
                {services.map((s) => {
                  const sid = String(s.sid);
                  const active = playingSid === sid;
                  return (
                    <HStack key={sid} justify="space-between" p="2" rounded="md" bg={active ? 'brand.subtle' : 'bg.subtle'}>
                      <Box>
                        <Text fontWeight="semibold">{s.label.label.trim() || sid}</Text>
                        <Text fontSize="xs" color="fg.muted" fontFamily="mono">SId {sid}{s.components?.[0]?.subchannel?.bitrate ? ` · ${s.components[0].subchannel.bitrate} kbit/s` : ''}{s.components?.[0]?.subchannel?.protection ? ` · ${s.components[0].subchannel.protection}` : ''}</Text>
                        {s.dls?.label && <Text fontSize="xs" color="fg.muted">{s.dls.label}</Text>}
                      </Box>
                      <Tooltip content={active ? 'Atura' : 'Escolta'}>
                        <IconButton aria-label={active ? 'Atura' : `Escolta ${s.label.label}`} size="sm" colorPalette={active ? 'red' : 'brand'} variant="subtle" onClick={() => (active ? stopAudio() : play(sid))}>
                          {active ? <LuCircleStop /> : <LuVolume2 />}
                        </IconButton>
                      </Tooltip>
                    </HStack>
                  );
                })}
              </Stack>
            ) : (
              <Box py="8" textAlign="center" color="fg.muted">
                <Box fontSize="2xl" mb="2" display="inline-block"><LuRadioTower /></Box>
                <Text>{running ? (synced ? 'Sincronitzat però encara sense llista de programes.' : 'Cap múltiplex en aquest bloc. Prova’n un altre o escombra la banda III per veure on hi ha senyal.') : 'Sintonitza un bloc per llistar-ne els programes.'}</Text>
                <Text fontSize="xs" mt="2">A Lleida la cobertura DAB és escassa: l’escombrat de la banda III (174–240 MHz) no ha trobat cap múltiplex clar amb l’antena vareta.</Text>
              </Box>
            )}
            <audio ref={audioRef} hidden onEnded={() => setPlayingSid(null)} />
          </Card.Body>
        </Card.Root>

        <Card.Root size="sm" minW="0" overflow="hidden">
          <Card.Header><Card.Title>Registre</Card.Title></Card.Header>
          <Card.Body>
            {state?.log?.length ? (
              <Box as="pre" fontSize="xs" whiteSpace="pre-wrap" maxH="80" overflowY="auto" color="fg.muted">{state.log.join('\n')}</Box>
            ) : (
              <Text fontSize="sm" color="fg.muted">Sense missatges.</Text>
            )}
          </Card.Body>
        </Card.Root>
      </SimpleGrid>
    </Stack>
  );
}
