import { Badge, Box, Button, Card, Field, HStack, IconButton, Input, NativeSelect, Stack, Table, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { LuRuler, LuTrash2 } from 'react-icons/lu';
import type { Scan } from '@shared/types';
import { useSdr } from '@/store';
import { api } from '@/lib/api';
import { useUnits } from '@/lib/units';
import { formatDateTime, formatMHz } from '@/lib/format';
import { toaster } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';

/** Level-2 calibration: one reference (known dBm) per tuner gain. */
export function CalibrationCard({ scans }: { scans: Scan[] }) {
  const { calibration, refreshCalibration } = useSdr();
  const u = useUnits();
  const [scanId, setScanId] = useState<number | null>(scans[0]?.id ?? null);
  const [freqTxt, setFreqTxt] = useState('107.4');
  const [reading, setReading] = useState<{ gainDb: number; freqHz: number; measuredDb: number } | null>(null);
  const [refTxt, setRefTxt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (scanId == null && scans[0]) setScanId(scans[0].id); }, [scans, scanId]);

  const fetchReading = async () => {
    if (scanId == null) return;
    const hz = Math.round(Number(freqTxt) * 1e6);
    if (!Number.isFinite(hz) || hz <= 0) return;
    setBusy(true);
    try { setReading(await api.calibrationReading(scanId, hz)); } catch (e) { setReading(null); toaster.create({ title: 'Sense lectura', description: (e as Error).message, type: 'error' }); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!reading) return;
    const ref = Number(refTxt);
    if (!Number.isFinite(ref)) { toaster.create({ title: 'Cal la referència en dBm', type: 'error' }); return; }
    try {
      await api.calibrationAdd({ gainDb: reading.gainDb, freqHz: reading.freqHz, measuredDb: reading.measuredDb, refDbm: ref, note });
      await refreshCalibration();
      u.setUnits('dbm');
      toaster.create({ title: 'Calibratge desat', description: `Offset ${(ref - reading.measuredDb).toFixed(1)} dB a ${reading.gainDb} dB de guany`, type: 'success', duration: 4000 });
    } catch (e) { toaster.create({ title: 'No s’ha pogut desar', description: (e as Error).message, type: 'error' }); }
  };
  const remove = async (g: number) => { await api.calibrationRemove(g); await refreshCalibration(); };

  return (
    <Card.Root size="sm" minW="0" overflow="hidden">
      <Card.Header>
        <HStack justify="space-between" flexWrap="wrap">
          <Box>
            <HStack gap="2"><Box color="brand.fg"><LuRuler /></Box><Card.Title>Calibratge a dBm (nivell 2)</Card.Title></HStack>
            <Card.Description>Amb un senyal de nivell conegut: l’app llegeix el que marca l’escombrat i l’offset = referència − lectura. Un per guany; els altres guanys es deriven.</Card.Description>
          </Box>
          <Badge variant="subtle" colorPalette={calibration?.entries.length ? 'green' : 'orange'}>{calibration?.entries.length ? `${calibration.entries.length} referència(es)` : 'sense referència: estimació ±6 dB'}</Badge>
        </HStack>
      </Card.Header>
      <Card.Body>
        <Stack gap="4">
          <HStack gap="3" flexWrap="wrap" align="end">
            <Field.Root w="72">
              <Field.Label fontSize="xs">Escombrat amb el senyal de referència</Field.Label>
              <NativeSelect.Root size="sm">
                <NativeSelect.Field aria-label="Escombrat" value={scanId ?? ''} onChange={(e) => setScanId(Number(e.target.value))}>
                  {scans.map((s) => 'gainDb' in s.config && 'fromHz' in s.config && <option key={s.id} value={s.id}>#{s.id} · {formatDateTime(s.startedAt)} · guany {s.config.gainDb} dB</option>)}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field.Root>
            <Field.Root w="32">
              <Field.Label fontSize="xs">Freqüència (MHz)</Field.Label>
              <Input size="sm" value={freqTxt} onChange={(e) => setFreqTxt(e.target.value)} inputMode="decimal" />
            </Field.Root>
            <Button size="sm" variant="outline" onClick={fetchReading} loading={busy} disabled={scanId == null}>Llegeix</Button>
            {reading && <Text fontSize="sm">Lectura: <b>{reading.measuredDb} dB</b> a {formatMHz(reading.freqHz)} amb guany {reading.gainDb} dB</Text>}
          </HStack>
          <HStack gap="3" flexWrap="wrap" align="end">
            <Field.Root w="40">
              <Field.Label fontSize="xs">Nivell real de referència (dBm)</Field.Label>
              <Input size="sm" value={refTxt} onChange={(e) => setRefTxt(e.target.value)} inputMode="decimal" placeholder="p. ex. -70" disabled={!reading} />
            </Field.Root>
            <Field.Root w="64">
              <Field.Label fontSize="xs">Nota</Field.Label>
              <Input size="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="generador, font de soroll, mesurador…" disabled={!reading} />
            </Field.Root>
            <Button size="sm" colorPalette="brand" onClick={save} disabled={!reading || !refTxt}>Desa la referència</Button>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Referències vàlides: un generador de senyal, una font de soroll calibrada, o una emissora de la qual sàpigues la potència rebuda amb un altre mesurador a la mateixa antena. Sense referència, els dBm són una estimació amb valors típics del R820T (0 dB de lectura ≈ −86 dBm a 40 dB de guany), ±6 dB.
            Fes servir una <b>portadora estreta</b> (CW, to d’un generador) o el mateix pas d’escombrat que després vulguis llegir: un senyal ample com una emissora FM reparteix la potència entre bins i la lectura canvia amb el pas.
            Per a soroll de fons, els dBm són per bin de l’escombrat (10 kHz → −128 dBm és el soroll tèrmic del receptor).
          </Text>
          {!!calibration?.entries.length && (
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header><Table.Row><Table.ColumnHeader>Guany</Table.ColumnHeader><Table.ColumnHeader>Freq.</Table.ColumnHeader><Table.ColumnHeader textAlign="end">Lectura</Table.ColumnHeader><Table.ColumnHeader textAlign="end">Referència</Table.ColumnHeader><Table.ColumnHeader textAlign="end">Offset</Table.ColumnHeader><Table.ColumnHeader>Nota</Table.ColumnHeader><Table.ColumnHeader /></Table.Row></Table.Header>
                <Table.Body>
                  {calibration.entries.map((e) => (
                    <Table.Row key={e.gainDb}>
                      <Table.Cell>{e.gainDb} dB</Table.Cell>
                      <Table.Cell fontFamily="mono">{formatMHz(e.freqHz)}</Table.Cell>
                      <Table.Cell textAlign="end">{e.measuredDb} dB</Table.Cell>
                      <Table.Cell textAlign="end">{e.refDbm} dBm</Table.Cell>
                      <Table.Cell textAlign="end" fontWeight="semibold">{e.offsetDb > 0 ? '+' : ''}{e.offsetDb} dB</Table.Cell>
                      <Table.Cell fontSize="xs" color="fg.muted">{e.note || '—'} · {formatDateTime(e.at)}</Table.Cell>
                      <Table.Cell textAlign="end"><Tooltip content="Esborra"><IconButton aria-label="Esborra" size="xs" variant="ghost" colorPalette="red" onClick={() => remove(e.gainDb)}><LuTrash2 /></IconButton></Tooltip></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}
