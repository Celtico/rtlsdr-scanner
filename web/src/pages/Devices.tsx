import { Badge, Box, Button, Card, HStack, Input, SegmentGroup, Stack, Table, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import { LuCircleStop, LuDownload, LuPlay, LuSearch } from 'react-icons/lu';
import { DEFAULT_DEVICES, type Device } from '@shared/types';
import { useNow, useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatAgo, formatMHz, formatReading } from '@/lib/format';
import { RssiBar } from '@/components/RssiBar';
import { DeviceDrawer } from '@/components/DeviceDrawer';

type Filter = 'all' | 'own' | 'neighbours';

export function Devices() {
  const { devices, status, setMode, stop, busy, updateDevice } = useSdr();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const running = status?.mode === 'devices';

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return devices
      .filter((d) => (filter === 'all' ? true : filter === 'own' ? d.likelyOwn : !d.likelyOwn))
      .filter((d) => !needle || [d.model, d.alias, d.deviceId, d.channel].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }, [devices, filter, q]);

  const open = openId != null ? devices.find((d) => d.id === openId) ?? null : null;

  const summary = (d: Device) => {
    const f = formatReading(d.lastData).slice(0, 3);
    return f.length ? f.map((x) => `${x.label}: ${x.value}`).join(' · ') : '—';
  };

  return (
    <Stack gap="4">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <HStack gap="3" flexWrap="wrap" minW="0">
              <SegmentGroup.Root value={filter} onValueChange={(e) => setFilter((e.value ?? 'all') as Filter)} size="sm">
                <SegmentGroup.Indicator />
                <SegmentGroup.Items items={[
                  { value: 'all', label: `Tots (${devices.length})` },
                  { value: 'own', label: `Meus (${devices.filter((d) => d.likelyOwn).length})` },
                  { value: 'neighbours', label: `Veïns (${devices.filter((d) => !d.likelyOwn).length})` },
                ]} />
              </SegmentGroup.Root>
              <HStack gap="2">
                <Box color="fg.muted"><LuSearch /></Box>
                <Input size="sm" placeholder="Cerca model, id o àlies" value={q} onChange={(e) => setQ(e.target.value)} w={{ base: 'full', md: '64' }} />
              </HStack>
            </HStack>
            <HStack>
              <Button asChild size="sm" variant="outline" disabled={!devices.length}>
                <a href={api.exportUrl('devices', 'csv')} download><LuDownload /> CSV</a>
              </Button>
              {running ? (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              ) : (
                <Button size="sm" colorPalette="brand" onClick={() => setMode({ mode: 'devices', config: DEFAULT_DEVICES })} loading={busy}>
                  <LuPlay /> Escolta 433,92 + 868,3 MHz
                </Button>
              )}
            </HStack>
          </HStack>
          <Text fontSize="xs" color="fg.muted" mt="2">
            «Meu» = RSSI fort (&gt; −8 dB) i estable (±3 dB) en almenys 3 missatges. La resta són veïns o de lluny.
          </Text>
        </Card.Body>
      </Card.Root>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body p="0">
          {rows.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm" interactive>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Dispositiu</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Id / canal</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Freqüència</Table.ColumnHeader>
                    <Table.ColumnHeader>RSSI</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Vist</Table.ColumnHeader>
                    <Table.ColumnHeader>Darrer cop</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', lg: 'table-cell' }}>Última lectura</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rows.map((d) => (
                    <Table.Row key={d.id} cursor="pointer" onClick={() => setOpenId(d.id)}>
                      <Table.Cell>
                        <HStack gap="2">
                          <Box>
                            <Text fontWeight="semibold">{d.alias ?? d.model}</Text>
                            {d.alias && <Text fontSize="xs" color="fg.muted">{d.model}</Text>}
                          </Box>
                          <Badge colorPalette={d.likelyOwn ? 'green' : 'gray'} variant="subtle" size="sm">{d.likelyOwn ? 'meu' : 'veí'}</Badge>
                        </HStack>
                      </Table.Cell>
                      <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontFamily="mono" fontSize="xs">
                        {d.deviceId ?? '—'}{d.channel ? ` / ${d.channel}` : ''}
                      </Table.Cell>
                      <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontFamily="mono" fontSize="xs">{d.freqHz ? formatMHz(d.freqHz) : '—'}</Table.Cell>
                      <Table.Cell><RssiBar rssi={d.rssi} /></Table.Cell>
                      <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{d.count}×</Table.Cell>
                      <Table.Cell whiteSpace="nowrap">{formatAgo(d.lastSeen, now)}</Table.Cell>
                      <Table.Cell display={{ base: 'none', lg: 'table-cell' }} color="fg.muted" fontSize="xs" maxW="sm" truncate>{summary(d)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Box py="12" textAlign="center" color="fg.muted">
              <Text>{devices.length ? 'Cap dispositiu coincideix amb el filtre.' : 'Cap dispositiu detectat encara.'}</Text>
              {!devices.length && <Text fontSize="sm">Inicia l’escolta i espera uns minuts: els sensors emeten cada 30–60 s.</Text>}
            </Box>
          )}
        </Card.Body>
      </Card.Root>

      <DeviceDrawer device={open} onClose={() => setOpenId(null)} onUpdated={updateDevice} />
    </Stack>
  );
}
