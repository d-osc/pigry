/* Godot-style game engine runtime on three.js: a scene tree of nodes with scripts, signals, groups, physics, input,
 * animation, tweens, UI controls and scene instancing. Plain ES module with no imports: three.js is passed in, so the
 * same file runs in the editor (edit mode), in a sandboxed iframe (play mode, standalone exports) and in node tests
 * (headless). Units: 3D in metres (+Y up, gravity 9.8), 2D in pixels with +Y UP (unlike Godot, whose 2D y axis points down). */

/* eslint-disable @typescript-eslint/no-this-alias */
export const API_VERSION = 1;

/* ---------- small helpers ---------- */

const EASE = {
  linear: (t) => t,
  sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  quart: (t) => t ** 4,
  expo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  circ: (t) => 1 - Math.sqrt(1 - t * t),
  back: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
  elastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  bounce: (t) => { const u = 1 - t; const n = 7.5625, d = 2.75; let v; if (u < 1 / d) v = n * u * u; else if (u < 2 / d) { const x = u - 1.5 / d; v = n * x * x + 0.75; } else if (u < 2.5 / d) { const x = u - 2.25 / d; v = n * x * x + 0.9375; } else { const x = u - 2.625 / d; v = n * x * x + 0.984375; } return 1 - v; },
};

/** `ease`: "in" | "out" | "inout" (out is the default for UI-style motion); `trans`: a key of EASE. */
export function ease(t, trans = 'linear', mode = 'out') {
  const f = EASE[trans] ?? EASE.linear;
  const x = Math.min(1, Math.max(0, t));
  if (mode === 'in') return f(x);
  if (mode === 'out') return 1 - f(1 - x);
  return x < 0.5 ? f(x * 2) / 2 : 1 - f((1 - x) * 2) / 2;
}

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const isArr = (v) => Array.isArray(v);
const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v && typeof v === 'object') {
    if ('x' in v && 'y' in v && typeof v.x === 'number') return `(${[v.x, v.y, v.z].filter((n) => n !== undefined).map((n) => Math.round(n * 1000) / 1000).join(', ')})`;
    if (v.constructor && v.constructor.nodeType) return `<${v.constructor.nodeType}:${v.name}>`;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

/** Splits "position:y" / "position.y" into ["position", "y"]. */
const splitProp = (p) => String(p).split(/[:.]/);

/* ---------- the engine ---------- */

export function createEngine(THREE, options = {}) {
  const { Vector2, Vector3, Euler, Quaternion, Color, MathUtils, Matrix4 } = THREE;
  const hasDom = typeof document !== 'undefined';

  const engine = {
    THREE, mode: options.mode ?? 'play', game: null, tree: null, time: 0, frame: 0, paused: false, timeScale: 1,
    physicsDelta: 1 / 60, gravity3d: 9.8, gravity2d: 980, logs: [], errors: [], quit: false, debugShapes: !!options.debugShapes,
    scriptClasses: new Map(), scriptSources: new Map(), scriptModules: new Map(), scenes: new Map(), threeScene: new THREE.Scene(),
    renderer: null, ui: null, size: { w: 1152, h: 648 }, fps: 0,
  };
  const isEdit = () => engine.mode === 'edit';

  const log = (level, args) => {
    const text = args.map(fmt).join(' ');
    engine.logs.push({ level, text });
    if (engine.logs.length > 2000) engine.logs.shift();
    options.onLog?.(level, text);
  };
  const print = (...args) => log('log', args);
  const printErr = (...args) => { log('error', args); engine.errors.push(args.map(fmt).join(' ')); };
  const guard = (where, fn) => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => printErr(`${where}: ${e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e}`));
      return r;
    } catch (e) { printErr(`${where}: ${e && e.message ? e.message : e}`); return undefined; }
  };

  /* ---------- Node ---------- */

  class Node {
    static nodeType = 'Node';
    constructor(name) {
      this.name = name || this.constructor.nodeType;
      this.parent = null;
      this.children = [];
      this.groups = new Set();
      this.tree = null;
      this.scenePath = null;
      this._sig = new Map();
      this._ready = false;
      this._freed = false;
      this.processMode = 'inherit';
    }
    get type() { return this.constructor.nodeType; }
    get nodeType() { return this.constructor.nodeType; }

    /* signals */
    connect(signal, fn) { if (!this._sig.has(signal)) this._sig.set(signal, []); this._sig.get(signal).push(fn); return this; }
    disconnect(signal, fn) { const l = this._sig.get(signal); if (l) this._sig.set(signal, fn ? l.filter((f) => f !== fn) : []); }
    isConnected(signal, fn) { return (this._sig.get(signal) ?? []).includes(fn); }
    emitSignal(signal, ...args) { for (const fn of [...(this._sig.get(signal) ?? [])]) guard(`signal ${this.name}.${signal}`, () => fn(...args)); }

    /* tree */
    addChild(child, options2) {
      if (child.parent) child.parent.removeChild(child);
      child.parent = this;
      this.children.push(child);
      if (options2?.name) child.name = options2.name;
      this._uniqueName(child);
      if (this.tree) child._enterTree(this.tree);
      return child;
    }
    _uniqueName(child) {
      const base = child.name.replace(/\d+$/, '');
      let n = 2, name = child.name;
      while (this.children.some((c) => c !== child && c.name === name)) name = `${base || child.name}${n++}`;
      child.name = name;
    }
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i < 0) return;
      if (child.tree) child._exitTree();
      this.children.splice(i, 1);
      child.parent = null;
    }
    getChildren() { return [...this.children]; }
    getChild(i) { return this.children[i < 0 ? this.children.length + i : i] ?? null; }
    getChildCount() { return this.children.length; }
    findChild(name, recursive = true) {
      for (const c of this.children) { if (c.name === name) return c; if (recursive) { const r = c.findChild(name, true); if (r) return r; } }
      return null;
    }
    getNodeOrNull(path) {
      let node = this;
      const parts = String(path).split('/');
      if (String(path).startsWith('/')) { node = this.tree ? this.tree.root : this; parts.shift(); if (parts[0] === 'root') parts.shift(); }
      for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') { node = node.parent; if (!node) return null; continue; }
        if (part.startsWith('%')) { node = node.findChild(part.slice(1), true); if (!node) return null; continue; }
        node = node.children.find((c) => c.name === part);
        if (!node) return null;
      }
      return node;
    }
    getNode(path) {
      const n = this.getNodeOrNull(path);
      if (!n) throw new Error(`Node not found: "${path}" (relative to ${this.getPath()})`);
      return n;
    }
    getParent() { return this.parent; }
    getPath() { const parts = []; for (let n = this; n; n = n.parent) parts.unshift(n.name); return `/${parts.join('/')}`; }
    getTree() { return this.tree; }
    isInsideTree() { return !!this.tree; }
    addToGroup(g) { this.groups.add(g); }
    removeFromGroup(g) { this.groups.delete(g); }
    isInGroup(g) { return this.groups.has(g); }
    reparent(newParent) { newParent.addChild(this); }
    queueFree() { if (!this._freed) { this._freed = true; engine.tree?.freeQueue.add(this); } }
    isQueuedForDeletion() { return this._freed; }
    duplicate() {
      const copy = new this.constructor(this.name);
      for (const key of Object.keys(this)) {
        if (['parent', 'children', 'tree', '_sig', '_ready', '_freed', 'object3d', 'el', 'groups'].includes(key)) continue;
        const v = this[key];
        copy[key] = v && typeof v.clone === 'function' ? v.clone() : v && typeof v === 'object' && !isArr(v) ? { ...v } : isArr(v) ? [...v] : v;
      }
      for (const g of this.groups) copy.groups.add(g);
      for (const c of this.children) copy.addChild(c.duplicate());
      return copy;
    }
    createTween() { const t = new Tween(this); engine.tweens.push(t); return t; }
    *walk() { yield this; for (const c of this.children) yield* c.walk(); }

    _enterTree(tree) {
      this.tree = tree;
      this._attachVisual();
      this._registered();
      if (!isEdit()) guard(`${this.name}.enterTree`, () => this.enterTree?.());
      for (const c of [...this.children]) c._enterTree(tree);
      if (!this._ready) {
        this._ready = true;
        this._onReady();
        if (!isEdit()) guard(`${this.name}.ready`, () => this.ready?.());
      }
    }
    _exitTree() {
      for (const c of [...this.children]) c._exitTree();
      if (!isEdit()) guard(`${this.name}.exitTree`, () => this.exitTree?.());
      this._unregistered();
      this._detachVisual();
      this.tree = null;
    }
    _registered() {}
    _unregistered() {}
    _onReady() {}
    _attachVisual() {}
    _detachVisual() {}
    setProp(key, value) { this[key] = value; }
    applyProps(props) { for (const [k, v] of Object.entries(props ?? {})) this.setProp(k, v); }
    _visualHost() {
      for (let n = this.parent; n; n = n.parent) if (n.object3d) return n.object3d;
      return engine.threeScene;
    }
  }

  /* ---------- Node3D and friends ---------- */

  class Node3D extends Node {
    static nodeType = 'Node3D';
    constructor(name) { super(name); this.object3d = new THREE.Group(); this.object3d.userData.node = this; this.object3d.name = this.name; }
    get position() { return this.object3d.position; }
    set position(v) { this.object3d.position.copy(v); }
    get rotation() { return this.object3d.rotation; }
    set rotation(v) { this.object3d.rotation.set(v.x, v.y, v.z); }
    get scale() { return this.object3d.scale; }
    set scale(v) { this.object3d.scale.copy(v); }
    get rotationDegrees() { const r = this.object3d.rotation; return new Vector3(deg(r.x), deg(r.y), deg(r.z)); }
    set rotationDegrees(v) { this.object3d.rotation.set(rad(v.x), rad(v.y), rad(v.z)); }
    get visible() { return this.object3d.visible; }
    set visible(v) { this.object3d.visible = !!v; }
    get globalPosition() { this.object3d.updateWorldMatrix(true, false); return new Vector3().setFromMatrixPosition(this.object3d.matrixWorld); }
    set globalPosition(v) { const parent = this.object3d.parent; const l = parent ? parent.worldToLocal(v.clone()) : v.clone(); this.object3d.position.copy(l); }
    forward() { return new Vector3(0, 0, -1).applyQuaternion(this.object3d.quaternion); }
    right() { return new Vector3(1, 0, 0).applyQuaternion(this.object3d.quaternion); }
    up() { return new Vector3(0, 1, 0).applyQuaternion(this.object3d.quaternion); }
    translate(v) { this.object3d.position.add(v.clone().applyQuaternion(this.object3d.quaternion)); }
    rotateX(a) { this.object3d.rotateX(a); }
    rotateY(a) { this.object3d.rotateY(a); }
    rotateZ(a) { this.object3d.rotateZ(a); }
    /** Turns the node so that its forward (-Z) points at `target` (a Vector3 in world space). */
    lookAt(target) {
      const m = new Matrix4().lookAt(this.globalPosition, target, new Vector3(0, 1, 0));
      this.object3d.quaternion.setFromRotationMatrix(m);
    }
    _attachVisual() { this._visualHost().add(this.object3d); this.object3d.name = this.name; }
    _detachVisual() { this.object3d.removeFromParent(); }
    setProp(key, value) {
      if (key === 'position' && isArr(value)) this.object3d.position.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
      else if (key === 'rotation' && isArr(value)) this.object3d.rotation.set(rad(value[0] ?? 0), rad(value[1] ?? 0), rad(value[2] ?? 0));
      else if (key === 'scale' && isArr(value)) this.object3d.scale.set(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1);
      else if (key === 'visible') this.object3d.visible = !!value;
      else super.setProp(key, value);
    }
  }
  class Marker3D extends Node3D { static nodeType = 'Marker3D'; }

  const color = (v, fallback = '#cccccc') => new Color(typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback);

  /** Unit meshes scaled by `size`: box 1×1×1, sphere/cylinder/cone/capsule of diameter 1 and height 1, torus, horizontal plane. */
  function makeUnitGeometry(kind) {
    switch (kind) {
      case 'sphere': return new THREE.SphereGeometry(0.5, 32, 16);
      case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
      case 'cone': return new THREE.ConeGeometry(0.5, 1, 32);
      case 'capsule': return new THREE.CapsuleGeometry(0.25, 0.5, 4, 16);
      case 'torus': return new THREE.TorusGeometry(0.35, 0.15, 12, 32);
      case 'plane': { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; }
      default: return new THREE.BoxGeometry(1, 1, 1);
    }
  }

  class MeshInstance3D extends Node3D {
    static nodeType = 'MeshInstance3D';
    constructor(name) {
      super(name);
      this.mesh = 'box'; this.size = new Vector3(1, 1, 1); this.material = { color: '#cccccc', metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 0, opacity: 1, wireframe: false, flatShading: false };
      this.castShadow = true;
      this._three = null;
      this._build();
    }
    _build() {
      if (this._three) { this._three.geometry.dispose(); this._three.material.dispose(); this.object3d.remove(this._three); }
      const m = this.material;
      const mat = new THREE.MeshStandardMaterial({ color: color(m.color), metalness: m.metalness, roughness: m.roughness, emissive: color(m.emissive, '#000000'), emissiveIntensity: m.emissiveIntensity, opacity: m.opacity, transparent: m.opacity < 1, wireframe: !!m.wireframe, flatShading: !!m.flatShading, side: this.mesh === 'plane' ? THREE.DoubleSide : THREE.FrontSide });
      const mesh = new THREE.Mesh(makeUnitGeometry(this.mesh), mat);
      mesh.scale.copy(this.size);
      mesh.castShadow = this.castShadow; mesh.receiveShadow = true;
      mesh.userData.node = this;
      this.object3d.add(mesh);
      this._three = mesh;
    }
    setColor(hex) { this.material.color = hex; this._three.material.color.set(color(hex)); }
    setProp(key, value) {
      if (key === 'mesh') { this.mesh = value; this._build(); }
      else if (key === 'size') { this.size = isArr(value) ? new Vector3(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1) : value; this._three.scale.copy(this.size); }
      else if (key === 'material') { this.material = { ...this.material, ...value }; this._build(); }
      else if (key === 'castShadow') { this.castShadow = !!value; this._three.castShadow = this.castShadow; }
      else super.setProp(key, value);
    }
  }

  class Camera3D extends Node3D {
    static nodeType = 'Camera3D';
    constructor(name) { super(name); this.fov = 60; this.near = 0.05; this.far = 1000; this.current = false; this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 1000); this.object3d.add(this.camera); }
    makeCurrent() { this.current = true; if (this.tree) for (const n of this.tree.root.walk()) if (n !== this && n instanceof Camera3D) n.current = false; }
    setProp(key, value) { if (key === 'fov' || key === 'near' || key === 'far') { this[key] = value; this.camera[key] = value; this.camera.updateProjectionMatrix(); } else super.setProp(key, value); }
    project(world) { const v = world.clone().project(this.camera); return new Vector2(((v.x + 1) / 2) * engine.size.w, ((1 - v.y) / 2) * engine.size.h); }
  }

  class Light3D extends Node3D {
    constructor(name) { super(name); this.color = '#ffffff'; this.energy = 1; this.shadow = true; this.light = null; }
    _make() { return null; }
    _init() { this.light = this._make(); this.light.castShadow = !!this.shadow; this.object3d.add(this.light); }
    setProp(key, value) {
      if (key === 'color') { this.color = value; this.light?.color.set(color(value)); }
      else if (key === 'energy') { this.energy = value; if (this.light) this.light.intensity = value; }
      else if (key === 'shadow') { this.shadow = !!value; if (this.light) this.light.castShadow = this.shadow; }
      else super.setProp(key, value);
    }
  }
  class DirectionalLight3D extends Light3D {
    static nodeType = 'DirectionalLight3D';
    constructor(name) { super(name); this.energy = 3; this._init(); this.target = new THREE.Object3D(); this.target.position.set(0, 0, -1); this.object3d.add(this.target); this.light.target = this.target; }
    _make() { const l = new THREE.DirectionalLight('#ffffff', 3); l.shadow.mapSize.set(1024, 1024); l.shadow.bias = -0.0005; const c = l.shadow.camera; c.left = -20; c.right = 20; c.top = 20; c.bottom = -20; c.near = 0.5; c.far = 80; return l; }
  }
  class OmniLight3D extends Light3D {
    static nodeType = 'OmniLight3D';
    constructor(name) { super(name); this.energy = 30; this.range = 0; this.shadow = false; this._init(); this.light.intensity = 30; }
    _make() { return new THREE.PointLight('#ffffff', 30, 0, 2); }
    setProp(key, value) { if (key === 'range') { this.range = value; this.light.distance = value; } else super.setProp(key, value); }
  }
  class SpotLight3D extends Light3D {
    static nodeType = 'SpotLight3D';
    constructor(name) { super(name); this.energy = 60; this.range = 0; this.spotAngle = 45; this._init(); this.light.intensity = 60; this.target = new THREE.Object3D(); this.target.position.set(0, 0, -1); this.object3d.add(this.target); this.light.target = this.target; }
    _make() { return new THREE.SpotLight('#ffffff', 60, 0, rad(45), 0.3, 2); }
    setProp(key, value) { if (key === 'range') { this.range = value; this.light.distance = value; } else if (key === 'spotAngle') { this.spotAngle = value; this.light.angle = rad(value); } else super.setProp(key, value); }
  }
  class WorldEnvironment extends Node {
    static nodeType = 'WorldEnvironment';
    constructor(name) { super(name); this.background = '#2b2f36'; this.ambient = 0.4; this.fog = false; this.fogDensity = 0.02; this._amb = new THREE.AmbientLight('#ffffff', 0.4); }
    _attachVisual() { engine.threeScene.add(this._amb); this._apply(); }
    _detachVisual() { engine.threeScene.remove(this._amb); }
    _apply() {
      engine.threeScene.background = color(this.background, '#2b2f36');
      this._amb.intensity = this.ambient;
      engine.threeScene.fog = this.fog ? new THREE.FogExp2(color(this.background), this.fogDensity) : null;
    }
    setProp(key, value) { this[key] = value; if (this.tree) this._apply(); }
  }

  /* ---------- Node2D family (y up, units are pixels) ---------- */

  class Node2D extends Node {
    static nodeType = 'Node2D';
    constructor(name) { super(name); this.object3d = new THREE.Group(); this.object3d.userData.node = this; this.position = new Vector2(); this.rotation = 0; this.scale = new Vector2(1, 1); this.visible = true; this.zIndex = 0; }
    get rotationDegrees() { return deg(this.rotation); }
    set rotationDegrees(d) { this.rotation = rad(d); }
    get globalPosition() { this.syncTransform(); this.object3d.updateWorldMatrix(true, false); const v = new Vector3().setFromMatrixPosition(this.object3d.matrixWorld); return new Vector2(v.x, v.y); }
    set globalPosition(v) { const parent = this.parent; if (parent instanceof Node2D) { const p = parent.globalPosition; this.position.set(v.x - p.x, v.y - p.y); } else this.position.copy(v); }
    syncTransform() { const o = this.object3d; o.position.set(this.position.x, this.position.y, this.zIndex * 0.01); o.rotation.set(0, 0, this.rotation); o.scale.set(this.scale.x, this.scale.y, 1); o.visible = this.visible; }
    translate(v) { this.position.x += v.x * Math.cos(this.rotation) - v.y * Math.sin(this.rotation); this.position.y += v.x * Math.sin(this.rotation) + v.y * Math.cos(this.rotation); }
    lookAt(p) { const g = this.globalPosition; this.rotation = Math.atan2(p.y - g.y, p.x - g.x); }
    _attachVisual() { this._visualHost().add(this.object3d); this.syncTransform(); }
    _detachVisual() { this.object3d.removeFromParent(); }
    setProp(key, value) {
      if (key === 'position' && isArr(value)) this.position.set(value[0] ?? 0, value[1] ?? 0);
      else if (key === 'rotation') this.rotation = rad(value ?? 0);
      else if (key === 'scale' && isArr(value)) this.scale.set(value[0] ?? 1, value[1] ?? 1);
      else super.setProp(key, value);
    }
  }
  class Marker2D extends Node2D { static nodeType = 'Marker2D'; }

  class Sprite2D extends Node2D {
    static nodeType = 'Sprite2D';
    constructor(name) { super(name); this.shape = 'rect'; this.size = new Vector2(64, 64); this.color = '#ffffff'; this.texture = null; this._three = null; this._build(); }
    _build() {
      if (this._three) { this._three.geometry.dispose(); this._three.material.dispose(); this.object3d.remove(this._three); this._three = null; }
      const geo = this.shape === 'circle' ? new THREE.CircleGeometry(0.5, 32) : this.shape === 'triangle' ? new THREE.CircleGeometry(0.5, 3) : new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({ color: color(this.color, '#ffffff'), transparent: true, side: THREE.DoubleSide });
      if (this.texture && hasDom && typeof Image !== 'undefined') {
        const img = new Image();
        img.onload = () => { const t = new THREE.Texture(img); t.needsUpdate = true; t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; mat.map = t; mat.needsUpdate = true; };
        img.src = this.texture;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(this.size.x, this.size.y, 1);
      mesh.userData.node = this;
      this.object3d.add(mesh);
      this._three = mesh;
    }
    setProp(key, value) {
      if (key === 'size') { this.size = isArr(value) ? new Vector2(value[0] ?? 64, value[1] ?? 64) : value; this._three?.scale.set(this.size.x, this.size.y, 1); }
      else if (key === 'shape' || key === 'texture') { this[key] = value; this._build(); }
      else if (key === 'color') { this.color = value; this._three?.material.color.set(color(value, '#ffffff')); }
      else super.setProp(key, value);
    }
  }

  class Camera2D extends Node2D {
    static nodeType = 'Camera2D';
    constructor(name) { super(name); this.zoom = 1; this.current = true; this.camera = new THREE.OrthographicCamera(-576, 576, 324, -324, -1000, 1000); }
    makeCurrent() { this.current = true; if (this.tree) for (const n of this.tree.root.walk()) if (n !== this && n instanceof Camera2D) n.current = false; }
    _fit() { const { w, h } = engine.size; const z = this.zoom || 1; this.camera.left = -w / 2 / z; this.camera.right = w / 2 / z; this.camera.top = h / 2 / z; this.camera.bottom = -h / 2 / z; this.camera.updateProjectionMatrix(); }
    syncTransform() { super.syncTransform(); const g = this.object3d; this.camera.position.set(0, 0, 10); g.add(this.camera); this._fit(); }
  }

  /* ---------- UI controls (DOM overlay) ---------- */

  const ANCHORS = {
    top_left: ['left', 'top'], top_right: ['right', 'top'], bottom_left: ['left', 'bottom'], bottom_right: ['right', 'bottom'], top_center: ['center', 'top'], bottom_center: ['center', 'bottom'],
    center_left: ['left', 'middle'], center_right: ['right', 'middle'], center: ['center', 'middle'], full_rect: ['full', 'full'],
  };
  class CanvasLayer extends Node { static nodeType = 'CanvasLayer'; constructor(n) { super(n); this.layer = 1; this.visible = true; } }
  class Control extends Node {
    static nodeType = 'Control';
    constructor(name) {
      super(name); this.position = new Vector2(0, 0); this.size = new Vector2(100, 30); this.el = null;
      // Changing these from a script updates the screen at once.
      const values = { anchor: 'top_left', visible: true, color: '#ffffff', text: '', fontSize: 18, align: 'left', value: 0, maxValue: 100 };
      for (const key of Object.keys(values)) Object.defineProperty(this, key, { get: () => values[key], set: (v) => { values[key] = v; this._style(); }, enumerable: true });
    }
    _tag() { return 'div'; }
    _attachVisual() {
      if (!engine.ui || !hasDom) return;
      this.el = document.createElement(this._tag());
      this.el.style.position = 'absolute'; this.el.style.boxSizing = 'border-box'; this.el.dataset.node = this.name;
      let host = engine.ui.root;
      for (let n = this.parent; n; n = n.parent) if (n instanceof Control && n.el) { host = n.el; break; }
      host.appendChild(this.el);
      this._style();
    }
    _detachVisual() { this.el?.remove(); this.el = null; }
    _style() {
      const el = this.el;
      if (!el) return;
      const [h, v] = ANCHORS[this.anchor] ?? ANCHORS.top_left;
      const s = el.style;
      s.left = s.right = s.top = s.bottom = s.width = s.height = s.transform = '';
      if (h === 'full') { s.left = `${this.position.x}px`; s.right = '0'; } else if (h === 'left') s.left = `${this.position.x}px`; else if (h === 'right') s.right = `${-this.position.x}px`; else { s.left = `calc(50% + ${this.position.x}px)`; }
      if (v === 'full') { s.top = `${this.position.y}px`; s.bottom = '0'; } else if (v === 'top') s.top = `${this.position.y}px`; else if (v === 'bottom') s.bottom = `${-this.position.y}px`; else { s.top = `calc(50% + ${this.position.y}px)`; }
      if (h !== 'full') s.width = `${this.size.x}px`;
      if (v !== 'full') s.height = `${this.size.y}px`;
      const tx = h === 'center' ? '-50%' : '0', ty = v === 'middle' ? '-50%' : '0';
      if (tx !== '0' || ty !== '0') s.transform = `translate(${tx}, ${ty})`;
      s.display = this.visible ? '' : 'none';
      s.pointerEvents = 'none';
      this._decorate();
    }
    _decorate() {}
    setProp(key, value) {
      if (key === 'position' && isArr(value)) this.position.set(value[0] ?? 0, value[1] ?? 0);
      else if (key === 'size' && isArr(value)) this.size.set(value[0] ?? 100, value[1] ?? 30);
      else this[key] = value;
      this._style();
    }
    set(prop, v) { this.setProp(prop, v); }
  }
  class Label extends Control {
    static nodeType = 'Label';
    _decorate() { const s = this.el.style; this.el.textContent = String(this.text); s.color = this.color; s.fontSize = `${this.fontSize}px`; s.textAlign = this.align; s.fontFamily = 'system-ui, sans-serif'; s.textShadow = '0 1px 2px rgba(0,0,0,0.5)'; s.whiteSpace = 'pre-wrap'; }
  }
  class ColorRect extends Control {
    static nodeType = 'ColorRect';
    _decorate() { this.el.style.background = this.color; }
  }
  class Button extends Control {
    static nodeType = 'Button';
    _tag() { return 'button'; }
    _attachVisual() { super._attachVisual(); this.el?.addEventListener('click', () => this.emitSignal('pressed')); }
    _decorate() { const s = this.el.style; this.el.textContent = String(this.text); s.pointerEvents = 'auto'; s.background = '#2d333b'; s.color = '#fff'; s.border = '1px solid #556'; s.borderRadius = '6px'; s.fontSize = `${this.fontSize}px`; s.cursor = 'pointer'; }
  }
  class ProgressBar extends Control {
    static nodeType = 'ProgressBar';
    constructor(name) { super(name); this.value = 50; this.maxValue = 100; this.color = '#4fb98a'; }
    _decorate() { const s = this.el.style; s.background = 'rgba(0,0,0,0.45)'; s.border = '1px solid rgba(255,255,255,0.3)'; s.borderRadius = '4px'; s.overflow = 'hidden'; this.el.innerHTML = ''; const f = document.createElement('div'); f.style.cssText = `height:100%;width:${Math.max(0, Math.min(100, (this.value / (this.maxValue || 1)) * 100))}%;background:${this.color}`; this.el.appendChild(f); }
  }

  /* ---------- timers, tweens, animation ---------- */

  class Timer extends Node {
    static nodeType = 'Timer';
    constructor(name) { super(name); this.waitTime = 1; this.oneShot = false; this.autostart = false; this.timeLeft = 0; this.running = false; }
    start(t) { if (t !== undefined) this.waitTime = t; this.timeLeft = this.waitTime; this.running = true; }
    stop() { this.running = false; this.timeLeft = 0; }
    isStopped() { return !this.running; }
    _onReady() { if (this.autostart && !isEdit()) this.start(); }
    _tick(dt) { if (!this.running) return; this.timeLeft -= dt; if (this.timeLeft <= 0) { if (this.oneShot) this.running = false; else this.timeLeft += this.waitTime; this.emitSignal('timeout'); } }
  }

  class Tween {
    constructor(owner) { this.owner = owner; this.steps = []; this.parallel = false; this.loops = 1; this.i = 0; this.t = 0; this.running = true; this.finished = false; this._cb = []; this.transType = 'linear'; this.easeType = 'out'; this._active = []; }
    setTrans(t) { this.transType = t; return this; }
    setEase(e) { this.easeType = e; return this; }
    setParallel(p = true) { this.parallel = p; return this; }
    setLoops(n) { this.loops = n; return this; }
    chain() { this.parallel = false; return this; }
    tweenProperty(obj, prop, to, duration) { const step = { kind: 'prop', obj, path: splitProp(prop), to, duration: Math.max(0.0001, duration), trans: this.transType, ease: this.easeType, from: null }; this.steps.push(step); return this._chainable(step); }
    tweenCallback(fn) { this.steps.push({ kind: 'call', fn, duration: 0 }); return this; }
    tweenInterval(t) { this.steps.push({ kind: 'wait', duration: t }); return this; }
    _chainable(step) { const self = this; return { setTrans(t) { step.trans = t; return this; }, setEase(e) { step.ease = e; return this; }, setDelay(d) { step.delay = d; return this; }, ...bindTween(self) }; }
    kill() { this.running = false; this.finished = true; }
    onFinished(fn) { this._cb.push(fn); return this; }
    _read(step) { let o = step.obj; for (const p of step.path.slice(0, -1)) o = o[p]; return { o, key: step.path[step.path.length - 1] }; }
    _begin(step) {
      if (step.kind !== 'prop') return;
      const { o, key } = this._read(step);
      const v = o[key];
      step.from = typeof v === 'number' ? v : v && typeof v.clone === 'function' ? v.clone() : v;
    }
    _apply(step, k) {
      if (step.kind !== 'prop') return;
      const { o, key } = this._read(step);
      const e = ease(k, step.trans, step.ease), from = step.from;
      if (typeof from === 'number') o[key] = from + (step.to - from) * e;
      else if (from && typeof from.lerpVectors === 'function') o[key].lerpVectors(from, step.to, e);
      else if (from instanceof Color) o[key].lerpColors(from, step.to, e);
      else if (e >= 1) o[key] = step.to;
    }
    update(dt) {
      if (!this.running || this.finished) return;
      if (this.owner && this.owner._freed) { this.kill(); return; }
      const run = this.parallel ? this.steps : [this.steps[this.i]];
      if (!run[0]) { this._finish(); return; }
      this.t += dt;
      let allDone = true;
      for (const step of run) {
        if (step.from === null && step.kind === 'prop') this._begin(step);
        const delay = step.delay ?? 0;
        const k = Math.min(1, Math.max(0, (this.t - delay) / step.duration));
        if (step.kind === 'prop') this._apply(step, k);
        if (step.kind === 'call' && !step.done) { step.done = true; guard('tween callback', () => step.fn()); }
        if (this.t - delay < step.duration) allDone = false;
      }
      if (allDone) {
        if (!this.parallel && this.i < this.steps.length - 1) { this.i++; this.t = 0; return; }
        this.loops--;
        if (this.loops === 0) { this._finish(); return; }
        this.i = 0; this.t = 0;
        for (const s of this.steps) { s.from = null; s.done = false; }
      }
    }
    _finish() { this.finished = true; this.running = false; for (const f of this._cb) guard('tween finished', f); }
  }
  function bindTween(t) {
    return { tweenProperty: (...a) => t.tweenProperty(...a), tweenCallback: (...a) => t.tweenCallback(...a), tweenInterval: (...a) => t.tweenInterval(...a), chain: () => t.chain(), setParallel: (p) => t.setParallel(p), setLoops: (n) => t.setLoops(n), kill: () => t.kill(), onFinished: (f) => t.onFinished(f) };
  }
  engine.tweens = [];

  /** Reads or writes a property by Godot-style path: "position:y", "scale", "material.color". */
  function setByPath(target, path, value) {
    const parts = splitProp(path);
    let o = target;
    for (const p of parts.slice(0, -1)) { o = o[p]; if (o == null) return; }
    const key = parts[parts.length - 1];
    const cur = o[key];
    if (typeof value === 'number' && typeof cur === 'number') o[key] = value;
    else if (isArr(value) && cur && typeof cur.set === 'function' && cur instanceof Color) cur.setRGB(value[0], value[1], value[2]);
    else if (isArr(value) && cur && typeof cur.set === 'function') cur.set(...value);
    else if (typeof value === 'string' && typeof cur === 'string') o[key] = value;
    else if (typeof value === 'string' && target.setProp && parts.length === 1) target.setProp(key, value);
    else o[key] = value;
  }

  class AnimationPlayer extends Node {
    static nodeType = 'AnimationPlayer';
    constructor(name) { super(name); this.animations = {}; this.autoplay = ''; this.speedScale = 1; this.currentAnimation = ''; this.time = 0; this.playing = false; }
    play(name, from = 0) { if (!this.animations[name]) { printErr(`AnimationPlayer ${this.name}: no animation "${name}"`); return; } this.currentAnimation = name; this.time = from; this.playing = true; this.apply(); }
    stop() { this.playing = false; this.time = 0; }
    pause() { this.playing = false; }
    seek(t) { this.time = t; this.apply(); }
    isPlaying() { return this.playing; }
    hasAnimation(n) { return !!this.animations[n]; }
    getAnimationList() { return Object.keys(this.animations); }
    _onReady() { if (this.autoplay && !isEdit()) this.play(this.autoplay); }
    apply() {
      const a = this.animations[this.currentAnimation];
      if (!a || !this.parent) return;
      for (const track of a.tracks ?? []) {
        const node = track.node ? this.parent.getNodeOrNull(track.node) : this.parent;
        if (!node || !track.keys?.length) continue;
        const keys = track.keys;
        let i = keys.findIndex((k) => k.t > this.time);
        let value;
        if (i === -1) value = keys[keys.length - 1].v;
        else if (i === 0) value = keys[0].v;
        else {
          const k0 = keys[i - 1], k1 = keys[i];
          const f = track.interp === 'step' ? 0 : ease((this.time - k0.t) / Math.max(1e-6, k1.t - k0.t), track.trans ?? 'linear', track.ease ?? 'inout');
          value = lerpValue(k0.v, k1.v, f);
        }
        setByPath(node, track.property, value);
      }
    }
    _tick(dt) {
      if (!this.playing) return;
      const a = this.animations[this.currentAnimation];
      if (!a) { this.playing = false; return; }
      this.time += dt * this.speedScale;
      const len = a.length ?? 1;
      if (this.time >= len) {
        if (a.loop) this.time %= len;
        else { this.time = len; this.apply(); this.playing = false; this.emitSignal('animationFinished', this.currentAnimation); return; }
      }
      this.apply();
    }
  }
  function lerpValue(a, b, f) {
    if (typeof a === 'number') return a + (b - a) * f;
    if (isArr(a)) return a.map((x, i) => x + ((b[i] ?? x) - x) * f);
    if (typeof a === 'string' && /^#/.test(a)) { const c = new Color(a).lerp(new Color(b), f); return `#${c.getHexString()}`; }
    return f < 0.5 ? a : b;
  }

  /* ---------- physics ---------- */

  const bodies = new Set();
  const colliders = (body) => body.children.filter((c) => c instanceof CollisionShape3D || c instanceof CollisionShape2D);

  function shapeToWorld(sn) {
    if (sn.disabled) return null;
    sn.object3d.updateWorldMatrix(true, false);
    const c = new Vector3().setFromMatrixPosition(sn.object3d.matrixWorld);
    const s = new Vector3().setFromMatrixScale(sn.object3d.matrixWorld);
    const size = sn.size, is2d = sn instanceof CollisionShape2D;
    if (is2d) {
      c.z = 0;
      if (sn.shape === 'circle') return { kind: 'sphere', c, r: (size.x / 2) * Math.max(Math.abs(s.x), Math.abs(s.y)) };
      return { kind: 'box', c, h: new Vector3((size.x / 2) * Math.abs(s.x), (size.y / 2) * Math.abs(s.y), 1e4) };
    }
    if (sn.shape === 'sphere') return { kind: 'sphere', c, r: (size.x / 2) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) };
    if (sn.shape === 'capsule') return { kind: 'box', c, h: new Vector3((size.x / 2) * Math.abs(s.x), (size.y / 2) * Math.abs(s.y), (size.x / 2) * Math.abs(s.z)) };
    return { kind: 'box', c, h: new Vector3((size.x / 2) * Math.abs(s.x), (size.y / 2) * Math.abs(s.y), (size.z / 2) * Math.abs(s.z)) };
  }
  const bodyShapes = (body) => colliders(body).map(shapeToWorld).filter(Boolean);

  const AXES = ['x', 'y', 'z'];
  function boxBox(a, b) {
    let best = null;
    for (const ax of AXES) {
      const d = a.c[ax] - b.c[ax], pen = a.h[ax] + b.h[ax] - Math.abs(d);
      if (pen <= 0) return null;
      if (!best || pen < best.d) best = { ax, d: pen, sign: d >= 0 ? 1 : -1 };
    }
    const n = new Vector3(); n[best.ax] = best.sign;
    return { n, d: best.d };
  }
  function sphereBox(s, b) {
    const cl = new Vector3(Math.min(b.c.x + b.h.x, Math.max(b.c.x - b.h.x, s.c.x)), Math.min(b.c.y + b.h.y, Math.max(b.c.y - b.h.y, s.c.y)), Math.min(b.c.z + b.h.z, Math.max(b.c.z - b.h.z, s.c.z)));
    const diff = s.c.clone().sub(cl), d2 = diff.lengthSq();
    if (d2 > s.r * s.r) return null;
    if (d2 > 1e-12) { const dist = Math.sqrt(d2); return { n: diff.multiplyScalar(1 / dist), d: s.r - dist }; }
    let best = null;
    for (const ax of AXES) { const dd = s.c[ax] - b.c[ax], pen = b.h[ax] - Math.abs(dd) + s.r; if (!best || pen < best.d) best = { ax, d: pen, sign: dd >= 0 ? 1 : -1 }; }
    const n = new Vector3(); n[best.ax] = best.sign;
    return { n, d: best.d };
  }
  function sphereSphere(a, b) {
    const diff = a.c.clone().sub(b.c), dist = diff.length(), sum = a.r + b.r;
    if (dist >= sum) return null;
    return { n: dist > 1e-9 ? diff.multiplyScalar(1 / dist) : new Vector3(0, 1, 0), d: sum - dist };
  }
  /** Overlap of shape a with shape b: the normal points from b towards a, d is the penetration depth; null when apart. */
  function collide(a, b) {
    if (a.kind === 'box' && b.kind === 'box') return boxBox(a, b);
    if (a.kind === 'sphere' && b.kind === 'box') return sphereBox(a, b);
    if (a.kind === 'box' && b.kind === 'sphere') { const r = sphereBox(b, a); return r ? { n: r.n.negate(), d: r.d } : null; }
    return sphereSphere(a, b);
  }
  function rayShape(origin, dir, maxDist, s) {
    if (s.kind === 'sphere') {
      const oc = origin.clone().sub(s.c), b = oc.dot(dir), c = oc.lengthSq() - s.r * s.r, disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      return t >= 0 && t <= maxDist ? { t, n: origin.clone().addScaledVector(dir, t).sub(s.c).normalize() } : null;
    }
    let tmin = 0, tmax = maxDist, n = new Vector3();
    for (const ax of AXES) {
      const lo = s.c[ax] - s.h[ax], hi = s.c[ax] + s.h[ax], o = origin[ax], d = dir[ax];
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
      let t1 = (lo - o) / d, t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) { tmin = t1; n = new Vector3(); n[ax] = d > 0 ? -1 : 1; }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    return { t: tmin, n };
  }

  const canHit = (a, b) => (a.collisionMask & b.collisionLayer) !== 0;

  function overlaps(body, others) {
    const mine = bodyShapes(body);
    const out = [];
    for (const o of others) {
      if (o === body || o._freed) continue;
      const theirs = bodyShapes(o);
      for (const s of mine) for (const t of theirs) { const c = collide(s, t); if (c) out.push({ collider: o, n: c.n, d: c.d }); }
    }
    return out;
  }
  const solidBodies = () => [...bodies].filter((b) => !(b instanceof Area3D) && !(b instanceof Area2D));

  function moveBody(body, delta) {
    if (body instanceof Node2D) { body.position.x += delta.x; body.position.y += delta.y; body.syncTransform(); }
    else body.object3d.position.add(delta);
  }

  /** Pushes `body` out of everything it overlaps (deepest first). Returns the contacts found. */
  function depenetrate(body, iterations = 4) {
    const contacts = [];
    const pool = solidBodies().filter((o) => o !== body && canHit(body, o));
    for (let it = 0; it < iterations; it++) {
      const hits = overlaps(body, pool);
      if (!hits.length) break;
      hits.sort((a, b) => b.d - a.d);
      const h = hits[0];
      moveBody(body, h.n.clone().multiplyScalar(h.d + 1e-4));
      contacts.push(h);
    }
    return contacts;
  }

  function physicsStep(dt) {
    const rigids = [...bodies].filter((b) => b instanceof RigidBody3D || b instanceof RigidBody2D);
    const solids = solidBodies();
    for (const r of rigids) {
      if (r.sleeping || r._freed) continue;
      const is2d = r instanceof Node2D;
      const g = is2d ? engine.gravity2d : engine.gravity3d;
      r.linearVelocity.y -= g * r.gravityScale * dt;
      r.linearVelocity.multiplyScalar(Math.max(0, 1 - r.linearDamp * dt));
      const v3 = is2d ? new Vector3(r.linearVelocity.x, r.linearVelocity.y, 0) : r.linearVelocity;
      moveBody(r, v3.clone().multiplyScalar(dt));
      for (let it = 0; it < 3; it++) {
        const hits = overlaps(r, solids.filter((o) => o !== r && canHit(r, o)));
        if (!hits.length) break;
        hits.sort((a, b) => b.d - a.d);
        const h = hits[0], other = h.collider, n = h.n;
        const otherRigid = other instanceof RigidBody3D || other instanceof RigidBody2D;
        const share = otherRigid ? r.mass / (r.mass + other.mass) : 1;
        moveBody(r, n.clone().multiplyScalar(h.d * (otherRigid ? 1 - r.mass / (r.mass + other.mass) : 1)));
        if (otherRigid) moveBody(other, n.clone().multiplyScalar(-h.d * share));
        const va = is2d ? new Vector3(r.linearVelocity.x, r.linearVelocity.y, 0) : r.linearVelocity.clone();
        const vb = otherRigid ? (other instanceof Node2D ? new Vector3(other.linearVelocity.x, other.linearVelocity.y, 0) : other.linearVelocity.clone()) : new Vector3();
        const vrel = va.clone().sub(vb).dot(n);
        if (vrel < 0) {
          const e = Math.abs(vrel) > 1.5 ? Math.max(r.bounce, otherRigid ? other.bounce : 0) : 0;
          const invA = 1 / r.mass, invB = otherRigid ? 1 / other.mass : 0;
          const j = (-(1 + e) * vrel) / (invA + invB);
          va.addScaledVector(n, j * invA);
          const tangent = va.clone().addScaledVector(n, -va.dot(n));
          va.addScaledVector(tangent, -Math.min(1, r.friction * dt * 8));
          if (is2d) r.linearVelocity.set(va.x, va.y); else r.linearVelocity.copy(va);
          if (otherRigid) { vb.addScaledVector(n, -j * invB); if (other instanceof Node2D) other.linearVelocity.set(vb.x, vb.y); else other.linearVelocity.copy(vb); }
          if (n.y > 0.7) r._contactFloor = true;
        }
        r.emitSignal('bodyEntered', other);
      }
    }
    for (const a of bodies) {
      if (!(a instanceof Area3D || a instanceof Area2D) || !a.monitoring) continue;
      const now = new Set(overlaps(a, solids.filter((o) => canHit(a, o))).map((h) => h.collider));
      for (const b of now) if (!a._inside.has(b)) { a._inside.add(b); a.emitSignal('bodyEntered', b); b.emitSignal?.('areaEntered', a); }
      for (const b of [...a._inside]) if (!now.has(b)) { a._inside.delete(b); a.emitSignal('bodyExited', b); }
    }
  }

  engine.physics = {
    collide, overlaps, depenetrate,
    /** The first body hit by a ray (Vector3 origin, normalised direction): { collider, position, normal, distance } or null. */
    raycast(origin, direction, maxDistance = 1000, opts = {}) {
      const dir = direction.clone().normalize();
      let best = null;
      for (const b of solidBodies()) {
        if (opts.exclude && (opts.exclude === b || opts.exclude.includes?.(b))) continue;
        if (opts.mask !== undefined && (opts.mask & b.collisionLayer) === 0) continue;
        for (const s of bodyShapes(b)) {
          const h = rayShape(origin, dir, maxDistance, s);
          if (h && (!best || h.t < best.distance)) best = { collider: b, position: origin.clone().addScaledVector(dir, h.t), normal: h.n, distance: h.t };
        }
      }
      return best;
    },
  };

  class CollisionShape3D extends Node3D {
    static nodeType = 'CollisionShape3D';
    constructor(name) { super(name); this.shape = 'box'; this.size = new Vector3(1, 1, 1); this.disabled = false; this._dbg = null; }
    _onReady() { this._debug(); }
    _debug() {
      this._dbg?.removeFromParent();
      if (!engine.debugShapes && !isEdit()) return;
      const g = this.shape === 'sphere' ? new THREE.SphereGeometry(0.5, 16, 10) : this.shape === 'capsule' ? new THREE.CapsuleGeometry(0.25, 0.5, 4, 10) : new THREE.BoxGeometry(1, 1, 1);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#3ecf8e', wireframe: true, transparent: true, opacity: 0.8 }));
      m.scale.copy(this.size); m.userData.helper = true;
      this.object3d.add(m); this._dbg = m;
    }
    setProp(key, value) {
      if (key === 'size') { this.size = isArr(value) ? new Vector3(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1) : value; if (this._dbg) this._dbg.scale.copy(this.size); }
      else if (key === 'shape') { this.shape = value; if (this.tree) this._debug(); }
      else super.setProp(key, value);
    }
  }
  class CollisionShape2D extends Node2D {
    static nodeType = 'CollisionShape2D';
    constructor(name) { super(name); this.shape = 'rect'; this.size = new Vector2(32, 32); this.disabled = false; this._dbg = null; }
    _onReady() { this._debug(); }
    _debug() {
      this._dbg?.removeFromParent();
      if (!engine.debugShapes && !isEdit()) return;
      const g = this.shape === 'circle' ? new THREE.RingGeometry(0.48, 0.5, 32) : new THREE.PlaneGeometry(1, 1);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#3ecf8e', wireframe: this.shape !== 'circle', transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      m.scale.set(this.size.x, this.size.y, 1); m.position.z = 5; m.userData.helper = true;
      this.object3d.add(m); this._dbg = m;
    }
    setProp(key, value) {
      if (key === 'size') { this.size = isArr(value) ? new Vector2(value[0] ?? 32, value[1] ?? 32) : value; this._dbg?.scale.set(this.size.x, this.size.y, 1); }
      else if (key === 'shape') { this.shape = value; if (this.tree) this._debug(); }
      else super.setProp(key, value);
    }
  }

  /** Physics body classes for 3D and 2D share their behaviour through this factory. */
  function makeBodies(Base, d2, suffix) {
    const vec = () => (d2 ? new Vector2() : new Vector3());
    class PhysicsBody extends Base {
      constructor(name) { super(name); this.collisionLayer = 1; this.collisionMask = 1; }
      _registered() { bodies.add(this); }
      _unregistered() { bodies.delete(this); }
      get collisionLayer() { return this._cl ?? 1; }
      set collisionLayer(v) { this._cl = v | 0; }
      get collisionMask() { return this._cm ?? 1; }
      set collisionMask(v) { this._cm = v | 0; }
      setProp(key, value) { if (key === 'collisionLayer' || key === 'collisionMask') this[key] = value; else super.setProp(key, value); }
    }
    class StaticBody extends PhysicsBody { static nodeType = `StaticBody${suffix}`; }
    class RigidBody extends PhysicsBody {
      static nodeType = `RigidBody${suffix}`;
      constructor(name) { super(name); this.mass = 1; this.gravityScale = 1; this.bounce = 0.2; this.friction = 0.4; this.linearDamp = 0.05; this.linearVelocity = vec(); this.sleeping = false; this._contactFloor = false; }
      applyImpulse(v) { this.linearVelocity.addScaledVector(v, 1 / this.mass); }
      applyCentralImpulse(v) { this.applyImpulse(v); }
    }
    class CharacterBody extends PhysicsBody {
      static nodeType = `CharacterBody${suffix}`;
      constructor(name) { super(name); this.velocity = vec(); this.floorMaxAngle = 45; this.floorSnap = d2 ? 6 : 0.12; this._floor = false; this._wall = false; this._ceiling = false; this._slides = []; this._floorNormal = new Vector3(0, 1, 0); }
      isOnFloor() { return this._floor; }
      isOnWall() { return this._wall; }
      isOnCeiling() { return this._ceiling; }
      getFloorNormal() { return this._floorNormal.clone(); }
      getSlideCollisionCount() { return this._slides.length; }
      getSlideCollision(i) { return this._slides[i] ?? null; }
      getGravity() { return d2 ? new Vector2(0, -engine.gravity2d) : new Vector3(0, -engine.gravity3d, 0); }
      /** Moves by `velocity * delta`, slides along what it hits and updates the floor/wall/ceiling flags. Returns true if it moved into something. */
      moveAndSlide() {
        const dt = engine.tree ? engine.tree.physicsDelta : 1 / 60;
        const v = d2 ? new Vector3(this.velocity.x, this.velocity.y, 0) : this.velocity.clone();
        this._floor = this._wall = this._ceiling = false; this._slides = [];
        const shapes = bodyShapes(this);
        const minHalf = shapes.reduce((m, s) => Math.min(m, s.kind === 'box' ? Math.min(s.h.x, s.h.y) : s.r), 1e9);
        const dist = v.length() * dt, steps = Math.max(1, Math.min(16, Math.ceil(dist / Math.max(0.05, minHalf * 0.8))));
        const cosFloor = Math.cos(rad(this.floorMaxAngle));
        const classify = (contacts) => {
          for (const c of contacts) {
            const up = c.n.y;
            this._slides.push({ collider: c.collider, normal: c.n.clone() });
            if (up >= cosFloor) { this._floor = true; this._floorNormal.copy(c.n); } else if (up <= -cosFloor) this._ceiling = true; else this._wall = true;
            const into = v.dot(c.n);
            if (into < 0) v.addScaledVector(c.n, -into);
          }
        };
        for (let s = 0; s < steps; s++) {
          moveBody(this, v.clone().multiplyScalar(dt / steps));
          classify(depenetrate(this));
        }
        if (!this._floor && v.y <= 0.001) {
          moveBody(this, new Vector3(0, -this.floorSnap, 0));
          const contacts = depenetrate(this, 2);
          if (contacts.some((c) => c.n.y >= cosFloor)) { this._floor = true; this._floorNormal.copy(contacts.find((c) => c.n.y >= cosFloor).n); v.y = Math.max(v.y, 0); } else { moveBody(this, new Vector3(0, this.floorSnap, 0)); depenetrate(this, 1); }
        }
        if (d2) this.velocity.set(v.x, v.y); else this.velocity.copy(v);
        return this._slides.length > 0;
      }
      moveAndCollide(motion) { moveBody(this, d2 ? new Vector3(motion.x, motion.y, 0) : motion.clone()); const c = depenetrate(this); return c.length ? { collider: c[0].collider, normal: c[0].n } : null; }
    }
    class Area extends PhysicsBody {
      static nodeType = `Area${suffix}`;
      constructor(name) { super(name); this.monitoring = true; this._inside = new Set(); }
      getOverlappingBodies() { return [...this._inside]; }
      hasOverlappingBodies() { return this._inside.size > 0; }
      overlapsBody(b) { return this._inside.has(b); }
    }
    return { StaticBody, RigidBody, CharacterBody, Area };
  }
  const B3 = makeBodies(Node3D, false, '3D');
  const B2 = makeBodies(Node2D, true, '2D');
  const StaticBody3D = B3.StaticBody, RigidBody3D = B3.RigidBody, CharacterBody3D = B3.CharacterBody, Area3D = B3.Area;
  const StaticBody2D = B2.StaticBody, RigidBody2D = B2.RigidBody, CharacterBody2D = B2.CharacterBody, Area2D = B2.Area;

  /* ---------- input ---------- */

  const input = {
    map: {}, down: new Set(), just: new Set(), released: new Set(), mouse: new Vector2(), mouseDelta: new Vector2(),
    actionKeys(a) { return this.map[a] ?? []; },
    _press(code) { if (!this.down.has(code)) this.just.add(code); this.down.add(code); },
    _release(code) { if (this.down.delete(code)) this.released.add(code); },
    isKeyPressed(code) { return this.down.has(code); },
    isActionPressed(a) { return this.actionKeys(a).some((k) => this.down.has(k)); },
    isActionJustPressed(a) { return this.actionKeys(a).some((k) => this.just.has(k)); },
    isActionJustReleased(a) { return this.actionKeys(a).some((k) => this.released.has(k)); },
    getActionStrength(a) { return this.isActionPressed(a) ? 1 : 0; },
    getAxis(neg, pos) { return this.getActionStrength(pos) - this.getActionStrength(neg); },
    getVector(nx, px, ny, py) { const v = new Vector2(this.getAxis(nx, px), this.getAxis(ny, py)); return v.lengthSq() > 1 ? v.normalize() : v; },
    getMousePosition() { return this.mouse.clone(); },
    isMouseButtonPressed(i) { return this.down.has(`Mouse${i}`); },
    /** Test helpers: hold or release an action (or a key code) without a keyboard. */
    pressAction(a) { const keys = this.actionKeys(a); this._press(keys[0] ?? a); },
    releaseAction(a) { for (const k of this.actionKeys(a)) this._release(k); this._release(a); },
    _endFrame() { this.just.clear(); this.released.clear(); this.mouseDelta.set(0, 0); },
  };
  engine.input = input;

  /* ---------- scene tree ---------- */

  const NODE_CLASSES = {
    Node, Node3D, Marker3D, MeshInstance3D, Camera3D, DirectionalLight3D, OmniLight3D, SpotLight3D, WorldEnvironment, CollisionShape3D, StaticBody3D, RigidBody3D, CharacterBody3D, Area3D,
    Node2D, Marker2D, Sprite2D, Camera2D, CollisionShape2D, StaticBody2D, RigidBody2D, CharacterBody2D, Area2D,
    CanvasLayer, Control, Label, ColorRect, Button, ProgressBar, Timer, AnimationPlayer,
  };
  engine.nodeClasses = NODE_CLASSES;

  class SceneTree {
    constructor() { this.root = new Node('root'); this.root.tree = this; this.freeQueue = new Set(); this.pendingScene = null; this.currentScene = null; this.paused = false; this.physicsDelta = engine.physicsDelta; this.autoloads = {}; }
    get timeScale() { return engine.timeScale; }
    set timeScale(v) { engine.timeScale = v; }
    getNodesInGroup(g) { const out = []; for (const n of this.root.walk()) if (n.groups.has(g)) out.push(n); return out; }
    callGroup(g, method, ...args) { for (const n of this.getNodesInGroup(g)) if (typeof n[method] === 'function') guard(`${n.name}.${method}`, () => n[method](...args)); }
    getFirstNodeInGroup(g) { return this.getNodesInGroup(g)[0] ?? null; }
    changeScene(name) { this.pendingScene = name; }
    reloadCurrentScene() { this.pendingScene = this.currentSceneName; }
    quit() { engine.quit = true; options.onQuit?.(); }
    createTimer(sec) {
      const t = new Node('SceneTimer'); t.left = sec; t._tick = function (dt) { this.left -= dt; if (this.left <= 0) { this.queueFree(); this.emitSignal('timeout'); this._res?.(); } };
      const p = new Promise((res) => { t._res = res; });
      this.root.addChild(t);
      t.timeout = t;
      t.then = (a, b) => p.then(a, b);
      return t;
    }
    getFrame() { return engine.frame; }
    get currentSceneNode() { return this.currentScene; }
  }

  /** Builds the node tree of a scene definition (and of instanced sub-scenes). Returns the root node. */
  function buildNode(def, sceneName, path, depth = 0) {
    if (depth > 20) throw new Error('scenes instance each other too deeply');
    let node;
    if (def.instance) {
      const sub = engine.scenes.get(def.instance);
      if (!sub) { printErr(`Scene "${sceneName}": cannot instance unknown scene "${def.instance}"`); node = new Node(def.name); }
      else { node = buildNode(sub.root, def.instance, '.', depth + 1); node.name = def.name || node.name; wireConnections(node, sub); }
      node.applyProps(def.props);
      if (!isEdit()) for (const [k, v] of Object.entries(def.exports ?? {})) node[k] = isArr(v) && node[k] && typeof node[k].set === 'function' ? node[k].set(...v) ?? node[k] : v;
      for (const g of def.groups ?? []) node.groups.add(g);
      return node;
    }
    let Cls = NODE_CLASSES[def.type];
    if (!Cls) { printErr(`Scene "${sceneName}": unknown node type "${def.type}" for "${def.name}" (using Node)`); Cls = Node; }
    const script = def.script && !isEdit() ? engine.scriptClasses.get(def.script) : null;
    if (def.script && !isEdit() && !script) printErr(`Scene "${sceneName}": script "${def.script}" of "${def.name}" is missing or failed to load`);
    if (script) {
      if (script === Cls || script.prototype instanceof Cls) Cls = script;
      else printErr(`Script "${def.script}" must extend ${def.type} (or a subclass) to be attached to "${def.name}"`);
    }
    node = new Cls(def.name);
    node.scriptPath = def.script ?? null;
    node.applyProps(def.props);
    if (!isEdit()) for (const [k, v] of Object.entries(def.exports ?? {})) node[k] = isArr(v) && node[k] && typeof node[k].set === 'function' ? node[k].set(...v) ?? node[k] : v;
    for (const g of def.groups ?? []) node.groups.add(g);
    for (const child of def.children ?? []) { const c = buildNode(child, sceneName, `${path}/${child.name}`, depth); node.addChild(c); }
    return node;
  }
  function wireConnections(root, scene) {
    if (isEdit()) return;
    for (const c of scene.connections ?? []) {
      const from = root.getNodeOrNull(c.from), to = root.getNodeOrNull(c.to);
      if (!from || !to) { printErr(`Scene "${scene.name}": connection ${c.from}.${c.signal} → ${c.to}.${c.method}: node not found`); continue; }
      from.connect(c.signal, (...args) => { if (typeof to[c.method] === 'function') to[c.method](...args); else printErr(`Connection target ${to.name} has no method "${c.method}"`); });
    }
  }

  /** A new instance of a scene by name (not yet in the tree). */
  function instantiate(sceneName) {
    const scene = engine.scenes.get(sceneName);
    if (!scene) throw new Error(`Unknown scene "${sceneName}" (known: ${[...engine.scenes.keys()].join(', ') || 'none'})`);
    const root = buildNode(scene.root, sceneName, '.');
    wireConnections(root, scene);
    return root;
  }

  /* ---------- loading a game ---------- */

  engine.load = function load(game) {
    engine.game = game;
    engine.scenes = new Map(Object.entries(game.scenes ?? {}));
    const s = game.settings ?? {};
    engine.size = { w: s.width ?? 1152, h: s.height ?? 648 };
    engine.gravity3d = s.gravity3d ?? 9.8;
    engine.gravity2d = s.gravity2d ?? 980;
    input.map = s.inputMap ?? {};
    engine.tree = new SceneTree();
  };

  /** Compiles and runs script modules. `compiled` maps a script path to CommonJS JavaScript. */
  engine.loadScripts = function loadScripts(compiled) {
    engine.scriptSources = new Map(Object.entries(compiled));
    engine.scriptModules.clear(); engine.scriptClasses.clear();
    for (const path of engine.scriptSources.keys()) {
      const mod = requireScript(path);
      const cls = mod && (mod.default ?? (typeof mod === 'function' ? mod : null));
      if (typeof cls === 'function') engine.scriptClasses.set(path, cls);
      else if (mod !== undefined && !(path in {})) { /* helper modules may export plain values */ }
    }
  };

  const normalizePath = (p) => { const out = []; for (const part of p.split('/')) { if (part === '..') out.pop(); else if (part !== '.' && part !== '') out.push(part); } return out.join('/'); };
  function requireScript(path, from) {
    let key = path;
    if (from !== undefined) {
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      key = normalizePath(`${dir}/${path}`);
    }
    const candidates = [key, `${key}.ts`, `${key}.js`, `${key}/index.ts`, `${key}/index.js`];
    const found = candidates.find((c) => engine.scriptSources.has(c));
    if (!found) throw new Error(`Cannot find script module "${path}"${from ? ` imported from ${from}` : ''}`);
    if (engine.scriptModules.has(found)) return engine.scriptModules.get(found).exports;
    const module = { exports: {} };
    engine.scriptModules.set(found, module);
    try {
      const names = Object.keys(engine.api);
      const fn = new Function('exports', 'module', 'require', ...names, engine.scriptSources.get(found));
      fn(module.exports, module, (spec) => (spec === 'engine' ? engine.api : requireScript(spec, found)), ...names.map((n) => engine.api[n]));
    } catch (e) { printErr(`Script ${found}: ${e && e.message ? e.message : e}`); }
    return module.exports;
  }

  engine.instantiate = instantiate;

  /** Edit mode: builds a scene without scripts or autoloads, for the editor's viewports. */
  engine.editScene = function editScene(name) {
    if (!engine.tree) throw new Error('load() a game first');
    changeSceneNow(name);
    syncAll();
    return engine.tree.currentScene;
  };
  engine.sync = () => syncAll();

  /** Starts the game: autoloads first, then the main scene. */
  engine.start = function start(sceneName) {
    if (!engine.tree) throw new Error('load() a game first');
    const tree = engine.tree;
    engine.threeScene.add(tree.root.object3d ?? new THREE.Group());
    for (const a of engine.game.settings?.autoloads ?? []) {
      const Cls = engine.scriptClasses.get(a.script);
      if (!Cls) { printErr(`Autoload "${a.name}": script "${a.script}" is missing`); continue; }
      const node = new Cls(a.name);
      tree.root.addChild(node);
      tree.autoloads[a.name] = node;
      engine.api[a.name] = node;
      globalThis[a.name] = node;
    }
    changeSceneNow(sceneName ?? engine.game.settings?.mainScene);
  };

  function changeSceneNow(name) {
    const tree = engine.tree;
    if (!engine.scenes.has(name)) { printErr(`Cannot change to unknown scene "${name}"`); return; }
    if (tree.currentScene) { tree.root.removeChild(tree.currentScene); }
    for (const t of tree.root.children) if (t.name === '__old') t.queueFree();
    tree.currentSceneName = name;
    const node = instantiate(name);
    tree.currentScene = node;
    tree.root.addChild(node);
    guard('scene start', () => 0);
  }

  /* ---------- frame loop ---------- */

  const everyNode = (fn) => { for (const n of [...engine.tree.root.walk()]) if (!n._freed && n.tree) fn(n); };
  const canRun = (n) => !engine.tree.paused || n.processMode === 'always';

  function flush() {
    const tree = engine.tree;
    for (const n of [...tree.freeQueue]) { n.parent?.removeChild(n); }
    tree.freeQueue.clear();
    if (tree.pendingScene) { const name = tree.pendingScene; tree.pendingScene = null; changeSceneNow(name); }
  }
  function syncAll() { everyNode((n) => { if (n instanceof Node2D) n.syncTransform(); }); }

  engine.physicsFrame = function physicsFrame(dt) {
    const tree = engine.tree;
    tree.physicsDelta = dt;
    syncAll();
    everyNode((n) => { if (n.physicsProcess && canRun(n)) guard(`${n.name}.physicsProcess`, () => n.physicsProcess(dt)); });
    physicsStep(dt);
    syncAll();
  };

  let acc = 0;
  /** Advances the game by `dt` seconds (physics at a fixed 60 Hz), then renders when a renderer is attached. */
  engine.step = function step(dtRaw) {
    if (!engine.tree || engine.quit) return;
    const dt = dtRaw * engine.timeScale;
    engine.frame++;
    engine.time += dt;
    acc += dt;
    const pdt = engine.physicsDelta;
    let n = 0;
    while (acc >= pdt - 1e-9 && n < 8) { engine.physicsFrame(pdt); acc -= pdt; n++; }
    if (n === 8) acc = 0;
    everyNode((node) => {
      if (!canRun(node)) return;
      if (node.process) guard(`${node.name}.process`, () => node.process(dt));
      if (node._tick) node._tick(dt);
    });
    for (const t of engine.tweens) if (!t.finished) t.update(dt);
    engine.tweens = engine.tweens.filter((t) => !t.finished);
    flush();
    syncAll();
    input._endFrame();
    engine.render();
  };
  /** Runs `frames` fixed steps of `dt` seconds. */
  engine.stepFrames = function stepFrames(frames, dt = 1 / 60) { for (let i = 0; i < frames; i++) engine.step(dt); };

  /** Dispatches an input event to scripts (`input(event)` and `unhandledInput(event)`). */
  engine.dispatchInput = function dispatchInput(event) {
    if (!engine.tree) return;
    everyNode((n) => { if (n.input) guard(`${n.name}.input`, () => n.input(event)); if (n.unhandledInput) guard(`${n.name}.unhandledInput`, () => n.unhandledInput(event)); });
  };

  /* ---------- rendering ---------- */

  engine.attachRenderer = function attachRenderer({ canvas, width, height, pixelRatio = 1, ui }) {
    engine.size = { w: width, h: height };
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    engine.renderer = renderer;
    if (ui) engine.ui = { root: ui };
    if (!engine.threeScene.background) engine.threeScene.background = new Color(engine.game?.settings?.background ?? '#2b2f36');
  };
  engine.resize = function resize(w, h) { engine.size = { w, h }; engine.renderer?.setSize(w, h, false); };
  const defaultCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 1000);
  defaultCamera.position.set(0, 3, 6); defaultCamera.lookAt(0, 0.5, 0);
  engine.currentCamera = function currentCamera() {
    if (!engine.tree) return defaultCamera;
    let cam3 = null, cam2 = null;
    for (const n of engine.tree.root.walk()) { if (n instanceof Camera3D && n.current && !cam3) cam3 = n; else if (n instanceof Camera2D && n.current && !cam2) cam2 = n; }
    if (cam3) { cam3.camera.aspect = engine.size.w / engine.size.h; cam3.camera.updateProjectionMatrix(); return cam3.camera; }
    if (cam2) { cam2.syncTransform(); cam2.object3d.updateWorldMatrix(true, true); return cam2.camera; }
    defaultCamera.aspect = engine.size.w / engine.size.h; defaultCamera.updateProjectionMatrix();
    return defaultCamera;
  };
  engine.render = function render() {
    if (!engine.renderer) return;
    engine.threeScene.updateMatrixWorld(true);
    engine.renderer.render(engine.threeScene, engine.currentCamera());
  };
  engine.captureFrame = function captureFrame() { engine.render(); return engine.renderer?.domElement.toDataURL('image/png') ?? null; };

  /** Positions and key state of every node, for headless checks. */
  engine.snapshot = function snapshot() {
    const out = [];
    for (const n of engine.tree.root.walk()) {
      if (n === engine.tree.root) continue;
      const row = { path: n.getPath().replace('/root/', ''), type: n.type };
      if (n instanceof Node3D) { const p = n.globalPosition; row.position = [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000); }
      else if (n instanceof Node2D) { const p = n.globalPosition; row.position = [p.x, p.y].map((v) => Math.round(v * 1000) / 1000); }
      if (n.velocity) row.velocity = [n.velocity.x, n.velocity.y, n.velocity.z].filter((v) => v !== undefined).map((v) => Math.round(v * 1000) / 1000);
      if (n.linearVelocity) row.velocity = [n.linearVelocity.x, n.linearVelocity.y, n.linearVelocity.z].filter((v) => v !== undefined).map((v) => Math.round(v * 1000) / 1000);
      if (typeof n.isOnFloor === 'function') row.onFloor = n.isOnFloor();
      if (n.text !== undefined && n instanceof Control) row.text = n.text;
      out.push(row);
    }
    return out;
  };

  /* ---------- the API scripts see ---------- */

  const rnd = options.random ?? Math.random;
  engine.api = {
    ...NODE_CLASSES, Tween, Vector2, Vector3, Color, Quaternion, Euler, MathUtils, Matrix4,
    Input: input, Physics: engine.physics, print, printErr, push_error: printErr,
    Engine: { get timeScale() { return engine.timeScale; }, set timeScale(v) { engine.timeScale = v; }, get time() { return engine.time; }, get frame() { return engine.frame; }, get fps() { return engine.fps; }, get gravity3d() { return engine.gravity3d; }, get gravity2d() { return engine.gravity2d; }, size: () => engine.size },
    instantiate, loadScene: (name) => ({ instantiate: () => instantiate(name) }), preload: (name) => ({ instantiate: () => instantiate(name) }),
    lerp: (a, b, t) => a + (b - a) * t, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), sign: Math.sign, smoothstep: MathUtils.smoothstep, deg2rad: rad, rad2deg: deg, ease,
    moveToward: (from, to, delta) => (Math.abs(to - from) <= delta ? to : from + Math.sign(to - from) * delta),
    randf: () => rnd(), randi: () => Math.floor(rnd() * 4294967296), randfRange: (a, b) => a + (b - a) * rnd(), randiRange: (a, b) => Math.floor(a + (b - a + 1) * rnd()),
    wrap: (v, lo, hi) => { const r = hi - lo; return lo + ((((v - lo) % r) + r) % r); },
    getTree: () => engine.tree, getNode: (p) => engine.tree.root.getNode(p),
  };
  engine.printDefaults = { print, printErr };

  /** Names of the API globals, for the script editor's declaration file. */
  engine.apiNames = () => Object.keys(engine.api);

  return engine;
}
