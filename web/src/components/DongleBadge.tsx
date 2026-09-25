import { Badge } from '@chakra-ui/react';
import { LuCircleAlert, LuPlug, LuUnplug, LuUsb } from 'react-icons/lu';
import type { DongleInfo } from '@shared/types';
import { Tooltip } from '@/components/ui/tooltip';

const LABEL: Record<DongleInfo['state'], { text: string; palette: string; icon: React.ReactNode }> = {
  unknown: { text: 'Dongle: desconegut', palette: 'gray', icon: <LuUsb /> },
  connected: { text: 'Dongle connectat', palette: 'green', icon: <LuPlug /> },
  'in-use': { text: 'Dongle en ús', palette: 'brand', icon: <LuPlug /> },
  busy: { text: 'Dongle ocupat', palette: 'orange', icon: <LuCircleAlert /> },
  missing: { text: 'Dongle no detectat', palette: 'red', icon: <LuUnplug /> },
  error: { text: 'Error del dongle', palette: 'red', icon: <LuCircleAlert /> },
};

export function DongleBadge({ dongle }: { dongle: DongleInfo | null }) {
  const state = dongle?.state ?? 'unknown';
  const l = LABEL[state];
  const tip = dongle?.message ?? [dongle?.name, dongle?.tuner].filter(Boolean).join(' · ') ?? '';
  return (
    <Tooltip content={tip || l.text} disabled={!tip}>
      <Badge colorPalette={l.palette} variant="subtle" size="lg" gap="1">
        {l.icon} {l.text}
      </Badge>
    </Tooltip>
  );
}
