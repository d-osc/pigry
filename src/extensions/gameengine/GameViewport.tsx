/** The editor viewport of the Game Engine: the 3D view (orbit camera) and the 2D view (orthographic, +Y up) of the scene
 * being edited, with picking, selection boxes and move/rotate/scale gizmos. The scene is built by the engine runtime in
 * edit mode (no scripts, no physics), so the editor shows exactly what the game will start with. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { createEngine } from './engineRuntime.js';
import type { Game } from './game';

export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale';
export interface TransformResult { position: number[]; rotation: number[]; scale: number[] }

export interface GameViewportHandle { frame: (path: string | null) => void; reset: () => void }

interface EngineLike {
  load(game: Game): void;
  editScene(name: string): EditNode;
  sync(): void;
  threeScene: THREE.Scene;
  tree: { root: EditNode };
}
interface EditNode { name: string; type: string; children: EditNode[]; object3d?: THREE.Object3D; getNodeOrNull(path: string): EditNode | null; getPath(): string; walk(): Generator<EditNode> }

interface Props {
  game: Game;
  sceneName: string;
  view: '3d' | '2d';
  selection: string | null;
  mode: GizmoMode;
  snap: boolean;
  showShapes: boolean;
  onSelect: (path: string | null) => void;
  onTransform: (path: string, result: TransformResult, final: boolean) => void;
}

const deg = THREE.MathUtils.radToDeg;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

interface Rt {
  renderer: THREE.WebGLRenderer;
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  orbit: OrbitControls;
  transform: TransformControls;
  engine: EngineLike | null;
  boxes: THREE.Box3Helper[];
  grid3: THREE.GridHelper;
  grid2: THREE.GridHelper;
  frame: THREE.LineSegments;
  headlight: THREE.DirectionalLight;
  fill: THREE.HemisphereLight;
  raf: number;
  dragging: boolean;
}

const pathOf = (node: EditNode): string => {
  const parts = node.getPath().split('/').filter(Boolean).slice(2); // drop "root" and the scene root's name
  return parts.length ? parts.join('/') : '.';
};

export const GameViewport = forwardRef<GameViewportHandle, Props>(function GameViewport({ game, sceneName, view, selection, mode, snap, showShapes, onSelect, onTransform }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rt = useRef<Rt | null>(null);
  const live = useRef({ game, sceneName, view, selection, mode, onSelect, onTransform, showShapes });
  useEffect(() => { live.current = { game, sceneName, view, selection, mode, onSelect, onTransform, showShapes }; });

  const request = (): void => {
    const r = rt.current;
    if (!r || r.raf) return;
    r.raf = window.requestAnimationFrame(() => {
      r.raf = 0;
      const scene = r.engine?.threeScene;
      if (scene) r.renderer.render(scene, live.current.view === '2d' ? r.ortho : r.persp);
    });
  };

  /* ---- one-time setup ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'gm__canvas';
    renderer.domElement.setAttribute('aria-label', 'Scene viewport');
    host.appendChild(renderer.domElement);
    const persp = new THREE.PerspectiveCamera(50, 1, 0.05, 4000);
    persp.position.set(7, 5, 9);
    const ortho = new THREE.OrthographicCamera(-500, 500, 300, -300, -5000, 5000);
    ortho.position.set(0, 0, 1000);
    ortho.zoom = 0.8;
    const orbit = new OrbitControls(persp, renderer.domElement);
    orbit.screenSpacePanning = true;
    orbit.target.set(0, 0.5, 0);
    orbit.update();
    const transform = new TransformControls(persp, renderer.domElement);
    const grid3 = new THREE.GridHelper(60, 60, 0x8a8f98, 0x474c55);
    grid3.position.y = 0.004;
    const grid2 = new THREE.GridHelper(4000, 80, 0x6d737d, 0x3b4048);
    grid2.rotation.x = Math.PI / 2;
    grid2.position.z = -50;
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0xffd166 }));
    frame.position.z = 40;
    const headlight = new THREE.DirectionalLight('#ffffff', 1.4);
    headlight.position.set(4, 8, 6);
    const fill = new THREE.HemisphereLight('#ffffff', '#4a4f5a', 0.9);
    const state: Rt = { renderer, persp, ortho, orbit, transform, engine: null, boxes: [], grid3, grid2, frame, headlight, fill, raf: 0, dragging: false };
    rt.current = state;

    orbit.addEventListener('change', request);
    transform.addEventListener('change', request);
    transform.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value;
      state.dragging = dragging;
      orbit.enabled = !dragging;
      if (!dragging) emitTransform(true);
    });
    transform.addEventListener('objectChange', () => emitTransform(false));

    const resize = (): void => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      ortho.left = -w / 2; ortho.right = w / 2; ortho.top = h / 2; ortho.bottom = -h / 2;
      ortho.updateProjectionMatrix();
      request();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // a click (not a drag) picks the node under the pointer
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent): void => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent): void => {
      if (!down || e.button !== 0 || !state.engine) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || state.dragging || state.transform.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, live.current.view === '2d' ? ortho : persp);
      const meshes: THREE.Object3D[] = [];
      state.engine.threeScene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) meshes.push(o); });
      const hits = ray.intersectObjects(meshes, false);
      let found: EditNode | null = null;
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData.node) o = o.parent;
        if (o) { found = o.userData.node as EditNode; break; }
      }
      live.current.onSelect(found ? pathOf(found) : null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    return () => {
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      window.cancelAnimationFrame(state.raf);
      transform.detach(); transform.dispose(); orbit.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      rt.current = null;
    };
  }, []);

  function emitTransform(final: boolean): void {
    const r = rt.current;
    const obj = r?.transform.object;
    const path = obj ? (obj.userData.editPath as string | undefined) : undefined;
    if (!r || !obj || path === undefined) return;
    const is2d = live.current.view === '2d';
    const result: TransformResult = is2d
      ? { position: [r4(obj.position.x), r4(obj.position.y)], rotation: [r4(deg(obj.rotation.z))], scale: [r4(obj.scale.x), r4(obj.scale.y)] }
      : { position: [r4(obj.position.x), r4(obj.position.y), r4(obj.position.z)], rotation: [r4(deg(obj.rotation.x)), r4(deg(obj.rotation.y)), r4(deg(obj.rotation.z))], scale: [r4(obj.scale.x), r4(obj.scale.y), r4(obj.scale.z)] };
    live.current.onTransform(path, result, final);
  }

  /* ---- rebuild the scene when the game, the scene or the view changes ---- */
  useEffect(() => {
    const r = rt.current;
    if (!r || r.dragging) return;
    r.transform.detach();
    const engine = createEngine(THREE, { mode: 'edit', debugShapes: showShapes }) as unknown as EngineLike;
    engine.load(game);
    try {
      engine.editScene(game.scenes[sceneName] ? sceneName : Object.keys(game.scenes)[0]);
    } catch { /* an empty or broken scene shows nothing */ }
    r.engine = engine;
    const scene = engine.threeScene;
    // tag every node's object with its path so a gizmo drag can report which node moved
    for (const n of engine.tree.root.walk()) if (n.object3d) n.object3d.userData.editPath = pathOf(n);
    const is2d = view === '2d';
    scene.add(r.grid3, r.grid2, r.frame, r.headlight, r.fill, r.transform.getHelper());
    r.grid3.visible = !is2d;
    r.grid2.visible = is2d;
    r.headlight.visible = !scene.children.some((c) => (c as THREE.Light).isLight && c !== r.headlight && c !== r.fill);
    r.fill.visible = true;
    if (!scene.background) scene.background = new THREE.Color(game.settings.background);
    // the 2D view marks the area the game shows
    r.frame.visible = is2d;
    r.frame.scale.set(game.settings.width, game.settings.height, 1);
    const cam2 = [...engine.tree.root.walk()].find((n) => n.type === 'Camera2D');
    if (cam2?.object3d) r.frame.position.set(cam2.object3d.position.x, cam2.object3d.position.y, 40); else r.frame.position.set(0, 0, 40);
    r.transform.camera = is2d ? r.ortho : r.persp;
    r.transform.showZ = !is2d;
    r.orbit.object = is2d ? r.ortho : r.persp;
    r.orbit.enableRotate = !is2d;
    attach();
    request();
  }, [game, sceneName, view, showShapes]);

  function attach(): void {
    const r = rt.current;
    if (!r?.engine) return;
    for (const b of r.boxes) { b.removeFromParent(); b.geometry.dispose(); }
    r.boxes = [];
    const path = live.current.selection;
    const node = path === null ? null : r.engine.tree.root.getNodeOrNull(r.engine.tree.root.children[0] ? `${r.engine.tree.root.children[0].name}/${path === '.' ? '' : path}` : path);
    const obj = node?.object3d;
    if (obj) {
      const box = new THREE.Box3().setFromObject(obj, true);
      if (!box.isEmpty()) {
        const helper = new THREE.Box3Helper(box, new THREE.Color('#ffb454'));
        r.engine.threeScene.add(helper);
        r.boxes.push(helper);
      }
    }
    if (obj && live.current.mode !== 'select') {
      r.transform.attach(obj);
      r.transform.setMode(live.current.mode);
    } else r.transform.detach();
  }

  useEffect(() => {
    const r = rt.current;
    if (!r || r.dragging) return;
    attach();
    r.transform.setTranslationSnap(snap ? (view === '2d' ? 8 : 0.25) : null);
    r.transform.setRotationSnap(snap ? THREE.MathUtils.degToRad(15) : null);
    r.transform.setScaleSnap(snap ? 0.1 : null);
    request();
  }, [selection, mode, snap, view]);

  useImperativeHandle(ref, () => ({
    frame: (path) => {
      const r = rt.current;
      if (!r?.engine) return;
      const base = r.engine.tree.root.children[0];
      const node = path && base ? r.engine.tree.root.getNodeOrNull(`${base.name}/${path === '.' ? '' : path}`) : null;
      const box = new THREE.Box3();
      if (node?.object3d) box.setFromObject(node.object3d, true); else box.setFromObject(r.engine.threeScene, true);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      if (live.current.view === '2d') {
        r.ortho.position.set(center.x, center.y, 1000);
        r.ortho.zoom = Math.min(8, Math.max(0.05, 0.8 * Math.min(r.ortho.right - r.ortho.left, r.ortho.top - r.ortho.bottom) / Math.max(size.x, size.y, 50)));
        r.ortho.updateProjectionMatrix();
      } else {
        const radius = Math.max(1, size.length() / 2);
        const dir = r.persp.position.clone().sub(r.orbit.target).normalize();
        r.orbit.target.copy(center);
        r.persp.position.copy(center).addScaledVector(dir, (radius / Math.sin(THREE.MathUtils.degToRad(r.persp.fov / 2))) * 0.9);
        r.orbit.update();
      }
      request();
    },
    reset: () => {
      const r = rt.current;
      if (!r) return;
      r.persp.position.set(7, 5, 9); r.orbit.target.set(0, 0.5, 0); r.orbit.update();
      r.ortho.position.set(0, 0, 1000); r.ortho.zoom = 0.8; r.ortho.updateProjectionMatrix();
      request();
    },
  }));

  return <div ref={hostRef} className="gm__host" data-testid="game-viewport" />;
});
