import { HStack, Progress, Text } from '@chakra-ui/react';

/** rtl_433 RSSI is dB relative to full scale: ~0 dB very strong, -20 dB weak. */
function rssiPercent(rssi: number | null): number {
  if (rssi === null) return 0;
  return Math.max(0, Math.min(100, Math.round(((rssi + 25) / 25) * 100)));
}

export function RssiBar({ rssi }: { rssi: number | null }) {
  const pct = rssiPercent(rssi);
  const palette = pct > 70 ? 'green' : pct > 40 ? 'yellow' : 'orange';
  return (
    <HStack gap="2" minW="28">
      <Progress.Root value={pct} size="sm" colorPalette={palette} flex="1" aria-label="RSSI">
        <Progress.Track>
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
      <Text fontSize="xs" color="fg.muted" fontVariantNumeric="tabular-nums" w="14" textAlign="right">
        {rssi === null ? '—' : `${rssi.toFixed(1)} dB`}
      </Text>
    </HStack>
  );
}
