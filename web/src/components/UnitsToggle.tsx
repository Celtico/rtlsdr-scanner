import { SegmentGroup } from '@chakra-ui/react';
import type { CalScale } from '@shared/sdr/calibration';
import { useUnits } from '@/lib/units';
import { Tooltip } from '@/components/ui/tooltip';

export function UnitsToggle({ gainDb, scale = 'power' }: { gainDb: number | null; scale?: CalScale }) {
  const u = useUnits();
  return (
    <Tooltip content={u.note(gainDb, scale)}>
      <SegmentGroup.Root size="xs" value={u.units} onValueChange={(e) => u.setUnits(e.value === 'dbm' ? 'dbm' : 'rel')}>
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={[{ value: 'rel', label: scale === 'iq' ? 'dBFS' : 'dB' }, { value: 'dbm', label: 'dBm' }]} />
      </SegmentGroup.Root>
    </Tooltip>
  );
}
