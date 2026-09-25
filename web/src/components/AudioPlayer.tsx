import { Badge, Box, HStack, IconButton, Slider, Spinner, Text } from '@chakra-ui/react';
import { useEffect } from 'react';
import { LuCircleStop, LuRadio, LuVolume2 } from 'react-icons/lu';
import { useSdr } from '@/store';
import { audioEngine, useAudioEngine } from '@/lib/audioEngine';
import { formatMHz } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';

/** Header bar shown while an FM station is being demodulated. */
export function AudioPlayer() {
  const { status } = useSdr();
  const audio = useAudioEngine();
  const serverAudio = status?.mode === 'audio' && status.config && 'freqHz' in status.config && !('sampleRate' in status.config) && !('fromHz' in status.config) ? status.config : null;

  // The server switched away from audio (another mode, another client): stop the local stream.
  useEffect(() => {
    if (status && status.mode !== 'audio') audioEngine.serverStopped();
  }, [status]);

  if (!serverAudio && !audio.playing) return null;
  const freqHz = audio.freqHz ?? serverAudio?.freqHz ?? 0;

  return (
    <HStack gap="2" px="3" py="1" rounded="full" bg="brand.subtle" borderWidth="1px" borderColor="brand.emphasized" flexWrap="wrap">
      <Box color="brand.fg"><LuRadio /></Box>
      <Text fontWeight="semibold" fontSize="sm" fontFamily="mono">{formatMHz(freqHz, 1)}</Text>
      <Badge colorPalette="brand" variant="subtle" size="sm">FM</Badge>
      {audio.buffering && <Spinner size="xs" />}
      {audio.error && <Text fontSize="xs" color="red.fg">{audio.error}</Text>}
      {!audio.playing && serverAudio && (
        <Tooltip content="Aquesta pestanya no reprodueix el so: prem per escoltar-la aquí">
          <IconButton aria-label="Escolta aquí" size="xs" variant="ghost" onClick={() => audioEngine.play(serverAudio.freqHz)}><LuVolume2 /></IconButton>
        </Tooltip>
      )}
      {audio.playing && (
        <Slider.Root
          size="sm" w="24" min={0} max={1} step={0.05} value={[audio.volume]}
          onValueChange={(e) => audioEngine.setVolume(e.value[0] ?? 0.8)} aria-label={['Volum']}
        >
          <Slider.Control>
            <Slider.Track><Slider.Range /></Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
      )}
      <Tooltip content="Atura la ràdio">
        <IconButton aria-label="Atura la ràdio" size="xs" variant="ghost" colorPalette="red" onClick={() => audioEngine.stop()}><LuCircleStop /></IconButton>
      </Tooltip>
    </HStack>
  );
}
