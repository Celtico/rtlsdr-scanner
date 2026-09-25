import { Badge, Box, Card, HStack, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useState } from 'react';
import { LuCircleCheck, LuEye, LuShieldAlert, LuShieldCheck, LuTriangleAlert } from 'react-icons/lu';
import { useSdr } from '@/store';
import { api, type AuditEntry } from '@/lib/api';
import { formatMHz } from '@/lib/format';

const EXPOSURE_BADGE: Record<AuditEntry['verdict']['exposure'], { palette: string; text: string }> = {
  plain: { palette: 'red', text: 'EXPOSAT EN CLAR' },
  'id-only': { palette: 'orange', text: 'Identificable per ID' },
  rolling: { palette: 'green', text: 'Sembla protegit (codi variable)' },
};
const PRIORITY_PALETTE = { alta: 'red', mitjana: 'orange', baixa: 'green' } as const;
const PRIORITY_ORDER = { alta: 0, mitjana: 1, baixa: 2 } as const;

function HourBar({ hours, routine }: { hours: number[]; routine: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <HStack gap="2px" align="end" h="8" aria-label="Activitat per hora">
      {hours.map((n, h) => (
        <Box key={h} w="6px" h={`${Math.max(2, (n / max) * 32)}px`} bg={routine.includes(h) ? 'red.solid' : n ? 'brand.solid' : 'bg.muted'} rounded="1px" title={`${h}:00 · ${n}`} />
      ))}
    </HStack>
  );
}

export function Audit() {
  const { devices } = useSdr();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    api.audit().then(setEntries).catch(() => setEntries([]));
  }, [devices]);

  const sorted = useMemo(() => (entries ?? []).slice().sort((a, b) => PRIORITY_ORDER[a.verdict.priority] - PRIORITY_ORDER[b.verdict.priority]), [entries]);
  const counts = useMemo(() => ({
    plain: sorted.filter((e) => e.verdict.exposure === 'plain').length,
    id: sorted.filter((e) => e.verdict.trackableId).length,
    rolling: sorted.filter((e) => e.verdict.exposure === 'rolling').length,
    routines: sorted.filter((e) => e.routineHours.length).length,
  }), [sorted]);

  return (
    <Stack gap="4">
      <Card.Root size="sm" variant="subtle">
        <Card.Body>
          <HStack gap="3" align="flex-start">
            <Box color="brand.fg" fontSize="xl" mt="1"><LuShieldCheck /></Box>
            <Box>
              <Text fontWeight="semibold">Superfície d’exposició de ràdio de casa</Text>
              <Text fontSize="sm" color="fg.muted">
                Exactament el que veuria un veí amb el mateix dongle: només els dispositius marcats com a meus, i només l’estat (en clar / protegit) i les metadades.
                No es desxifra res ni es mostra contingut de tercers.
              </Text>
            </Box>
          </HStack>
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 2, md: 4 }} gap="3">
        <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Emeten en clar</Text><Text fontSize="2xl" fontWeight="bold" color={counts.plain ? 'red.fg' : 'fg'}>{counts.plain}</Text></Card.Body></Card.Root>
        <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Amb ID fix (seguibles)</Text><Text fontSize="2xl" fontWeight="bold" color={counts.id ? 'orange.fg' : 'fg'}>{counts.id}</Text></Card.Body></Card.Root>
        <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Codi variable</Text><Text fontSize="2xl" fontWeight="bold" color="green.fg">{counts.rolling}</Text></Card.Body></Card.Root>
        <Card.Root size="sm"><Card.Body><Text fontSize="xs" color="fg.muted">Rutines detectables</Text><Text fontSize="2xl" fontWeight="bold" color={counts.routines ? 'orange.fg' : 'fg'}>{counts.routines}</Text></Card.Body></Card.Root>
      </SimpleGrid>

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Header>
          <Card.Title>Els meus dispositius (433/868 MHz)</Card.Title>
          <Card.Description>Marca la propietat des del detall de cada dispositiu si l’heurística s’equivoca.</Card.Description>
        </Card.Header>
        <Card.Body p="0">
          {sorted.length ? (
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Dispositiu</Table.ColumnHeader>
                    <Table.ColumnHeader>Exposició</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Què es llegeix</Table.ColumnHeader>
                    <Table.ColumnHeader display={{ base: 'none', lg: 'table-cell' }}>Activitat per hora (0–23 h)</Table.ColumnHeader>
                    <Table.ColumnHeader>Fuites de metadades</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {sorted.map(({ device: d, verdict: v, activityByHour, routineHours, activeDays }) => (
                    <Table.Row key={d.id}>
                      <Table.Cell>
                        <Text fontWeight="semibold">{d.alias ?? d.model}</Text>
                        <Text fontSize="xs" color="fg.muted">{d.alias ? `${d.model} · ` : ''}{d.deviceId ? `id ${d.deviceId} · ` : ''}{d.freqHz ? formatMHz(d.freqHz) : ''} · {d.count} msg</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge colorPalette={EXPOSURE_BADGE[v.exposure].palette} variant="solid" size="sm">{EXPOSURE_BADGE[v.exposure].text}</Badge>
                      </Table.Cell>
                      <Table.Cell display={{ base: 'none', md: 'table-cell' }} fontSize="sm">{v.readable.join(', ') || '—'}</Table.Cell>
                      <Table.Cell display={{ base: 'none', lg: 'table-cell' }}>
                        <HourBar hours={activityByHour} routine={routineHours} />
                      </Table.Cell>
                      <Table.Cell fontSize="xs">
                        <Stack gap="1">
                          {v.trackableId && <HStack gap="1" color="orange.fg"><LuEye /><Text>ID fix: permet saber si el dispositiu (i tu) és a casa</Text></HStack>}
                          {routineHours.length ? (
                            <HStack gap="1" color="orange.fg"><LuTriangleAlert /><Text>Rutina: actiu sobretot a les {routineHours.map((h) => `${h}h`).join(', ')}{activeDays > 1 ? ` (${activeDays} dies)` : ' (només 1 dia de dades)'}</Text></HStack>
                          ) : (
                            <HStack gap="1" color="fg.muted"><LuCircleCheck /><Text>Sense patró horari clar{activeDays <= 1 ? ' (poques dades)' : ''}</Text></HStack>
                          )}
                        </Stack>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Box py="10" textAlign="center" color="fg.muted">
              <Text>{entries === null ? 'Carregant…' : 'Cap dispositiu marcat com a meu encara. Escolta dispositius i marca’n la propietat al detall.'}</Text>
            </Box>
          )}
        </Card.Body>
      </Card.Root>

      <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4">
        <Card.Root size="sm">
          <Card.Header>
            <HStack><Box color="red.fg"><LuShieldAlert /></Box><Card.Title>Recomanacions</Card.Title></HStack>
          </Card.Header>
          <Card.Body>
            {sorted.length ? (
              <Stack gap="3">
                {sorted.map(({ device: d, verdict: v }) => (
                  <HStack key={d.id} align="flex-start" gap="3">
                    <Badge colorPalette={PRIORITY_PALETTE[v.priority]} variant="subtle" minW="16" justifyContent="center" textTransform="capitalize">{v.priority}</Badge>
                    <Box fontSize="sm">
                      <Text fontWeight="semibold">{d.alias ?? d.model}{d.deviceId ? ` (id ${d.deviceId})` : ''}</Text>
                      <Text color="fg.muted">{v.recommendation}</Text>
                    </Box>
                  </HStack>
                ))}
              </Stack>
            ) : (
              <Text color="fg.muted" fontSize="sm">Res a recomanar fins que hi hagi dispositius propis.</Text>
            )}
          </Card.Body>
        </Card.Root>

        <Card.Root size="sm">
          <Card.Header>
            <HStack><Box color="green.fg"><LuCircleCheck /></Box><Card.Title>Què queda fora de l’abast d’aquest atac</Card.Title></HStack>
            <Card.Description>No és exposició per ràdio amb un RTL-SDR: no cal preocupar-se’n.</Card.Description>
          </Card.Header>
          <Card.Body>
            <Stack gap="2" fontSize="sm">
              <Text><b>WiFi i Bluetooth</b>: a 2,4 i 5 GHz, fora del rang del dongle (màxim 1,7 GHz), i a més van xifrats (WPA2/3, BLE).</Text>
              <Text><b>Mòbil (4G/5G)</b>: s’hi veu activitat de les antenes, però tot el trànsit va xifrat; ningú en pot llegir res.</Text>
              <Text><b>Claus de cotxe i comandaments moderns</b> (KeeLoq, Somfy RTS/io, Nice Flor-S): codi variable; gravar la trama no serveix per repetir-la.</Text>
              <Text><b>TETRA (Rescat)</b>: xifrat de punta a punta.</Text>
              <Text><b>Alarmes amb xifratge</b> (Zigbee 3.0, Z-Wave S2, 868 MHz propietari xifrat): el dongle només en veu que emeten.</Text>
            </Stack>
          </Card.Body>
        </Card.Root>
      </SimpleGrid>
    </Stack>
  );
}
