/** The Game document: scenes made of Godot-style nodes, scripts (TypeScript or JavaScript) and project settings, all in one
 * JSON file. Pure data with the node catalogue, operations and checks that both the editor and the agent tools use — no
 * three.js and no DOM, so it runs in node tests. The engine that plays it is engineRuntime.js. */

export const GAMES_DIR = '.pigry/games/';
export const GAME_EXT = '.game.json';
export const MAX_NODES = 600;
export const MAX_SCRIPT_CHARS = 60000;

export type PropType = 'number' | 'int' | 'bool' | 'string' | 'text' | 'color' | 'vec2' | 'vec3' | 'enum' | 'material' | 'json';
export interface PropSpec { type: PropType; default: unknown; min?: number; max?: number; step?: number; options?: string[]; label?: string }

export interface NodeTypeSpec { base: string | null; category: 'Node' | '3D' | '2D' | 'Physics' | 'UI' | 'Utility'; description: string; props: Record<string, PropSpec> }

const v3 = (x = 0, y = 0, z = 0): [number, number, number] => [x, y, z];
const bodyProps = (): Record<string, PropSpec> => ({ collisionLayer: { type: 'int', default: 1, min: 0, max: 65535 }, collisionMask: { type: 'int', default: 1, min: 0, max: 65535 } });
const MATERIAL_DEFAULT = { color: '#cccccc', metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 0, opacity: 1, wireframe: false, flatShading: false };

/** Every node type the engine knows, with the properties the inspector shows and the operations accept. */
export const NODE_TYPES: Record<string, NodeTypeSpec> = {
  Node: { base: null, category: 'Node', description: 'The base of everything: a node in the scene tree with a name, children, a script and groups.', props: {} },
  Node3D: { base: 'Node', category: '3D', description: 'A node with a 3D transform (position, rotation in degrees, scale).', props: { position: { type: 'vec3', default: v3(), step: 0.1 }, rotation: { type: 'vec3', default: v3(), step: 5, label: 'Rotation (°)' }, scale: { type: 'vec3', default: v3(1, 1, 1), step: 0.1 }, visible: { type: 'bool', default: true } } },
  Marker3D: { base: 'Node3D', category: '3D', description: 'An empty 3D point, for spawn positions and pivots.', props: {} },
  MeshInstance3D: {
    base: 'Node3D', category: '3D', description: 'Shows a primitive mesh (box, sphere, cylinder, cone, capsule, torus, plane) scaled to size, with a PBR material.',
    props: { mesh: { type: 'enum', default: 'box', options: ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'plane'] }, size: { type: 'vec3', default: v3(1, 1, 1), step: 0.1 }, material: { type: 'material', default: MATERIAL_DEFAULT }, castShadow: { type: 'bool', default: true } },
  },
  Camera3D: { base: 'Node3D', category: '3D', description: 'The 3D camera. The current camera is what the game shows.', props: { fov: { type: 'number', default: 60, min: 5, max: 150, label: 'Field of view (°)' }, near: { type: 'number', default: 0.05, min: 0.001 }, far: { type: 'number', default: 1000, min: 1 }, current: { type: 'bool', default: false } } },
  DirectionalLight3D: { base: 'Node3D', category: '3D', description: 'A sun: parallel light along the node\'s -Z axis.', props: { color: { type: 'color', default: '#ffffff' }, energy: { type: 'number', default: 3, min: 0, step: 0.1 }, shadow: { type: 'bool', default: true } } },
  OmniLight3D: { base: 'Node3D', category: '3D', description: 'A point light that shines in every direction.', props: { color: { type: 'color', default: '#ffffff' }, energy: { type: 'number', default: 30, min: 0, step: 1 }, range: { type: 'number', default: 0, min: 0 }, shadow: { type: 'bool', default: false } } },
  SpotLight3D: { base: 'Node3D', category: '3D', description: 'A cone of light along the node\'s -Z axis.', props: { color: { type: 'color', default: '#ffffff' }, energy: { type: 'number', default: 60, min: 0, step: 1 }, range: { type: 'number', default: 0, min: 0 }, spotAngle: { type: 'number', default: 45, min: 1, max: 90 }, shadow: { type: 'bool', default: true } } },
  WorldEnvironment: { base: 'Node', category: '3D', description: 'Background colour, ambient light and fog of the 3D world.', props: { background: { type: 'color', default: '#2b2f36' }, ambient: { type: 'number', default: 0.4, min: 0, max: 5, step: 0.05 }, fog: { type: 'bool', default: false }, fogDensity: { type: 'number', default: 0.02, min: 0, max: 1, step: 0.005 } } },
  CollisionShape3D: { base: 'Node3D', category: 'Physics', description: 'The collision shape of its parent body. Boxes and capsules use axis-aligned boxes, spheres use spheres.', props: { shape: { type: 'enum', default: 'box', options: ['box', 'sphere', 'capsule'] }, size: { type: 'vec3', default: v3(1, 1, 1), step: 0.1 }, disabled: { type: 'bool', default: false } } },
  StaticBody3D: { base: 'Node3D', category: 'Physics', description: 'A solid that never moves (floors, walls). Add a CollisionShape3D child.', props: bodyProps() },
  RigidBody3D: { base: 'Node3D', category: 'Physics', description: 'A body moved by gravity and collisions (crates, balls).', props: { ...bodyProps(), mass: { type: 'number', default: 1, min: 0.01 }, gravityScale: { type: 'number', default: 1, step: 0.1 }, bounce: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.05 }, friction: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.05 }, linearDamp: { type: 'number', default: 0.05, min: 0, step: 0.01 } } },
  CharacterBody3D: { base: 'Node3D', category: 'Physics', description: 'A body you move from a script with velocity and moveAndSlide() (players, enemies).', props: { ...bodyProps(), floorMaxAngle: { type: 'number', default: 45, min: 0, max: 90 }, floorSnap: { type: 'number', default: 0.12, min: 0, step: 0.01 } } },
  Area3D: { base: 'Node3D', category: 'Physics', description: 'Detects bodies entering and leaving its shape (signals bodyEntered / bodyExited).', props: { ...bodyProps(), monitoring: { type: 'bool', default: true } } },
  Node2D: { base: 'Node', category: '2D', description: 'A node with a 2D transform. Units are pixels and +Y points UP (unlike Godot).', props: { position: { type: 'vec2', default: [0, 0] }, rotation: { type: 'number', default: 0, step: 5, label: 'Rotation (°)' }, scale: { type: 'vec2', default: [1, 1], step: 0.1 }, visible: { type: 'bool', default: true }, zIndex: { type: 'int', default: 0, min: -100, max: 100 } } },
  Marker2D: { base: 'Node2D', category: '2D', description: 'An empty 2D point, for spawn positions.', props: {} },
  Sprite2D: { base: 'Node2D', category: '2D', description: 'A coloured rectangle, circle or triangle, or a picture (texture as a data: URL).', props: { shape: { type: 'enum', default: 'rect', options: ['rect', 'circle', 'triangle'] }, size: { type: 'vec2', default: [64, 64] }, color: { type: 'color', default: '#ffffff' }, texture: { type: 'text', default: '' } } },
  Camera2D: { base: 'Node2D', category: '2D', description: 'The 2D camera: shows the world around its position, zoom 2 = twice as big.', props: { zoom: { type: 'number', default: 1, min: 0.05, max: 20, step: 0.1 }, current: { type: 'bool', default: true } } },
  CollisionShape2D: { base: 'Node2D', category: 'Physics', description: 'The collision shape of its parent 2D body (rect or circle).', props: { shape: { type: 'enum', default: 'rect', options: ['rect', 'circle'] }, size: { type: 'vec2', default: [32, 32] }, disabled: { type: 'bool', default: false } } },
  StaticBody2D: { base: 'Node2D', category: 'Physics', description: 'A 2D solid that never moves (ground, walls).', props: bodyProps() },
  RigidBody2D: { base: 'Node2D', category: 'Physics', description: 'A 2D body moved by gravity and collisions.', props: { ...bodyProps(), mass: { type: 'number', default: 1, min: 0.01 }, gravityScale: { type: 'number', default: 1, step: 0.1 }, bounce: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.05 }, friction: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.05 }, linearDamp: { type: 'number', default: 0.05, min: 0, step: 0.01 } } },
  CharacterBody2D: { base: 'Node2D', category: 'Physics', description: 'A 2D body you move from a script with velocity and moveAndSlide() (platformer players, enemies).', props: { ...bodyProps(), floorMaxAngle: { type: 'number', default: 45, min: 0, max: 90 }, floorSnap: { type: 'number', default: 6, min: 0 } } },
  Area2D: { base: 'Node2D', category: 'Physics', description: 'Detects 2D bodies entering and leaving its shape (coins, hazards, triggers).', props: { ...bodyProps(), monitoring: { type: 'bool', default: true } } },
  CanvasLayer: { base: 'Node', category: 'UI', description: 'A layer for UI controls drawn on top of the game.', props: { layer: { type: 'int', default: 1 } } },
  Control: { base: 'Node', category: 'UI', description: 'The base of UI nodes: a pixel position and size anchored to the screen.', props: { position: { type: 'vec2', default: [0, 0] }, size: { type: 'vec2', default: [100, 30] }, anchor: { type: 'enum', default: 'top_left', options: ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right', 'full_rect'] }, visible: { type: 'bool', default: true } } },
  Label: { base: 'Control', category: 'UI', description: 'Text on screen (score, messages).', props: { text: { type: 'text', default: 'Label' }, color: { type: 'color', default: '#ffffff' }, fontSize: { type: 'int', default: 18, min: 6, max: 200 }, align: { type: 'enum', default: 'left', options: ['left', 'center', 'right'] } } },
  ColorRect: { base: 'Control', category: 'UI', description: 'A filled rectangle (panels, bars, fades).', props: { color: { type: 'color', default: '#ffffff' } } },
  Button: { base: 'Control', category: 'UI', description: 'A clickable button (signal pressed).', props: { text: { type: 'text', default: 'Button' }, fontSize: { type: 'int', default: 18, min: 6, max: 200 } } },
  ProgressBar: { base: 'Control', category: 'UI', description: 'A bar showing value out of maxValue (health, loading).', props: { value: { type: 'number', default: 50 }, maxValue: { type: 'number', default: 100 }, color: { type: 'color', default: '#4fb98a' } } },
  Timer: { base: 'Node', category: 'Utility', description: 'Counts down and emits the timeout signal.', props: { waitTime: { type: 'number', default: 1, min: 0.01, step: 0.1 }, oneShot: { type: 'bool', default: false }, autostart: { type: 'bool', default: false } } },
  AnimationPlayer: { base: 'Node', category: 'Utility', description: 'Plays keyframe animations of its parent\'s properties (position, rotation, scale, colours).', props: { autoplay: { type: 'string', default: '' }, speedScale: { type: 'number', default: 1, step: 0.1 }, animations: { type: 'json', default: {} } } },
};

/** The properties of a node type including everything it inherits. */
export function propsOf(type: string): Record<string, PropSpec> {
  const chain: string[] = [];
  for (let t: string | null = type; t && NODE_TYPES[t]; t = NODE_TYPES[t].base) chain.unshift(t);
  return Object.assign({}, ...chain.map((t) => NODE_TYPES[t].props));
}
export const inherits = (type: string, base: string): boolean => { for (let t: string | null = type; t && NODE_TYPES[t]; t = NODE_TYPES[t].base) if (t === base) return true; return false; };
export const is2D = (type: string): boolean => inherits(type, 'Node2D');
export const isBody = (type: string): boolean => /^(Static|Rigid|Character)Body[23]D$|^Area[23]D$/.test(type);
export const isShape = (type: string): boolean => type === 'CollisionShape3D' || type === 'CollisionShape2D';
export const NODE_CATEGORIES: Array<NodeTypeSpec['category']> = ['Node', '3D', 'Physics', '2D', 'UI', 'Utility'];

/* ---------- the document ---------- */

export interface GameNode {
  name: string;
  type: string;
  props?: Record<string, unknown>;
  /** A script path ("scripts/player.ts"); the script's class must extend the node's type. */
  script?: string;
  /** Values for the script's `static exports` variables. */
  exports?: Record<string, unknown>;
  groups?: string[];
  /** The name of another scene to instance here (the node's own children are ignored then). */
  instance?: string;
  children?: GameNode[];
}
export interface Connection { from: string; signal: string; to: string; method: string }
export interface GameScene { name: string; root: GameNode; connections: Connection[] }
export interface GameSettings {
  width: number;
  height: number;
  mainScene: string;
  background: string;
  gravity3d: number;
  gravity2d: number;
  /** action name → key codes (KeyboardEvent.code, e.g. "KeyW", "ArrowUp", "Space", "Mouse0"). */
  inputMap: Record<string, string[]>;
  autoloads: Array<{ name: string; script: string }>;
}
export interface GameScript { code: string }
export interface Game { version: 1; title: string; settings: GameSettings; scenes: Record<string, GameScene>; scripts: Record<string, GameScript> }

export const DEFAULT_INPUT_MAP: Record<string, string[]> = {
  move_left: ['KeyA', 'ArrowLeft'], move_right: ['KeyD', 'ArrowRight'], move_forward: ['KeyW', 'ArrowUp'], move_back: ['KeyS', 'ArrowDown'], jump: ['Space'], action: ['KeyE', 'Enter'],
};

export const emptySettings = (): GameSettings => ({ width: 1152, height: 648, mainScene: 'main', background: '#2b2f36', gravity3d: 9.8, gravity2d: 980, inputMap: structuredClone(DEFAULT_INPUT_MAP), autoloads: [] });
export const emptyGame = (title = 'Untitled'): Game => ({ version: 1, title, settings: emptySettings(), scenes: { main: { name: 'main', root: { name: 'Main', type: 'Node3D' }, connections: [] } }, scripts: {} });

const clampN = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());

/** A valid node name: no slashes, dots, colons or percent signs (they are path syntax). */
export const cleanNodeName = (name: unknown, fallback: string): string => {
  const n = String(name ?? '').replace(/[/.:%@"]/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return n || fallback;
};
export const scriptPathOk = (p: unknown): p is string => typeof p === 'string' && /^[A-Za-z0-9_\-/]+\.(ts|js)$/.test(p) && !p.includes('..') && !p.startsWith('/');

/** Coerces one property to the shape its type needs; returns undefined when the value cannot be used. */
export function coerceProp(spec: PropSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'number': return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) ? clampN(value, spec.default as number, spec.min, spec.max) : undefined;
    case 'int': return Math.round(clampN(value, spec.default as number, spec.min, spec.max));
    case 'bool': return typeof value === 'boolean' ? value : undefined;
    case 'string': case 'text': return typeof value === 'string' ? value.slice(0, spec.type === 'text' ? 200000 : 200) : undefined;
    case 'color': return isHex(value) ? value.trim() : undefined;
    case 'enum': return typeof value === 'string' && spec.options?.includes(value) ? value : undefined;
    case 'vec2': return Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [value[0], value[1]] : typeof value === 'number' ? [value, value] : undefined;
    case 'vec3': return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [value[0], value[1], value[2]] : typeof value === 'number' ? [value, value, value] : undefined;
    case 'material': {
      if (!value || typeof value !== 'object') return undefined;
      const m = value as Record<string, unknown>, out: Record<string, unknown> = {};
      if (isHex(m.color)) out.color = m.color; if (isHex(m.emissive)) out.emissive = m.emissive;
      for (const k of ['metalness', 'roughness', 'opacity']) if (m[k] !== undefined) out[k] = clampN(m[k], 0, 0, 1);
      if (m.emissiveIntensity !== undefined) out.emissiveIntensity = clampN(m.emissiveIntensity, 0, 0, 20);
      for (const k of ['wireframe', 'flatShading']) if (typeof m[k] === 'boolean') out[k] = m[k];
      return out;
    }
    case 'json': return value && typeof value === 'object' ? value : undefined;
    default: return undefined;
  }
}

/** Validates the props for a node type; returns the cleaned props and what was wrong. */
export function cleanProps(type: string, props: unknown): { props: Record<string, unknown>; errors: string[] } {
  const spec = propsOf(type), out: Record<string, unknown> = {}, errors: string[] = [];
  if (!props || typeof props !== 'object') return { props: out, errors };
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    const s = spec[k];
    if (!s) { errors.push(`${type} has no property "${k}" (known: ${Object.keys(spec).join(', ') || 'none'})`); continue; }
    const c = coerceProp(s, v);
    if (c === undefined) { errors.push(`${type}.${k}: ${JSON.stringify(v)} is not a valid ${s.type}${s.options ? ` (${s.options.join(', ')})` : ''}`); continue; }
    out[k] = c;
  }
  return { props: out, errors };
}

function normalizeNode(raw: unknown, warnings: string[], depth = 0): GameNode | null {
  if (!raw || typeof raw !== 'object' || depth > 24) return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' && NODE_TYPES[r.type] ? r.type : null;
  if (!type) { warnings.push(`Dropped node "${String(r.name)}" of unknown type "${String(r.type)}".`); return null; }
  const node: GameNode = { name: cleanNodeName(r.name, type), type };
  const cleaned = cleanProps(type, r.props);
  for (const e of cleaned.errors) warnings.push(`${node.name}: ${e}`);
  if (Object.keys(cleaned.props).length) node.props = cleaned.props;
  if (typeof r.script === 'string' && scriptPathOk(r.script)) node.script = r.script;
  if (r.exports && typeof r.exports === 'object') node.exports = r.exports as Record<string, unknown>;
  if (Array.isArray(r.groups)) { const g = r.groups.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 40); if (g.length) node.groups = [...new Set(g)]; }
  if (typeof r.instance === 'string' && r.instance) node.instance = r.instance;
  const kids: GameNode[] = [];
  if (Array.isArray(r.children) && !node.instance) {
    for (const c of r.children) {
      const n = normalizeNode(c, warnings, depth + 1);
      if (!n) continue;
      let name = n.name, i = 2;
      while (kids.some((k) => k.name === name)) name = `${n.name}${i++}`;
      n.name = name;
      kids.push(n);
    }
  }
  if (kids.length) node.children = kids;
  return node;
}

export interface NormalizeResult { game: Game; warnings: string[] }

/** Repairs whatever was read from disk (or written by an agent) into a valid game, listing what it had to fix. */
export function normalizeGame(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const warnings: string[] = [];
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const game = emptyGame(typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : fallbackTitle);
  const s = o.settings && typeof o.settings === 'object' ? (o.settings as Record<string, unknown>) : {};
  game.settings = {
    width: Math.round(clampN(s.width, 1152, 64, 7680)), height: Math.round(clampN(s.height, 648, 64, 4320)), mainScene: typeof s.mainScene === 'string' ? s.mainScene : 'main',
    background: isHex(s.background) ? s.background : '#2b2f36', gravity3d: clampN(s.gravity3d, 9.8, 0, 1000), gravity2d: clampN(s.gravity2d, 980, 0, 100000),
    inputMap: {}, autoloads: [],
  };
  const map = s.inputMap && typeof s.inputMap === 'object' ? (s.inputMap as Record<string, unknown>) : DEFAULT_INPUT_MAP;
  for (const [a, keys] of Object.entries(map)) if (/^[A-Za-z0-9_]{1,40}$/.test(a) && Array.isArray(keys)) game.settings.inputMap[a] = keys.filter((k): k is string => typeof k === 'string' && k.length < 30);
  if (Array.isArray(s.autoloads)) for (const a of s.autoloads) if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string' && scriptPathOk((a as Record<string, unknown>).script)) game.settings.autoloads.push({ name: cleanNodeName((a as Record<string, unknown>).name, 'Autoload'), script: (a as Record<string, unknown>).script as string });
  game.scenes = {};
  const scenes = o.scenes && typeof o.scenes === 'object' ? (o.scenes as Record<string, unknown>) : {};
  for (const [name, sc] of Object.entries(scenes)) {
    if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(name) || !sc || typeof sc !== 'object') { warnings.push(`Dropped scene "${name}" (bad name or content).`); continue; }
    const root = normalizeNode((sc as Record<string, unknown>).root, warnings);
    if (!root) { warnings.push(`Scene "${name}" had no valid root node; dropped.`); continue; }
    const conns: Connection[] = [];
    const rawConns = (sc as Record<string, unknown>).connections;
    if (Array.isArray(rawConns)) for (const c of rawConns) { const k = c as Record<string, unknown>; if (c && typeof k.from === 'string' && typeof k.signal === 'string' && typeof k.to === 'string' && typeof k.method === 'string') conns.push({ from: k.from, signal: k.signal, to: k.to, method: k.method }); }
    game.scenes[name] = { name, root, connections: conns };
  }
  if (Object.keys(game.scenes).length === 0) { game.scenes = emptyGame().scenes; warnings.push('The game had no scenes; added an empty "main" scene.'); }
  if (!game.scenes[game.settings.mainScene]) { game.settings.mainScene = Object.keys(game.scenes)[0]; warnings.push(`mainScene was not a scene; using "${game.settings.mainScene}".`); }
  game.scripts = {};
  const scripts = o.scripts && typeof o.scripts === 'object' ? (o.scripts as Record<string, unknown>) : {};
  for (const [path, sc] of Object.entries(scripts)) {
    if (!scriptPathOk(path) || !sc || typeof (sc as Record<string, unknown>).code !== 'string') { warnings.push(`Dropped script "${path}" (bad path or no code).`); continue; }
    game.scripts[path] = { code: ((sc as Record<string, unknown>).code as string).slice(0, MAX_SCRIPT_CHARS) };
  }
  return { game, warnings };
}

export function parseGameJson(text: string, fallbackTitle = 'Untitled'): NormalizeResult {
  try { return normalizeGame(JSON.parse(text), fallbackTitle); } catch { return { game: emptyGame(fallbackTitle), warnings: ['The file was not valid JSON; started an empty game.'] }; }
}
export const serializeGame = (game: Game): string => JSON.stringify(game, null, 1);

/* ---------- finding nodes ---------- */

/** Child indexes from the scene root for a path like "Player/Camera3D" ("." or "" = the root). */
export function findNode(scene: GameScene, path: string): { node: GameNode; parent: GameNode | null; index: number } | null {
  const clean = String(path ?? '').trim().replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '');
  if (clean === '' || clean === scene.root.name) return { node: scene.root, parent: null, index: -1 };
  let node = scene.root, parent: GameNode | null = null, index = -1;
  const parts = clean.split('/');
  if (parts[0] === scene.root.name) parts.shift();
  for (const part of parts) {
    const i = (node.children ?? []).findIndex((c) => c.name === part);
    if (i < 0) return null;
    parent = node; node = node.children![i]; index = i;
  }
  return { node, parent, index };
}
export function walkNodes(node: GameNode, fn: (n: GameNode, path: string, depth: number) => void, path = '.', depth = 0): void {
  fn(node, path, depth);
  for (const c of node.children ?? []) walkNodes(c, fn, path === '.' ? c.name : `${path}/${c.name}`, depth + 1);
}
export const countNodes = (scene: GameScene): number => { let n = 0; walkNodes(scene.root, () => { n++; }); return n; };

/* ---------- script exports (the "@export" variables) ---------- */

export interface ExportSpec { name: string; type: 'number' | 'int' | 'bool' | 'string' | 'color' | 'vec2' | 'vec3'; default: unknown; min?: number; max?: number }

/** Reads `static exports = { speed: 5, jump: { default: 7, min: 0, max: 20 }, tint: '#ff0000' }` from a script without running it. */
export function parseExports(code: string): ExportSpec[] {
  const m = /static\s+exports\s*(?::[^=]+)?=\s*\{/.exec(code);
  if (!m) return [];
  const i = m.index + m[0].length - 1;
  let depth = 0, end = -1;
  for (let k = i; k < code.length; k++) { const c = code[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = k; break; } } }
  if (end < 0) return [];
  const literal = code.slice(i, end + 1);
  if (!/^[\w\s:,.'"\-#[\]{}+*/]*$/.test(literal)) return [];
  let value: unknown;
  try { value = new Function(`"use strict"; return (${literal});`)(); } catch { return []; }
  if (!value || typeof value !== 'object') return [];
  const out: ExportSpec[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const spec = raw && typeof raw === 'object' && !Array.isArray(raw) && 'default' in (raw as object) ? (raw as Record<string, unknown>) : { default: raw };
    const d = spec.default;
    const type: ExportSpec['type'] = typeof d === 'boolean' ? 'bool' : typeof d === 'number' ? (Number.isInteger(d) && spec.int === true ? 'int' : 'number') : typeof d === 'string' ? (isHex(d) ? 'color' : 'string') : Array.isArray(d) ? (d.length === 2 ? 'vec2' : 'vec3') : 'string';
    out.push({ name, type, default: d, min: typeof spec.min === 'number' ? spec.min : undefined, max: typeof spec.max === 'number' ? spec.max : undefined });
  }
  return out;
}

/** The base class a script extends ("CharacterBody3D"), read from `class X extends Y`. */
export function scriptBase(code: string): string | null {
  const m = /export\s+default\s+class\s*\w*\s+extends\s+([A-Za-z0-9_$.]+)/.exec(code) ?? /class\s+\w+\s+extends\s+([A-Za-z0-9_$.]+)/.exec(code);
  return m ? m[1].split('.').pop() ?? null : null;
}

/* ---------- operations ---------- */

export type GameOp = { op: string } & Record<string, unknown>;

export const OP_SPECS: Record<string, { summary: string; required: string[] }> = {
  add_node: { summary: '{op:"add_node", scene?, parent?: path ("." = scene root), type, name?, props?, script?: "scripts/x.ts", exports?, groups?: [..], instance?: "scene name", index?} — adds a node; props are the node type\'s properties (position, size, mesh, material, …)', required: ['type'] },
  set: { summary: '{op:"set", scene?, node: path, name?, props?, script?: path|null, exports?, groups?} — change a node (props merge)', required: ['node'] },
  remove_node: { summary: '{op:"remove_node", scene?, node: path}', required: ['node'] },
  move_node: { summary: '{op:"move_node", scene?, node: path, to: parent path, index?}', required: ['node', 'to'] },
  duplicate_node: { summary: '{op:"duplicate_node", scene?, node: path, name?}', required: ['node'] },
  add_scene: { summary: '{op:"add_scene", name, rootType?: Node3D|Node2D|Node|Control…, rootName?}', required: ['name'] },
  remove_scene: { summary: '{op:"remove_scene", name}', required: ['name'] },
  rename_scene: { summary: '{op:"rename_scene", name, to}', required: ['name', 'to'] },
  set_main_scene: { summary: '{op:"set_main_scene", name}', required: ['name'] },
  set_script: { summary: '{op:"set_script", path: "scripts/player.ts", code} — create or replace a script (TypeScript or JavaScript)', required: ['path', 'code'] },
  remove_script: { summary: '{op:"remove_script", path}', required: ['path'] },
  rename_script: { summary: '{op:"rename_script", path, to} — also updates the nodes and autoloads that use it', required: ['path', 'to'] },
  connect: { summary: '{op:"connect", scene?, from: path, signal, to: path, method} — when node `from` emits `signal`, call `method` on node `to`', required: ['from', 'signal', 'to', 'method'] },
  disconnect: { summary: '{op:"disconnect", scene?, from, signal, to, method}', required: ['from', 'signal', 'to', 'method'] },
  settings: { summary: '{op:"settings", title?, width?, height?, background?, gravity3d?, gravity2d?}', required: [] },
  input_action: { summary: '{op:"input_action", name, keys: ["KeyW","ArrowUp","Space","Mouse0"]} — define or replace an input action', required: ['name', 'keys'] },
  remove_action: { summary: '{op:"remove_action", name}', required: ['name'] },
  autoload: { summary: '{op:"autoload", name, script} — a global node created before the main scene (a singleton such as Game or Audio)', required: ['name', 'script'] },
  remove_autoload: { summary: '{op:"remove_autoload", name}', required: ['name'] },
  animation: { summary: '{op:"animation", scene?, node: AnimationPlayer path, name, length, loop?, tracks: [{node: path relative to the player\'s parent ("" = the parent itself), property: "position"|"rotationDegrees"|"scale"|"position:y"|"material.color"…, keys: [{t, v}], trans?, ease?, interp?: "step"}]}', required: ['node', 'name', 'tracks'] },
};
export const OP_HELP = Object.values(OP_SPECS).map((s) => `- ${s.summary}`).join('\n');

export function validateOp(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'an operation must be an object like {"op":"add_node","type":"Node3D"}';
  const op = raw as GameOp, spec = OP_SPECS[op.op];
  if (!spec) return `unknown op "${String(op.op)}" (known: ${Object.keys(OP_SPECS).join(', ')})`;
  for (const k of spec.required) if (op[k] === undefined || op[k] === '') return `${op.op} needs "${k}"`;
  if (op.op === 'add_node' && !NODE_TYPES[String(op.type)] && !op.instance) return `add_node: unknown type "${String(op.type)}" (known: ${Object.keys(NODE_TYPES).join(', ')})`;
  if ((op.op === 'set_script' || op.op === 'remove_script' || op.op === 'rename_script') && !scriptPathOk(op.path)) return `${op.op}: path must look like "scripts/player.ts" (letters, digits, _ - /, ending in .ts or .js)`;
  if (op.op === 'rename_script' && !scriptPathOk(op.to)) return 'rename_script: "to" must look like "scripts/player.ts"';
  if (op.op === 'set_script' && (typeof op.code !== 'string' || (op.code as string).length > MAX_SCRIPT_CHARS)) return `set_script: code must be a string of at most ${MAX_SCRIPT_CHARS} characters`;
  if (op.op === 'input_action' && !(Array.isArray(op.keys) && op.keys.every((k) => typeof k === 'string'))) return 'input_action: keys must be a list of key codes like "KeyW"';
  if (op.op === 'settings' && op.background !== undefined && !isHex(op.background)) return 'settings: background must be a colour like "#223344"';
  if (op.op === 'animation' && !Array.isArray(op.tracks)) return 'animation: tracks must be a list';
  return null;
}

export function parseOps(value: unknown): { ops: GameOp[]; errors: string[] } {
  let list: unknown = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { return { ops: [], errors: ['"ops" is not valid JSON'] }; } }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return { ops: [], errors: ['"ops" must be a list of operations'] };
  const ops: GameOp[] = [], errors: string[] = [];
  list.forEach((entry, i) => { const e = validateOp(entry); if (e) errors.push(`op ${i + 1}: ${e}`); else ops.push(entry as GameOp); });
  return { ops, errors };
}

const sceneOf = (game: Game, op: GameOp): GameScene => {
  const name = typeof op.scene === 'string' && op.scene ? op.scene : game.settings.mainScene;
  const s = game.scenes[name];
  if (!s) throw new Error(`no scene "${name}" (scenes: ${Object.keys(game.scenes).join(', ')})`);
  return s;
};
const needNode = (scene: GameScene, path: unknown, what = 'node') => {
  const f = findNode(scene, String(path));
  if (!f) throw new Error(`no ${what} "${String(path)}" in scene "${scene.name}" (see game_read)`);
  return f;
};
const pathOfNode = (scene: GameScene, target: GameNode): string => { let found = '.'; walkNodes(scene.root, (n, p) => { if (n === target) found = p; }); return found; };

function uniqueSibling(parent: GameNode, name: string): string {
  let n = name, i = 2;
  while ((parent.children ?? []).some((c) => c.name === n)) n = `${name}${i++}`;
  return n;
}

function setNodeFields(game: Game, scene: GameScene, node: GameNode, op: GameOp, parent: GameNode | null): void {
  if (typeof op.name === 'string' && op.name.trim() && node !== scene.root) {
    const wanted = cleanNodeName(op.name, node.name);
    if (parent && (parent.children ?? []).some((c) => c !== node && c.name === wanted)) throw new Error(`a sibling is already named "${wanted}"`);
    node.name = wanted;
  } else if (typeof op.name === 'string' && op.name.trim()) node.name = cleanNodeName(op.name, node.name);
  if (op.props !== undefined) {
    const { props, errors } = cleanProps(node.type, op.props);
    if (errors.length) throw new Error(errors.join('; '));
    node.props = { ...(node.props ?? {}), ...props };
    if (op.props && typeof op.props === 'object' && 'material' in (op.props as object) && node.props.material && props.material) node.props.material = { ...((node.props.material as object) ?? {}), ...(props.material as object) };
  }
  if (op.script !== undefined) {
    if (op.script === null || op.script === '') delete node.script;
    else if (!scriptPathOk(op.script)) throw new Error('script must be a path like "scripts/player.ts"');
    else {
      node.script = op.script as string;
      if (!game.scripts[node.script]) throw new Error(`script "${node.script}" does not exist yet — create it with set_script first`);
    }
  }
  if (op.exports !== undefined && op.exports && typeof op.exports === 'object') node.exports = { ...(node.exports ?? {}), ...(op.exports as Record<string, unknown>) };
  if (Array.isArray(op.groups)) { const g = op.groups.filter((x): x is string => typeof x === 'string' && x.length > 0); if (g.length) node.groups = [...new Set(g)]; else delete node.groups; }
}

/** Applies one operation to the game in place and returns a one-line description; throws a readable error when it cannot. */
export function applyGameOp(game: Game, op: GameOp): string {
  switch (op.op) {
    case 'add_node': {
      const scene = sceneOf(game, op);
      if (countNodes(scene) >= MAX_NODES) throw new Error(`a scene can have at most ${MAX_NODES} nodes`);
      const where = needNode(scene, op.parent ?? '.', 'parent');
      const parent = where.node;
      if (parent.instance) throw new Error(`"${parent.name}" is an instanced scene; add nodes inside that scene instead`);
      const type = typeof op.type === 'string' && NODE_TYPES[op.type] ? op.type : 'Node';
      if (op.instance && !game.scenes[String(op.instance)]) throw new Error(`cannot instance unknown scene "${String(op.instance)}"`);
      if (op.instance === scene.name) throw new Error('a scene cannot instance itself');
      const node: GameNode = { name: uniqueSibling(parent, cleanNodeName(op.name, op.instance ? String(op.instance) : type)), type: op.instance ? 'Node' : type };
      if (op.instance) { node.instance = String(op.instance); node.type = game.scenes[node.instance].root.type; }
      setNodeFields(game, scene, node, { ...op, name: undefined }, parent);
      parent.children = parent.children ?? [];
      const index = typeof op.index === 'number' ? Math.max(0, Math.min(parent.children.length, Math.round(op.index))) : parent.children.length;
      parent.children.splice(index, 0, node);
      return `added ${node.type} "${node.name}" under ${pathOfNode(scene, parent)}`;
    }
    case 'set': { const scene = sceneOf(game, op); const f = needNode(scene, op.node); setNodeFields(game, scene, f.node, op, f.parent); return `updated "${f.node.name}"`; }
    case 'remove_node': {
      const scene = sceneOf(game, op); const f = needNode(scene, op.node);
      if (!f.parent) throw new Error('the root node cannot be removed (remove the scene instead)');
      f.parent.children = (f.parent.children ?? []).filter((c) => c !== f.node);
      if (!f.parent.children.length) delete f.parent.children;
      scene.connections = scene.connections.filter((c) => !c.from.startsWith(String(op.node)) && !c.to.startsWith(String(op.node)));
      return `removed "${f.node.name}"`;
    }
    case 'move_node': {
      const scene = sceneOf(game, op); const f = needNode(scene, op.node); const to = needNode(scene, op.to, 'new parent');
      if (!f.parent) throw new Error('the root node cannot be moved');
      let bad = false; walkNodes(f.node, (n) => { if (n === to.node) bad = true; });
      if (bad) throw new Error('a node cannot be moved into itself or its own child');
      f.parent.children = (f.parent.children ?? []).filter((c) => c !== f.node);
      to.node.children = to.node.children ?? [];
      f.node.name = uniqueSibling(to.node, f.node.name);
      to.node.children.splice(typeof op.index === 'number' ? Math.max(0, Math.min(to.node.children.length, Math.round(op.index))) : to.node.children.length, 0, f.node);
      return `moved "${f.node.name}" under ${pathOfNode(scene, to.node)}`;
    }
    case 'duplicate_node': {
      const scene = sceneOf(game, op); const f = needNode(scene, op.node);
      if (!f.parent) throw new Error('the root node cannot be duplicated');
      const copy = structuredClone(f.node);
      copy.name = uniqueSibling(f.parent, cleanNodeName(op.name, f.node.name));
      f.parent.children!.splice(f.index + 1, 0, copy);
      return `duplicated "${f.node.name}" as "${copy.name}"`;
    }
    case 'add_scene': {
      const name = String(op.name);
      if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(name)) throw new Error('a scene name uses letters, digits, _ - /');
      if (game.scenes[name]) throw new Error(`scene "${name}" already exists`);
      const type = typeof op.rootType === 'string' && NODE_TYPES[op.rootType] ? op.rootType : 'Node3D';
      game.scenes[name] = { name, root: { name: cleanNodeName(op.rootName, name.split('/').pop() ?? type), type }, connections: [] };
      return `added scene "${name}"`;
    }
    case 'remove_scene': {
      const name = String(op.name);
      if (!game.scenes[name]) throw new Error(`no scene "${name}"`);
      if (Object.keys(game.scenes).length === 1) throw new Error('a game needs at least one scene');
      delete game.scenes[name];
      for (const s of Object.values(game.scenes)) walkNodes(s.root, (n) => { if (n.instance === name) { delete n.instance; } });
      if (game.settings.mainScene === name) game.settings.mainScene = Object.keys(game.scenes)[0];
      return `removed scene "${name}"`;
    }
    case 'rename_scene': {
      const from = String(op.name), to = String(op.to);
      if (!game.scenes[from]) throw new Error(`no scene "${from}"`);
      if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(to) || game.scenes[to]) throw new Error(`"${to}" is not a free scene name`);
      const entries = Object.entries(game.scenes).map(([k, v]) => (k === from ? [to, { ...v, name: to }] as const : ([k, v] as const)));
      game.scenes = Object.fromEntries(entries);
      for (const s of Object.values(game.scenes)) walkNodes(s.root, (n) => { if (n.instance === from) n.instance = to; });
      if (game.settings.mainScene === from) game.settings.mainScene = to;
      return `renamed scene "${from}" to "${to}"`;
    }
    case 'set_main_scene': { const name = String(op.name); if (!game.scenes[name]) throw new Error(`no scene "${name}"`); game.settings.mainScene = name; return `main scene is "${name}"`; }
    case 'set_script': { const existed = !!game.scripts[String(op.path)]; game.scripts[String(op.path)] = { code: String(op.code) }; return `${existed ? 'updated' : 'created'} script ${String(op.path)} (${String(op.code).split('\n').length} lines)`; }
    case 'remove_script': {
      const path = String(op.path);
      if (!game.scripts[path]) throw new Error(`no script "${path}"`);
      delete game.scripts[path];
      for (const s of Object.values(game.scenes)) walkNodes(s.root, (n) => { if (n.script === path) delete n.script; });
      game.settings.autoloads = game.settings.autoloads.filter((a) => a.script !== path);
      return `removed script ${path}`;
    }
    case 'rename_script': {
      const from = String(op.path), to = String(op.to);
      if (!game.scripts[from]) throw new Error(`no script "${from}"`);
      if (game.scripts[to]) throw new Error(`script "${to}" already exists`);
      game.scripts[to] = game.scripts[from]; delete game.scripts[from];
      for (const s of Object.values(game.scenes)) walkNodes(s.root, (n) => { if (n.script === from) n.script = to; });
      for (const a of game.settings.autoloads) if (a.script === from) a.script = to;
      return `renamed script ${from} to ${to}`;
    }
    case 'connect': case 'disconnect': {
      const scene = sceneOf(game, op);
      needNode(scene, op.from, 'source node'); needNode(scene, op.to, 'target node');
      const same = (c: Connection): boolean => c.from === String(op.from) && c.signal === String(op.signal) && c.to === String(op.to) && c.method === String(op.method);
      if (op.op === 'disconnect') { scene.connections = scene.connections.filter((c) => !same(c)); return `disconnected ${String(op.from)}.${String(op.signal)}`; }
      if (!scene.connections.some(same)) scene.connections.push({ from: String(op.from), signal: String(op.signal), to: String(op.to), method: String(op.method) });
      return `connected ${String(op.from)}.${String(op.signal)} → ${String(op.to)}.${String(op.method)}()`;
    }
    case 'settings': {
      const s = game.settings;
      if (typeof op.title === 'string' && op.title.trim()) game.title = op.title.trim().slice(0, 80);
      if (op.width !== undefined) s.width = Math.round(clampN(op.width, s.width, 64, 7680));
      if (op.height !== undefined) s.height = Math.round(clampN(op.height, s.height, 64, 4320));
      if (isHex(op.background)) s.background = op.background;
      if (op.gravity3d !== undefined) s.gravity3d = clampN(op.gravity3d, s.gravity3d, 0, 1000);
      if (op.gravity2d !== undefined) s.gravity2d = clampN(op.gravity2d, s.gravity2d, 0, 100000);
      return `project settings updated (${s.width}×${s.height})`;
    }
    case 'input_action': {
      const name = String(op.name);
      if (!/^[A-Za-z0-9_]{1,40}$/.test(name)) throw new Error('an action name uses letters, digits and _');
      game.settings.inputMap[name] = (op.keys as string[]).slice(0, 12);
      return `action "${name}" = ${game.settings.inputMap[name].join(', ')}`;
    }
    case 'remove_action': { const name = String(op.name); if (!game.settings.inputMap[name]) throw new Error(`no action "${name}"`); delete game.settings.inputMap[name]; return `removed action "${name}"`; }
    case 'autoload': {
      const name = cleanNodeName(op.name, 'Autoload'); const script = String(op.script);
      if (!scriptPathOk(script) || !game.scripts[script]) throw new Error(`script "${script}" does not exist — create it with set_script first`);
      game.settings.autoloads = [...game.settings.autoloads.filter((a) => a.name !== name), { name, script }];
      return `autoload "${name}" → ${script}`;
    }
    case 'remove_autoload': { const name = String(op.name); game.settings.autoloads = game.settings.autoloads.filter((a) => a.name !== name); return `removed autoload "${name}"`; }
    case 'animation': {
      const scene = sceneOf(game, op); const f = needNode(scene, op.node);
      if (f.node.type !== 'AnimationPlayer') throw new Error(`"${f.node.name}" is a ${f.node.type}, not an AnimationPlayer`);
      const tracks = (op.tracks as Array<Record<string, unknown>>).map((t) => {
        if (!t || typeof t.property !== 'string' || !Array.isArray(t.keys) || t.keys.length === 0) throw new Error('every track needs a property and at least one key {t, v}');
        return {
          node: typeof t.node === 'string' ? t.node : '', property: t.property, interp: t.interp === 'step' ? 'step' : undefined, trans: typeof t.trans === 'string' ? t.trans : undefined, ease: typeof t.ease === 'string' ? t.ease : undefined,
          keys: (t.keys as Array<Record<string, unknown>>).map((k) => ({ t: clampN(k.t, 0, 0, 3600), v: k.v })).sort((a, b) => a.t - b.t),
        };
      });
      const anims = { ...((f.node.props?.animations as Record<string, unknown>) ?? {}) };
      anims[String(op.name)] = { length: clampN(op.length, 1, 0.01, 3600), loop: op.loop === true, tracks };
      f.node.props = { ...(f.node.props ?? {}), animations: anims };
      return `animation "${String(op.name)}" on "${f.node.name}" (${tracks.length} track${tracks.length === 1 ? '' : 's'})`;
    }
    default: throw new Error(`unknown op "${String(op.op)}"`);
  }
}

export function applyGameOps(game: Game, ops: GameOp[]): { log: string[]; error?: string } {
  const log: string[] = [];
  for (const [i, op] of ops.entries()) {
    try { log.push(`✓ ${op.op}: ${applyGameOp(game, op)}`); } catch (e) { return { log, error: `op ${i + 1} (${op.op}): ${e instanceof Error ? e.message : String(e)}` }; }
  }
  return { log };
}

/* ---------- review and summary ---------- */

export interface GameIssue { severity: 'error' | 'warn' | 'info'; message: string }

export function checkGame(game: Game): GameIssue[] {
  const issues: GameIssue[] = [];
  const add = (severity: GameIssue['severity'], message: string): void => { issues.push({ severity, message }); };
  const main = game.scenes[game.settings.mainScene];
  if (!main) add('error', `The main scene "${game.settings.mainScene}" does not exist.`);
  const usedScripts = new Set<string>();
  for (const scene of Object.values(game.scenes)) {
    let hasCamera = false, hasLight = false, has3d = false;
    walkNodes(scene.root, (n, path) => {
      if (n.type.startsWith('Camera')) hasCamera = true;
      if (n.type.endsWith('Light3D') || n.type === 'WorldEnvironment') hasLight = true;
      if (inherits(n.type, 'Node3D')) has3d = true;
      if (n.instance && !game.scenes[n.instance]) add('error', `${scene.name}: "${path}" instances the missing scene "${n.instance}".`);
      if (n.script) {
        usedScripts.add(n.script);
        const sc = game.scripts[n.script];
        if (!sc) add('error', `${scene.name}: "${path}" uses the missing script ${n.script}.`);
        else {
          const base = scriptBase(sc.code);
          if (!base) add('warn', `${n.script} has no "export default class … extends ${n.type}" — it will not be attached.`);
          else if (NODE_TYPES[base] && !inherits(n.type, base)) add('error', `${n.script} extends ${base} but is attached to a ${n.type} ("${path}").`);
          else if (NODE_TYPES[base] && !inherits(base, n.type)) add('error', `${n.script} extends ${base}, which is not a ${n.type} ("${path}"): the script's class must extend ${n.type} or a subclass.`);
        }
      }
      if (isBody(n.type) && !(n.children ?? []).some((c) => isShape(c.type)) && !n.instance) add('warn', `${scene.name}: ${n.type} "${path}" has no CollisionShape child, so nothing can collide with it.`);
    });
    if (scene.name === game.settings.mainScene) {
      if (!hasCamera) add('warn', `The main scene "${scene.name}" has no Camera3D or Camera2D; the game uses a default camera.`);
      if (has3d && !hasLight) add('warn', `The main scene "${scene.name}" has no light or WorldEnvironment, so 3D objects look flat or dark.`);
    }
    for (const c of scene.connections) if (!findNode(scene, c.from) || !findNode(scene, c.to)) add('error', `${scene.name}: the connection ${c.from}.${c.signal} → ${c.to}.${c.method} points at a node that does not exist.`);
  }
  for (const a of game.settings.autoloads) { usedScripts.add(a.script); if (!game.scripts[a.script]) add('error', `Autoload "${a.name}" uses the missing script ${a.script}.`); }
  for (const p of Object.keys(game.scripts)) if (!usedScripts.has(p) && !Object.values(game.scripts).some((o) => o !== game.scripts[p] && new RegExp(`['"]\\.{0,2}/?${p.replace(/^scripts\//, '').replace(/\.(ts|js)$/, '')}['"]`).test(o.code))) add('info', `The script ${p} is not used by any node or autoload.`);
  return issues.filter((i) => i.message);
}

export function summarizeGame(game: Game): string {
  const s = game.settings;
  const lines = [`"${game.title}" — ${s.width}×${s.height}, main scene "${s.mainScene}", ${Object.keys(game.scenes).length} scene(s), ${Object.keys(game.scripts).length} script(s), gravity ${s.gravity3d} (3D) / ${s.gravity2d} (2D).`];
  lines.push(`Input actions: ${Object.entries(s.inputMap).map(([a, k]) => `${a}=${k.join('/')}`).join(', ') || 'none'}.`);
  if (s.autoloads.length) lines.push(`Autoloads: ${s.autoloads.map((a) => `${a.name} (${a.script})`).join(', ')}.`);
  for (const scene of Object.values(game.scenes)) {
    lines.push(`\nScene "${scene.name}"${scene.name === s.mainScene ? ' (main)' : ''} — ${countNodes(scene)} nodes:`);
    walkNodes(scene.root, (n, path, depth) => {
      const bits: string[] = [];
      for (const [k, v] of Object.entries(n.props ?? {})) bits.push(`${k}=${k === 'animations' ? `${Object.keys(v as object).length} anim` : k === 'texture' ? '…' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      if (n.script) bits.push(`script ${n.script}`);
      if (n.exports && Object.keys(n.exports).length) bits.push(`exports ${JSON.stringify(n.exports)}`);
      if (n.groups?.length) bits.push(`groups ${n.groups.join('/')}`);
      if (n.instance) bits.push(`instance of "${n.instance}"`);
      lines.push(`${'  '.repeat(depth)}- ${depth === 0 ? '.' : n.name} [${n.type}]${bits.length ? ' ' + bits.join('; ') : ''}${depth > 0 ? `  (path ${path})` : ''}`);
    });
    for (const c of scene.connections) lines.push(`  signal: ${c.from}.${c.signal} → ${c.to}.${c.method}()`);
  }
  return lines.join('\n');
}
