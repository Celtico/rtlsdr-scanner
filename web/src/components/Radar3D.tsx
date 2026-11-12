import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuPause, LuRotate3D } from 'react-icons/lu';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Plane } from '@shared/types';
import type { TrailPoint } from '@/store';
import { bearingDeg, distanceKm } from '@/lib/geo';
import { altitudeColor } from '@/lib/radar';
import { disposeGroup, label } from '@/lib/three-helpers';

/**
 * Aircraft around home in three dimensions. Everything drawn here is a real position: ADS-B frames carry
 * the aircraft's own GPS fix and altitude. Devices without a position (sensors, remotes) are not shown;
 * they stay on the 2D radar's RSSI rings.
 */

/** Scene units: the range ring sits at RADIUS, and CEILING_FT is drawn at CEILING. */
const RADIUS = 60;
const CEILING = 26;
const CEILING_FT = 45_000;
const KM_PER_FT = 0.0003048;
const HEIGHT_PX = 560;
const BG = 0x0b0d10;
const TEAL = 0x2dd4bf;
/** A plane not heard for this long is drawn faded. */
const STALE_MS = 60_000;
/** Aircraft heard without a position are kept on the altitude mast for this long. */
const UNPLACED_MS = 5 * 60_000;

export interface Radar3DProps {
  home: { lat: number; lon: number };
  rangeKm: number;
  planes: Plane[];
  trails: ReadonlyMap<string, TrailPoint[]>;
  now: number;
}

interface Stage {
  controls: OrbitControls;
  /** Rings, compass and altitude scale: rebuilt when the range changes. */
  frame: THREE.Group;
  /** Aircraft: rebuilt when the data changes. */
  traffic: THREE.Group;
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

export function Radar3D({ home, rangeKm, planes, trails, now }: Radar3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [spin, setSpin] = useState(true);
  const spinRef = useRef(spin);
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
    scene.add(frame, traffic);

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

    stageRef.current = { controls, frame, traffic };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(frame);
      disposeGroup(traffic);
      for (const m of [ground, beam]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stageRef.current = null;
    };
  }, []);

  // Range rings, compass and the altitude scale.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.frame);
    const g = stage.frame;

    for (let i = 1; i <= 4; i++) {
      const r = (RADIUS * i) / 4;
      g.add(circle(r, 0, i === 4 ? TEAL : 0x35505c, i === 4 ? 0.8 : 0.9));
      const km = label(`${Math.round((rangeKm * i) / 4)} km`, '#8b98a5', 1);
      km.position.set(r * Math.SQRT1_2, 0.6, r * Math.SQRT1_2);
      g.add(km);
    }
    g.add(segment(new THREE.Vector3(-RADIUS, 0, 0), new THREE.Vector3(RADIUS, 0, 0), 0x2a3a44, 0.7));
    g.add(segment(new THREE.Vector3(0, 0, -RADIUS), new THREE.Vector3(0, 0, RADIUS), 0x2a3a44, 0.7));
    for (const [name, x, z] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['O', -1, 0]] as const) {
      const s = label(name, name === 'N' ? '#5eead4' : '#9aa7b2', name === 'N' ? 1.5 : 1.1);
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
      const s = label(`${ft / 1000}.000 ft`, '#8b98a5', 0.9);
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

    for (const p of inRange) {
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
      const tag = label(`${name}${alt}`, fade < 1 ? '#7b8794' : '#e6edf3', 1.25);
      tag.position.set(x, y + 4.4, z);
      g.add(tag);
    }

    // Aircraft without a position: a dashed ring around the mast at their altitude. The ring says
    // "somewhere around, this high"; its radius means nothing.
    unplaced.forEach((p, i) => {
      const y = altY(p.altitudeFt);
      const color = new THREE.Color(altitudeColor(p.altitudeFt));
      const r = 9 + i * 2.2;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 96; k++) { const a = (k / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 1.1, gapSize: 0.9, transparent: true, opacity: 0.85 }));
      ring.computeLineDistances();
      g.add(ring);
      const name = p.callsign?.trim() || p.icao.toUpperCase();
      const tag = label(`${name} · ${p.altitudeFt!.toLocaleString('ca-ES')} ft · sense posició`, '#b6c2cc', 0.9);
      // Spread the names around the mast so aircraft at similar altitudes do not print on top of each other.
      const a = i * 2.1;
      tag.position.set(Math.cos(a) * (r + 9), y + 1.2, Math.sin(a) * (r + 9));
      g.add(tag);
    });
  }, [inRange, unplaced, place, trails, now, rangeKm]);

  const outside = positioned.length - inRange.length;
  return (
    <Box borderWidth="1px" rounded="l2" overflow="hidden" bg="bg.subtle" position="relative" minW="0">
      <Box ref={mountRef} h={`${HEIGHT_PX}px`} role="img" aria-label={`Radar 3D: ${inRange.length} avions amb posició`} />
      {inRange.length === 0 && (
        <Box position="absolute" top="3" left="3" right="32" pointerEvents="none">
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
      </HStack>
      <Box px="3" py="2" borderTopWidth="1px">
        <Text fontSize="xs" color="fg.muted">
          Posicions reals: cada avió emet la seva posició GPS i l’altitud (ADS-B). Con = rumb · línia al davant = on serà d’aquí a 2 min · tija = alçada sobre el terra.
          {' '}L’altitud es dibuixa a ×{exaggeration.toLocaleString('ca-ES', { maximumFractionDigits: 1 })} de l’escala del terra. El feix que gira és decoratiu.
          {' '}Els dispositius sense posició només surten al radar 2D.
        </Text>
      </Box>
    </Box>
  );
}
