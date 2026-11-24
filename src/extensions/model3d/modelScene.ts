/** Builds a three.js scene from a Model3D document, renders it to an image and exports it (GLB, OBJ, STL).
 * Browser only (WebGL). The editor viewport and the agent tools share this code, so what the agent previews is what
 * the person sees. */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { sceneBounds, type Model3D, type Obj3D, type Shading, type Vec3 } from './model3d';

export interface BuiltScene {
  scene: THREE.Scene;
  /** The group of each object (children are parented under their parent's group). */
  byId: Map<string, THREE.Object3D>;
  /** The groups added directly to the scene (top-level objects and their mirrored copies). */
  roots: THREE.Object3D[];
  /** Everything that can be picked with the mouse: meshes tagged with userData.objId. */
  pickables: THREE.Object3D[];
  /** Lights are switched off in solid shading, where the editor lights the scene itself. */
  lights: THREE.Light[];
  dispose: () => void;
}

export interface BuildOptions {
  shading?: Shading;
  /** Show light and camera icons (editor only). */
  helpers?: boolean;
}

const rad = THREE.MathUtils.degToRad;

function makeGeometry(o: Obj3D): THREE.BufferGeometry | null {
  const p = o.params;
  switch (o.kind) {
    case 'box': return new THREE.BoxGeometry(p.width, p.height, p.depth);
    case 'sphere': return new THREE.SphereGeometry(p.radius, p.segments, Math.max(2, Math.round(p.segments / 2)));
    case 'icosphere': return new THREE.IcosahedronGeometry(p.radius, p.detail);
    case 'cylinder': return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, p.segments);
    case 'cone': return new THREE.ConeGeometry(p.radius, p.height, p.segments);
    case 'torus': return new THREE.TorusGeometry(p.radius, p.tube, Math.max(3, Math.round(p.segments / 2)), p.segments);
    case 'plane': return new THREE.PlaneGeometry(p.width, p.height);
    case 'circle': return new THREE.CircleGeometry(p.radius, p.segments);
    case 'capsule': return new THREE.CapsuleGeometry(p.radius, p.length, 4, p.segments);
    default: return null;
  }
}

function makeMaterial(o: Obj3D, shading: Shading): THREE.MeshStandardMaterial {
  const m = o.material;
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color), metalness: m.metalness, roughness: m.roughness, emissive: new THREE.Color(m.emissive), emissiveIntensity: m.emissiveIntensity,
    opacity: m.opacity, transparent: m.opacity < 1, wireframe: m.wireframe || shading === 'wireframe', flatShading: m.flatShading,
    side: o.kind === 'plane' || o.kind === 'circle' ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/** The sign flips of every mirrored copy of an object: one per non-empty combination of its mirror axes. The mirror plane
 * passes through the origin of the object's parent (the scene origin for top-level objects). */
function mirrorFlips(o: Obj3D): Array<[number, number, number]> {
  const axes = [...new Set(o.modifiers.filter((m) => m.type === 'mirror').map((m) => m.axis ?? 'x'))];
  const out: Array<[number, number, number]> = [];
  for (let mask = 1; mask < 1 << axes.length; mask++) {
    const on = axes.filter((_, i) => mask & (1 << i));
    out.push([on.includes('x') ? -1 : 1, on.includes('y') ? -1 : 1, on.includes('z') ? -1 : 1]);
  }
  return out;
}

/** The local matrices of every array copy a modifier stack produces (the original first). */
function instanceMatrices(o: Obj3D): THREE.Matrix4[] {
  let list: THREE.Matrix4[] = [new THREE.Matrix4()];
  for (const m of o.modifiers) {
    if (m.type === 'array') {
      const count = Math.max(1, m.count ?? 1), off = m.offset ?? [1, 0, 0];
      const next: THREE.Matrix4[] = [];
      for (let i = 0; i < count; i++) for (const mat of list) next.push(new THREE.Matrix4().makeTranslation(off[0] * i, off[1] * i, off[2] * i).multiply(mat));
      list = next;
    }
  }
  return list;
}

export function buildScene(model: Model3D, options: BuildOptions = {}): BuiltScene {
  const shading = options.shading ?? 'material';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(model.world.background);
  if (model.world.fog) scene.fog = new THREE.Fog(model.world.background, 20, 90);
  const byId = new Map<string, THREE.Object3D>();
  const pickables: THREE.Object3D[] = [];
  const roots: THREE.Object3D[] = [];
  const mirrored: Array<{ group: THREE.Group; parent: string | null }> = [];
  const lights: THREE.Light[] = [];
  const disposables: Array<{ dispose: () => void }> = [];

  const ambient = new THREE.AmbientLight('#ffffff', model.world.ambient);
  scene.add(ambient);
  lights.push(ambient);

  for (const o of model.objects) {
    const group = new THREE.Group();
    group.name = o.name;
    group.userData.objId = o.id;
    group.position.set(...o.position);
    group.rotation.set(rad(o.rotation[0]), rad(o.rotation[1]), rad(o.rotation[2]), 'XYZ');
    group.scale.set(...o.scale);
    group.visible = o.visible;
    byId.set(o.id, group);

    const geometry = makeGeometry(o);
    if (geometry) {
      const material = makeMaterial(o, shading);
      disposables.push(geometry, material);
      for (const matrix of instanceMatrices(o)) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.applyMatrix4(matrix);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.objId = o.id;
        group.add(mesh);
        pickables.push(mesh);
      }
      // Mirror modifiers: a mirrored copy of the whole object, placed across the plane through the parent's origin.
      const flips = mirrorFlips(o);
      if (flips.length) {
        const local = new THREE.Matrix4().compose(group.position, group.quaternion, group.scale);
        for (const flip of flips) {
          const copy = new THREE.Group();
          copy.name = `${o.name} (mirror)`;
          copy.userData.objId = o.id;
          copy.matrixAutoUpdate = false;
          copy.matrix.copy(new THREE.Matrix4().makeScale(flip[0], flip[1], flip[2]).multiply(local));
          copy.visible = o.visible;
          for (const mesh of [...group.children]) { const c = (mesh as THREE.Mesh).clone(); c.userData.objId = o.id; copy.add(c); pickables.push(c); }
          mirrored.push({ group: copy, parent: o.parent });
        }
      }
    } else if (o.kind === 'light' && o.light) {
      const l = o.light;
      let light: THREE.Light;
      if (l.type === 'sun') light = new THREE.DirectionalLight(l.color, l.intensity);
      else if (l.type === 'spot') light = new THREE.SpotLight(l.color, l.intensity, l.distance, rad(l.angle / 2), 0.3, 2);
      else if (l.type === 'ambient') light = new THREE.AmbientLight(l.color, l.intensity);
      else if (l.type === 'hemisphere') light = new THREE.HemisphereLight(l.color, '#3a3a40', l.intensity);
      else light = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
      if (l.castShadow && (l.type === 'sun' || l.type === 'spot' || l.type === 'point')) {
        light.castShadow = true;
        const shadow = (light as THREE.DirectionalLight).shadow;
        shadow.mapSize.set(1024, 1024);
        shadow.bias = -0.0005;
        if (l.type === 'sun') { const cam = (shadow as THREE.DirectionalLightShadow).camera; cam.left = -15; cam.right = 15; cam.top = 15; cam.bottom = -15; cam.near = 0.5; cam.far = 60; }
      }
      group.add(light);
      lights.push(light);
      if ((l.type === 'sun' || l.type === 'spot') && o.lookAt) {
        const target = new THREE.Object3D();
        target.position.set(...o.lookAt);
        scene.add(target);
        (light as THREE.DirectionalLight).target = target;
      }
      if (options.helpers) {
        const icon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: l.color, wireframe: false }));
        icon.userData.objId = o.id;
        icon.userData.helper = true;
        group.add(icon);
        pickables.push(icon);
        disposables.push(icon.geometry, icon.material as THREE.Material);
      }
    } else if (o.kind === 'camera' && options.helpers) {
      const cam = new THREE.PerspectiveCamera(o.camera?.fov ?? 50, 16 / 9, 0.3, 1.2);
      const helper = new THREE.CameraHelper(cam);
      group.add(helper);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), new THREE.MeshBasicMaterial({ color: '#ffd166' }));
      hit.userData.objId = o.id;
      hit.userData.helper = true;
      group.add(hit);
      pickables.push(hit);
      disposables.push(hit.geometry, hit.material as THREE.Material, helper.geometry, helper.material as THREE.Material);
    } else if (o.kind === 'empty' && options.helpers) {
      const axes = new THREE.AxesHelper(0.4);
      group.add(axes);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.objId = o.id;
      hit.userData.helper = true;
      group.add(hit);
      pickables.push(hit);
      disposables.push(hit.geometry, hit.material as THREE.Material, axes.geometry, axes.material as THREE.Material);
    }
    if ((o.kind === 'light' || o.kind === 'camera') && o.lookAt && !o.parent) {
      group.updateMatrixWorld(true);
      const m = new THREE.Matrix4().lookAt(group.position, new THREE.Vector3(...o.lookAt), new THREE.Vector3(0, 1, 0));
      group.quaternion.setFromRotationMatrix(m);
    }
  }
  for (const o of model.objects) {
    const group = byId.get(o.id)!;
    const parent = o.parent ? byId.get(o.parent) : null;
    (parent ?? scene).add(group);
    if (!parent) roots.push(group);
  }
  for (const { group, parent } of mirrored) {
    const host = parent ? byId.get(parent) : null;
    (host ?? scene).add(group);
    if (!host) roots.push(group);
  }
  scene.updateMatrixWorld(true);
  return {
    scene, byId, roots, pickables, lights,
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}

export interface RenderOptions {
  width?: number;
  height?: number;
  shading?: Shading;
  /** Look from this position at this target (default: the model's viewport view, or fit to the scene). */
  position?: Vec3;
  target?: Vec3;
  /** Render through a camera object of the scene (id or name). */
  camera?: string;
  grid?: boolean;
  transparent?: boolean;
}

/** The camera a render uses, fitted to the scene when no explicit view is given. */
export function frameCamera(model: Model3D, aspect: number, opts: RenderOptions = {}): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(45, aspect, 0.05, 2000);
  if (opts.position || opts.target) {
    cam.position.set(...(opts.position ?? model.view.position));
    cam.lookAt(...(opts.target ?? model.view.target));
    return cam;
  }
  const b = sceneBounds(model);
  if (!b) { cam.position.set(...model.view.position); cam.lookAt(...model.view.target); return cam; }
  const center = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  // Ignore a huge ground plane when framing: look at the model that stands on it.
  const radius = Math.min(Math.max(size.length() / 2, 1), 40);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 0.9;
  const dir = new THREE.Vector3(0.7, 0.55, 1).normalize();
  const focus = new THREE.Vector3(center.x, Math.max(center.y, radius * 0.3), center.z);
  cam.position.copy(focus).addScaledVector(dir, dist);
  cam.lookAt(focus);
  return cam;
}

function makeRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas: canvas as HTMLCanvasElement, antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/** Renders the scene to a PNG data URL (used by model_preview, the Render menu and the guide screenshots). */
export function renderModel(model: Model3D, opts: RenderOptions = {}): { dataUrl: string; width: number; height: number } {
  const width = Math.min(2048, Math.max(64, Math.round(opts.width ?? 960))), height = Math.min(2048, Math.max(64, Math.round(opts.height ?? 600)));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = makeRenderer(canvas, width, height);
  const built = buildScene(model, { shading: opts.shading ?? 'material' });
  try {
    let camera: THREE.Camera;
    const camObj = opts.camera ? model.objects.find((o) => o.kind === 'camera' && (o.id === opts.camera || o.name.toLowerCase() === String(opts.camera).toLowerCase())) : undefined;
    if (opts.camera && !camObj) throw new Error(`no camera "${opts.camera}" in the scene`);
    if (camObj?.camera) {
      const c = camObj.camera;
      camera = c.ortho
        ? new THREE.OrthographicCamera(-c.orthoSize * (width / height), c.orthoSize * (width / height), c.orthoSize, -c.orthoSize, c.near, c.far)
        : new THREE.PerspectiveCamera(c.fov, width / height, c.near, c.far);
      const holder = built.byId.get(camObj.id)!;
      holder.add(camera);
      // A camera looks along its own -Z; the group's rotation (or lookAt) already aims it.
    } else {
      camera = frameCamera(model, width / height, opts);
    }
    if (opts.grid) built.scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x444444));
    if (opts.transparent) built.scene.background = null;
    built.scene.updateMatrixWorld(true);
    renderer.render(built.scene, camera);
    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  } finally {
    built.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

export type ExportFormat = 'glb' | 'obj' | 'stl';

/** The scene's meshes as a file: a binary glTF, a Wavefront OBJ or a binary STL. */
export async function exportModel(model: Model3D, format: ExportFormat): Promise<{ data: ArrayBuffer | string; mime: string }> {
  const built = buildScene(model, { shading: 'material' });
  try {
    // Only visible meshes belong in an export: lights and the editor helpers are left out.
    const root = new THREE.Group();
    for (const [id, group] of built.byId) {
      const source = model.objects.find((o) => o.id === id)!;
      if (!source.visible) continue;
      group.traverse((n) => { if (n.userData.helper) n.visible = false; });
    }
    for (const r of built.roots) root.add(r);
    root.updateMatrixWorld(true);
    if (format === 'glb') {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        new GLTFExporter().parse(root, (result) => (result instanceof ArrayBuffer ? resolve(result) : resolve(new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer)), (error) => reject(error instanceof Error ? error : new Error(String(error))), { binary: true, onlyVisible: true });
      });
      return { data: buffer, mime: 'model/gltf-binary' };
    }
    if (format === 'obj') return { data: new OBJExporter().parse(root), mime: 'text/plain' };
    const stl = new STLExporter().parse(root, { binary: true }) as unknown as DataView;
    const copy = new ArrayBuffer(stl.byteLength);
    new Uint8Array(copy).set(new Uint8Array(stl.buffer, stl.byteOffset, stl.byteLength));
    return { data: copy, mime: 'model/stl' };
  } finally {
    built.dispose();
  }
}

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export const textToBase64 = (text: string): string => arrayBufferToBase64(new TextEncoder().encode(text).buffer as ArrayBuffer);
