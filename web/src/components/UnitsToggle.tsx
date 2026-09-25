import { SegmentGroup } from '@chakra-ui/react';
import { useUnits } from '@/lib/units';
import { Tooltip } from '@/components/ui/tooltip';

export function UnitsToggle({ gainDb }: { gainDb: number | null }) {
  const u = useUnits();
  return (
    <Tooltip content={u.note(gainDb)}>
      <SegmentGroup.Root size="xs" value={u.units} onValueChange={(e) => u.setUnits(e.value === 'dbm' ? 'dbm' : 'rel')}>
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={[{ value: 'rel', label: 'dB' }, { value: 'dbm', label: 'dBm' }]} />
      </SegmentGroup.Root>
    </Tooltip>
  );
}
