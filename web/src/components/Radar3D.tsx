import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuFocus, LuMap, LuPause, LuRotate3D, LuSatellite } from 'react-icons/lu';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Device, Plane, SkySat } from '@shared/types';
import type { TrailPoint } from '@/store';
import { api } from '@/lib/api';
import { BASEMAP_ATTRIBUTION, loadBasemap } from '@/lib/basemap';
import { bearingDeg, destination, distanceKm } from '@/lib/geo';
import { altitudeColor, rssiToRadius } from '@/lib/radar';
import type { RadarFilter } from '@/components/RadarCanvas';
import { disposeGroup, label } from '@/lib/three-helpers';

/**
 * What the receiver hears around home, in three dimensions. Aircraft are at their real position: ADS-B
 * frames carry the aircraft's own GPS fix and altitude. Sensors and remotes send no position, so each is
 * a ring on the ground whose radius comes from its signal strength: how close, never which way.
 * Satellites are drawn on a sky dome by direction only (azimuth and elevation), computed from their
 * published orbits: they are where to look, not something the dongle heard.
 */

/** Scene units: the range ring sits at RADIUS, and CEILING_FT is drawn at CEILING. */
const RADIUS = 60;
const CEILING = 26;
const CEILING_FT = 45_000;
const KM_PER_FT = 0.0003048;
const HEIGHT_PX = 560;
const BG = 0x0b0d10;
const TEAL = 0x2dd4bf;
/** The sky dome: as wide as the range ring, and this tall at the zenith. */
const DOME_HEIGHT = 46;
const SKY_COLOR: Record<SkySat['group'], number> = { weather: 0xfbbf24, iss: 0xf472b6, gps: 0x93a4b3 };
/** Sky tracks are fetched again this often; in between, positions are interpolated. */
const SKY_REFRESH_MS = 5 * 60_000;
const MAP_KEY = 'sdr-radar3d-map';
const SKY_KEY = 'sdr-radar3d-sky';

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) !== '0'; } catch { return true; }
}
function writeFlag(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* ignore */ }
}

/** A direction in the sky as a point on the dome. */
function domePoint(azDeg: number, elDeg: number): THREE.Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el) * RADIUS, Math.sin(el) * DOME_HEIGHT, -Math.cos(az) * Math.cos(el) * RADIUS);
}

/** Azimuth and elevation of a satellite at `t`, interpolated between its samples; null outside them. */
function skyAt(track: SkySat['track'], t: number): { az: number; el: number } | null {
  if (track.length === 0 || t < track[0]![0] || t > track[track.length - 1]![0]) return null;
  let i = 1;
  while (i < track.length - 1 && track[i]![0] < t) i++;
  const [t0, az0, el0] = track[i - 1]!;
  const [t1, az1, el1] = track[i]!;
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const turn = ((az1 - az0 + 540) % 360) - 180; // the short way round north
  return { az: (az0 + turn * f + 360) % 360, el: el0 + (el1 - el0) * f };
}
/** A plane not heard for this long is drawn faded. */
const STALE_MS = 60_000;
/** Aircraft heard without a position are kept on the altitude mast for this long. */
const UNPLACED_MS = 5 * 60_000;

export interface Radar3DProps {
  home: { lat: number; lon: number };
  rangeKm: number;
  planes: Plane[];
  trails: ReadonlyMap<string, TrailPoint[]>;
  devices: Device[];
  filter: RadarFilter;
  now: number;
}

interface Stage {
  controls: OrbitControls;
  /** Rings, compass and altitude scale: rebuilt when the range changes. */
  frame: THREE.Group;
  /** Aircraft: rebuilt when the data changes. */
  traffic: THREE.Group;
  /** The street map on the ground. */
  map: THREE.Group;
  /** The sky dome and the satellites on it. */
  sky: THREE.Group;
}

const altY = (ft: number | null) => (Math.max(0, ft ?? 0) / CEILING_FT) * CEILING;

function circle(radius: number, y: number, color: number, opacity: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
  }
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function segment(a: THREE.Vector3, b: THREE.Vector3, color: THREE.ColorRepresentation, opacity: number): THREE.Line {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

export function Radar3D({ home, rangeKm, planes, trails, devices, filter, now }: Radar3DProps) {
  const showPlanes = filter !== 'devices';
  const shownDevices = useMemo(() => (filter === 'planes' ? [] : devices), [filter, devices]);
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [spin, setSpin] = useState(true);
  const [mapOn, setMapOn] = useState(() => readFlag(MAP_KEY));
  const [skyOn, setSkyOn] = useState(() => readFlag(SKY_KEY));
  const [mapState, setMapState] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [sats, setSats] = useState<SkySat[]>([]);
  const [skyError, setSkyError] = useState(false);
  const spinRef = useRef(spin);
  useEffect(() => { writeFlag(MAP_KEY, mapOn); }, [mapOn]);
  useEffect(() => { writeFlag(SKY_KEY, skyOn); }, [skyOn]);
  useEffect(() => { spinRef.current = spin; if (stageRef.current) stageRef.current.controls.autoRotate = spin; }, [spin]);

  /** Ground position of a lat/lon: east is +X, north is −Z. */
  const place = useMemo(() => {
    const scale = RADIUS / rangeKm;
    return (lat: number, lon: number) => {
      const d = distanceKm(home.lat, home.lon, lat, lon);
      const b = (bearingDeg(home.lat, home.lon, lat, lon) * Math.PI) / 180;
      return { x: Math.sin(b) * d * scale, z: -Math.cos(b) * d * scale, km: d };
    };
  }, [home, rangeKm]);

  const positioned = useMemo(() => planes.filter((p) => p.lat != null && p.lon != null), [planes]);
  // Heard, with an altitude, but no position yet: we know how high it is, not where.
  const unplaced = useMemo(
    () => planes.filter((p) => (p.lat == null || p.lon == null) && p.altitudeFt != null && now - p.lastSeen < UNPLACED_MS).slice(0, 8),
    [planes, now],
  );
  const inRange = useMemo(() => positioned.filter((p) => place(p.lat!, p.lon!).km <= rangeKm * 1.05), [positioned, place, rangeKm]);
  // How much taller than true scale altitudes are drawn (so 10 km of height is visible over 100 km of ground).
  const exaggeration = (CEILING / (CEILING_FT * KM_PER_FT)) / (RADIUS / rangeKm);

  // Renderer, camera, controls and the rotating beam: created once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BG);
    renderer.domElement.style.display = 'block';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(BG, 190, 380);
    const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 700);
    camera.position.set(-66, 58, 116);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 7, 0);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 40;
    controls.maxDistance = 280;
    controls.autoRotate = spinRef.current;
    controls.autoRotateSpeed = 0.35;
    controls.addEventListener('start', () => setSpin(false));
    // The opening view, so it can be restored after zooming or panning too far.
    controls.saveState();

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS, 96),
      new THREE.MeshBasicMaterial({ color: 0x111a20, transparent: true, opacity: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    scene.add(ground);

    // The sweeping beam is the classic radar cue. It is decoration: nothing is detected by it.
    const beam = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS, 24, 0, Math.PI / 7),
      new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.rotation.x = -Math.PI / 2;
    beam.position.y = 0.02;
    scene.add(beam);

    const frame = new THREE.Group();
    const traffic = new THREE.Group();
    const map = new THREE.Group();
    const sky = new THREE.Group();
    scene.add(map, frame, traffic, sky);

    const resize = () => {
      const w = mount.clientWidth || 800;
      renderer.setSize(w, HEIGHT_PX);
      camera.aspect = w / HEIGHT_PX;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    const tick = () => {
      beam.rotation.z -= 0.012;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    stageRef.current = { controls, frame, traffic, map, sky };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(frame);
      disposeGroup(traffic);
      disposeGroup(map);
      disposeGroup(sky);
      for (const m of [ground, beam]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stageRef.current = null;
    };
  }, []);

  // The street map: a disc whose every vertex looks up its own place on the stitched tiles, so the map
  // follows the same distance-and-bearing projection as everything drawn on top of it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.map);
    if (!mapOn) { setMapState('off'); return; }
    setMapState('loading');
    const abort = new AbortController();
    void loadBasemap(home, rangeKm, abort.signal).then((basemap) => {
      if (abort.signal.aborted || stageRef.current !== stage) return;
      if (!basemap) { setMapState('failed'); return; }
      const geometry = new THREE.RingGeometry(0, RADIUS, 96, 28);
      const pos = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < pos.count; i++) {
        // Before the disc is laid flat, +X is east and +Y is north.
        const x = pos.getX(i);
        const y = pos.getY(i);
        const at = destination(home.lat, home.lon, (Math.atan2(x, y) * 180) / Math.PI, (Math.hypot(x, y) / RADIUS) * rangeKm);
        const [u, v] = basemap.uv(at.lat, at.lon);
        uv.setXY(i, u, v);
      }
      uv.needsUpdate = true;
      const texture = new THREE.CanvasTexture(basemap.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      const disc = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = -0.01;
      stage.map.add(disc);
      setMapState('ready');
    });
    return () => abort.abort();
  }, [mapOn, home, rangeKm]);

  // Satellite tracks, refreshed now and then.
  useEffect(() => {
    if (!skyOn) { setSats([]); setSkyError(false); return; }
    let alive = true;
    const load = () => api.satSky(home.lat, home.lon)
      .then((r) => { if (alive) { setSats(r.satellites); setSkyError(false); } })
      .catch(() => { if (alive) setSkyError(true); });
    void load();
    const id = setInterval(() => void load(), SKY_REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [skyOn, home]);

  const overhead = useMemo(
    () => sats.flatMap((s) => { const at = skyAt(s.track, now); return at && at.el > 0 ? [{ sat: s, ...at }] : []; }),
    [sats, now],
  );

  // The sky dome and what is on it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.sky);
    if (!skyOn) return;
    const g = stage.sky;
    // Elevation circles and four ribs, so the dome reads as a surface.
    for (const el of [30, 60]) {
      const r = Math.cos((el * Math.PI) / 180) * RADIUS;
      g.add(circle(r, domePoint(0, el).y, 0x3b4a5a, 0.5));
      const s = label(`${el}°`, '#6b7a88', 0.55);
      s.position.copy(domePoint(135, el));
      g.add(s);
    }
    for (const az of [0, 90, 180, 270]) {
      const rib: THREE.Vector3[] = [];
      for (let el = 0; el <= 90; el += 3) rib.push(domePoint(az, el));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rib), new THREE.LineBasicMaterial({ color: 0x3b4a5a, transparent: true, opacity: 0.35 })));
    }
    for (const { sat, az, el } of overhead) {
      const color = SKY_COLOR[sat.group];
      const here = domePoint(az, el);
      const minor = sat.group === 'gps';
      const body = new THREE.Mesh(new THREE.OctahedronGeometry(minor ? 0.8 : 1.5), new THREE.MeshBasicMaterial({ color }));
      body.position.copy(here);
      g.add(body);
      // The rest of its way across the sky, until it sets or the forecast ends.
      const ahead = sat.track.filter(([t, , e]) => t > now && e > 0).map(([, a, e]) => domePoint(a, e));
      if (ahead.length > 0) {
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([here, ...ahead]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: minor ? 0.35 : 0.8 })));
      }
      const tag = label(minor ? sat.name : `${sat.name} · ${Math.round(el)}°`, minor ? '#93a4b3' : `#${color.toString(16).padStart(6, '0')}`, minor ? 0.5 : 0.7);
      tag.position.set(here.x, here.y + (minor ? 1.8 : 3), here.z);
      g.add(tag);
    }
  }, [skyOn, overhead, now]);

  // Range rings, compass and the altitude scale.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.frame);
    const g = stage.frame;

    for (let i = 1; i <= 4; i++) {
      const r = (RADIUS * i) / 4;
      g.add(circle(r, 0, i === 4 ? TEAL : 0x35505c, i === 4 ? 0.8 : 0.9));
      const km = label(`${Math.round((rangeKm * i) / 4)} km`, '#8b98a5', 0.6);
      km.position.set(r * Math.SQRT1_2, 0.6, r * Math.SQRT1_2);
      g.add(km);
    }
    g.add(segment(new THREE.Vector3(-RADIUS, 0, 0), new THREE.Vector3(RADIUS, 0, 0), 0x2a3a44, 0.7));
    g.add(segment(new THREE.Vector3(0, 0, -RADIUS), new THREE.Vector3(0, 0, RADIUS), 0x2a3a44, 0.7));
    for (const [name, x, z] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['O', -1, 0]] as const) {
      const s = label(name, name === 'N' ? '#5eead4' : '#9aa7b2', name === 'N' ? 0.95 : 0.75);
      s.position.set(x * (RADIUS + 5), 1, z * (RADIUS + 5));
      g.add(s);
    }

    // Home, with an altitude mast: a ring and a label every 10,000 ft.
    const homeDot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 20), new THREE.MeshBasicMaterial({ color: TEAL }));
    homeDot.position.y = 0.9;
    g.add(homeDot);
    g.add(segment(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, CEILING, 0), TEAL, 0.35));
    for (let ft = 10_000; ft <= 40_000; ft += 10_000) {
      g.add(circle(RADIUS, altY(ft), 0x22303a, 0.45));
      g.add(circle(1.6, altY(ft), TEAL, 0.5));
      const s = label(`${ft / 1000}.000 ft`, '#8b98a5', 0.6);
      s.position.set(7.5, altY(ft), 0);
      g.add(s);
    }
  }, [rangeKm]);

  // Aircraft.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.traffic);
    const g = stage.traffic;

    for (const p of showPlanes ? inRange : []) {
      const { x, z } = place(p.lat!, p.lon!);
      const y = altY(p.altitudeFt);
      const color = new THREE.Color(altitudeColor(p.altitudeFt));
      const fade = now - p.lastSeen > STALE_MS ? 0.35 : 1;
      const here = new THREE.Vector3(x, y, z);

      // Where it is over the ground, and how high.
      g.add(segment(new THREE.Vector3(x, 0, z), here, color, 0.75 * fade));
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 * fade }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(x, 0.03, z);
      g.add(shadow);

      // Where it has been. Trail points carry no altitude, so the trail is drawn at the current one.
      const trail = (trails.get(p.icao) ?? []).map((t) => { const q = place(t.lat, t.lon); return new THREE.Vector3(q.x, y, q.z); });
      if (trail.length > 1) {
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...trail, here]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 * fade })));
      }

      // The aircraft: a cone along its track, or a ball when the heading is unknown.
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fade });
      if (p.headingDeg != null) {
        const h = (p.headingDeg * Math.PI) / 180;
        const dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.3, 4.6, 14), material);
        cone.position.copy(here);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        g.add(cone);
        // Where it will be in two minutes at this speed.
        if (p.speedKt != null) {
          const ahead = ((p.speedKt * 1.852) / 30) * (RADIUS / rangeKm);
          g.add(segment(here, here.clone().addScaledVector(dir, ahead), color, 0.7 * fade));
        }
      } else {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 16), material);
        ball.position.copy(here);
        g.add(ball);
      }

      const name = p.callsign?.trim() || p.icao.toUpperCase();
      const alt = p.altitudeFt != null ? ` · ${p.altitudeFt.toLocaleString('ca-ES')} ft` : '';
      const tag = label(`${name}${alt}`, fade < 1 ? '#7b8794' : '#e6edf3', 0.72);
      tag.position.set(x, y + 4.4, z);
      g.add(tag);
    }

    // Aircraft without a position: a dashed ring around the mast at their altitude. The ring says
    // "somewhere around, this high"; its radius means nothing.
    (showPlanes ? unplaced : []).forEach((p, i) => {
      const y = altY(p.altitudeFt);
      const color = new THREE.Color(altitudeColor(p.altitudeFt));
      const r = 9 + i * 2.2;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 96; k++) { const a = (k / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 1.1, gapSize: 0.9, transparent: true, opacity: 0.85 }));
      ring.computeLineDistances();
      g.add(ring);
      const name = p.callsign?.trim() || p.icao.toUpperCase();
      const tag = label(`${name} · ${p.altitudeFt!.toLocaleString('ca-ES')} ft · sense posició`, '#b6c2cc', 0.62);
      // Spread the names around the mast so aircraft at similar altitudes do not print on top of each other.
      const a = i * 2.1;
      tag.position.set(Math.cos(a) * (r + 9), y + 1.2, Math.sin(a) * (r + 9));
      g.add(tag);
    });

    // Devices: a dashed ring on the ground, closer to home the stronger the signal. With a bearing set by
    // hand (found with a directional antenna) the device becomes a post on that ring.
    shownDevices.forEach((d, i) => {
      const r = rssiToRadius(d.rssi) * RADIUS;
      const own = d.owner ? d.owner === 'own' : d.likelyOwn;
      const color = own ? TEAL : 0x8b98a5;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 128; k++) { const a = (k / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0.06, Math.sin(a) * r)); }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 0.9, gapSize: 0.9, transparent: true, opacity: own ? 0.9 : 0.6 }));
      ring.computeLineDistances();
      g.add(ring);
      // Names go round the rings in turn, so devices with a similar signal do not print on top of each other.
      const a = d.bearingDeg != null ? ((d.bearingDeg - 90) * Math.PI) / 180 : (i / Math.max(1, shownDevices.length)) * Math.PI * 2 + 0.4;
      const at = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      if (d.bearingDeg != null) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), new THREE.MeshBasicMaterial({ color }));
        post.position.set(at.x, 1.2, at.z);
        g.add(post);
      } else {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 12), new THREE.MeshBasicMaterial({ color }));
        dot.position.set(at.x, 0.55, at.z);
        g.add(dot);
      }
      const name = d.alias ?? `${d.model}${d.deviceId ? ` ${d.deviceId.slice(-4)}` : ''}`;
      const tag = label(name, own ? '#99f6e4' : '#b6c2cc', 0.6);
      tag.position.set(at.x, 2.4, at.z);
      g.add(tag);
    });
  }, [inRange, unplaced, shownDevices, showPlanes, place, trails, now, rangeKm]);

  const outside = positioned.length - inRange.length;
  return (
    <Box borderWidth="1px" rounded="l2" overflow="hidden" bg="bg.subtle" position="relative" minW="0">
      <Box ref={mountRef} h={`${HEIGHT_PX}px`} role="img" aria-label={`Radar 3D: ${inRange.length} avions amb posició`} />
      {showPlanes && inRange.length === 0 && (
        <Box position="absolute" top="12" left="3" right="3" pointerEvents="none">
          <Text color="fg.muted" fontSize="sm">
            {outside > 0
              ? 'Hi ha avions amb posició, però fora de l’abast triat. Amplia l’abast.'
              : unplaced.length > 0
                ? `Sentits ${unplaced.length} avions, encara sense posició: se’n sap l’altitud (anell puntejat) però no on són. Cal rebre una trama parell i una senar del mateix avió.`
                : 'Cap avió encara. Amb «Escolta avions» en marxa, espera uns minuts; amb l’antena a la finestra se’n reben molts més.'}
          </Text>
        </Box>
      )}
      <HStack position="absolute" top="2" right="2" gap="2">
        <Button size="xs" variant="surface" onClick={() => setSpin((v) => !v)} aria-pressed={spin}>
          {spin ? <><LuPause /> Atura el gir</> : <><LuRotate3D /> Gira</>}
        </Button>
        <Button size="xs" variant={mapOn ? 'solid' : 'surface'} colorPalette={mapOn ? 'brand' : undefined} onClick={() => setMapOn((v) => !v)} aria-pressed={mapOn} title="Mapa a terra">
          <LuMap /> Mapa
        </Button>
        <Button size="xs" variant={skyOn ? 'solid' : 'surface'} colorPalette={skyOn ? 'brand' : undefined} onClick={() => setSkyOn((v) => !v)} aria-pressed={skyOn} title="Satèl·lits sobre l’horitzó">
          <LuSatellite /> Satèl·lits
        </Button>
        <Button size="xs" variant="surface" onClick={() => stageRef.current?.controls.reset()} title="Torna a la vista inicial">
          <LuFocus /> Recentra
        </Button>
      </HStack>
      <Box px="3" py="2" borderTopWidth="1px">
        <Text fontSize="xs" color="fg.muted">
          Avions, posició real: cada avió emet la seva posició GPS i l’altitud (ADS-B). Con = rumb · línia al davant = on serà d’aquí a 2 min · tija = alçada sobre el terra.
          {' '}L’altitud es dibuixa a ×{exaggeration.toLocaleString('ca-ES', { maximumFractionDigits: 1 })} de l’escala del terra. El feix que gira és decoratiu.
          {' '}Dispositius: un anell a terra segons la força del senyal (com més fort, més a prop del centre). Se’n sap la proximitat, no la direcció: el punt només hi posa el nom.
          {skyOn && (
            <>
              {' '}Satèl·lits ({overhead.length} sobre l’horitzó): posició <b>calculada</b> amb l’òrbita publicada (Celestrak), no rebuda. A la cúpula només compta la direcció (on mirar i a quina elevació), no la distància. Groc = meteorològics que es poden rebre a 137 MHz · rosa = ISS · gris = GPS.
              {skyError && ' No s’han pogut obtenir les òrbites (cal connexió).'}
            </>
          )}
          {mapOn && mapState === 'failed' && ' El mapa no s’ha pogut carregar (cal connexió).'}
        </Text>
      </Box>
      {mapOn && mapState === 'ready' && (
        <Text position="absolute" top={`${HEIGHT_PX - 20}px`} right="3" fontSize="2xs" color="fg.muted" pointerEvents="none">
          {BASEMAP_ATTRIBUTION}
        </Text>
      )}
    </Box>
  );
}
