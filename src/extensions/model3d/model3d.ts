/** The 3D Model document: a scene of primitives, lights and cameras with PBR materials and modifiers (Blender-style
 * object mode), and the list of operations that both the editor and the agent tools understand. Pure data — no three.js,
 * so it runs in the editor, in the agent tools and in node tests. Units are metres, +Y is up (like three.js). */

export const MODELS_DIR = '.pigry/models/';
export const MODEL_EXT = '.model.json';
export const MAX_OBJECTS = 400;
export const MAX_ARRAY = 100;

export type Vec3 = [number, number, number];

export const PRIMITIVES = ['box', 'sphere', 'icosphere', 'cylinder', 'cone', 'torus', 'plane', 'circle', 'capsule'] as const;
export type PrimitiveKind = (typeof PRIMITIVES)[number];
export const KINDS = [...PRIMITIVES, 'empty', 'light', 'camera'] as const;
export type ObjectKind = (typeof KINDS)[number];
export const LIGHT_TYPES = ['point', 'sun', 'spot', 'ambient', 'hemisphere'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];
export const SHADING = ['solid', 'material', 'wireframe'] as const;
export type Shading = (typeof SHADING)[number];

export interface Material {
  color: string;
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  wireframe: boolean;
  flatShading: boolean;
}

export interface Modifier {
  type: 'mirror' | 'array';
  /** Mirror: the axis to mirror across (through the object's origin). */
  axis?: 'x' | 'y' | 'z';
  /** Array: number of copies including the original, and the offset between copies (in the object's space). */
  count?: number;
  offset?: Vec3;
}

export interface LightProps { type: LightType; color: string; intensity: number; distance: number; angle: number; castShadow: boolean }
export interface CameraProps { fov: number; near: number; far: number; ortho: boolean; orthoSize: number }

export interface Obj3D {
  id: string;
  name: string;
  kind: ObjectKind;
  /** Id of the parent object (position, rotation and scale are relative to it), or null. */
  parent: string | null;
  position: Vec3;
  /** Euler angles in degrees (XYZ order). */
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  locked: boolean;
  /** Primitive size parameters (see PRIMITIVE_PARAMS). */
  params: Record<string, number>;
  material: Material;
  modifiers: Modifier[];
  light?: LightProps;
  camera?: CameraProps;
  /** A light or camera can aim at a point. */
  lookAt?: Vec3;
}

export interface World {
  background: string;
  /** Intensity of the soft light that fills the whole scene. */
  ambient: number;
  grid: boolean;
  fog: boolean;
}

export interface Model3D {
  version: 1;
  title: string;
  world: World;
  objects: Obj3D[];
  /** Where the editor's viewport looks from. */
  view: { position: Vec3; target: Vec3 };
}

/** Geometry parameters of each primitive with their defaults (metres, segment counts) and limits. */
export const PRIMITIVE_PARAMS: Record<PrimitiveKind, Record<string, { value: number; min: number; max: number }>> = {
  box: { width: { value: 1, min: 0.001, max: 1000 }, height: { value: 1, min: 0.001, max: 1000 }, depth: { value: 1, min: 0.001, max: 1000 } },
  sphere: { radius: { value: 0.5, min: 0.001, max: 1000 }, segments: { value: 32, min: 3, max: 128 } },
  icosphere: { radius: { value: 0.5, min: 0.001, max: 1000 }, detail: { value: 2, min: 0, max: 5 } },
  cylinder: { radiusTop: { value: 0.5, min: 0, max: 1000 }, radiusBottom: { value: 0.5, min: 0, max: 1000 }, height: { value: 1, min: 0.001, max: 1000 }, segments: { value: 32, min: 3, max: 128 } },
  cone: { radius: { value: 0.5, min: 0.001, max: 1000 }, height: { value: 1, min: 0.001, max: 1000 }, segments: { value: 32, min: 3, max: 128 } },
  torus: { radius: { value: 0.5, min: 0.001, max: 1000 }, tube: { value: 0.15, min: 0.001, max: 1000 }, segments: { value: 32, min: 3, max: 128 } },
  plane: { width: { value: 2, min: 0.001, max: 10000 }, height: { value: 2, min: 0.001, max: 10000 } },
  circle: { radius: { value: 0.5, min: 0.001, max: 1000 }, segments: { value: 32, min: 3, max: 128 } },
  capsule: { radius: { value: 0.25, min: 0.001, max: 1000 }, length: { value: 0.5, min: 0, max: 1000 }, segments: { value: 12, min: 3, max: 64 } },
};

export const DEFAULT_MATERIAL: Material = { color: '#c8c8c8', metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 0, opacity: 1, wireframe: false, flatShading: false };
export const DEFAULT_LIGHT: LightProps = { type: 'point', color: '#ffffff', intensity: 3, distance: 0, angle: 45, castShadow: true };
export const DEFAULT_CAMERA: CameraProps = { fov: 50, near: 0.1, far: 1000, ortho: false, orthoSize: 5 };

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());

/** "#rgb" / "#rrggbb" / a common colour name → "#rrggbb", or null. */
const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00a000', lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  pink: '#ffc0cb', brown: '#8b4513', gray: '#808080', grey: '#808080', cyan: '#00ffff', magenta: '#ff00ff', gold: '#ffd700', silver: '#c0c0c0', teal: '#008080', navy: '#000080',
};
export function normalizeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  return null;
}

const vec3 = (v: unknown, fallback: Vec3): Vec3 => {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
  if (typeof v === 'number') return [v, v, v];
  return [...fallback];
};

export function normalizeMaterial(raw: unknown, base: Material = DEFAULT_MATERIAL): Material {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    color: normalizeColor(m.color) ?? base.color,
    metalness: num(m.metalness, base.metalness, 0, 1),
    roughness: num(m.roughness, base.roughness, 0, 1),
    emissive: normalizeColor(m.emissive) ?? base.emissive,
    emissiveIntensity: num(m.emissiveIntensity, base.emissiveIntensity, 0, 20),
    opacity: num(m.opacity, base.opacity, 0, 1),
    wireframe: typeof m.wireframe === 'boolean' ? m.wireframe : base.wireframe,
    flatShading: typeof m.flatShading === 'boolean' ? m.flatShading : base.flatShading,
  };
}

function normalizeModifiers(raw: unknown): Modifier[] {
  if (!Array.isArray(raw)) return [];
  const out: Modifier[] = [];
  for (const entry of raw.slice(0, 6)) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    if (m.type === 'mirror') out.push({ type: 'mirror', axis: m.axis === 'y' || m.axis === 'z' ? m.axis : 'x' });
    else if (m.type === 'array') out.push({ type: 'array', count: Math.round(num(m.count, 2, 1, MAX_ARRAY)), offset: vec3(m.offset, [1.5, 0, 0]) });
  }
  return out;
}

export function normalizeParams(kind: ObjectKind, raw: unknown, base?: Record<string, number>): Record<string, number> {
  if (!(PRIMITIVES as readonly string[]).includes(kind)) return {};
  const spec = PRIMITIVE_PARAMS[kind as PrimitiveKind];
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [key, def] of Object.entries(spec)) out[key] = num(given[key], base?.[key] ?? def.value, def.min, def.max);
  if ('segments' in out) out.segments = Math.round(out.segments);
  if ('detail' in out) out.detail = Math.round(out.detail);
  return out;
}

export const newObjectId = (objects: Array<{ id: string }>): string => {
  let n = objects.length + 1;
  while (objects.some((o) => o.id === `o${n}`)) n++;
  return `o${n}`;
};

const LABELS: Record<ObjectKind, string> = { box: 'Cube', sphere: 'Sphere', icosphere: 'Icosphere', cylinder: 'Cylinder', cone: 'Cone', torus: 'Torus', plane: 'Plane', circle: 'Circle', capsule: 'Capsule', empty: 'Empty', light: 'Light', camera: 'Camera' };

/** A unique "Cube", "Cube.001", … name in Blender's style. */
export function uniqueName(objects: Array<{ name: string }>, base: string): string {
  const taken = new Set(objects.map((o) => o.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 1;
  const name = (): string => `${base}.${String(n).padStart(3, '0')}`;
  while (taken.has(name().toLowerCase())) n++;
  return name();
}

export function makeObject(kind: ObjectKind, objects: Obj3D[], init: Record<string, unknown> = {}): Obj3D {
  const id = typeof init.id === 'string' && init.id && !objects.some((o) => o.id === init.id) ? init.id : newObjectId(objects);
  const baseName = typeof init.name === 'string' && init.name.trim() ? init.name.trim().slice(0, 60) : init.light && typeof init.light === 'object' && kind === 'light' ? `${String((init.light as Record<string, unknown>).type ?? 'point')[0].toUpperCase()}${String((init.light as Record<string, unknown>).type ?? 'point').slice(1)} light` : LABELS[kind];
  const obj: Obj3D = {
    id, name: uniqueName(objects, baseName), kind, parent: typeof init.parent === 'string' ? init.parent : null,
    position: vec3(init.position, [0, kind === 'light' ? 3 : 0, 0]), rotation: vec3(init.rotation, [0, 0, 0]), scale: vec3(init.scale, [1, 1, 1]),
    visible: init.visible !== false, locked: init.locked === true,
    params: normalizeParams(kind, init.params), material: normalizeMaterial(init.material), modifiers: normalizeModifiers(init.modifiers),
  };
  if (kind === 'light') {
    const l = init.light && typeof init.light === 'object' ? (init.light as Record<string, unknown>) : {};
    const type = (LIGHT_TYPES as readonly string[]).includes(String(l.type)) ? (l.type as LightType) : 'point';
    obj.light = {
      type, color: normalizeColor(l.color) ?? '#ffffff', intensity: num(l.intensity, type === 'sun' ? 3 : type === 'ambient' || type === 'hemisphere' ? 0.6 : 40, 0, 10000),
      distance: num(l.distance, 0, 0, 10000), angle: num(l.angle, 45, 1, 90), castShadow: l.castShadow !== false && type !== 'ambient' && type !== 'hemisphere',
    };
  }
  if (kind === 'camera') {
    const c = init.camera && typeof init.camera === 'object' ? (init.camera as Record<string, unknown>) : {};
    obj.camera = { fov: num(c.fov, 50, 5, 150), near: num(c.near, 0.1, 0.001, 100), far: num(c.far, 1000, 1, 100000), ortho: c.ortho === true, orthoSize: num(c.orthoSize, 5, 0.01, 1000) };
    if (init.position === undefined) obj.position = [4, 3, 6];
  }
  if ((kind === 'light' || kind === 'camera') && init.lookAt !== undefined) obj.lookAt = vec3(init.lookAt, [0, 0, 0]);
  if (kind === 'plane' || kind === 'circle') { if (init.rotation === undefined) obj.rotation = [-90, 0, 0]; }
  return obj;
}

export function emptyModel(title = 'Untitled'): Model3D {
  return {
    version: 1, title, world: { background: '#2b2f36', ambient: 0.35, grid: true, fog: false }, objects: [],
    view: { position: [6, 4.5, 8], target: [0, 0.5, 0] },
  };
}

/** A starter scene: a cube on a ground plane with a sun and a camera, like Blender's default scene. */
export function starterModel(title = 'Untitled'): Model3D {
  const m = emptyModel(title);
  const ground = makeObject('plane', m.objects, { name: 'Ground', params: { width: 20, height: 20 }, material: { color: '#6b7280', roughness: 0.95 } });
  m.objects.push(ground);
  m.objects.push(makeObject('box', m.objects, { name: 'Cube', position: [0, 0.5, 0], material: { color: '#e07a3f', roughness: 0.5 } }));
  m.objects.push(makeObject('light', m.objects, { name: 'Sun', position: [5, 8, 4], light: { type: 'sun', intensity: 3 }, lookAt: [0, 0, 0] }));
  m.objects.push(makeObject('camera', m.objects, { name: 'Camera', position: [6, 4.5, 8], lookAt: [0, 0.5, 0] }));
  return m;
}

export interface NormalizeResult { model: Model3D; warnings: string[] }

/** Repairs whatever was read from disk (or written by an agent) into a valid model, listing what it had to fix. */
export function normalizeModel(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const warnings: string[] = [];
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = emptyModel(typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 80) : fallbackTitle);
  const w = obj.world && typeof obj.world === 'object' ? (obj.world as Record<string, unknown>) : {};
  base.world = { background: normalizeColor(w.background) ?? base.world.background, ambient: num(w.ambient, base.world.ambient, 0, 10), grid: w.grid !== false, fog: w.fog === true };
  const v = obj.view && typeof obj.view === 'object' ? (obj.view as Record<string, unknown>) : {};
  base.view = { position: vec3(v.position, base.view.position), target: vec3(v.target, base.view.target) };
  const list = Array.isArray(obj.objects) ? obj.objects.slice(0, MAX_OBJECTS) : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { warnings.push('Dropped an object that was not an object.'); continue; }
    const e = entry as Record<string, unknown>;
    const kind = (KINDS as readonly string[]).includes(String(e.kind)) ? (e.kind as ObjectKind) : null;
    if (!kind) { warnings.push(`Dropped "${String(e.name ?? e.id)}": unknown kind "${String(e.kind)}".`); continue; }
    const made = makeObject(kind, base.objects, e);
    if (typeof e.id === 'string' && e.id && e.id !== made.id) warnings.push(`Renamed a duplicate object id "${e.id}" to ${made.id}.`);
    if (kind === 'plane' || kind === 'circle') made.rotation = vec3(e.rotation, [-90, 0, 0]);
    base.objects.push(made);
  }
  // A parent must exist and must not create a cycle.
  const ids = new Set(base.objects.map((o) => o.id));
  for (const o of base.objects) {
    const original = list.find((e) => e && typeof e === 'object' && (e as Record<string, unknown>).id === o.id) as Record<string, unknown> | undefined;
    const parent = original && typeof original.parent === 'string' ? original.parent : null;
    o.parent = parent && ids.has(parent) && parent !== o.id ? parent : null;
    if (parent && !o.parent) warnings.push(`"${o.name}" had a parent that does not exist; moved to the top level.`);
  }
  for (const o of base.objects) {
    let at: Obj3D | undefined = o, steps = 0;
    while (at?.parent && steps++ < base.objects.length + 1) at = base.objects.find((x) => x.id === at!.parent);
    if (steps > base.objects.length) { o.parent = null; warnings.push(`Broke a parent cycle at "${o.name}".`); }
  }
  return { model: base, warnings };
}

export function parseModelJson(text: string, fallbackTitle = 'Untitled'): NormalizeResult {
  try {
    return normalizeModel(JSON.parse(text), fallbackTitle);
  } catch {
    return { model: emptyModel(fallbackTitle), warnings: ['The file was not valid JSON; started an empty scene.'] };
  }
}

export const serializeModel = (model: Model3D): string => JSON.stringify(model, null, 1);

/** The object an id, a name (case-insensitive) or a 1-based position refers to. */
export function findObject(objects: Obj3D[], ref: unknown): Obj3D | undefined {
  if (typeof ref === 'number') return objects[ref - 1];
  const text = String(ref ?? '').trim();
  if (!text) return undefined;
  return objects.find((o) => o.id === text) ?? objects.find((o) => o.name.toLowerCase() === text.toLowerCase());
}

export const childrenOf = (model: Model3D, id: string): Obj3D[] => model.objects.filter((o) => o.parent === id);

export function descendantsOf(model: Model3D, id: string): Obj3D[] {
  const out: Obj3D[] = [];
  const walk = (parent: string): void => { for (const c of childrenOf(model, parent)) { out.push(c); walk(c.id); } };
  walk(id);
  return out;
}

/** Half-sizes of the primitive's own bounding box (before scale). */
export function localHalfSize(o: Obj3D): Vec3 {
  const p = o.params;
  switch (o.kind) {
    case 'box': return [p.width / 2, p.height / 2, p.depth / 2];
    case 'sphere': case 'icosphere': return [p.radius, p.radius, p.radius];
    case 'cylinder': { const r = Math.max(p.radiusTop, p.radiusBottom); return [r, p.height / 2, r]; }
    case 'cone': return [p.radius, p.height / 2, p.radius];
    case 'torus': return [p.radius + p.tube, p.radius + p.tube, p.tube];
    case 'plane': return [p.width / 2, p.height / 2, 0];
    case 'circle': return [p.radius, p.radius, 0];
    case 'capsule': return [p.radius, p.radius + p.length / 2, p.radius];
    default: return [0, 0, 0];
  }
}

const rad = (d: number): number => (d * Math.PI) / 180;

/** World position of an object (parent chain with scale and rotation about Y/X/Z applied in XYZ order). */
export function worldMatrixPosition(model: Model3D, o: Obj3D): Vec3 {
  const chain: Obj3D[] = [];
  let at: Obj3D | undefined = o;
  for (let i = 0; at && i < 50; i++) { chain.unshift(at); at = at.parent ? model.objects.find((x) => x.id === at!.parent) : undefined; }
  let pos: Vec3 = [0, 0, 0];
  let rot: Vec3 = [0, 0, 0];
  let scale: Vec3 = [1, 1, 1];
  for (const node of chain) {
    const local: Vec3 = [node.position[0] * scale[0], node.position[1] * scale[1], node.position[2] * scale[2]];
    const r = rotateEuler(local, rot);
    pos = [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
    rot = [rot[0] + node.rotation[0], rot[1] + node.rotation[1], rot[2] + node.rotation[2]];
    scale = [scale[0] * node.scale[0], scale[1] * node.scale[1], scale[2] * node.scale[2]];
  }
  return pos;
}

function rotateEuler(v: Vec3, eulerDeg: Vec3): Vec3 {
  let [x, y, z] = v;
  const [rx, ry, rz] = eulerDeg.map(rad);
  // three.js Euler 'XYZ' = R = Rx · Ry · Rz applied to the vector: Rz first, then Ry, then Rx.
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}

/** An axis-aligned box around the object in world space (rotation of its own geometry included, parents' rotation ignored). */
export function worldBounds(model: Model3D, o: Obj3D): { min: Vec3; max: Vec3 } | null {
  if (o.kind === 'empty' || o.kind === 'light' || o.kind === 'camera') return null;
  const half = localHalfSize(o);
  const s = o.scale;
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(rotateEuler([half[0] * s[0] * sx, half[1] * s[1] * sy, half[2] * s[2] * sz], o.rotation));
  const c = worldMatrixPosition(model, o);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of corners) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i] + c[i]); max[i] = Math.max(max[i], p[i] + c[i]); }
  return { min, max };
}

export function sceneBounds(model: Model3D): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity], any = false;
  for (const o of model.objects) {
    if (!o.visible) continue;
    const b = worldBounds(model, o);
    if (!b) continue;
    any = true;
    min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1]), Math.min(min[2], b.min[2])];
    max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1]), Math.max(max[2], b.max[2])];
  }
  return any ? { min, max } : null;
}

/** Triangle count estimate of the scene (modifiers included), used to keep models light. */
export function triangleCount(model: Model3D): number {
  let total = 0;
  for (const o of model.objects) {
    if (!o.visible) continue;
    const p = o.params;
    let tris = 0;
    switch (o.kind) {
      case 'box': tris = 12; break;
      case 'sphere': tris = p.segments * Math.max(2, Math.round(p.segments / 2)) * 2; break;
      case 'icosphere': tris = 20 * 4 ** p.detail; break;
      case 'cylinder': tris = p.segments * 4; break;
      case 'cone': tris = p.segments * 2; break;
      case 'torus': tris = p.segments * Math.max(3, Math.round(p.segments / 2)) * 2; break;
      case 'plane': tris = 2; break;
      case 'circle': tris = p.segments; break;
      case 'capsule': tris = p.segments * 8; break;
      default: tris = 0;
    }
    let copies = 1;
    for (const m of o.modifiers) copies *= m.type === 'mirror' ? 2 : m.count ?? 1;
    total += tris * copies;
  }
  return Math.round(total);
}

export interface ModelIssue { severity: 'error' | 'warn' | 'info'; message: string }

/** A short review of the scene: missing light/camera, bad scale, floating or sunken objects, heavy meshes, default names. */
export function checkModel(model: Model3D): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const meshes = model.objects.filter((o) => (PRIMITIVES as readonly string[]).includes(o.kind));
  if (meshes.length === 0) issues.push({ severity: 'warn', message: 'The scene has no objects yet.' });
  if (!model.objects.some((o) => o.kind === 'light') && model.world.ambient < 0.5) issues.push({ severity: 'warn', message: 'There is no light and the ambient light is low: the scene will render dark. Add a sun or point light.' });
  if (!model.objects.some((o) => o.kind === 'camera')) issues.push({ severity: 'info', message: 'There is no camera object; the preview uses the viewport camera.' });
  for (const o of model.objects) {
    if (o.scale.some((s) => Math.abs(s) < 1e-4)) issues.push({ severity: 'error', message: `"${o.name}" has a scale of zero on an axis and is invisible.` });
    if (o.scale.some((s) => s < 0)) issues.push({ severity: 'warn', message: `"${o.name}" has a negative scale, which flips its faces; use a mirror modifier instead.` });
    if (/^(Cube|Sphere|Icosphere|Cylinder|Cone|Torus|Plane|Circle|Capsule|Empty)(\.\d+)?$/.test(o.name) && meshes.length > 4) issues.push({ severity: 'info', message: `"${o.name}" still has a default name; name objects by purpose ("Wheel.L", "Roof").` });
    const b = worldBounds(model, o);
    if (b && b.min.some((v) => Math.abs(v) > 5000)) issues.push({ severity: 'warn', message: `"${o.name}" is more than 5000 m from the origin.` });
    for (const m of o.modifiers) if (m.type === 'array' && (m.count ?? 1) * (m.count ?? 1) > 10000) issues.push({ severity: 'warn', message: `"${o.name}" has a very large array.` });
  }
  const tris = triangleCount(model);
  if (tris > 300000) issues.push({ severity: 'warn', message: `The scene has about ${tris.toLocaleString('en-US')} triangles; reduce segments or use fewer objects for smooth interaction.` });
  return issues;
}

/** One line per object (indented under its parent) — what the agent reads before it edits. */
export function summarizeModel(model: Model3D): string {
  const f = (v: number): string => String(Math.round(v * 1000) / 1000);
  const v3 = (v: Vec3): string => `(${f(v[0])}, ${f(v[1])}, ${f(v[2])})`;
  const lines = [`"${model.title}" — ${model.objects.length} object${model.objects.length === 1 ? '' : 's'}, about ${triangleCount(model).toLocaleString('en-US')} triangles, background ${model.world.background}, ambient ${f(model.world.ambient)}${model.world.grid ? '' : ', grid off'}.`];
  const row = (o: Obj3D, depth: number): void => {
    const bits = [`${o.kind}`, `at ${v3(o.position)}`];
    if (o.rotation.some((r) => r !== 0)) bits.push(`rot ${v3(o.rotation)}°`);
    if (o.scale.some((s) => s !== 1)) bits.push(`scale ${v3(o.scale)}`);
    if (Object.keys(o.params).length) bits.push(Object.entries(o.params).map(([k, v]) => `${k} ${f(v)}`).join(', '));
    if (o.light) bits.push(`${o.light.type} light ${f(o.light.intensity)} ${o.light.color}`);
    if (o.camera) bits.push(`fov ${f(o.camera.fov)}${o.camera.ortho ? ' ortho' : ''}`);
    if ((PRIMITIVES as readonly string[]).includes(o.kind)) bits.push(`${o.material.color} m${f(o.material.metalness)} r${f(o.material.roughness)}${o.material.opacity < 1 ? ` α${f(o.material.opacity)}` : ''}`);
    if (o.modifiers.length) bits.push(o.modifiers.map((m) => (m.type === 'mirror' ? `mirror ${m.axis}` : `array ×${m.count}`)).join(', '));
    if (!o.visible) bits.push('hidden');
    if (o.locked) bits.push('locked');
    lines.push(`${'  '.repeat(depth)}- ${o.id} "${o.name}": ${bits.join('; ')}`);
    for (const c of childrenOf(model, o.id)) row(c, depth + 1);
  };
  for (const o of model.objects.filter((x) => !x.parent)) row(o, 0);
  return lines.join('\n');
}

/* ---------- operations ---------- */

export type ModelOp = { op: string } & Record<string, unknown>;

interface OpSpec { summary: string; required: string[] }

/** Every operation an agent (or the editor) can apply. `target` / `id` is an object id, a name or a 1-based position. */
export const OP_SPECS: Record<string, OpSpec> = {
  add: { summary: '{op:"add", kind: box|sphere|icosphere|cylinder|cone|torus|plane|circle|capsule|empty|light|camera, name?, position?: [x,y,z], rotation?: [x°,y°,z°], scale?: [x,y,z] or number, params?: {width,height,depth,radius,segments,…}, material?: {color,metalness,roughness,emissive,emissiveIntensity,opacity,wireframe,flatShading}, parent?, modifiers?: [{type:"mirror",axis} | {type:"array",count,offset:[x,y,z]}], light?: {type: point|sun|spot|ambient|hemisphere, color, intensity, distance, angle, castShadow}, camera?: {fov,near,far,ortho,orthoSize}, lookAt?: [x,y,z]} — adds one object', required: ['kind'] },
  update: { summary: '{op:"update", target, name?, position?, rotation?, scale?, params?, material?, visible?, locked?, light?, camera?, lookAt?, modifiers?} — change fields of one object (only the fields you pass change; params/material/light/camera merge)', required: ['target'] },
  remove: { summary: '{op:"remove", target} — delete an object and everything parented to it', required: ['target'] },
  duplicate: { summary: '{op:"duplicate", target, offset?: [x,y,z], count?: 1} — copy an object with its children (the copy is shifted by offset)', required: ['target'] },
  parent: { summary: '{op:"parent", target, to: id|name|null} — make target a child of another object (position becomes relative) or null for the top level', required: ['target', 'to'] },
  move: { summary: '{op:"move", target, by: [x,y,z]} — shift an object by a delta (or {to: [x,y,z]} to put it somewhere)', required: ['target'] },
  rotate: { summary: '{op:"rotate", target, by: [x°,y°,z°]} — rotate by degrees (or {to: [x°,y°,z°]})', required: ['target'] },
  scale: { summary: '{op:"scale", target, by: number | [x,y,z]} — multiply the scale (or {to: …} to set it)', required: ['target'] },
  material: { summary: '{op:"material", target, color?, metalness?, roughness?, emissive?, emissiveIntensity?, opacity?, wireframe?, flatShading?} — set the material of an object (and its children with children:true)', required: ['target'] },
  modifier: { summary: '{op:"modifier", target, type: mirror|array, axis?, count?, offset?, clear?: true} — add a modifier (clear:true removes all modifiers first). Mirror adds a mirrored copy of the whole object across the plane through the origin of its PARENT (the scene origin for top-level objects): a leg at x = 0.65 gets a copy at x = -0.65. Array repeats the object count times, each shifted by offset in the space of the object itself', required: ['target', 'type'] },
  world: { summary: '{op:"world", background?: colour, ambient?: 0-10, grid?: bool, fog?: bool} — scene settings', required: [] },
  view: { summary: '{op:"view", position?: [x,y,z], target?: [x,y,z]} — where the editor viewport looks from; also used by drawing_preview-style renders', required: [] },
  align: { summary: '{op:"align", target, to?: id|name, axis?: x|y|z|all, mode?: center|min|max, ground?: true} — align an object to another object on an axis, or ground:true to put its lowest point on y=0', required: ['target'] },
  arrange: { summary: '{op:"arrange", targets: [ids…], axis?: x|z, gap?: 0.5} — line objects up along an axis with a gap between their bounding boxes', required: ['targets'] },
  clear: { summary: '{op:"clear"} — remove every object', required: [] },
};

export const OP_HELP = Object.values(OP_SPECS).map((s) => `- ${s.summary}`).join('\n');

export function validateOp(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'an operation must be an object like {"op":"add","kind":"box"}';
  const op = raw as ModelOp;
  const spec = OP_SPECS[op.op];
  if (!spec) return `unknown op "${String(op.op)}" (known: ${Object.keys(OP_SPECS).join(', ')})`;
  for (const key of spec.required) if (op[key] === undefined || op[key] === '') return `${op.op} needs "${key}"`;
  if (op.op === 'add' && !(KINDS as readonly string[]).includes(String(op.kind))) return `add: kind must be one of ${KINDS.join(', ')}`;
  for (const key of ['position', 'rotation', 'lookAt', 'by', 'offset']) {
    const v = op[key];
    if (v !== undefined && !(Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) && !(key === 'by' && typeof v === 'number')) return `${op.op}: "${key}" must be [x, y, z] numbers`;
  }
  if (op.scale !== undefined && typeof op.scale !== 'number' && !(Array.isArray(op.scale) && op.scale.length >= 3)) return `${op.op}: "scale" must be a number or [x, y, z]`;
  if (op.op === 'modifier' && op.type !== 'mirror' && op.type !== 'array') return 'modifier: type must be mirror or array';
  for (const key of ['color', 'emissive', 'background']) if (op[key] !== undefined && normalizeColor(op[key]) === null) return `${op.op}: "${key}" must be a colour like "#ff8800" or "orange" (got ${JSON.stringify(op[key])})`;
  const m = op.material;
  if (m && typeof m === 'object') for (const key of ['color', 'emissive']) { const c = (m as Record<string, unknown>)[key]; if (c !== undefined && normalizeColor(c) === null) return `${op.op}: material.${key} must be a colour (got ${JSON.stringify(c)})`; }
  return null;
}

export function parseOps(value: unknown): { ops: ModelOp[]; errors: string[] } {
  let list: unknown = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { return { ops: [], errors: ['"ops" is not valid JSON'] }; } }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return { ops: [], errors: ['"ops" must be a list of operations'] };
  const ops: ModelOp[] = [], errors: string[] = [];
  list.forEach((entry, i) => { const err = validateOp(entry); if (err) errors.push(`op ${i + 1}: ${err}`); else ops.push(entry as ModelOp); });
  return { ops, errors };
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const r3 = (v: Vec3): Vec3 => [Math.round(v[0] * 10000) / 10000, Math.round(v[1] * 10000) / 10000, Math.round(v[2] * 10000) / 10000];

function need(model: Model3D, ref: unknown, what = 'object'): Obj3D {
  const o = findObject(model.objects, ref);
  if (!o) throw new Error(`no ${what} "${String(ref)}" (see model_read)`);
  return o;
}

function mergeUpdate(o: Obj3D, op: ModelOp): void {
  if (typeof op.name === 'string' && op.name.trim()) o.name = op.name.trim().slice(0, 60);
  if (op.position !== undefined) o.position = vec3(op.position, o.position);
  if (op.rotation !== undefined) o.rotation = vec3(op.rotation, o.rotation);
  if (op.scale !== undefined) o.scale = vec3(op.scale, o.scale);
  if (typeof op.visible === 'boolean') o.visible = op.visible;
  if (typeof op.locked === 'boolean') o.locked = op.locked;
  if (op.params && typeof op.params === 'object') o.params = normalizeParams(o.kind, op.params, o.params);
  if (op.material && typeof op.material === 'object') o.material = normalizeMaterial(op.material, o.material);
  if (op.lookAt !== undefined) o.lookAt = vec3(op.lookAt, [0, 0, 0]);
  if (op.modifiers !== undefined) o.modifiers = normalizeModifiers(op.modifiers);
  if (op.light && typeof op.light === 'object' && o.light) {
    const l = op.light as Record<string, unknown>;
    o.light = {
      type: (LIGHT_TYPES as readonly string[]).includes(String(l.type)) ? (l.type as LightType) : o.light.type, color: normalizeColor(l.color) ?? o.light.color,
      intensity: num(l.intensity, o.light.intensity, 0, 10000), distance: num(l.distance, o.light.distance, 0, 10000), angle: num(l.angle, o.light.angle, 1, 90),
      castShadow: typeof l.castShadow === 'boolean' ? l.castShadow : o.light.castShadow,
    };
  }
  if (op.camera && typeof op.camera === 'object' && o.camera) {
    const c = op.camera as Record<string, unknown>;
    o.camera = { fov: num(c.fov, o.camera.fov, 5, 150), near: num(c.near, o.camera.near, 0.001, 100), far: num(c.far, o.camera.far, 1, 100000), ortho: typeof c.ortho === 'boolean' ? c.ortho : o.camera.ortho, orthoSize: num(c.orthoSize, o.camera.orthoSize, 0.01, 1000) };
  }
}

/** Applies one operation to the model in place and returns a one-line description; throws a readable error when it cannot. */
export function applyModelOp(model: Model3D, op: ModelOp): string {
  switch (op.op) {
    case 'add': {
      if (model.objects.length >= MAX_OBJECTS) throw new Error(`a scene can have at most ${MAX_OBJECTS} objects`);
      if (typeof op.parent === 'string' && !findObject(model.objects, op.parent)) throw new Error(`no parent "${op.parent}"`);
      const init = { ...op } as Record<string, unknown>;
      if (typeof op.parent === 'string') init.parent = findObject(model.objects, op.parent)!.id;
      const o = makeObject(op.kind as ObjectKind, model.objects, init);
      model.objects.push(o);
      return `added ${o.kind} ${o.id} "${o.name}" at (${o.position.join(', ')})`;
    }
    case 'update': { const o = need(model, op.target); mergeUpdate(o, op); return `updated ${o.id} "${o.name}"`; }
    case 'remove': {
      const o = need(model, op.target);
      const gone = new Set([o.id, ...descendantsOf(model, o.id).map((d) => d.id)]);
      model.objects = model.objects.filter((x) => !gone.has(x.id));
      return `removed "${o.name}"${gone.size > 1 ? ` and ${gone.size - 1} child object(s)` : ''}`;
    }
    case 'duplicate': {
      const o = need(model, op.target);
      const count = Math.round(num(op.count, 1, 1, 50));
      const offset = vec3(op.offset, [1.5, 0, 0]);
      for (let i = 1; i <= count; i++) {
        if (model.objects.length >= MAX_OBJECTS) break;
        const idMap = new Map<string, string>();
        const group = [o, ...descendantsOf(model, o.id)];
        for (const src of group) {
          const copy: Obj3D = JSON.parse(JSON.stringify(src));
          copy.id = newObjectId(model.objects);
          copy.name = uniqueName(model.objects, src.name.replace(/\.\d{3}$/, ''));
          idMap.set(src.id, copy.id);
          copy.parent = src.id === o.id ? o.parent : idMap.get(src.parent ?? '') ?? null;
          if (src.id === o.id) copy.position = add3(src.position, [offset[0] * i, offset[1] * i, offset[2] * i]);
          model.objects.push(copy);
        }
      }
      return `duplicated "${o.name}" ${count}×`;
    }
    case 'parent': {
      const o = need(model, op.target);
      if (op.to === null || op.to === 'null' || op.to === '') { o.parent = null; return `"${o.name}" is now at the top level`; }
      const p = need(model, op.to, 'parent');
      if (p.id === o.id || descendantsOf(model, o.id).some((d) => d.id === p.id)) throw new Error('an object cannot be the parent of itself or of its own parent');
      o.parent = p.id;
      return `"${o.name}" is now a child of "${p.name}"`;
    }
    case 'move': {
      const o = need(model, op.target);
      if (op.to !== undefined) o.position = r3(vec3(op.to, o.position));
      else o.position = r3(add3(o.position, vec3(op.by, [0, 0, 0])));
      return `moved "${o.name}" to (${o.position.join(', ')})`;
    }
    case 'rotate': {
      const o = need(model, op.target);
      if (op.to !== undefined) o.rotation = r3(vec3(op.to, o.rotation));
      else o.rotation = r3(add3(o.rotation, vec3(op.by, [0, 0, 0])));
      return `rotated "${o.name}" to (${o.rotation.join(', ')})°`;
    }
    case 'scale': {
      const o = need(model, op.target);
      if (op.to !== undefined) o.scale = vec3(op.to, o.scale);
      else { const by = vec3(op.by, [1, 1, 1]); o.scale = [o.scale[0] * by[0], o.scale[1] * by[1], o.scale[2] * by[2]]; }
      o.scale = r3(o.scale);
      return `scaled "${o.name}" to (${o.scale.join(', ')})`;
    }
    case 'material': {
      const o = need(model, op.target);
      const patch = { color: op.color, metalness: op.metalness, roughness: op.roughness, emissive: op.emissive, emissiveIntensity: op.emissiveIntensity, opacity: op.opacity, wireframe: op.wireframe, flatShading: op.flatShading };
      const targets = op.children === true ? [o, ...descendantsOf(model, o.id)] : [o];
      for (const t of targets) t.material = normalizeMaterial(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), t.material);
      return `material of "${o.name}"${targets.length > 1 ? ` and ${targets.length - 1} child object(s)` : ''} updated`;
    }
    case 'modifier': {
      const o = need(model, op.target);
      if (op.clear === true) o.modifiers = [];
      if (o.modifiers.length >= 6) throw new Error('an object can have at most 6 modifiers');
      o.modifiers = [...o.modifiers, ...normalizeModifiers([{ type: op.type, axis: op.axis, count: op.count, offset: op.offset }])];
      return `"${o.name}" now has ${o.modifiers.length} modifier(s)`;
    }
    case 'world': {
      if (op.background !== undefined) model.world.background = normalizeColor(op.background) ?? model.world.background;
      if (op.ambient !== undefined) model.world.ambient = num(op.ambient, model.world.ambient, 0, 10);
      if (typeof op.grid === 'boolean') model.world.grid = op.grid;
      if (typeof op.fog === 'boolean') model.world.fog = op.fog;
      return 'scene settings updated';
    }
    case 'view': {
      if (op.position !== undefined) model.view.position = vec3(op.position, model.view.position);
      if (op.target !== undefined) model.view.target = vec3(op.target, model.view.target);
      return `viewport looks from (${model.view.position.join(', ')}) at (${model.view.target.join(', ')})`;
    }
    case 'align': {
      const o = need(model, op.target);
      if (op.ground === true) {
        const b = worldBounds(model, o);
        if (!b) throw new Error('only meshes can be put on the ground');
        o.position = r3([o.position[0], o.position[1] - b.min[1], o.position[2]]);
        return `"${o.name}" now rests on the ground`;
      }
      const ref = need(model, op.to, 'object to align to');
      const axes = op.axis === 'x' ? [0] : op.axis === 'y' ? [1] : op.axis === 'z' ? [2] : [0, 1, 2];
      const a = worldBounds(model, o), b = worldBounds(model, ref);
      const mode = op.mode === 'min' || op.mode === 'max' ? op.mode : 'center';
      const next: Vec3 = [...o.position];
      for (const i of axes) {
        const pa = a ? (mode === 'min' ? a.min[i] : mode === 'max' ? a.max[i] : (a.min[i] + a.max[i]) / 2) : worldMatrixPosition(model, o)[i];
        const pb = b ? (mode === 'min' ? b.min[i] : mode === 'max' ? b.max[i] : (b.min[i] + b.max[i]) / 2) : worldMatrixPosition(model, ref)[i];
        next[i] += pb - pa;
      }
      o.position = r3(next);
      return `aligned "${o.name}" to "${ref.name}"`;
    }
    case 'arrange': {
      const list = (Array.isArray(op.targets) ? op.targets : []).map((t) => need(model, t));
      if (list.length < 2) throw new Error('arrange needs at least two objects');
      const axis = op.axis === 'z' ? 2 : 0, gap = num(op.gap, 0.5, 0, 1000);
      let cursor: number | null = null;
      for (const o of list) {
        const b = worldBounds(model, o);
        const size = b ? b.max[axis] - b.min[axis] : 0;
        const center = b ? (b.min[axis] + b.max[axis]) / 2 : o.position[axis];
        if (cursor === null) cursor = center + size / 2 + gap;
        else { const shift = cursor + size / 2 - center; o.position = r3(o.position.map((v, i) => (i === axis ? v + shift : v)) as Vec3); cursor += size + gap; }
      }
      return `arranged ${list.length} objects along ${axis === 0 ? 'x' : 'z'}`;
    }
    case 'clear': { model.objects = []; return 'removed every object'; }
    default: throw new Error(`unknown op "${String(op.op)}"`);
  }
}

/** Applies a list of operations in order. Returns the log; stops at the first failure (the caller discards the model then). */
export function applyModelOps(model: Model3D, ops: ModelOp[]): { log: string[]; error?: string } {
  const log: string[] = [];
  for (const [i, op] of ops.entries()) {
    try { log.push(`✓ ${op.op}: ${applyModelOp(model, op)}`); } catch (error) { return { log, error: `op ${i + 1} (${op.op}): ${error instanceof Error ? error.message : String(error)}` }; }
  }
  return { log };
}
