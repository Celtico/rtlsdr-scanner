import { Badge, Box, Button, Card, Field, HStack, IconButton, Input, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';
import { LuRuler, LuTrash2 } from 'react-icons/lu';
import { entryScale } from '@shared/sdr/calibration';
import { useSdr } from '@/store';
import { api } from '@/lib/api';
import { useUnits } from '@/lib/units';
import { formatDateTime, formatMHz } from '@/lib/format';
import { toaster } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';

export interface HuntCalibrationProps {
  running: boolean;
  gainDb: number;
  /** Live reading to calibrate against: the current peak (dBFS) and its channel. */
  readingDbfs: number | null;
  readingHz: number | null;
}

/** Calibration of the Hunt (raw-IQ dBFS) scale: one reference per gain. */
export function HuntCalibration({ running, gainDb, readingDbfs, readingHz }: HuntCalibrationProps) {
  const { calibration, refreshCalibration } = useSdr();
  const u = useUnits();
  const [refTxt, setRefTxt] = useState('');
  const [note, setNote] = useState('');
  const [held, setHeld] = useState<{ dbfs: number; hz: number | null; gain: number } | null>(null);
  const entries = (calibration?.entries ?? []).filter((e) => entryScale(e) === 'iq');
  const info = u.offset(gainDb, 'iq');

  const hold = () => { if (readingDbfs != null) setHeld({ dbfs: readingDbfs, hz: readingHz, gain: gainDb }); };
  const save = async () => {
    const ref = Number(refTxt);
    if (!held || !Number.isFinite(ref)) { toaster.create({ title: 'Cal una lectura retinguda i la referència en dBm', type: 'error' }); return; }
    try {
      await api.calibrationAdd({ scale: 'iq', gainDb: held.gain, freqHz: held.hz ?? 868_100_000, measuredDb: held.dbfs, refDbm: ref, note });
      await refreshCalibration();
      u.setUnits('dbm');
      toaster.create({ title: 'Calibratge del Hunt desat', description: `Offset ${(ref - held.dbfs).toFixed(1)} dB a ${held.gain} dB de guany`, type: 'success', duration: 4000 });
      setHeld(null);
    } catch (e) { toaster.create({ title: 'No s’ha pogut desar', description: (e as Error).message, type: 'error' }); }
  };

  return (
    <Card.Root size="sm" minW="0" overflow="hidden">
      <Card.Header>
        <HStack justify="space-between" flexWrap="wrap">
          <HStack gap="2"><Box color="brand.fg"><LuRuler /></Box><Card.Title>Calibratge del Hunt (dBFS → dBm)</Card.Title></HStack>
          <Badge variant="subtle" colorPalette={entries.length ? 'green' : 'orange'}>
            {info.source === 'calibrated' ? `calibrat a ${info.fromGainDb} dB` : info.source === 'derived' ? `derivat de ${info.fromGainDb} dB` : 'estimat ±10 dB'} · offset {info.offsetDb > 0 ? '+' : ''}{info.offsetDb} dB
          </Badge>
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          <Text fontSize="xs" color="fg.muted">
            Per comparar amb el gateway (−101 dBm) cal una referència de nivell conegut <b>a la mateixa antena</b>: un generador a 868 MHz, o un aparell del qual sàpigues la potència que arriba al dongle.
            Amb el Hunt en marxa i el senyal de referència emetent, retén la lectura i indica el nivell real. Sense referència, els dBm són una estimació de ±10 dB.
          </Text>
          <HStack gap="3" flexWrap="wrap" align="end">
            <Button size="sm" variant="outline" onClick={hold} disabled={!running || readingDbfs == null}>Retén la lectura actual</Button>
            {held ? (
              <Text fontSize="sm">Retingut: <b>{held.dbfs.toFixed(1)} dBFS</b>{held.hz ? ` a ${formatMHz(held.hz, 1)}` : ''} amb guany {held.gain} dB</Text>
            ) : (
              <Text fontSize="sm" color="fg.muted">{running ? `Ara: ${readingDbfs?.toFixed(1) ?? '—'} dBFS` : 'Inicia el Hunt per retenir una lectura.'}</Text>
            )}
            <Field.Root w="40">
              <Field.Label fontSize="xs">Nivell real (dBm)</Field.Label>
              <Input size="sm" value={refTxt} onChange={(e) => setRefTxt(e.target.value)} inputMode="decimal" placeholder="p. ex. -60" disabled={!held} />
            </Field.Root>
            <Field.Root w="56">
              <Field.Label fontSize="xs">Nota</Field.Label>
              <Input size="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="generador, mesurador…" disabled={!held} />
            </Field.Root>
            <Button size="sm" colorPalette="brand" onClick={save} disabled={!held || !refTxt}>Desa</Button>
          </HStack>
          {entries.length > 0 && (
            <Stack gap="1" fontSize="xs">
              {entries.map((e) => (
                <HStack key={e.gainDb} gap="3">
                  <Text>guany <b>{e.gainDb} dB</b>: {e.measuredDb} dBFS = {e.refDbm} dBm → offset {e.offsetDb > 0 ? '+' : ''}{e.offsetDb} dB</Text>
                  <Text color="fg.muted">{e.note || '—'} · {formatDateTime(e.at)}</Text>
                  <Tooltip content="Esborra"><IconButton aria-label="Esborra" size="2xs" variant="ghost" colorPalette="red" onClick={async () => { await api.calibrationRemove(e.gainDb, 'iq'); await refreshCalibration(); }}><LuTrash2 /></IconButton></Tooltip>
                </HStack>
              ))}
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}
