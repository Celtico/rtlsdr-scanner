import { Box, Button, HStack, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LuFocus, LuPause, LuRotate3D } from 'react-icons/lu';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Band, Sweep } from '@shared/types';
import { LUT, displayRange, downsample } from '@/lib/colormap';
import { formatMHz } from '@/lib/format';
import { disposeGroup, label } from '@/lib/three-helpers';

/**
 * The spectrum as a landscape: X is frequency, height is signal level and depth is time, with the latest
 * sweep at the front. It is the waterfall in volume, NOT a map of where signals come from: a single
 * antenna has no direction information.
 */

const MAX_COLS = 420;
const MAX_ROWS = 90;
/** Scene units. */
const WIDTH = 120;
const DEPTH = 70;
const HEIGHT = 22;
const HEIGHT_PX = 520;
const BG = 0x0b0d10;

export interface Spectrum3DProps {
  sweeps: Sweep[];
  bands: Band[];
  markedHz: number | null;
}

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Everything rebuilt when the data changes. */
  data: THREE.Group;
}

/** The waterfall palette in linear space: vertex colours are linear, the LUT is sRGB. */
const LINEAR_LUT = new Float32Array(256 * 3);
{
  const c = new THREE.Color();
  for (let i = 0; i < 256; i++) {
    c.setRGB(LUT[i * 3]! / 255, LUT[i * 3 + 1]! / 255, LUT[i * 3 + 2]! / 255, THREE.SRGBColorSpace);
    LINEAR_LUT[i * 3] = c.r;
    LINEAR_LUT[i * 3 + 1] = c.g;
    LINEAR_LUT[i * 3 + 2] = c.b;
  }
}

/** Round tick spacing (Hz) that gives about `target` ticks over `spanHz`. */
function tickStep(spanHz: number, target = 7): number {
  const raw = spanHz / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

const tickLabel = (hz: number) => (hz >= 1e9 ? `${+(hz / 1e9).toFixed(3)} GHz` : `${+(hz / 1e6).toFixed(3)} MHz`);

export function Spectrum3D({ sweeps, bands, markedHz }: Spectrum3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [spin, setSpin] = useState(true);
  const spinRef = useRef(spin);
  useEffect(() => { spinRef.current = spin; if (stageRef.current) stageRef.current.controls.autoRotate = spin; }, [spin]);

  const grid = useMemo(() => {
    const s = sweeps[sweeps.length - 1];
    if (!s) return null;
    const bins = s.dbs.length;
    const group = Math.max(1, Math.ceil(bins / MAX_COLS));
    return { lowHz: s.lowHz, spanHz: s.stepHz * bins, group, cols: Math.ceil(bins / group) };
  }, [sweeps]);

  const rows = useMemo(
    () => (grid ? sweeps.slice(-MAX_ROWS).map((s) => downsample(s.dbs, grid.group, grid.cols)) : []),
    [sweeps, grid],
  );
  const range = useMemo(() => displayRange(rows), [rows]);

  // Renderer, camera and controls: created once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BG);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(BG, 120, 260);
    const camera = new THREE.PerspectiveCamera(42, 2, 0.1, 600);
    camera.position.set(-50, 44, 100);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 3, 2);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 40;
    controls.maxDistance = 230;
    controls.autoRotate = spinRef.current;
    controls.autoRotateSpeed = 0.5;
    // Touching the scene hands the camera to the user.
    controls.addEventListener('start', () => setSpin(false));
    // The opening view, so it can be restored after zooming or panning too far.
    controls.saveState();

    const floor = new THREE.GridHelper(Math.max(WIDTH, DEPTH) * 1.6, 32, 0x1f2a33, 0x151b21);
    floor.position.y = -0.05;
    scene.add(floor);
    const data = new THREE.Group();
    scene.add(data);

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
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    stageRef.current = { renderer, scene, camera, controls, data };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(data);
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stageRef.current = null;
    };
  }, []);

  // Landscape, live profile, band labels and marker: rebuilt when the data changes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    disposeGroup(stage.data);
    if (!grid || rows.length === 0) return;

    const cols = grid.cols;
    // A single sweep still needs depth to be a surface: repeat it.
    const surface = rows.length === 1 ? [rows[0]!, rows[0]!] : rows;
    const n = surface.length;
    const xOf = (c: number) => (c / (cols - 1) - 0.5) * WIDTH;
    // Latest sweep at the front (towards the camera), older ones recede.
    // With only a few sweeps each one gets more depth, so the surface is visible from the first pass
    // instead of starting as a thin line. From 16 sweeps on the spacing shrinks until MAX_ROWS fill DEPTH.
    const depthPerRow = DEPTH / Math.min(MAX_ROWS - 1, Math.max(15, n - 1));
    const zOf = (r: number) => DEPTH / 2 - (n - 1 - r) * depthPerRow;
    const level = (db: number) => (Number.isFinite(db) ? Math.max(0, Math.min(1.15, (db - range.lo) / (range.hi - range.lo))) : 0);
    const yOf = (db: number) => Math.pow(level(db), 1.35) * HEIGHT;

    const positions = new Float32Array(cols * n * 3);
    const colors = new Float32Array(cols * n * 3);
    for (let r = 0; r < n; r++) {
      const row = surface[r]!;
      // Older sweeps fade, so the eye goes to what is happening now.
      const age = 0.45 + 0.55 * (r / (n - 1));
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        const db = row[c]!;
        positions[i] = xOf(c);
        positions[i + 1] = yOf(db);
        positions[i + 2] = zOf(r);
        // Stop at red, short of the white end of the scale: on a surface white reads as glare.
        const li = Math.round(Math.min(0.82, level(db)) * 255) * 3;
        colors[i] = LINEAR_LUT[li]! * age;
        colors[i + 1] = LINEAR_LUT[li + 1]! * age;
        colors[i + 2] = LINEAR_LUT[li + 2]! * age;
      }
    }
    const index = new Uint32Array((cols - 1) * (n - 1) * 6);
    let k = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        index[k++] = a; index[k++] = d; index[k++] = b;
        index[k++] = b; index[k++] = d; index[k++] = e;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    stage.data.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));

    // The latest sweep, drawn as a bright line along the front edge.
    const latest = surface[n - 1]!;
    const front = new Float32Array(cols * 3);
    for (let c = 0; c < cols; c++) {
      front[c * 3] = xOf(c);
      front[c * 3 + 1] = yOf(latest[c]!) + 0.08;
      front[c * 3 + 2] = zOf(n - 1) + 0.05;
    }
    const frontGeometry = new THREE.BufferGeometry();
    frontGeometry.setAttribute('position', new THREE.BufferAttribute(front, 3));
    stage.data.add(new THREE.Line(frontGeometry, new THREE.LineBasicMaterial({ color: 0x5eead4 })));

    // Frequency axis and the bands wide enough to read, in front of the latest sweep.
    const hzToX = (hz: number) => ((hz - grid.lowHz) / grid.spanHz - 0.5) * WIDTH;
    const zLabel = DEPTH / 2 + 5;
    const step = tickStep(grid.spanHz);
    for (let hz = Math.ceil(grid.lowHz / step) * step; hz <= grid.lowHz + grid.spanHz; hz += step) {
      const sprite = label(tickLabel(hz), '#8b98a5', 0.8);
      sprite.position.set(hzToX(hz), 0.4, zLabel + 5);
      stage.data.add(sprite);
    }
    // Uplink and downlink halves of one service share a name once the "(…)" is dropped: draw them as one band.
    const merged: { name: string; restricted: boolean; from: number; to: number }[] = [];
    for (const b of [...bands].sort((p, q) => p.fromHz - q.fromHz)) {
      const from = Math.max(b.fromHz, grid.lowHz);
      const to = Math.min(b.toHz, grid.lowHz + grid.spanHz);
      if (to <= from) continue;
      const name = b.name.replace(/\s*\(.*\)\s*$/, '');
      const prev = merged[merged.length - 1];
      if (prev && prev.name === name && from - prev.to < grid.spanHz * 0.05) prev.to = Math.max(prev.to, to);
      else merged.push({ name, restricted: !!b.restricted, from, to });
    }
    const shown = merged
      .filter((x) => (x.to - x.from) / grid.spanHz > 0.012)
      .sort((p, q) => (q.to - q.from) - (p.to - p.from))
      .slice(0, 9)
      .sort((p, q) => p.from - q.from);
    // Neighbouring bands would print on top of each other: stack their names on up to three levels.
    let lastX = -Infinity;
    let tier = 0;
    for (const b of shown) {
      const { from, to } = b;
      const x0 = hzToX(from);
      const x1 = hzToX(to);
      const bar = new THREE.Mesh(
        new THREE.PlaneGeometry(x1 - x0, 1.1),
        new THREE.MeshBasicMaterial({ color: b.restricted ? 0xb45353 : 0x2dd4bf, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
      );
      bar.rotation.x = -Math.PI / 2;
      bar.position.set((x0 + x1) / 2, 0.02, zLabel - 2.4);
      stage.data.add(bar);
      const sprite = label(b.name, b.restricted ? '#f0a5a5' : '#99f6e4', 0.75);
      const mid = (x0 + x1) / 2;
      tier = mid - lastX < 16 ? (tier + 1) % 3 : 0;
      lastX = mid;
      sprite.position.set(mid, 2.2 + tier * 2.3, zLabel - 2.4);
      stage.data.add(sprite);
    }

    // Marked frequency: a translucent curtain across time.
    if (markedHz != null && markedHz >= grid.lowHz && markedHz <= grid.lowHz + grid.spanHz) {
      const curtain = new THREE.Mesh(
        new THREE.PlaneGeometry(DEPTH, HEIGHT * 1.2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      curtain.rotation.y = Math.PI / 2;
      curtain.position.set(hzToX(markedHz), HEIGHT * 0.6, 0);
      stage.data.add(curtain);
      const sprite = label(formatMHz(markedHz), '#ffffff', 0.9);
      sprite.position.set(hzToX(markedHz), HEIGHT * 1.25, DEPTH / 2);
      stage.data.add(sprite);
    }
  }, [grid, rows, range, bands, markedHz]);

  return (
    <Box borderWidth="1px" rounded="l2" overflow="hidden" bg="bg.subtle" position="relative" minW="0">
      <Box ref={mountRef} h={`${HEIGHT_PX}px`} aria-label="Paisatge 3D de l'espectre" role="img" />
      {sweeps.length === 0 && (
        <Box position="absolute" inset="0" display="flex" alignItems="center" justifyContent="center" pointerEvents="none">
          <Text color="fg.muted" fontSize="sm">Inicia un escombrat per veure el paisatge de l’espectre.</Text>
        </Box>
      )}
      <HStack position="absolute" top="2" right="2" gap="2">
        <Button size="xs" variant="surface" onClick={() => setSpin((v) => !v)} aria-pressed={spin}>
          {spin ? <><LuPause /> Atura el gir</> : <><LuRotate3D /> Gira</>}
        </Button>
        <Button size="xs" variant="surface" onClick={() => stageRef.current?.controls.reset()} title="Torna a la vista inicial">
          <LuFocus /> Recentra
        </Button>
      </HStack>
      <Box px="3" py="2" borderTopWidth="1px">
        <Text fontSize="xs" color="fg.muted">
          Amplada = freqüència · alçada = intensitat · profunditat = temps (l’escombrat més recent, al davant). Arrossega per girar, roda per apropar.
          {' '}No indica direcció: amb una sola antena el receptor no sap d’on ve cada senyal.
        </Text>
      </Box>
    </Box>
  );
}
