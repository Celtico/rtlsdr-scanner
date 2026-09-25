import { Badge, Box, HStack, Table, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';
import { LuArrowDown, LuArrowUp, LuArrowUpDown, LuLock } from 'react-icons/lu';
import type { Signal } from '@shared/types';
import { formatMHz, formatWidth } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';

type Key = 'freqHz' | 'widthHz' | 'peakDb' | 'excessDb' | 'dutyPct' | 'band';

const COLS: { key: Key; label: string; numeric?: boolean }[] = [
  { key: 'freqHz', label: 'Freqüència', numeric: true },
  { key: 'widthHz', label: 'Ample', numeric: true },
  { key: 'peakDb', label: 'Pic', numeric: true },
  { key: 'excessDb', label: '+dB soroll', numeric: true },
  { key: 'dutyPct', label: 'Actiu', numeric: true },
  { key: 'band', label: 'Banda probable' },
];

export interface SignalsTableProps {
  signals: Signal[];
  selectedId: string | null;
  onSelect: (s: Signal) => void;
}

export function SignalsTable({ signals, selectedId, onSelect }: SignalsTableProps) {
  const [sort, setSort] = useState<{ key: Key; dir: 'asc' | 'desc' }>({ key: 'excessDb', dir: 'desc' });

  const rows = useMemo(() => {
    const arr = [...signals];
    const m = sort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * m;
      return String(va ?? '').localeCompare(String(vb ?? ''), 'ca') * m;
    });
    return arr;
  }, [signals, sort]);

  const toggle = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'band' ? 'asc' : 'desc' }));

  if (!signals.length) {
    return <Text color="fg.muted" py="6" textAlign="center">Cap senyal per sobre del llindar encara.</Text>;
  }

  return (
    <Box overflowX="auto">
      <Table.Root size="sm" interactive stickyHeader>
        <Table.Header>
          <Table.Row>
            {COLS.map((c) => (
              <Table.ColumnHeader key={c.key} textAlign={c.numeric ? 'end' : 'start'} cursor="pointer" onClick={() => toggle(c.key)} userSelect="none">
                <HStack gap="1" justify={c.numeric ? 'flex-end' : 'flex-start'}>
                  <Text>{c.label}</Text>
                  <Box color="fg.muted" fontSize="xs">
                    {sort.key === c.key ? (sort.dir === 'asc' ? <LuArrowUp /> : <LuArrowDown />) : <LuArrowUpDown />}
                  </Box>
                </HStack>
              </Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((s) => (
            <Table.Row
              key={s.id}
              onClick={() => onSelect(s)}
              cursor="pointer"
              bg={selectedId === s.id ? 'brand.subtle' : undefined}
              data-selected={selectedId === s.id ? '' : undefined}
            >
              <Table.Cell textAlign="end" fontFamily="mono" fontVariantNumeric="tabular-nums">{formatMHz(s.freqHz)}</Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{formatWidth(s.widthHz)}</Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{s.peakDb.toFixed(1)} dB</Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                <Badge colorPalette={s.excessDb > 25 ? 'red' : s.excessDb > 15 ? 'orange' : 'gray'} variant="subtle">+{s.excessDb.toFixed(1)}</Badge>
              </Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">
                <Tooltip content={s.dutyPct >= 90 ? 'Contínua (emissora, portadora)' : s.dutyPct >= 30 ? 'Intermitent' : 'Ràfegues (sensors, comandaments)'}>
                  <Text as="span">{s.dutyPct}%</Text>
                </Tooltip>
              </Table.Cell>
              <Table.Cell>
                <HStack gap="1">
                  {s.restricted && (
                    <Tooltip content="Banda xifrada: només es mostra activitat">
                      <Box color="orange.fg"><LuLock /></Box>
                    </Tooltip>
                  )}
                  <Text color={s.band ? 'fg' : 'fg.muted'}>{s.band ?? 'Desconeguda'}</Text>
                </HStack>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
