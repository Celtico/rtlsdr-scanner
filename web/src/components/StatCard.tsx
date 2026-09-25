import { Box, Card, HStack, Stat } from '@chakra-ui/react';
import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  help?: ReactNode;
  icon: ReactNode;
  palette?: string;
}

export function StatCard({ label, value, help, icon, palette = 'brand' }: StatCardProps) {
  return (
    <Card.Root size="sm" variant="elevated">
      <Card.Body>
        <HStack justify="space-between" align="flex-start">
          <Stat.Root>
            <Stat.Label>{label}</Stat.Label>
            <Stat.ValueText fontSize="2xl" fontVariantNumeric="tabular-nums">{value}</Stat.ValueText>
            {help && <Stat.HelpText>{help}</Stat.HelpText>}
          </Stat.Root>
          <Box colorPalette={palette} color="colorPalette.fg" bg="colorPalette.subtle" rounded="lg" p="2" fontSize="xl">
            {icon}
          </Box>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}
