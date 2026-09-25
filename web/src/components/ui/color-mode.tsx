/* eslint-disable react-refresh/only-export-components */
import { IconButton, type IconButtonProps } from '@chakra-ui/react';
import { ThemeProvider, useTheme, type ThemeProviderProps } from 'next-themes';
import { LuMoon, LuSun } from 'react-icons/lu';
import { Tooltip } from './tooltip';

export type ColorMode = 'light' | 'dark';

export function ColorModeProvider(props: ThemeProviderProps) {
  // Fosc per defecte sempre: no se segueix el sistema.
  return <ThemeProvider attribute="class" disableTransitionOnChange defaultTheme="dark" enableSystem={false} {...props} />;
}

export function useColorMode() {
  const { resolvedTheme, setTheme, forcedTheme } = useTheme();
  const colorMode = (forcedTheme ?? resolvedTheme ?? 'dark') as ColorMode;
  const toggleColorMode = () => setTheme(colorMode === 'dark' ? 'light' : 'dark');
  return { colorMode, setColorMode: setTheme, toggleColorMode };
}

export function ColorModeButton(props: Omit<IconButtonProps, 'aria-label'>) {
  const { colorMode, toggleColorMode } = useColorMode();
  const label = colorMode === 'dark' ? 'Canvia a tema clar' : 'Canvia a tema fosc';
  return (
    <Tooltip content={label}>
      <IconButton onClick={toggleColorMode} variant="ghost" aria-label={label} size="sm" {...props}>
        {colorMode === 'dark' ? <LuSun /> : <LuMoon />}
      </IconButton>
    </Tooltip>
  );
}
