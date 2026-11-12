import { Badge, Box, Button, Drawer, Flex, HStack, Heading, IconButton, Portal, Spinner, Stack, Text, VStack } from '@chakra-ui/react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LuActivity, LuCircleStop, LuCrosshair, LuHistory, LuLayoutDashboard, LuMenu, LuPlane, LuRadioTower, LuRefreshCw, LuSatellite, LuShieldCheck, LuX, LuZap } from 'react-icons/lu';
import { MdSensors } from 'react-icons/md';
import { TbAntenna } from 'react-icons/tb';
import { useSdr } from '@/store';
import { MODE_LABEL } from '@/lib/labels';
import { api } from '@/lib/api';
import { ColorModeButton } from '@/components/ui/color-mode';
import { Tooltip } from '@/components/ui/tooltip';
import { DongleBadge } from '@/components/DongleBadge';
import { AudioPlayer } from '@/components/AudioPlayer';

/** `what`: what the section is for. `how`: the first thing to do there. Shown at the top of each page. */
const NAV: { to: string; label: string; icon: ReactNode; what: string; how: string }[] = [
  { to: '/', label: 'Tauler', icon: <LuLayoutDashboard />, what: 'Resum de tot el que el receptor ha trobat fins ara.', how: 'El dongle només fa una cosa alhora: tria què vols que faci des de cada secció.' },
  { to: '/espectre', label: 'Espectre', icon: <LuActivity />, what: 'Mesura quanta potència hi ha a cada freqüència: el mapa del que s’emet al teu voltant (FM, TDT, mòbil, comandaments…).', how: 'Prem «Inicia» i deixa’l uns minuts. A la llista, el ▶ d’una emissora FM te la fa escoltar.' },
  { to: '/dispositius', label: 'Dispositius', icon: <MdSensors />, what: 'Escolta 433 i 868 MHz i descodifica sensors, estacions meteorològiques i comandaments propers.', how: 'Prem «Escolta dispositius» i fes servir un comandament: apareixerà a la llista.' },
  { to: '/avions', label: 'Avions', icon: <LuPlane />, what: 'Rep la posició que emeten els avions (ADS-B, 1090 MHz) i els dibuixa en una taula i un radar.', how: 'Prem «Escolta avions» i espera uns minuts. Amb l’antena a la finestra se’n reben molts més.' },
  { to: '/auditoria', label: 'Auditoria', icon: <LuShieldCheck />, what: 'Què pot saber de casa teva algú amb un receptor com aquest: quins dels teus dispositius emeten identificadors fixos.', how: 'No cal engegar res: treballa amb el que ja s’ha detectat a «Dispositius».' },
  { to: '/hunt', label: 'Hunt', icon: <LuCrosshair />, what: 'Mesura en directe la força d’un senyal a 868 MHz, per trobar on és un sensor caminant amb el portàtil.', how: 'Inicia el mode Hunt i acosta-t’hi: com més alt el nivell, més a prop.' },
  { to: '/satellits', label: 'Satèl·lits', icon: <LuSatellite />, what: 'Calcula quan passen els satèl·lits meteorològics i en grava el pas per treure’n la imatge.', how: 'Cal una antena per a 137 MHz i SatDump instal·lat. Programa un pas de la llista.' },
  { to: '/dab', label: 'DAB', icon: <LuRadioTower />, what: 'Ràdio digital DAB: llista les emissores d’un canal i les reprodueix.', how: 'Necessita Docker. Tria un canal, espera que surtin les emissores i prem ▶.' },
  { to: '/soroll', label: 'Soroll (EMI)', icon: <LuZap />, what: 'Mira si el soroll de fons de ràdio de casa és més alt del normal i quin aparell l’embruta.', how: 'Fixa una línia base amb tot endollat, desendolla un aparell, repeteix l’escombrat i mira què baixa.' },
  { to: '/historic', label: 'Històric', icon: <LuHistory />, what: 'Tot el que has fet: cada fila és una vegada que has engegat un mode.', how: 'La carpeta torna a obrir un escombrat, la fletxa n’exporta les dades i la paperera l’esborra.' },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <VStack align="stretch" gap="1">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={onNavigate}>
          {({ isActive }) => (
            <HStack
              px="3"
              py="2"
              rounded="md"
              gap="3"
              bg={isActive ? 'brand.subtle' : 'transparent'}
              color={isActive ? 'brand.fg' : 'fg.muted'}
              fontWeight={isActive ? 'semibold' : 'medium'}
              _hover={{ bg: isActive ? 'brand.subtle' : 'bg.muted', color: isActive ? 'brand.fg' : 'fg' }}
              transition="background 0.15s"
            >
              <Box fontSize="lg">{n.icon}</Box>
              <Text>{n.label}</Text>
            </HStack>
          )}
        </NavLink>
      ))}
    </VStack>
  );
}

function Brand() {
  return (
    <HStack gap="2" px="3">
      <Box color="brand.solid" fontSize="2xl">
        <TbAntenna />
      </Box>
      <Heading size="md" letterSpacing="tight">RTL-SDR Scanner</Heading>
    </HStack>
  );
}

export function Layout() {
  const { status, connected, stop, busy, setMode } = useSdr();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const location = useLocation();
  const page = NAV.find((n) => n.to === location.pathname);
  const mode = status?.mode ?? 'idle';
  const active = mode !== 'idle';

  const check = async () => {
    setChecking(true);
    try {
      await api.checkDongle();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Flex minH="100vh" bg="bg">
      {/* Sidebar (desktop) */}
      <Box
        as="nav"
        display={{ base: 'none', md: 'block' }}
        w="56"
        flexShrink={0}
        borderRightWidth="1px"
        borderColor="border"
        bg="bg.panel"
        py="4"
        position="sticky"
        top="0"
        h="100vh"
      >
        <Stack gap="6">
          <Brand />
          <Box px="2">
            <NavItems />
          </Box>
        </Stack>
      </Box>

      {/* Sidebar (mobile) */}
      <Drawer.Root open={open} onOpenChange={(e) => setOpen(e.open)} placement="start">
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content maxW="72">
              <Drawer.Header>
                <Brand />
              </Drawer.Header>
              <Drawer.Body px="2">
                <NavItems onNavigate={() => setOpen(false)} />
              </Drawer.Body>
              <Drawer.CloseTrigger asChild>
                <IconButton aria-label="Tanca el menú" variant="ghost" size="sm" position="absolute" top="2" right="2">
                  <LuX />
                </IconButton>
              </Drawer.CloseTrigger>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      <Flex direction="column" flex="1" minW="0">
        {/* Header */}
        <Flex
          as="header"
          align="center"
          gap="3"
          px={{ base: '3', md: '6' }}
          py="3"
          borderBottomWidth="1px"
          borderColor="border"
          bg="bg.panel"
          position="sticky"
          top="0"
          zIndex="sticky"
          wrap="wrap"
        >
          <IconButton aria-label="Obre el menú" variant="ghost" display={{ base: 'inline-flex', md: 'none' }} onClick={() => setOpen(true)}>
            <LuMenu />
          </IconButton>
          <Heading size="md" display={{ base: 'none', sm: 'block' }}>
            {page?.label ?? 'Tauler'}
          </Heading>
          <Box flex="1" />
          <HStack gap="2" flexWrap="wrap" justify="flex-end">
            <AudioPlayer />
            {!connected && (
              <Badge colorPalette="red" variant="subtle">
                <Spinner size="xs" /> Reconnectant…
              </Badge>
            )}
            <DongleBadge dongle={status?.dongle ?? null} />
            <Tooltip content="Torna a comprovar el dongle (només en mode inactiu)">
              <IconButton aria-label="Comprova el dongle" size="sm" variant="ghost" onClick={check} disabled={active || checking} loading={checking}>
                <LuRefreshCw />
              </IconButton>
            </Tooltip>
            <Badge colorPalette={active ? 'brand' : 'gray'} variant={active ? 'solid' : 'surface'} size="lg">
              {active && <Spinner size="xs" mr="1" />}
              {MODE_LABEL[mode]}
            </Badge>
            {active ? (
              <Button size="sm" colorPalette="red" variant="subtle" onClick={stop} loading={busy}>
                <LuCircleStop /> Atura
              </Button>
            ) : (
              <Button size="sm" colorPalette="brand" variant="subtle" onClick={() => setMode({ mode: 'devices', config: { freqsHz: [433_920_000, 868_300_000], hopS: 60 } })} loading={busy} display={{ base: 'none', md: 'inline-flex' }}>
                <MdSensors /> Escolta dispositius
              </Button>
            )}
            <ColorModeButton />
          </HStack>
        </Flex>

        <Box as="main" flex="1" p={{ base: '3', md: '6' }} minW="0" maxW="100vw" overflowX="hidden">
          {page && (
            <Text fontSize="sm" color="fg.muted" mb="4" maxW="5xl">
              <Text as="span" color="fg">{page.what}</Text> {page.how}
            </Text>
          )}
          <Outlet />
        </Box>
      </Flex>
    </Flex>
  );
}
