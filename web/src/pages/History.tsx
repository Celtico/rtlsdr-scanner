import { Badge, Box, Button, Card, HStack, IconButton, Stack, Table, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LuDownload, LuFolderOpen, LuRefreshCw, LuTrash2 } from 'react-icons/lu';
import type { Scan } from '@shared/types';
import { useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, formatHzShort } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';
import { toaster } from '@/components/ui/toaster';
import { MODE_LABEL } from '@/lib/labels';

const KIND_PALETTE: Record<Scan['kind'], string> = { survey: 'brand', devices: 'green', adsb: 'blue' };

function describe(s: Scan): string {
  if (s.kind === 'survey' && 'fromHz' in s.config) {
    return `${formatHzShort(s.config.fromHz)} – ${formatHzShort(s.config.toHz)} · pas ${formatHzShort(s.config.stepHz)} · guany ${s.config.gainDb} dB · llindar ${s.config.thresholdDb} dB`;
  }
  if (s.kind === 'devices' && 'freqsHz' in s.config) {
    return s.config.freqsHz.map((f) => formatHzShort(f)).join(' + ');
  }
  return '1090 MHz';
}

function counts(s: Scan): string {
  if (s.kind === 'survey') return `${s.sweeps} escombrats · ${s.signals} senyals`;
  if (s.kind === 'devices') return `${s.devices} dispositius`;
  return `${s.planes} avions`;
}

export function History() {
  const { status, loadScanSweeps } = useSdr();
  const navigate = useNavigate();
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const load = useCallback(() => api.scans().then(setScans).catch(() => setScans([])), []);
  useEffect(() => { void load(); }, [load, status?.mode]);

  const open = async (s: Scan) => {
    if (s.kind === 'survey') {
      await loadScanSweeps(s.id);
      navigate('/espectre');
    } else if (s.kind === 'devices') navigate('/dispositius');
    else navigate('/avions');
  };

  const remove = async (id: number) => {
    try {
      await api.deleteScan(id);
      setConfirmId(null);
      await load();
      toaster.create({ title: 'Escaneig eliminat', type: 'success', duration: 2000 });
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut eliminar', description: (e as Error).message, type: 'error' });
    }
  };

  const exportUrl = (s: Scan, format: 'csv' | 'json') => {
    if (s.kind === 'survey') return api.exportUrl('signals', format, { scanId: s.id });
    if (s.kind === 'adsb') return api.exportUrl('planes', format, { scanId: s.id });
    return api.exportUrl('devices', format);
  };

  return (
    <Stack gap="4">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Header>
          <HStack justify="space-between">
            <Box>
              <Card.Title>Escaneigs anteriors</Card.Title>
              <Card.Description>Torna a obrir un escombrat per veure el waterfall i els senyals, o exporta’n les dades.</Card.Description>
            </Box>
            <Tooltip content="Actualitza">
              <IconButton aria-label="Actualitza" size="sm" variant="ghost" onClick={load}><LuRefreshCw /></IconButton>
            </Tooltip>
          </HStack>
        </Card.Header>
        <Card.Body p="0">
          {scans && scans.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Tipus</Table.ColumnHeader>
                    <Table.ColumnHeader>Inici</Table.ColumnHeader>
                    <Table.ColumnHeader>Durada</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Configuració</Table.ColumnHeader>
                    <Table.ColumnHeader>Resultat</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Accions</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {scans.map((s) => {
                    const active = status?.scanId === s.id && status.mode !== 'idle';
                    return (
                      <Table.Row key={s.id}>
                        <Table.Cell>
                          <HStack gap="2">
                            <Badge colorPalette={KIND_PALETTE[s.kind]} variant="subtle">{MODE_LABEL[s.kind]}</Badge>
                            {active && <Badge colorPalette="brand" variant="solid" size="sm">en curs</Badge>}
                          </HStack>
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{formatDateTime(s.startedAt)}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{formatDuration((s.endedAt ?? Date.now()) - s.startedAt)}</Table.Cell>
                        <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontSize="xs" color="fg.muted">{describe(s)}</Table.Cell>
                        <Table.Cell fontSize="sm">{counts(s)}</Table.Cell>
                        <Table.Cell>
                          <HStack justify="flex-end" gap="1">
                            <Tooltip content="Obre">
                              <IconButton aria-label="Obre" size="sm" variant="ghost" onClick={() => open(s)}><LuFolderOpen /></IconButton>
                            </Tooltip>
                            <Tooltip content="Exporta CSV">
                              <IconButton asChild aria-label="Exporta CSV" size="sm" variant="ghost">
                                <a href={exportUrl(s, 'csv')} download><LuDownload /></a>
                              </IconButton>
                            </Tooltip>
                            {confirmId === s.id ? (
                              <Button size="xs" colorPalette="red" onClick={() => remove(s.id)}>Confirma</Button>
                            ) : (
                              <Tooltip content="Elimina">
                                <IconButton aria-label="Elimina" size="sm" variant="ghost" colorPalette="red" disabled={active} onClick={() => setConfirmId(s.id)}><LuTrash2 /></IconButton>
                              </Tooltip>
                            )}
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Box py="12" textAlign="center" color="fg.muted">
              <Text>{scans === null ? 'Carregant…' : 'Encara no hi ha cap escaneig.'}</Text>
            </Box>
          )}
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
