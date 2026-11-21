/** Diagram model shared by the Diagram editor screen and the agent's diagram
 * tools: file format, validation, operations, auto layout, Mermaid export and
 * a dependency-free SVG renderer (the editor draws with the same renderer it
 * exports with, so what the user sees is what gets saved). Pure functions — no
 * DOM, no Tauri — so everything here is unit-testable in Node. */

export type NodeKind =
  | 'process' | 'terminator' | 'decision' | 'io' | 'database' | 'document'
  | 'entity' | 'actor' | 'usecase' | 'system' | 'note' | 'cloud' | 'queue';

export type DiagramType = 'flowchart' | 'erd' | 'usecase' | 'architecture' | 'generic';
export type Direction = 'TB' | 'LR';
export type ArrowStyle = 'end' | 'both' | 'none';

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Entity rows, e.g. "id PK", "user_id FK", "email varchar". */
  fields?: string[];
  /** Container (system boundary) this node sits inside. */
  parent?: string;
  /** Optional CSS colour overrides. */
  fill?: string;
  stroke?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Cardinality text near the source / target end (ERD: "1", "N", "0..1"). */
  fromLabel?: string;
  toLabel?: string;
  dashed?: boolean;
  arrow?: ArrowStyle;
}

export interface Diagram {
  version: 1;
  title: string;
  type: DiagramType;
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export const NODE_KINDS: NodeKind[] = [
  'process', 'terminator', 'decision', 'io', 'database', 'document',
  'entity', 'actor', 'usecase', 'system', 'note', 'cloud', 'queue',
];
export const DIAGRAM_TYPES: DiagramType[] = ['flowchart', 'erd', 'usecase', 'architecture', 'generic'];

export const DIAGRAMS_DIR = '.pigry/diagrams/';
export const DIAGRAM_EXT = '.diagram.json';
export const MAX_NODES = 300;
const MAX_FIELDS = 40;

const KIND_LABELS: Record<NodeKind, string> = {
  process: 'Process', terminator: 'Start / End', decision: 'Decision', io: 'Input / Output',
  database: 'Database', document: 'Document', entity: 'Entity (table)', actor: 'Actor',
  usecase: 'Use case', system: 'System boundary', note: 'Note', cloud: 'Cloud / external',
  queue: 'Queue',
};
export const kindLabel = (kind: NodeKind): string => KIND_LABELS[kind];

/* ---------- ids ---------- */

function nextId(prefix: string, taken: Set<string>): string {
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

const cleanId = (value: unknown): string =>
  String(value ?? '').trim().replace(/[^\w.\-]+/g, '_').slice(0, 60);

/* ---------- sizes ---------- */

const ROW_H = 22;
const HEAD_H = 30;

export function defaultSize(kind: NodeKind, fields?: string[]): { w: number; h: number } {
  switch (kind) {
    case 'terminator': return { w: 130, h: 46 };
    case 'decision': return { w: 150, h: 90 };
    case 'io': return { w: 160, h: 56 };
    case 'database': return { w: 110, h: 80 };
    case 'document': return { w: 140, h: 64 };
    case 'entity': return { w: 190, h: entityHeight(fields) };
    case 'actor': return { w: 70, h: 100 };
    case 'usecase': return { w: 170, h: 70 };
    case 'system': return { w: 420, h: 300 };
    case 'note': return { w: 170, h: 80 };
    case 'cloud': return { w: 150, h: 84 };
    case 'queue': return { w: 150, h: 56 };
    default: return { w: 150, h: 60 };
  }
}

export function entityHeight(fields?: string[]): number {
  return HEAD_H + Math.max(1, fields?.length ?? 0) * ROW_H + 6;
}

/* ---------- normalize / validate ---------- */

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const str = (value: unknown, max = 200): string => String(value ?? '').slice(0, max);
const isKind = (value: unknown): value is NodeKind => NODE_KINDS.includes(value as NodeKind);

export interface NormalizeResult {
  diagram: Diagram;
  warnings: string[];
  /** True when at least one node had no usable position. */
  needsLayout: boolean;
}

/** Turns untrusted input (a file, or a model's tool arguments) into a valid
 * diagram. Tolerant: bad rows are dropped with a warning instead of throwing. */
export function normalizeDiagram(raw: unknown, fallbackTitle = 'Untitled'): NormalizeResult {
  const warnings: string[] = [];
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const type: DiagramType = DIAGRAM_TYPES.includes(input.type as DiagramType) ? (input.type as DiagramType) : 'generic';
  const direction: Direction = input.direction === 'LR' ? 'LR' : 'TB';
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (rawNodes.length > MAX_NODES) warnings.push(`Only the first ${MAX_NODES} nodes were kept.`);

  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  let needsLayout = false;
  for (const item of rawNodes.slice(0, MAX_NODES)) {
    const n = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const kind: NodeKind = isKind(n.kind) ? n.kind : (Array.isArray(n.fields) && n.fields.length ? 'entity' : 'process');
    if (n.kind !== undefined && !isKind(n.kind)) warnings.push(`Unknown kind "${str(n.kind, 30)}" — used "${kind}".`);
    let id = cleanId(n.id);
    if (!id || ids.has(id)) {
      if (id) warnings.push(`Duplicate node id "${id}" was renamed.`);
      id = nextId('n', ids);
    }
    ids.add(id);
    const fields = Array.isArray(n.fields)
      ? n.fields.map((f) => str(f, 80)).filter(Boolean).slice(0, MAX_FIELDS)
      : undefined;
    const size = defaultSize(kind, fields);
    const hasPos = typeof n.x === 'number' && typeof n.y === 'number' && Number.isFinite(n.x) && Number.isFinite(n.y);
    if (!hasPos) needsLayout = true;
    nodes.push({
      id,
      kind,
      label: str(n.label ?? n.name ?? id),
      x: hasPos ? (n.x as number) : 0,
      y: hasPos ? (n.y as number) : 0,
      w: kind === 'entity' ? Math.max(120, num(n.w, size.w)) : Math.max(24, num(n.w, size.w)),
      h: kind === 'entity' ? entityHeight(fields) : Math.max(24, num(n.h, size.h)),
      ...(fields && fields.length ? { fields } : {}),
      ...(typeof n.parent === 'string' && n.parent ? { parent: cleanId(n.parent) } : {}),
      ...(typeof n.fill === 'string' && n.fill ? { fill: str(n.fill, 40) } : {}),
      ...(typeof n.stroke === 'string' && n.stroke ? { stroke: str(n.stroke, 40) } : {}),
    });
  }
  for (const node of nodes) {
    if (node.parent && (!ids.has(node.parent) || node.parent === node.id)) delete node.parent;
  }

  const byLabel = new Map<string, string[]>();
  for (const node of nodes) {
    const key = node.label.trim().toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), node.id]);
  }
  const resolve = (ref: unknown): string | null => {
    const text = String(ref ?? '').trim();
    if (!text) return null;
    if (ids.has(text)) return text;
    const clean = cleanId(text);
    if (ids.has(clean)) return clean;
    const byName = byLabel.get(text.toLowerCase());
    return byName && byName.length === 1 ? byName[0] : null;
  };

  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();
  for (const item of rawEdges) {
    const e = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const from = resolve(e.from ?? e.source);
    const to = resolve(e.to ?? e.target);
    if (!from || !to) {
      warnings.push(`Edge ${str(e.from ?? e.source, 30)} → ${str(e.to ?? e.target, 30)} was dropped: unknown node.`);
      continue;
    }
    let id = cleanId(e.id);
    if (!id || edgeIds.has(id)) id = nextId('e', edgeIds);
    edgeIds.add(id);
    edges.push({
      id,
      from,
      to,
      ...(e.label ? { label: str(e.label, 120) } : {}),
      ...(e.fromLabel ? { fromLabel: str(e.fromLabel, 20) } : {}),
      ...(e.toLabel ? { toLabel: str(e.toLabel, 20) } : {}),
      ...(e.dashed === true ? { dashed: true } : {}),
      ...(e.arrow === 'both' || e.arrow === 'none' ? { arrow: e.arrow } : {}),
    });
  }

  return {
    diagram: { version: 1, title: str(input.title, 120) || fallbackTitle, type, direction, nodes, edges },
    warnings,
    needsLayout,
  };
}

/** Problems worth telling the model / user about (not fatal). */
export function validateDiagram(d: Diagram): string[] {
  const out: string[] = [];
  const connected = new Set<string>();
  for (const edge of d.edges) { connected.add(edge.from); connected.add(edge.to); }
  for (const node of d.nodes) {
    if (!node.label.trim()) out.push(`Node ${node.id} has an empty label.`);
    if (d.edges.length > 0 && node.kind !== 'system' && node.kind !== 'note' && !connected.has(node.id)) {
      out.push(`Node ${node.id} ("${node.label}") has no connections.`);
    }
  }
  const boxes = d.nodes.filter((n) => n.kind !== 'system');
  let overlaps = 0;
  for (let i = 0; i < boxes.length && overlaps < 5; i += 1) {
    for (let j = i + 1; j < boxes.length && overlaps < 5; j += 1) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlaps += 1;
        out.push(`Nodes ${a.id} and ${b.id} overlap — run layout.`);
      }
    }
  }
  return out;
}

export const emptyDiagram = (title = 'Untitled', type: DiagramType = 'generic'): Diagram => ({
  version: 1, title, type, direction: type === 'erd' || type === 'usecase' ? 'LR' : 'TB', nodes: [], edges: [],
});

export function parseDiagramJson(text: string, fallbackTitle?: string): NormalizeResult {
  try {
    return normalizeDiagram(JSON.parse(text), fallbackTitle);
  } catch (error) {
    throw new Error(`not valid diagram JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const serializeDiagram = (d: Diagram): string => `${JSON.stringify(d, null, 2)}\n`;

/* ---------- layout ---------- */

const isContainer = (node: DiagramNode): boolean => node.kind === 'system';

/** Layered (Sugiyama-style) layout: longest-path ranks, barycenter ordering,
 * then compact placement. System-boundary containers are sized to wrap their
 * children afterwards. Returns a new diagram. */
export function autoLayout(d: Diagram, direction: Direction = d.direction): Diagram {
  const nodes = d.nodes.map((n) => ({ ...n }));
  const items = nodes.filter((n) => !isContainer(n));
  const index = new Map(items.map((n, i) => [n.id, i]));
  const out: number[][] = items.map(() => []);
  const inn: number[][] = items.map(() => []);
  for (const edge of d.edges) {
    const a = index.get(edge.from), b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!out[a].includes(b)) { out[a].push(b); inn[b].push(a); }
  }

  // Break cycles: DFS, ignore back edges.
  const state = new Array<number>(items.length).fill(0);
  const forward: number[][] = items.map(() => []);
  const visit = (u: number) => {
    state[u] = 1;
    for (const v of out[u]) {
      if (state[v] === 1) continue; // back edge
      forward[u].push(v);
      if (state[v] === 0) visit(v);
    }
    state[u] = 2;
  };
  for (let i = 0; i < items.length; i += 1) if (state[i] === 0) visit(i);

  // Longest-path ranks over the acyclic edge set.
  const rank = new Array<number>(items.length).fill(0);
  const indegree = new Array<number>(items.length).fill(0);
  forward.forEach((targets) => targets.forEach((v) => { indegree[v] += 1; }));
  const queue: number[] = [];
  indegree.forEach((deg, i) => { if (deg === 0) queue.push(i); });
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    for (const v of forward[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      indegree[v] -= 1;
      if (indegree[v] === 0) queue.push(v);
    }
  }

  const layers: number[][] = [];
  items.forEach((_, i) => { (layers[rank[i]] ??= []).push(i); });
  const position = new Array<number>(items.length).fill(0);
  layers.forEach((layer) => layer.forEach((n, i) => { position[n] = i; }));
  const barycenter = (n: number, neighbours: number[]) =>
    neighbours.length === 0 ? position[n] : neighbours.reduce((sum, m) => sum + position[m], 0) / neighbours.length;
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const li of order) {
      const layer = layers[li];
      if (!layer) continue;
      layer.sort((a, b) => barycenter(a, down ? inn[a] : out[a]) - barycenter(b, down ? inn[b] : out[b]) || a - b);
      layer.forEach((n, i) => { position[n] = i; });
    }
  }

  const gapMain = direction === 'TB' ? 70 : 90;
  const gapCross = direction === 'TB' ? 50 : 36;
  const mainSize = (n: DiagramNode) => (direction === 'TB' ? n.h : n.w);
  const crossSize = (n: DiagramNode) => (direction === 'TB' ? n.w : n.h);
  const layerCross = layers.map((layer) =>
    (layer ?? []).reduce((sum, n) => sum + crossSize(items[n]), 0) + Math.max(0, (layer?.length ?? 1) - 1) * gapCross);
  const widest = Math.max(0, ...layerCross);
  let main = 40;
  layers.forEach((layer, li) => {
    if (!layer) return;
    const thickness = Math.max(...layer.map((n) => mainSize(items[n])));
    let cross = 40 + (widest - layerCross[li]) / 2;
    for (const n of layer) {
      const node = items[n];
      const centeredMain = main + (thickness - mainSize(node)) / 2;
      if (direction === 'TB') { node.x = Math.round(cross); node.y = Math.round(centeredMain); }
      else { node.x = Math.round(centeredMain); node.y = Math.round(cross); }
      cross += crossSize(node) + gapCross;
    }
    main += thickness + gapMain;
  });

  const laidOut: Diagram = { ...d, direction, nodes };
  return fitContainers(laidOut);
}

/** Sizes every system-boundary container around the nodes that name it as parent. */
export function fitContainers(d: Diagram): Diagram {
  const nodes = d.nodes.map((n) => ({ ...n }));
  for (const box of nodes.filter(isContainer)) {
    const kids = nodes.filter((n) => n.parent === box.id);
    if (kids.length === 0) continue;
    const pad = 28, head = 30;
    const minX = Math.min(...kids.map((n) => n.x)), minY = Math.min(...kids.map((n) => n.y));
    const maxX = Math.max(...kids.map((n) => n.x + n.w)), maxY = Math.max(...kids.map((n) => n.y + n.h));
    box.x = minX - pad; box.y = minY - pad - head;
    box.w = maxX - minX + pad * 2; box.h = maxY - minY + pad * 2 + head;
  }
  return { ...d, nodes };
}

export function boundsOf(d: Diagram): { x: number; y: number; w: number; h: number } {
  if (d.nodes.length === 0) return { x: 0, y: 0, w: 400, h: 300 };
  const minX = Math.min(...d.nodes.map((n) => n.x)), minY = Math.min(...d.nodes.map((n) => n.y));
  const maxX = Math.max(...d.nodes.map((n) => n.x + n.w)), maxY = Math.max(...d.nodes.map((n) => n.y + n.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ---------- operations (the agent's diagram_edit, also used by the editor) ---------- */

export interface DiagramOp {
  op: string;
  [key: string]: unknown;
}

export interface OpsResult {
  diagram: Diagram;
  log: string[];
  errors: string[];
}

/** Applies a list of edit operations. Valid ones are applied, invalid ones are
 * reported in `errors`. Nodes/edges may be addressed by id or (when unique) label. */
export function applyOperations(input: Diagram, ops: DiagramOp[]): OpsResult {
  let d: Diagram = { ...input, nodes: input.nodes.map((n) => ({ ...n })), edges: input.edges.map((e) => ({ ...e })) };
  const log: string[] = [];
  const errors: string[] = [];
  let relayout: Direction | null = null;
  const find = (ref: unknown): DiagramNode | undefined => {
    const text = String(ref ?? '').trim();
    return d.nodes.find((n) => n.id === text)
      ?? (d.nodes.filter((n) => n.label.trim().toLowerCase() === text.toLowerCase()).length === 1
        ? d.nodes.find((n) => n.label.trim().toLowerCase() === text.toLowerCase())
        : undefined);
  };
  const findEdge = (op: DiagramOp): DiagramEdge | undefined => {
    if (op.id) return d.edges.find((e) => e.id === String(op.id));
    const from = find(op.from), to = find(op.to);
    return from && to ? d.edges.find((e) => e.from === from.id && e.to === to.id) : undefined;
  };
  const patchNode = (node: DiagramNode, op: DiagramOp) => {
    if (op.label !== undefined) node.label = str(op.label);
    if (isKind(op.kind)) node.kind = op.kind;
    if (Array.isArray(op.fields)) node.fields = op.fields.map((f) => str(f, 80)).filter(Boolean).slice(0, MAX_FIELDS);
    if (typeof op.x === 'number') node.x = op.x;
    if (typeof op.y === 'number') node.y = op.y;
    if (typeof op.w === 'number') node.w = Math.max(24, op.w);
    if (typeof op.h === 'number') node.h = Math.max(24, op.h);
    if (typeof op.fill === 'string') node.fill = op.fill || undefined;
    if (typeof op.stroke === 'string') node.stroke = op.stroke || undefined;
    if (op.parent !== undefined) node.parent = op.parent ? cleanId(op.parent) : undefined;
    if (node.kind === 'entity') node.h = entityHeight(node.fields);
    if (node.kind === 'entity') node.w = Math.max(120, node.w);
  };

  ops.forEach((op, i) => {
    const where = `op ${i + 1} (${String(op?.op ?? '?')})`;
    try {
      switch (String(op.op)) {
        case 'add_node': {
          if (d.nodes.length >= MAX_NODES) throw new Error(`diagram is full (${MAX_NODES} nodes)`);
          const taken = new Set(d.nodes.map((n) => n.id));
          let id = cleanId(op.id);
          if (!id || taken.has(id)) id = nextId('n', taken);
          const kind: NodeKind = isKind(op.kind) ? op.kind : (Array.isArray(op.fields) && op.fields.length ? 'entity' : 'process');
          const size = defaultSize(kind);
          const placed = typeof op.x === 'number' && typeof op.y === 'number';
          const node: DiagramNode = { id, kind, label: str(op.label ?? id), x: num(op.x, 0), y: num(op.y, 0), w: size.w, h: size.h };
          patchNode(node, { ...op, x: undefined, y: undefined });
          if (placed) { node.x = op.x as number; node.y = op.y as number; } else {
            const b = boundsOf(d);
            node.x = d.nodes.length ? Math.round(b.x + b.w + 60) : 40; node.y = d.nodes.length ? Math.round(b.y) : 40;
            relayout = relayout ?? d.direction;
          }
          d.nodes.push(node);
          log.push(`added ${kind} ${id} "${node.label}"`);
          break;
        }
        case 'update_node': {
          const node = find(op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          patchNode(node, op);
          log.push(`updated ${node.id}`);
          break;
        }
        case 'remove_node': {
          const node = find(op.id ?? op.node);
          if (!node) throw new Error(`no node "${String(op.id ?? op.node)}"`);
          d.nodes = d.nodes.filter((n) => n.id !== node.id).map((n) => (n.parent === node.id ? { ...n, parent: undefined } : n));
          const before = d.edges.length;
          d.edges = d.edges.filter((e) => e.from !== node.id && e.to !== node.id);
          log.push(`removed ${node.id} and ${before - d.edges.length} edge(s)`);
          break;
        }
        case 'add_edge': {
          const from = find(op.from), to = find(op.to);
          if (!from || !to) throw new Error(`unknown node ${!from ? String(op.from) : String(op.to)}`);
          const taken = new Set(d.edges.map((e) => e.id));
          let id = cleanId(op.id);
          if (!id || taken.has(id)) id = nextId('e', taken);
          d.edges.push({
            id, from: from.id, to: to.id,
            ...(op.label ? { label: str(op.label, 120) } : {}),
            ...(op.fromLabel ? { fromLabel: str(op.fromLabel, 20) } : {}),
            ...(op.toLabel ? { toLabel: str(op.toLabel, 20) } : {}),
            ...(op.dashed === true ? { dashed: true } : {}),
            ...(op.arrow === 'both' || op.arrow === 'none' ? { arrow: op.arrow } : {}),
          });
          log.push(`connected ${from.id} → ${to.id}`);
          break;
        }
        case 'update_edge': {
          const edge = findEdge(op);
          if (!edge) throw new Error('no such edge (give id, or from + to)');
          if (op.label !== undefined) edge.label = op.label ? str(op.label, 120) : undefined;
          if (op.fromLabel !== undefined) edge.fromLabel = op.fromLabel ? str(op.fromLabel, 20) : undefined;
          if (op.toLabel !== undefined) edge.toLabel = op.toLabel ? str(op.toLabel, 20) : undefined;
          if (op.dashed !== undefined) edge.dashed = op.dashed === true ? true : undefined;
          if (op.arrow === 'end' || op.arrow === 'both' || op.arrow === 'none') edge.arrow = op.arrow === 'end' ? undefined : op.arrow;
          log.push(`updated edge ${edge.id}`);
          break;
        }
        case 'remove_edge': {
          const edge = findEdge(op);
          if (!edge) throw new Error('no such edge (give id, or from + to)');
          d.edges = d.edges.filter((e) => e.id !== edge.id);
          log.push(`removed edge ${edge.id}`);
          break;
        }
        case 'set_meta': {
          if (op.title !== undefined) d = { ...d, title: str(op.title, 120) };
          if (DIAGRAM_TYPES.includes(op.type as DiagramType)) d = { ...d, type: op.type as DiagramType };
          if (op.direction === 'TB' || op.direction === 'LR') d = { ...d, direction: op.direction };
          log.push('updated title/type/direction');
          break;
        }
        case 'layout': {
          relayout = op.direction === 'LR' || op.direction === 'TB' ? op.direction : (relayout ?? d.direction);
          log.push(`auto layout (${relayout})`);
          break;
        }
        default:
          throw new Error('unknown op — use add_node, update_node, remove_node, add_edge, update_edge, remove_edge, set_meta or layout');
      }
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (relayout) d = autoLayout(d, relayout);
  else d = fitContainers(d);
  return { diagram: d, log, errors };
}

/* ---------- text summaries & Mermaid ---------- */

/** Compact, model-friendly description of a diagram. */
export function summarizeDiagram(d: Diagram): string {
  const lines = [`"${d.title}" — ${d.type}, ${d.direction}, ${d.nodes.length} nodes, ${d.edges.length} edges`];
  for (const n of d.nodes) {
    const fields = n.fields?.length ? ` {${n.fields.join('; ')}}` : '';
    lines.push(`- ${n.id} [${n.kind}] "${n.label}"${fields}${n.parent ? ` (in ${n.parent})` : ''}`);
  }
  for (const e of d.edges) {
    const card = e.fromLabel || e.toLabel ? ` (${e.fromLabel ?? ''}..${e.toLabel ?? ''})` : '';
    lines.push(`- ${e.id}: ${e.from} ${e.dashed ? '-->' : '->'} ${e.to}${e.label ? ` "${e.label}"` : ''}${card}`);
  }
  return lines.join('\n');
}

const mermaidId = (id: string): string => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
const mq = (text: string): string => text.replace(/"/g, "'").replace(/\n/g, ' ');

const ER_LEFT: Record<string, string> = { '1': '||', '0..1': '|o', '1..1': '||', n: '}o', '*': '}o', '0..n': '}o', '0..*': '}o', '1..n': '}|', '1..*': '}|' };
const ER_RIGHT: Record<string, string> = { '1': '||', '0..1': 'o|', '1..1': '||', n: 'o{', '*': 'o{', '0..n': 'o{', '0..*': 'o{', '1..n': '|{', '1..*': '|{' };

/** Mermaid source: an erDiagram for ERDs, otherwise a flowchart. */
export function toMermaid(d: Diagram): string {
  const entities = d.nodes.filter((n) => n.kind === 'entity');
  if (d.type === 'erd' || (entities.length > 0 && entities.length === d.nodes.filter((n) => n.kind !== 'note').length)) {
    const name = (n: DiagramNode) => n.label.trim().replace(/[^A-Za-z0-9_]+/g, '_') || mermaidId(n.id);
    const lines = ['erDiagram'];
    for (const e of d.edges) {
      const a = d.nodes.find((n) => n.id === e.from), b = d.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const left = ER_LEFT[(e.fromLabel ?? '1').toLowerCase()] ?? '||';
      const right = ER_RIGHT[(e.toLabel ?? 'n').toLowerCase()] ?? 'o{';
      lines.push(`  ${name(a)} ${left}--${right} ${name(b)} : "${mq(e.label ?? 'relates')}"`);
    }
    for (const n of entities) {
      lines.push(`  ${name(n)} {`);
      for (const field of n.fields ?? []) {
        const parts = field.trim().split(/\s+/);
        const keys = parts.filter((p) => /^(PK|FK|UK)$/i.test(p)).map((p) => p.toUpperCase());
        const rest = parts.filter((p) => !/^(PK|FK|UK)$/i.test(p));
        // Field convention is "name [type] [PK|FK|UK]"; Mermaid wants "type name".
        const [first, second] = rest;
        const type = second ?? 'string';
        const column = (first ?? 'field').replace(/[^A-Za-z0-9_]/g, '_');
        lines.push(`    ${type.replace(/[^A-Za-z0-9_()]/g, '')} ${column}${keys.length ? ` ${keys.join(',')}` : ''}`);
      }
      lines.push('  }');
    }
    return lines.join('\n');
  }
  const lines = [`flowchart ${d.direction === 'LR' ? 'LR' : 'TD'}`];
  for (const n of d.nodes) {
    const id = mermaidId(n.id);
    const label = mq(n.kind === 'entity' ? [n.label, ...(n.fields ?? [])].join('<br/>') : n.label);
    const shape = {
      terminator: `${id}(["${label}"])`, decision: `${id}{"${label}"}`, io: `${id}[/"${label}"/]`,
      database: `${id}[("${label}")]`, usecase: `${id}(("${label}"))`, cloud: `${id}(("${label}"))`,
      actor: `${id}["👤 ${label}"]`, note: `${id}["📝 ${label}"]`, queue: `${id}[["${label}"]]`,
    }[n.kind as string] ?? `${id}["${label}"]`;
    lines.push(`  ${shape}`);
  }
  for (const e of d.edges) {
    const a = mermaidId(e.from), b = mermaidId(e.to);
    const label = e.label ? `|"${mq(e.label)}"|` : '';
    const arrow = e.arrow === 'none' ? (e.dashed ? '-.-' : '---') : e.arrow === 'both' ? (e.dashed ? '<-.->' : '<-->') : (e.dashed ? '-.->' : '-->');
    lines.push(`  ${a} ${arrow}${label} ${b}`);
  }
  return lines.join('\n');
}

/* ---------- SVG rendering ---------- */

export interface Palette {
  bg: string; node: string; nodeStroke: string; text: string; muted: string;
  edge: string; accent: string; note: string; system: string; head: string;
}

export const LIGHT_PALETTE: Palette = {
  bg: '#ffffff', node: '#f4f6fb', nodeStroke: '#5a6682', text: '#1b2233', muted: '#5f6b85',
  edge: '#5a6682', accent: '#3b6cf6', note: '#fff7c2', system: '#8a94ad', head: '#dfe6f7',
};

export const THEME_PALETTE: Palette = {
  bg: 'transparent', node: 'var(--bg-card, #1b2030)', nodeStroke: 'var(--text-muted, #7f8aa6)',
  text: 'var(--text-primary, #e8ecf6)', muted: 'var(--text-muted, #8f9ab5)',
  edge: 'var(--text-muted, #8f9ab5)', accent: 'var(--accent, #6d8cff)', note: '#f5e7a1',
  system: 'var(--text-muted, #8f9ab5)', head: 'var(--accent-tint-2, #2a3558)',
};

export const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy word wrap by character budget (labels are short; no font metrics needed). */
export function wrapLabel(label: string, maxChars: number, maxLines = 4): string[] {
  const lines: string[] = [];
  for (const paragraph of label.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!current) current = word;
      else if ((current + ' ' + word).length <= maxChars) current += ` ${word}`;
      else { lines.push(current); current = word; }
    }
    lines.push(current);
  }
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`;
    return cut;
  }
  return lines.length ? lines : [''];
}

const center = (n: DiagramNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

/** Where the line from `n`'s centre towards (tx, ty) leaves the node's outline. */
export function borderPoint(n: DiagramNode, tx: number, ty: number): { x: number; y: number } {
  const c = center(n);
  const dx = tx - c.x, dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = n.w / 2, hh = n.h / 2;
  if (n.kind === 'usecase' || n.kind === 'cloud') {
    const t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  if (n.kind === 'decision') {
    const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  const t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

interface EdgeGeometry { path: string; label: { x: number; y: number }; start: { x: number; y: number }; end: { x: number; y: number }; startDir: { x: number; y: number }; endDir: { x: number; y: number } }

function edgeGeometry(d: Diagram, edge: DiagramEdge): EdgeGeometry | null {
  const a = d.nodes.find((n) => n.id === edge.from), b = d.nodes.find((n) => n.id === edge.to);
  if (!a || !b) return null;
  if (a.id === b.id) {
    const x = a.x + a.w, y = a.y + a.h / 2;
    return {
      path: `M ${x} ${y - 12} C ${x + 46} ${y - 40}, ${x + 46} ${y + 40}, ${x} ${y + 12}`,
      label: { x: x + 40, y }, start: { x, y: y - 12 }, end: { x, y: y + 12 },
      startDir: { x: 1, y: 0 }, endDir: { x: 1, y: 0 },
    };
  }
  // Several edges between the same pair bow out so they don't overlap.
  const siblings = d.edges.filter((e) => (e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from));
  const slot = siblings.findIndex((e) => e.id === edge.id);
  const forwardAxis = d.direction === 'LR' ? (b.x + b.w / 2) - (a.x + a.w / 2) : (b.y + b.h / 2) - (a.y + a.h / 2);
  // Edges that run against the layout direction (loops back) bow out so they don't overlap the forward flow.
  const bow = siblings.length > 1 ? (slot - (siblings.length - 1) / 2) * 38 : (forwardAxis < -20 ? 34 : 0);
  const ca = center(a), cb = center(b);
  const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
  const nx = -(cb.y - ca.y) / len, ny = (cb.x - ca.x) / len;
  const control = { x: mid.x + nx * bow * 2, y: mid.y + ny * bow * 2 };
  const aim = bow === 0 ? cb : control, aimB = bow === 0 ? ca : control;
  const start = borderPoint(a, aim.x, aim.y), end = borderPoint(b, aimB.x, aimB.y);
  const path = bow === 0
    ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  const label = bow === 0
    ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    : { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 };
  const unit = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
  };
  return { path, label, start, end, startDir: unit(start, bow === 0 ? end : control), endDir: unit(bow === 0 ? start : control, end) };
}

export interface RenderOptions {
  palette?: Palette;
  selectedNodes?: string[];
  selectedEdges?: string[];
  /** Adds the resize / connect handles of the single selected node. */
  handles?: boolean;
  /** Include data-* hooks used by the editor's hit testing. */
  interactive?: boolean;
  /** Hides the label of this node (an inline editor is covering it). */
  editingNode?: string | null;
  editingEdge?: string | null;
}

function fieldRow(field: string, x: number, y: number, p: Palette): string {
  const parts = field.trim().split(/\s+/);
  const keys = parts.filter((w) => /^(PK|FK|UK)$/i.test(w));
  const rest = parts.filter((w) => !/^(PK|FK|UK)$/i.test(w)).join(' ');
  const badge = keys.map((k) => `<tspan font-weight="700" style="fill:${p.accent}" dx="6">${escapeXml(k.toUpperCase())}</tspan>`).join('');
  return `<text x="${x}" y="${y}" font-size="12" style="fill:${p.text}" font-family="ui-monospace,Menlo,Consolas,monospace">${escapeXml(rest)}${badge}</text>`;
}

function nodeSvg(n: DiagramNode, p: Palette, selected: boolean, editing: boolean, interactive: boolean): string {
  const fill = n.fill ?? (n.kind === 'note' ? p.note : p.node);
  const stroke = selected ? p.accent : (n.stroke ?? p.nodeStroke);
  const sw = selected ? 2.4 : 1.4;
  const style = `style="fill:${fill};stroke:${stroke};stroke-width:${sw}"`;
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const maxChars = Math.max(6, Math.floor((n.w - 20) / 7));
  // Notes keep a pale fill in every theme, so their text stays dark.
  const ink = n.kind === 'note' && !n.fill ? '#2b2a1e' : p.text;
  const text = (lines: string[], y0: number, extra = '') => {
    const lh = 16;
    const top = y0 - ((lines.length - 1) * lh) / 2;
    return `<text text-anchor="middle" font-size="13" ${extra} style="fill:${ink};stroke:none">${lines
      .map((line, i) => `<tspan x="${cx}" y="${top + i * lh + 4.5}">${escapeXml(line)}</tspan>`).join('')}</text>`;
  };
  const label = editing ? '' : text(wrapLabel(n.label, maxChars), cy);
  let body = '';
  switch (n.kind) {
    case 'terminator':
      body = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.h / 2}" ${style}/>${label}`;
      break;
    case 'decision':
      body = `<polygon points="${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}" ${style}/>${editing ? '' : text(wrapLabel(n.label, Math.max(6, Math.floor((n.w - 60) / 7)), 3), cy)}`;
      break;
    case 'io': {
      const s = 18;
      body = `<polygon points="${n.x + s},${n.y} ${n.x + n.w},${n.y} ${n.x + n.w - s},${n.y + n.h} ${n.x},${n.y + n.h}" ${style}/>${label}`;
      break;
    }
    case 'database': {
      const ry = Math.min(12, n.h / 5);
      body = `<path d="M ${n.x} ${n.y + ry} A ${n.w / 2} ${ry} 0 0 1 ${n.x + n.w} ${n.y + ry} V ${n.y + n.h - ry} A ${n.w / 2} ${ry} 0 0 1 ${n.x} ${n.y + n.h - ry} Z" ${style}/>`
        + `<path d="M ${n.x} ${n.y + ry} A ${n.w / 2} ${ry} 0 0 0 ${n.x + n.w} ${n.y + ry}" style="fill:none;stroke:${stroke};stroke-width:${sw}"/>${editing ? '' : text(wrapLabel(n.label, maxChars, 3), cy + ry / 2)}`;
      break;
    }
    case 'document':
      body = `<path d="M ${n.x} ${n.y} H ${n.x + n.w} V ${n.y + n.h - 10} C ${n.x + n.w * 0.75} ${n.y + n.h - 24}, ${n.x + n.w * 0.5} ${n.y + n.h + 4}, ${n.x} ${n.y + n.h - 8} Z" ${style}/>${editing ? '' : text(wrapLabel(n.label, maxChars, 3), cy - 4)}`;
      break;
    case 'queue':
      body = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${Math.min(18, n.h / 2)}" ${style}/><line x1="${n.x + 22}" y1="${n.y}" x2="${n.x + 22}" y2="${n.y + n.h}" style="stroke:${stroke};stroke-width:1"/>${label}`;
      break;
    case 'cloud':
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${n.w / 2}" ry="${n.h / 2}" ${style} stroke-dasharray="6 3"/>${label}`;
      break;
    case 'usecase':
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${n.w / 2}" ry="${n.h / 2}" ${style}/>${editing ? '' : text(wrapLabel(n.label, Math.max(6, Math.floor((n.w - 40) / 7)), 3), cy)}`;
      break;
    case 'actor': {
      const top = n.y + 4;
      const sc = `style="fill:none;stroke:${stroke};stroke-width:${sw + 0.2}"`;
      body = `<circle cx="${cx}" cy="${top + 11}" r="10" style="fill:${fill};stroke:${stroke};stroke-width:${sw}"/>`
        + `<path d="M ${cx} ${top + 21} V ${top + 52} M ${cx - 18} ${top + 32} H ${cx + 18} M ${cx} ${top + 52} L ${cx - 15} ${top + 72} M ${cx} ${top + 52} L ${cx + 15} ${top + 72}" ${sc}/>`
        + (editing ? '' : `<text x="${cx}" y="${n.y + n.h - 2}" text-anchor="middle" font-size="13" style="fill:${p.text};stroke:none">${escapeXml(n.label.slice(0, 18))}</text>`);
      break;
    }
    case 'note':
      body = `<path d="M ${n.x} ${n.y} H ${n.x + n.w - 14} L ${n.x + n.w} ${n.y + 14} V ${n.y + n.h} H ${n.x} Z" ${style}/>`
        + `<path d="M ${n.x + n.w - 14} ${n.y} V ${n.y + 14} H ${n.x + n.w}" style="fill:none;stroke:${stroke};stroke-width:1"/>${editing ? '' : text(wrapLabel(n.label, maxChars, 4), cy)}`;
      break;
    case 'system':
      body = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" style="fill:none;stroke:${selected ? p.accent : p.system};stroke-width:${sw};stroke-dasharray:8 5"/>`
        + (editing ? '' : `<text x="${n.x + 14}" y="${n.y + 22}" font-size="13" font-weight="600" style="fill:${p.muted};stroke:none">${escapeXml(n.label)}</text>`);
      break;
    case 'entity': {
      const rows = n.fields && n.fields.length ? n.fields : [''];
      body = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" ${style}/>`
        + `<path d="M ${n.x} ${n.y + HEAD_H} V ${n.y + 6} Q ${n.x} ${n.y} ${n.x + 6} ${n.y} H ${n.x + n.w - 6} Q ${n.x + n.w} ${n.y} ${n.x + n.w} ${n.y + 6} V ${n.y + HEAD_H} Z" style="fill:${p.head};stroke:${stroke};stroke-width:${sw}"/>`
        + (editing ? '' : `<text x="${cx}" y="${n.y + 20}" text-anchor="middle" font-size="13" font-weight="700" style="fill:${p.text};stroke:none">${escapeXml(n.label)}</text>`)
        + rows.map((f, i) => fieldRow(f, n.x + 10, n.y + HEAD_H + 17 + i * ROW_H, p)).join('');
      break;
    }
    default:
      body = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" ${style}/>${label}`;
  }
  return `<g${interactive ? ` data-node="${escapeXml(n.id)}"` : ''}>${body}</g>`;
}

function arrowHead(point: { x: number; y: number }, dir: { x: number; y: number }, color: string): string {
  const size = 10, spread = 5;
  const bx = point.x - dir.x * size, by = point.y - dir.y * size;
  const px = -dir.y * spread, py = dir.x * spread;
  return `<polygon points="${point.x},${point.y} ${bx + px},${by + py} ${bx - px},${by - py}" style="fill:${color};stroke:none"/>`;
}

function labelPill(text: string, x: number, y: number, p: Palette, small = false): string {
  const size = small ? 11 : 12;
  const w = Math.max(14, text.length * (size * 0.58) + 10);
  return `<rect x="${x - w / 2}" y="${y - 9}" width="${w}" height="18" rx="4" style="fill:${p.bg === 'transparent' ? 'var(--bg-workspace, #0f1320)' : p.bg};stroke:none;opacity:0.92"/>`
    + `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="${size}" style="fill:${p.text};stroke:none">${escapeXml(text)}</text>`;
}

function edgeSvg(d: Diagram, edge: DiagramEdge, p: Palette, selected: boolean, editing: boolean, interactive: boolean): string {
  const g = edgeGeometry(d, edge);
  if (!g) return '';
  const color = selected ? p.accent : p.edge;
  const dash = edge.dashed ? ' stroke-dasharray="7 5"' : '';
  const heads = (edge.arrow === 'none' ? '' : arrowHead(g.end, g.endDir, color))
    + (edge.arrow === 'both' ? arrowHead(g.start, { x: -g.startDir.x, y: -g.startDir.y }, color) : '');
  const near = (pt: { x: number; y: number }, dir: { x: number; y: number }, text: string, sign: number) =>
    labelPill(text, pt.x + dir.x * 16 * sign - dir.y * 12, pt.y + dir.y * 16 * sign + dir.x * 12, p, true);
  return `<g${interactive ? ` data-edge="${escapeXml(edge.id)}"` : ''}>`
    + (interactive ? `<path d="${g.path}" style="fill:none;stroke:transparent;stroke-width:14" pointer-events="stroke"/>` : '')
    + `<path d="${g.path}" style="fill:none;stroke:${color};stroke-width:${selected ? 2.4 : 1.5}"${dash}/>${heads}`
    + (edge.label && !editing ? labelPill(edge.label, g.label.x, g.label.y, p) : '')
    + (edge.fromLabel ? near(g.start, g.startDir, edge.fromLabel, 1) : '')
    + (edge.toLabel ? near(g.end, { x: -g.endDir.x, y: -g.endDir.y }, edge.toLabel, 1) : '')
    + '</g>';
}

/** Inner SVG markup (no <svg> wrapper) for the diagram. */
export function renderDiagramContent(d: Diagram, options: RenderOptions = {}): string {
  const p = options.palette ?? LIGHT_PALETTE;
  const selectedNodes = new Set(options.selectedNodes ?? []);
  const selectedEdges = new Set(options.selectedEdges ?? []);
  const interactive = options.interactive === true;
  const containers = d.nodes.filter(isContainer).map((n) => nodeSvg(n, p, selectedNodes.has(n.id), options.editingNode === n.id, interactive));
  const edges = d.edges.map((e) => edgeSvg(d, e, p, selectedEdges.has(e.id), options.editingEdge === e.id, interactive));
  const nodes = d.nodes.filter((n) => !isContainer(n)).map((n) => nodeSvg(n, p, selectedNodes.has(n.id), options.editingNode === n.id, interactive));
  let handles = '';
  if (options.handles && selectedNodes.size === 1) {
    const n = d.nodes.find((node) => selectedNodes.has(node.id));
    if (n) {
      handles = `<g data-handle="connect"><circle cx="${n.x + n.w + 14}" cy="${n.y + n.h / 2}" r="8" style="fill:${p.accent};stroke:#fff;stroke-width:1.5;cursor:crosshair"/>`
        + `<path d="M ${n.x + n.w + 10} ${n.y + n.h / 2} h 8 m -3 -3 l 3 3 l -3 3" style="fill:none;stroke:#fff;stroke-width:1.5;pointer-events:none"/></g>`
        + `<rect data-handle="resize" x="${n.x + n.w - 5}" y="${n.y + n.h - 5}" width="10" height="10" rx="2" style="fill:${p.accent};stroke:#fff;stroke-width:1.5;cursor:nwse-resize"/>`;
    }
  }
  return containers.join('') + edges.join('') + nodes.join('') + handles;
}

/** A complete standalone SVG document (light palette by default), cropped to the content. */
export function renderDiagramSvg(d: Diagram, options: RenderOptions = {}): string {
  const b = boundsOf(d);
  const pad = 40;
  const x = Math.floor(b.x - pad), y = Math.floor(b.y - pad);
  const w = Math.ceil(b.w + pad * 2 + 30), h = Math.ceil(b.h + pad * 2);
  const p = options.palette ?? LIGHT_PALETTE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" font-family="system-ui,-apple-system,Segoe UI,sans-serif">`
    + `<title>${escapeXml(d.title)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" style="fill:${p.bg}"/>`
    + renderDiagramContent(d, { ...options, palette: p })
    + '</svg>';
}

/* ---------- starter templates ---------- */

export function templateDiagram(type: DiagramType, title: string): Diagram {
  const base = emptyDiagram(title, type);
  const node = (id: string, kind: NodeKind, label: string, fields?: string[]): DiagramNode => ({ id, kind, label, x: 0, y: 0, ...defaultSize(kind, fields), ...(fields ? { fields } : {}) });
  let d: Diagram = base;
  if (type === 'flowchart') {
    d = { ...base, nodes: [node('start', 'terminator', 'Start'), node('step', 'process', 'Process step'), node('check', 'decision', 'Done?'), node('end', 'terminator', 'End')],
      edges: [{ id: 'e1', from: 'start', to: 'step' }, { id: 'e2', from: 'step', to: 'check' }, { id: 'e3', from: 'check', to: 'end', label: 'yes' }, { id: 'e4', from: 'check', to: 'step', label: 'no' }] };
  } else if (type === 'erd') {
    d = { ...base, nodes: [node('user', 'entity', 'User', ['id PK', 'email', 'name']), node('order', 'entity', 'Order', ['id PK', 'user_id FK', 'total'])],
      edges: [{ id: 'e1', from: 'user', to: 'order', label: 'places', fromLabel: '1', toLabel: 'N' }] };
  } else if (type === 'usecase') {
    d = { ...base, nodes: [node('actor', 'actor', 'User'), { ...node('box', 'system', 'System'), x: 0, y: 0 }, { ...node('uc1', 'usecase', 'Sign in'), parent: 'box' }, { ...node('uc2', 'usecase', 'View report'), parent: 'box' }],
      edges: [{ id: 'e1', from: 'actor', to: 'uc1', arrow: 'none' }, { id: 'e2', from: 'actor', to: 'uc2', arrow: 'none' }] };
  } else if (type === 'architecture') {
    d = { ...base, nodes: [node('web', 'process', 'Web app'), node('api', 'process', 'API service'), node('db', 'database', 'Database'), node('ext', 'cloud', 'External service')],
      edges: [{ id: 'e1', from: 'web', to: 'api', label: 'HTTPS' }, { id: 'e2', from: 'api', to: 'db', label: 'SQL' }, { id: 'e3', from: 'api', to: 'ext', dashed: true }] };
  }
  return d.nodes.length ? autoLayout(d, d.direction) : d;
}
