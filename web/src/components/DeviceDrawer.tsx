import { Badge, Box, Button, DataList, Drawer, Field, HStack, IconButton, Input, NativeSelect, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { Chart, useChart } from '@chakra-ui/charts';
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { LuCheck, LuDownload, LuX } from 'react-icons/lu';
import type { Device, Reading } from '@shared/types';
import { api } from '@/lib/api';
import { CHARTABLE_FIELDS, fieldLabel, formatDateTime, formatMHz, formatReading, formatTime } from '@/lib/format';
import { toaster } from '@/components/ui/toaster';
import { Tooltip } from '@/components/ui/tooltip';
import { RssiBar } from '@/components/RssiBar';

export interface DeviceDrawerProps {
  device: Device | null;
  onClose: () => void;
  onUpdated: (d: Device) => void;
}

export function DeviceDrawer({ device, onClose, onUpdated }: DeviceDrawerProps) {
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [alias, setAlias] = useState('');
  const [saving, setSaving] = useState(false);
  const [field, setField] = useState<string>('rssi');

  useEffect(() => {
    setAlias(device?.alias ?? '');
    setReadings(null);
    if (!device) return;
    let cancelled = false;
    api.deviceHistory(device.id).then((r) => { if (!cancelled) setReadings(r.readings); }).catch(() => { if (!cancelled) setReadings([]); });
    return () => { cancelled = true; };
  }, [device]);

  const numericFields = useMemo(() => {
    const keys = new Set<string>();
    for (const r of readings ?? []) for (const [k, v] of Object.entries(r.data)) if (typeof v === 'number') keys.add(k);
    const ordered = CHARTABLE_FIELDS.filter((k) => keys.has(k));
    for (const k of keys) if (!ordered.includes(k)) ordered.push(k);
    return ordered;
  }, [readings]);

  useEffect(() => {
    if (field !== 'rssi' && !numericFields.includes(field)) setField(numericFields[0] ?? 'rssi');
  }, [numericFields, field]);

  const data = useMemo(() => (readings ?? []).map((r) => ({
    ts: r.ts,
    value: field === 'rssi' ? r.rssi : (typeof r.data[field] === 'number' ? (r.data[field] as number) : null),
  })).filter((d) => d.value !== null) as { ts: number; value: number }[], [readings, field]);

  const chart = useChart({ data, series: [{ name: 'value', color: 'brand.solid' }] });

  const save = async () => {
    if (!device) return;
    setSaving(true);
    try {
      const d = await api.setAlias(device.id, alias.trim() || null);
      onUpdated(d);
      toaster.create({ title: 'Àlies desat', type: 'success', duration: 2000 });
    } catch (e) {
      toaster.create({ title: 'No s’ha pogut desar', description: (e as Error).message, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const fields = device ? formatReading(device.lastData) : [];

  return (
    <Drawer.Root open={!!device} onOpenChange={(e) => { if (!e.open) onClose(); }} size={{ base: 'full', md: 'md' }}>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            {device && (
              <>
                <Drawer.Header>
                  <Stack gap="1">
                    <Drawer.Title>{device.alias ?? device.model}</Drawer.Title>
                    <HStack gap="2" flexWrap="wrap">
                      <Text color="fg.muted" fontSize="sm">{device.model}{device.deviceId ? ` · id ${device.deviceId}` : ''}{device.channel ? ` · canal ${device.channel}` : ''}</Text>
                      <Badge colorPalette={device.likelyOwn ? 'green' : 'gray'} variant="subtle">{device.likelyOwn ? 'Probablement meu' : 'Veí / llunyà'}</Badge>
                    </HStack>
                  </Stack>
                </Drawer.Header>
                <Drawer.Body>
                  <Stack gap="6">
                    <Field.Root>
                      <Field.Label>Àlies</Field.Label>
                      <HStack>
                        <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Sensor terrassa" onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
                        <Tooltip content="Desa l’àlies">
                          <IconButton aria-label="Desa l’àlies" onClick={save} loading={saving} colorPalette="brand"><LuCheck /></IconButton>
                        </Tooltip>
                      </HStack>
                      <Field.HelperText>Un nom per reconèixer aquest dispositiu.</Field.HelperText>
                    </Field.Root>

                    <DataList.Root orientation="horizontal" size="sm">
                      <DataList.Item>
                        <DataList.ItemLabel>Freqüència</DataList.ItemLabel>
                        <DataList.ItemValue fontFamily="mono">{device.freqHz ? formatMHz(device.freqHz) : '—'}</DataList.ItemValue>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.ItemLabel>RSSI</DataList.ItemLabel>
                        <DataList.ItemValue><RssiBar rssi={device.rssi} /></DataList.ItemValue>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.ItemLabel>RSSI mitjà</DataList.ItemLabel>
                        <DataList.ItemValue>{device.rssiAvg == null ? '—' : `${device.rssiAvg.toFixed(1)} dB ± ${(device.rssiStd ?? 0).toFixed(1)}`}</DataList.ItemValue>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.ItemLabel>Missatges</DataList.ItemLabel>
                        <DataList.ItemValue>{device.count}</DataList.ItemValue>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.ItemLabel>Primer cop</DataList.ItemLabel>
                        <DataList.ItemValue>{formatDateTime(device.firstSeen)}</DataList.ItemValue>
                      </DataList.Item>
                      <DataList.Item>
                        <DataList.ItemLabel>Darrer cop</DataList.ItemLabel>
                        <DataList.ItemValue>{formatDateTime(device.lastSeen)}</DataList.ItemValue>
                      </DataList.Item>
                    </DataList.Root>

                    <Box>
                      <Text fontWeight="semibold" mb="2">Última lectura</Text>
                      {fields.length ? (
                        <DataList.Root orientation="horizontal" size="sm">
                          {fields.map((f) => (
                            <DataList.Item key={f.key}>
                              <DataList.ItemLabel>{f.label}</DataList.ItemLabel>
                              <DataList.ItemValue fontVariantNumeric="tabular-nums">{f.value}</DataList.ItemValue>
                            </DataList.Item>
                          ))}
                        </DataList.Root>
                      ) : (
                        <Text color="fg.muted" fontSize="sm">Sense dades descodificades.</Text>
                      )}
                    </Box>

                    <Box>
                      <HStack justify="space-between" mb="2" flexWrap="wrap" gap="2">
                        <Text fontWeight="semibold">Històric</Text>
                        <NativeSelect.Root size="sm" width="auto">
                          <NativeSelect.Field value={field} onChange={(e) => setField(e.target.value)} aria-label="Camp a graficar">
                            <option value="rssi">RSSI (dB)</option>
                            {numericFields.map((k) => <option key={k} value={k}>{fieldLabel(k)}</option>)}
                          </NativeSelect.Field>
                          <NativeSelect.Indicator />
                        </NativeSelect.Root>
                      </HStack>
                      {readings === null ? (
                        <HStack py="6" justify="center"><Spinner size="sm" /><Text color="fg.muted">Carregant…</Text></HStack>
                      ) : data.length < 2 ? (
                        <Text color="fg.muted" fontSize="sm">Calen almenys dues lectures per dibuixar l’històric.</Text>
                      ) : (
                        <Chart.Root chart={chart} h="52">
                          <LineChart responsive data={chart.data} margin={{ left: -10, right: 8, top: 8 }}>
                            <CartesianGrid stroke={chart.color('border')} vertical={false} />
                            <XAxis dataKey={chart.key('ts')} tickFormatter={(v: number) => formatTime(v)} stroke={chart.color('border')} fontSize={11} minTickGap={40} />
                            <YAxis stroke={chart.color('border')} fontSize={11} domain={['auto', 'auto']} />
                            <RTooltip content={<Chart.Tooltip hideLabel />} cursor={{ stroke: chart.color('border') }} />
                            <Line type="monotone" dataKey={chart.key('value')} stroke={chart.color('brand.solid')} strokeWidth={2} dot={data.length < 60} isAnimationActive={false} name={field === 'rssi' ? 'RSSI' : fieldLabel(field)} />
                          </LineChart>
                        </Chart.Root>
                      )}
                    </Box>

                    <HStack>
                      <Button asChild size="sm" variant="outline">
                        <a href={api.exportUrl('readings', 'csv', { deviceId: device.id })} download><LuDownload /> Lectures CSV</a>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <a href={api.exportUrl('readings', 'json', { deviceId: device.id })} download><LuDownload /> JSON</a>
                      </Button>
                    </HStack>
                  </Stack>
                </Drawer.Body>
                <Drawer.CloseTrigger asChild>
                  <IconButton aria-label="Tanca" variant="ghost" size="sm" position="absolute" top="3" right="3"><LuX /></IconButton>
                </Drawer.CloseTrigger>
              </>
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
