import { Box, Card, HStack, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { LuChevronRight } from 'react-icons/lu';

export interface SummaryCardProps {
  title: string;
  to: string;
  icon: ReactNode;
  palette?: string;
  children: ReactNode;
  action?: ReactNode;
}

/** One-glance summary of a section, linking to it. */
export function SummaryCard({ title, to, icon, palette = 'brand', children, action }: SummaryCardProps) {
  return (
    <Card.Root size="sm" variant="outline" minW="0" _hover={{ borderColor: 'colorPalette.solid' }} colorPalette={palette}>
      <Card.Body>
        <HStack justify="space-between" mb="2">
          <RouterLink to={to}>
            <HStack gap="2" color="colorPalette.fg" fontWeight="semibold" fontSize="sm">
              <Box fontSize="md">{icon}</Box>
              <Text>{title}</Text>
              <Box color="fg.muted" fontSize="xs"><LuChevronRight /></Box>
            </HStack>
          </RouterLink>
          {action}
        </HStack>
        <Box fontSize="sm">{children}</Box>
      </Card.Body>
    </Card.Root>
  );
}
