/* eslint-disable react-refresh/only-export-components */
import { IconButton, type IconButtonProps } from '@chakra-ui/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LuMoon, LuSun } from 'react-icons/lu';
import { Tooltip } from './tooltip';

export type ColorMode = 'light' | 'dark';

const STORAGE_KEY = 'sdr-color-mode';

interface Ctx { colorMode: ColorMode; setColorMode: (m: ColorMode) => void; toggleColorMode: () => void }
const ColorModeCtx = createContext<Ctx | null>(null);

function readStored(): ColorMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(mode: ColorMode) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(mode);
  root.style.colorScheme = mode;
}

/** Fosc per defecte sempre; no se segueix el sistema. Chakra llegeix la classe `dark`/`light` de <html>. */
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [colorMode, setState] = useState<ColorMode>(() => {
    const m = readStored();
    if (typeof document !== 'undefined') apply(m);
    return m;
  });

  useEffect(() => { apply(colorMode); }, [colorMode]);

  const setColorMode = useCallback((m: ColorMode) => {
    setState(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
  }, []);
  const toggleColorMode = useCallback(() => setColorMode(colorMode === 'dark' ? 'light' : 'dark'), [colorMode, setColorMode]);

  const value = useMemo(() => ({ colorMode, setColorMode, toggleColorMode }), [colorMode, setColorMode, toggleColorMode]);
  return <ColorModeCtx.Provider value={value}>{children}</ColorModeCtx.Provider>;
}

export function useColorMode(): Ctx {
  const v = useContext(ColorModeCtx);
  if (!v) throw new Error('useColorMode fora de ColorModeProvider');
  return v;
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
