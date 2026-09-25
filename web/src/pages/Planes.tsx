import { Badge, Box, Button, Card, HStack, Link, Stack, Table, Text } from '@chakra-ui/react';
import { useMemo } from 'react';
import { LuCircleStop, LuDownload, LuExternalLink, LuPlay } from 'react-icons/lu';
import { useNow, useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatAgo } from '@/lib/format';

export function Planes() {
  const { planes, status, setMode, stop, busy } = useSdr();
  const now = useNow(2000);
  const running = status?.mode === 'adsb';
  const rows = useMemo(() => [...planes].sort((a, b) => b.lastSeen - a.lastSeen), [planes]);

  return (
    <Stack gap="4">
      <Card.Root size="sm">
        <Card.Body>
          <HStack justify="space-between" flexWrap="wrap" gap="3">
            <Text color="fg.muted" fontSize="sm">
              ADS-B a 1090 MHz. Millor amb l’antena vertical i a prop d’una finestra. Posició només quan arriben trames parell i senar seguides.
            </Text>
            <HStack>
              <Button asChild size="sm" variant="outline" disabled={!planes.length}>
                <a href={api.exportUrl('planes', 'csv')} download><LuDownload /> CSV</a>
              </Button>
              {running ? (
                <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
              ) : (
                <Button size="sm" colorPalette="brand" onClick={() => setMode({ mode: 'adsb', config: { gainDb: null } })} loading={busy}><LuPlay /> Escolta avions</Button>
              )}
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      <Card.Root size="sm">
        <Card.Body p="0">
          {rows.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm" interactive>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>ICAO</Table.ColumnHeader>
                    <Table.ColumnHeader>Indicatiu</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Altitud</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end" display={{ base: 'none', md: 'table-cell' }}>Velocitat</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end" display={{ base: 'none', md: 'table-cell' }}>Rumb</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', lg: 'table-cell' }}>Posició</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Msg</Table.ColumnHeader>
                    <Table.ColumnHeader>Darrer cop</Table.ColumnHeader>
                    <Table.ColumnHeader>Mapa</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rows.map((p) => {
                    const live = now - p.lastSeen < 60_000;
                    return (
                      <Table.Row key={p.icao} opacity={live ? 1 : 0.6}>
                        <Table.Cell fontFamily="mono">{p.icao.toUpperCase()}</Table.Cell>
                        <Table.Cell>
                          {p.callsign ? <Badge variant="subtle" colorPalette="blue" fontFamily="mono">{p.callsign}</Badge> : <Text color="fg.muted">—</Text>}
                        </Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{p.altitudeFt != null ? `${p.altitudeFt.toLocaleString('ca-ES')} ft` : '—'}</Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" display={{ base: 'none', md: 'table-cell' }}>{p.speedKt != null ? `${p.speedKt} kt` : '—'}</Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" display={{ base: 'none', md: 'table-cell' }}>{p.headingDeg != null ? `${p.headingDeg}°` : '—'}</Table.Cell>
                        <Table.Cell fontFamily="mono" fontSize="xs" display={{ base: 'none', lg: 'table-cell' }}>
                          {p.lat != null && p.lon != null ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '—'}
                        </Table.Cell>
                        <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{p.msgs}</Table.Cell>
                        <Table.Cell whiteSpace="nowrap">{formatAgo(p.lastSeen, now)}</Table.Cell>
                        <Table.Cell>
                          <Link href={`https://globe.adsbexchange.com/?icao=${p.icao}`} target="_blank" rel="noreferrer" colorPalette="brand" fontSize="sm">
                            adsbexchange <LuExternalLink />
                          </Link>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Box py="12" textAlign="center" color="fg.muted">
              <Text>Cap avió detectat encara.</Text>
              <Text fontSize="sm">A Lleida hi passen sobretot vols en ruta a gran altitud: pot trigar uns minuts.</Text>
            </Box>
          )}
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
