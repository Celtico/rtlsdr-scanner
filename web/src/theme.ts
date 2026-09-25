import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

const config = defineConfig({
  globalCss: {
    // Evita el zoom automàtic d'iOS en enfocar un camp (< 16px el dispara).
    'input, select, textarea': { fontSize: '16px' },
    html: { colorScheme: 'dark light' },
    body: { bg: 'bg', color: 'fg' },
  },
  theme: {
    tokens: {
      colors: {
        brand: {
          50: { value: '#e6fffb' },
          100: { value: '#b5f5ec' },
          200: { value: '#87e8de' },
          300: { value: '#5cdbd3' },
          400: { value: '#36cfc9' },
          500: { value: '#13c2c2' },
          600: { value: '#08979c' },
          700: { value: '#006d75' },
          800: { value: '#00474f' },
          900: { value: '#002329' },
          950: { value: '#001214' },
        },
      },
      fonts: {
        mono: { value: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace" },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: { value: { _light: '{colors.brand.600}', _dark: '{colors.brand.400}' } },
          contrast: { value: { _light: 'white', _dark: '{colors.brand.950}' } },
          fg: { value: { _light: '{colors.brand.700}', _dark: '{colors.brand.300}' } },
          muted: { value: { _light: '{colors.brand.100}', _dark: '{colors.brand.900}' } },
          subtle: { value: { _light: '{colors.brand.50}', _dark: '{colors.brand.950}' } },
          emphasized: { value: { _light: '{colors.brand.200}', _dark: '{colors.brand.800}' } },
          focusRing: { value: { _light: '{colors.brand.600}', _dark: '{colors.brand.400}' } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
