import { Badge, Box, Button, Card, Field, HStack, Input, NativeSelect, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { LuCircleStop, LuDownload, LuPlay } from 'react-icons/lu';
import { DEFAULT_SURVEY, type Signal, type SurveyConfig } from '@shared/types';
import { useSdr } from '@/store';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { Waterfall } from '@/components/Waterfall';
import { audioEngine, useAudioEngine } from '@/lib/audioEngine';
import { SignalsTable } from '@/components/SignalsTable';

const PRESETS: { label: string; fromMHz: number; toMHz: number; stepKHz: number }[] = [
  { label: 'Tot (24–1700 MHz, 100 kHz)', fromMHz: 24, toMHz: 1700, stepKHz: 100 },
  { label: 'FM (87–108 MHz, 25 kHz)', fromMHz: 87, toMHz: 108, stepKHz: 25 },
  { label: 'Aèria (118–137 MHz, 10 kHz)', fromMHz: 118, toMHz: 137, stepKHz: 10 },
  { label: 'VHF (137–175 MHz, 10 kHz)', fromMHz: 137, toMHz: 175, stepKHz: 10 },
  { label: 'UHF ISM 433 (400–470 MHz, 10 kHz)', fromMHz: 400, toMHz: 470, stepKHz: 10 },
  { label: 'ISM 868 (860–880 MHz, 5 kHz)', fromMHz: 860, toMHz: 880, stepKHz: 5 },
  { label: 'TDT (470–700 MHz, 100 kHz)', fromMHz: 470, toMHz: 700, stepKHz: 100 },
];

// Real R820T gain steps (rtl_test -t). rtl_power rounds any value to the nearest one.
const GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6];
const nearestGain = (g: number) => GAINS.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));

interface Form { fromMHz: string; toMHz: string; stepKHz: string; gainDb: string; intervalS: string; thresholdDb: string }

function toForm(c: SurveyConfig): Form {
  return {
    fromMHz: String(c.fromHz / 1e6), toMHz: String(c.toHz / 1e6), stepKHz: String(c.stepHz / 1e3),
    gainDb: String(c.gainDb), intervalS: String(c.intervalS), thresholdDb: String(c.thresholdDb),
  };
}

function toConfig(f: Form): SurveyConfig {
  return {
    fromHz: Math.round(Number(f.fromMHz) * 1e6), toHz: Math.round(Number(f.toMHz) * 1e6), stepHz: Math.round(Number(f.stepKHz) * 1e3),
    gainDb: Number(f.gainDb), intervalS: Number(f.intervalS), thresholdDb: Number(f.thresholdDb),
  };
}

export function Spectrum() {
  const { status, sweeps, signals, signalsScanId, bands, setMode, stop, busy } = useSdr();
  const [form, setForm] = useState<Form>(() => toForm(DEFAULT_SURVEY));
  const [marked, setMarked] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const running = status?.mode === 'survey';
  const audio = useAudioEngine();
  const runningConfig = running && status.config && 'fromHz' in status.config ? status.config : null;
  // Mirror the running survey's configuration (it may have been started from another page or client).
  useEffect(() => { if (runningConfig) setForm(toForm(runningConfig)); }, [runningConfig]);
  const bins = Math.round(((Number(form.toMHz) - Number(form.fromMHz)) * 1e6) / (Number(form.stepKHz) * 1e3));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const start = () => setMode({ mode: 'survey', config: toConfig(form) });
  const pick = (s: Signal) => { setSelected(s.id); setMarked(s.freqHz); };
  const last = sweeps[sweeps.length - 1];

  return (
    <Stack gap="4" minW="0">
      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Body>
          <Stack gap="3">
            <SimpleGrid columns={{ base: 2, md: 4, xl: 7 }} gap="3" alignItems="end">
              <Field.Root gridColumn={{ base: 'span 2', md: 'span 4', xl: 'span 2' }}>
                <Field.Label>Preajust</Field.Label>
                <NativeSelect.Root size="sm">
                  <NativeSelect.Field
                    aria-label="Preajust de rang"
                    onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) setForm((f) => ({ ...f, fromMHz: String(p.fromMHz), toMHz: String(p.toMHz), stepKHz: String(p.stepKHz) })); }}
                    defaultValue="0"
                  >
                    {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              <Field.Root>
                <Field.Label>De (MHz)</Field.Label>
                <Input size="sm" type="number" inputMode="decimal" value={form.fromMHz} onChange={set('fromMHz')} disabled={running} />
              </Field.Root>
              <Field.Root>
                <Field.Label>A (MHz)</Field.Label>
                <Input size="sm" type="number" inputMode="decimal" value={form.toMHz} onChange={set('toMHz')} disabled={running} />
              </Field.Root>
              <Field.Root>
                <Field.Label>Pas (kHz)</Field.Label>
                <Input size="sm" type="number" inputMode="decimal" value={form.stepKHz} onChange={set('stepKHz')} disabled={running} />
              </Field.Root>
              <Field.Root>
                <Field.Label>Guany (dB)</Field.Label>
                <NativeSelect.Root size="sm" disabled={running}>
                  <NativeSelect.Field value={String(nearestGain(Number(form.gainDb)))} onChange={set('gainDb')} aria-label="Guany">
                    {GAINS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              <Field.Root>
                <Field.Label>Llindar (dB)</Field.Label>
                <Input size="sm" type="number" inputMode="decimal" value={form.thresholdDb} onChange={set('thresholdDb')} disabled={running} />
              </Field.Root>
            </SimpleGrid>
            <HStack justify="space-between" flexWrap="wrap" gap="3">
              <HStack gap="3" flexWrap="wrap">
                <Field.Root w="auto" orientation="horizontal">
                  <Field.Label fontSize="sm">Integració (s)</Field.Label>
                  <Input size="sm" w="20" type="number" inputMode="numeric" value={form.intervalS} onChange={set('intervalS')} disabled={running} />
                </Field.Root>
                <Text fontSize="sm" color={bins > 200_000 ? 'red.fg' : 'fg.muted'}>
                  {Number.isFinite(bins) && bins > 0 ? `${bins.toLocaleString('ca-ES')} bins` : ''}
                </Text>
                {last && (
                  <Badge variant="subtle" colorPalette="brand">
                    {sweeps.length} escombrats · darrer {formatTime(last.ts)}
                  </Badge>
                )}
              </HStack>
              <HStack>
                <Button asChild size="sm" variant="outline" disabled={!signals.length}>
                  <a href={api.exportUrl('signals', 'csv', { scanId: signalsScanId ?? undefined })} download><LuDownload /> CSV</a>
                </Button>
                {running ? (
                  <Button size="sm" colorPalette="red" onClick={stop} loading={busy}><LuCircleStop /> Atura</Button>
                ) : (
                  <Button size="sm" colorPalette="brand" onClick={start} loading={busy}>
                    <LuPlay /> {status?.mode && status.mode !== 'idle' ? 'Canvia a escombrat' : 'Inicia'}
                  </Button>
                )}
              </HStack>
            </HStack>
          </Stack>
        </Card.Body>
      </Card.Root>

      <Waterfall sweeps={sweeps} bands={bands} markedHz={marked} onPick={(hz) => { setMarked(hz); setSelected(null); }} />

      <Card.Root size="sm" minW="0" overflow="hidden">
        <Card.Header>
          <HStack justify="space-between" flexWrap="wrap">
            <Card.Title>Senyals ({signals.length})</Card.Title>
            <Text fontSize="sm" color="fg.muted">Clica un senyal per marcar-lo al waterfall. Les emissores FM tenen botó d’escolta (atura l’escombrat: el dongle només fa una cosa alhora).</Text>
          </HStack>
        </Card.Header>
        <Card.Body pt="0">
          <Box maxH="lg" overflowY="auto">
            <SignalsTable
              signals={signals}
              selectedId={selected}
              onSelect={pick}
              playingHz={audio.playing ? audio.freqHz : null}
              onPlay={(s) => { pick(s); void audioEngine.play(s.freqHz); }}
              onStop={() => audioEngine.stop()}
            />
          </Box>
        </Card.Body>
      </Card.Root>
    </Stack>
  );
}
