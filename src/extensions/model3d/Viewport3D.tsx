/** The 3D viewport: a three.js canvas with orbit/pan/zoom, picking, selection outlines and transform gizmos. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { sceneBounds, type Model3D, type Shading, type Vec3 } from './model3d';
import { buildScene, type BuiltScene } from './modelScene';

export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale';
export type ViewPreset = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

export interface TransformResult { position: Vec3; rotation: Vec3; scale: Vec3 }

export interface Viewport3DHandle {
  setView: (preset: ViewPreset) => void;
  frame: (ids: string[]) => void;
  /** The viewport camera, for saving it with the model. */
  getView: () => { position: Vec3; target: Vec3 };
  stats: () => { calls: number; triangles: number };
}

interface Props {
  model: Model3D;
  selection: string[];
  mode: GizmoMode;
  shading: Shading;
  ortho: boolean;
  grid: boolean;
  snap: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  onTransform: (id: string, result: TransformResult, final: boolean) => void;
  onViewChange?: () => void;
}

const deg = THREE.MathUtils.radToDeg;
const vec = (v: THREE.Vector3): Vec3 => [Math.round(v.x * 10000) / 10000, Math.round(v.y * 10000) / 10000, Math.round(v.z * 10000) / 10000];

/** Everything the viewport keeps outside React state. */
interface Rt {
  renderer: THREE.WebGLRenderer;
  persp: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
  orbit: OrbitControls;
  transform: TransformControls;
  built: BuiltScene | null;
  helperGroup: THREE.Group;
  grid: THREE.GridHelper;
  headlight: THREE.DirectionalLight;
  fill: THREE.HemisphereLight;
  boxes: THREE.Box3Helper[];
  frame: number;
  dragging: boolean;
}

export const Viewport3D = forwardRef<Viewport3DHandle, Props>(function Viewport3D({ model, selection, mode, shading, ortho, grid, snap, onSelect, onTransform, onViewChange }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rt = useRef<Rt | null>(null);
  const live = useRef({ model, selection, mode, onSelect, onTransform, onViewChange, ortho });

  useEffect(() => { live.current = { model, selection, mode, onSelect, onTransform, onViewChange, ortho }; });

  const activeCamera = (r: Rt): THREE.Camera => (live.current.ortho ? r.orthoCam : r.persp);

  const requestRender = (): void => {
    const r = rt.current;
    if (!r || r.frame) return;
    r.frame = window.requestAnimationFrame(() => {
      r.frame = 0;
      r.renderer.render(r.built?.scene ?? new THREE.Scene(), activeCamera(r));
    });
  };

  /* ---- set up the renderer, cameras and controls once ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'm3d__canvas';
    renderer.domElement.setAttribute('aria-label', '3D viewport');
    host.appendChild(renderer.domElement);

    const persp = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    const orthoCam = new THREE.OrthographicCamera(-5, 5, 5, -5, -1000, 2000);
    const orbit = new OrbitControls(persp, renderer.domElement);
    orbit.enableDamping = false;
    orbit.screenSpacePanning = true;
    orbit.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    const transform = new TransformControls(persp, renderer.domElement);
    const helperGroup = new THREE.Group();
    const gridHelper = new THREE.GridHelper(40, 40, 0x8a8f98, 0x4a4f58);
    gridHelper.position.y = 0.004;
    const headlight = new THREE.DirectionalLight('#ffffff', 2.2);
    const fill = new THREE.HemisphereLight('#ffffff', '#555a66', 1.2);
    const state: Rt = { renderer, persp, orthoCam, orbit, transform, built: null, helperGroup, grid: gridHelper, headlight, fill, boxes: [], frame: 0, dragging: false };
    rt.current = state;

    const view = live.current.model.view;
    persp.position.set(...view.position);
    orbit.target.set(...view.target);
    orbit.update();

    orbit.addEventListener('change', () => { syncOrtho(state); requestRender(); live.current.onViewChange?.(); });
    transform.addEventListener('change', requestRender);
    transform.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value;
      state.dragging = dragging;
      orbit.enabled = !dragging;
      const obj = transform.object;
      if (!dragging && obj?.userData.objId) live.current.onTransform(obj.userData.objId as string, readTransform(obj), true);
    });
    transform.addEventListener('objectChange', () => {
      const obj = transform.object;
      if (obj?.userData.objId) live.current.onTransform(obj.userData.objId as string, readTransform(obj), false);
    });

    const resize = (): void => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      syncOrtho(state);
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(state.frame);
      transform.detach();
      transform.dispose();
      orbit.dispose();
      state.built?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      rt.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keep the orthographic camera looking at the same thing as the perspective one, at the same apparent size. */
  function syncOrtho(r: Rt): void {
    const host = hostRef.current;
    if (!host) return;
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    const dist = r.persp.position.distanceTo(r.orbit.target);
    const halfH = Math.tan(THREE.MathUtils.degToRad(r.persp.fov / 2)) * dist;
    r.orthoCam.left = -halfH * (w / h); r.orthoCam.right = halfH * (w / h); r.orthoCam.top = halfH; r.orthoCam.bottom = -halfH;
    r.orthoCam.position.copy(r.persp.position);
    r.orthoCam.quaternion.copy(r.persp.quaternion);
    r.orthoCam.updateProjectionMatrix();
  }

  function readTransform(obj: THREE.Object3D): TransformResult {
    return { position: vec(obj.position), rotation: [Math.round(deg(obj.rotation.x) * 1000) / 1000, Math.round(deg(obj.rotation.y) * 1000) / 1000, Math.round(deg(obj.rotation.z) * 1000) / 1000], scale: vec(obj.scale) };
  }

  /* ---- rebuild the three.js scene when the document or the shading changes ---- */
  useEffect(() => {
    const r = rt.current;
    if (!r) return;
    if (r.dragging) return; // the gizmo is moving an object: the document catches up on release
    r.transform.detach();
    r.built?.dispose();
    const built = buildScene(model, { shading, helpers: true });
    r.built = built;
    built.scene.add(r.grid, r.helperGroup, r.headlight, r.fill, r.transform.getHelper());
    r.grid.visible = grid;
    // Solid shading lights the scene from the camera and ignores the scene's own lights; material preview uses them.
    const solid = shading !== 'material';
    for (const l of built.lights) l.visible = !solid;
    r.headlight.visible = solid;
    r.fill.visible = solid;
    r.headlight.target.position.set(0, 0, 0);
    attachSelection(r, built);
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, shading]);

  function attachSelection(r: Rt, built: BuiltScene): void {
    for (const b of r.boxes) { b.removeFromParent(); b.geometry.dispose(); }
    r.boxes = [];
    const ids = live.current.selection.filter((id) => built.byId.has(id));
    for (const id of ids) {
      const obj = built.byId.get(id)!;
      const box = new THREE.Box3().setFromObject(obj, true);
      if (box.isEmpty()) continue;
      const helper = new THREE.Box3Helper(box, new THREE.Color(id === ids[ids.length - 1] ? '#ffb454' : '#c88a3a'));
      built.scene.add(helper);
      r.boxes.push(helper);
    }
    const active = ids.length ? built.byId.get(ids[ids.length - 1]) : undefined;
    const locked = ids.length ? live.current.model.objects.find((o) => o.id === ids[ids.length - 1])?.locked : false;
    if (active && live.current.mode !== 'select' && !locked) {
      r.transform.attach(active);
      r.transform.setMode(live.current.mode);
    } else {
      r.transform.detach();
    }
  }

  /* ---- selection / gizmo / view settings that do not need a rebuild ---- */
  useEffect(() => {
    const r = rt.current;
    if (!r?.built || r.dragging) return;
    attachSelection(r, r.built);
    r.transform.setTranslationSnap(snap ? 0.25 : null);
    r.transform.setRotationSnap(snap ? THREE.MathUtils.degToRad(15) : null);
    r.transform.setScaleSnap(snap ? 0.1 : null);
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, mode, snap]);

  useEffect(() => {
    const r = rt.current;
    if (!r) return;
    r.grid.visible = grid;
    r.transform.camera = ortho ? r.orthoCam : r.persp;
    syncOrtho(r);
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, ortho]);

  /* ---- picking: a click that did not drag selects the object under the pointer ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent): void => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    const onUp = (e: PointerEvent): void => {
      const r = rt.current;
      if (!r?.built || !down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || r.dragging || r.transform.axis) return;
      const rect = r.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, activeCamera(r));
      const hits = ray.intersectObjects(r.built.pickables, false).filter((h) => h.object.visible && h.object.parent?.visible !== false);
      const id = hits.length ? (hits[0].object.userData.objId as string) : null;
      live.current.onSelect(id, e.shiftKey);
    };
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointerup', onUp);
    return () => { host.removeEventListener('pointerdown', onDown); host.removeEventListener('pointerup', onUp); };
  }, []);

  /* ---- Blender-like navigation: left drag orbits too unless the gizmo or a pick is in progress ---- */
  useEffect(() => {
    const r = rt.current;
    if (!r) return;
    r.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  }, []);

  useImperativeHandle(ref, () => ({
    setView: (preset) => {
      const r = rt.current;
      if (!r) return;
      const target = r.orbit.target.clone();
      const dist = Math.max(2, r.persp.position.distanceTo(target));
      const dirs: Record<ViewPreset, [number, number, number]> = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001] };
      const d = new THREE.Vector3(...dirs[preset]).normalize();
      r.persp.position.copy(target).addScaledVector(d, dist);
      r.persp.up.set(0, 1, 0);
      r.orbit.update();
      syncOrtho(r);
      requestRender();
    },
    frame: (ids) => {
      const r = rt.current;
      if (!r?.built) return;
      const box = new THREE.Box3();
      const objects = ids.length ? ids.map((id) => r.built!.byId.get(id)).filter((o): o is THREE.Object3D => !!o) : [];
      if (objects.length) for (const o of objects) box.expandByObject(o, true);
      else {
        const b = sceneBounds(live.current.model);
        if (b) box.set(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
      }
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
      const dist = (radius / Math.sin(THREE.MathUtils.degToRad(r.persp.fov / 2))) * 0.95;
      const dir = r.persp.position.clone().sub(r.orbit.target).normalize();
      r.orbit.target.copy(center);
      r.persp.position.copy(center).addScaledVector(dir, dist);
      r.orbit.update();
      syncOrtho(r);
      requestRender();
    },
    getView: () => {
      const r = rt.current;
      return r ? { position: vec(r.persp.position), target: vec(r.orbit.target) } : { position: [6, 4.5, 8], target: [0, 0.5, 0] };
    },
    stats: () => {
      const r = rt.current;
      return r ? { calls: r.renderer.info.render.calls, triangles: r.renderer.info.render.triangles } : { calls: 0, triangles: 0 };
    },
  }));

  return <div ref={hostRef} className="m3d__host" data-testid="viewport3d" />;
});
