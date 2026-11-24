import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronLeft, Copy, FileCode2, GitFork, Image as ImageIcon, Layers, LayoutTemplate, Maximize, Plus,
  Keyboard, Redo2, Trash2, Undo2, ZoomIn, ZoomOut, Workflow, MousePointer2, Check, X,
} from 'lucide-react';
import { CanvasContextMenu, type CanvasMenuEntry } from '../../app/CanvasContextMenu';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel, type CanvasSelection } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeFile } from '../../lib/tauriClient';
import {
  DIAGRAM_TYPES, NODE_KINDS, THEME_PALETTE, autoLayout, boundsOf, defaultSize,
  emptyDiagram, entityHeight, fitContainers, kindLabel, renderDiagramContent, renderDiagramSvg,
  templateDiagram, toMermaid, validateDiagram, LIGHT_PALETTE,
  type Diagram, type DiagramEdge, type DiagramNode, type DiagramType, type NodeKind,
} from './diagram';
import {
  DIAGRAM_CHANGED, DIAGRAM_OPEN, diagramPath, loadDiagram, listDiagramRefs, notifyDiagramChanged, registerDiagramFlush,
  removeDiagram, saveDiagram, setOpenDiagram, takePendingOpenDiagram, type DiagramChange,
} from './diagramStore';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import './DiagramScreen.css';

interface View { x: number; y: number; k: number }
type Sel = { type: 'node' | 'edge'; id: string } | null;
type Tool = 'select' | 'connect';

const ADD_KEYS: Array<{ key: string; kind: NodeKind; label: string }> = [
  { key: '1', kind: 'process', label: 'Process' }, { key: '2', kind: 'decision', label: 'Decision' }, { key: '3', kind: 'terminator', label: 'Start / end' },
  { key: '4', kind: 'database', label: 'Database' }, { key: '5', kind: 'actor', label: 'Actor' }, { key: '6', kind: 'note', label: 'Note' },
];

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Add', items: ADD_KEYS.map((a) => ({ keys: a.key, label: `Add ${a.label.toLowerCase()}` })) },
  { title: 'Tools', items: [{ keys: 'V', label: 'Select' }, { keys: 'C', label: 'Connect two shapes' }, { keys: 'L', label: 'Auto layout' }] },
  { title: 'Edit', items: [
    { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+D', label: 'Duplicate' },
    { keys: 'Delete / Backspace', label: 'Delete' }, { keys: 'Enter / F2', label: 'Edit the label' }, { keys: 'Ctrl+S', label: 'Save now' },
    { keys: 'Arrows', label: 'Nudge (Shift = 10)' },
  ] },
  { title: 'Select', items: [{ keys: 'Tab / Shift+Tab', label: 'Next / previous shape' }, { keys: 'Esc', label: 'Clear selection / back to Select' }] },
  { title: 'View', items: [
    { keys: '+ / -', label: 'Zoom in / out' }, { keys: 'Ctrl+Scroll', label: 'Zoom at the cursor' }, { keys: 'Shift+0', label: 'Zoom to 100%' },
    { keys: 'Shift+1 / Ctrl+0', label: 'Fit everything' }, { keys: 'Shift+2', label: 'Zoom to the selection' }, { keys: 'Ctrl+Shift+E', label: 'Export' }, { keys: '?', label: 'This list' },
  ] },
];

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'resize'; id: string; start: { x: number; y: number }; w: number; h: number; moved: boolean }
  | { kind: 'connect'; from: string };

const MIN_K = 0.2;
const MAX_K = 3;
const LAST_KEY = 'pigry:diagram-last';
const SAVE_DELAY = 700;

const TEMPLATES: Array<{ type: DiagramType; label: string; hint: string }> = [
  { type: 'flowchart', label: 'Flowchart', hint: 'Processes, decisions, start/end' },
  { type: 'erd', label: 'ER diagram', hint: 'Entities, fields, relationships' },
  { type: 'usecase', label: 'Use case', hint: 'Actors and system boundary' },
  { type: 'architecture', label: 'Architecture', hint: 'Services, databases, external systems' },
  { type: 'generic', label: 'Blank', hint: 'Start from an empty canvas' },
];

const PALETTE_KINDS: NodeKind[] = ['process', 'terminator', 'decision', 'io', 'entity', 'database', 'actor', 'usecase', 'system', 'document', 'queue', 'cloud', 'note'];

function KindPreview({ kind }: { kind: NodeKind }) {
  const markup = useMemo(() => {
    const size = defaultSize(kind, kind === 'entity' ? ['id PK', 'name'] : undefined);
    const node: DiagramNode = { id: 'p', kind, label: kind === 'system' ? 'System' : kindLabel(kind).split(' ')[0], x: 0, y: 0, ...size, ...(kind === 'entity' ? { fields: ['id PK', 'name'] } : {}) };
    const d: Diagram = { ...emptyDiagram('p'), nodes: [node] };
    const b = boundsOf(d);
    const pad = 6;
    return `<svg viewBox="${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}" preserveAspectRatio="xMidYMid meet">${renderDiagramContent(d, { palette: THEME_PALETTE })}</svg>`;
  }, [kind]);
  return <span className="dgm-kind__preview" dangerouslySetInnerHTML={{ __html: markup }} />;
}

export function DiagramScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Diagram>(() => emptyDiagram());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [editing, setEditing] = useState<{ type: 'node' | 'edge'; id: string } | null>(null);
  const [editText, setEditText] = useState('');
  const [link, setLink] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [creating, setCreating] = useState<DiagramType | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The agent rail needs room: open by default only on wide windows.
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1500);
  const [aiWidth, setAiWidth] = useState(360);

  const docRef = useRef(doc);
  const dirtyRef = useRef(false);
  const currentRef = useRef<string | null>(null);
  const viewRef = useRef(view);
  const selRef = useRef<Sel>(null);
  const undoStack = useRef<Diagram[]>([]);
  const redoStack = useRef<Diagram[]>([]);
  const lastKey = useRef<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => { docRef.current = doc; }, [doc]);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  useLayoutEffect(() => { selRef.current = sel; }, [sel]);
  useLayoutEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useLayoutEffect(() => { currentRef.current = current; }, [current]);

  const syncHist = () => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  /** "owner/name" key to file reference (a bare name belongs to the user's folder). */
  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key);
    return { owner: owner ?? USER_OWNER, slug };
  };

  /* ---- persistence ---- */

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current);
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      await saveDiagram(ref, docRef.current, 'editor');
      // Edits made while the write was in flight keep the diagram dirty.
      setDirty(dirtyRef.current);
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the diagram: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerDiagramFlush(saveNow), [saveNow]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const ref = refOf(currentRef.current);
    if (dirtyRef.current && ref) void saveDiagram(ref, docRef.current, 'editor');
  }, []);

  const fitView = useCallback((target?: Diagram) => {
    const stage = stageRef.current;
    const d = target ?? docRef.current;
    if (!stage) return;
    const b = boundsOf(d);
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    const k = Math.min(1.4, Math.max(MIN_K, Math.min((w - 120) / (b.w + 60), (h - 120) / (b.h + 60))));
    setView({ k, x: (w - b.w * k) / 2 - b.x * k, y: (h - b.h * k) / 2 - b.y * k });
  }, []);

  const resetEditing = () => { setEditing(null); setLink(null); setSel(null); setTool('select'); };

  const openDiagram = useCallback(async (name: string, opts?: { keepSelection?: boolean; asUndo?: boolean }) => {
    await saveNow();
    const target = refOf(name);
    if (!target) return;
    try {
      const { diagram, ref, warnings } = await loadDiagram(target);
      const key = refKey(ref);
      if (opts?.asUndo) { undoStack.current.push(docRef.current); redoStack.current = []; } else { undoStack.current = []; redoStack.current = []; }
      lastKey.current = null;
      docRef.current = diagram;
      setDoc(diagram);
      setCurrent(key);
      currentRef.current = key;
      setDirty(false);
      syncHist();
      if (!opts?.keepSelection) resetEditing();
      setOpenDiagram(key);
      try { localStorage.setItem(LAST_KEY, key); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Diagram opened with ${warnings.length} repaired issue(s).`);
      window.requestAnimationFrame(() => { if (!opts?.asUndo) fitView(diagram); });
    } catch (error) {
      notify(`Could not open "${name}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify, fitView]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listDiagramRefs()); } catch { setRefs([]); }
  }, []);

  // Initial load: list diagrams, then open the requested / last used one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listDiagramRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const wanted = takePendingOpenDiagram() ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openDiagram(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent tools write the files — reload what is open; the editor is the source of truth otherwise.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<DiagramChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setOpenDiagram(null); setDoc(emptyDiagram()); return; }
      if (change.source === 'agent') void openDiagram(change.key, { keepSelection: true, asUndo: true });
    };
    const onOpen = (event: Event) => { void openDiagram((event as CustomEvent<string>).detail); takePendingOpenDiagram(); };
    window.addEventListener(DIAGRAM_CHANGED, onChanged);
    window.addEventListener(DIAGRAM_OPEN, onOpen);
    return () => {
      window.removeEventListener(DIAGRAM_CHANGED, onChanged);
      window.removeEventListener(DIAGRAM_OPEN, onOpen);
    };
  }, [openDiagram, refreshList]);

  /* ---- editing model ---- */

  /** Applies a change. Edits sharing a `key` (typing in one field) merge into one undo step. */
  const commit = useCallback((next: Diagram, key?: string) => {
    if (!(key && lastKey.current === key)) {
      undoStack.current.push(docRef.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
    }
    lastKey.current = key ?? null;
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    dirtyRef.current = true;
    syncHist();
    scheduleSave();
  }, [scheduleSave]);

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = prev; setDoc(prev); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
    if (selRef.current && !prev.nodes.some((n) => n.id === selRef.current?.id) && !prev.edges.some((e) => e.id === selRef.current?.id)) setSel(null);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = next; setDoc(next); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
  };

  const patchNode = (id: string, patch: Partial<DiagramNode>, key?: string) => {
    const d = docRef.current;
    let nodes = d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    nodes = nodes.map((n) => (n.id === id && n.kind === 'entity' ? { ...n, h: entityHeight(n.fields), w: Math.max(120, n.w) } : n));
    commit(fitContainers({ ...d, nodes }), key);
  };
  const patchEdge = (id: string, patch: Partial<DiagramEdge>, key?: string) => {
    const d = docRef.current;
    commit({ ...d, edges: d.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }, key);
  };

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - v.x) / v.k, y: (clientY - (rect?.top ?? 0) - v.y) / v.k };
  };

  const nodeAt = (x: number, y: number): DiagramNode | undefined => {
    const nodes = docRef.current.nodes;
    const hit = (n: DiagramNode) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h;
    return [...nodes].reverse().find((n) => n.kind !== 'system' && hit(n)) ?? [...nodes].reverse().find(hit);
  };

  const addNode = (kind: NodeKind, at?: { x: number; y: number }) => {
    const stage = stageRef.current;
    const v = viewRef.current;
    const size = defaultSize(kind, kind === 'entity' ? ['id PK'] : undefined);
    const cx = at ? at.x : ((stage?.clientWidth ?? 600) / 2 - v.x) / v.k;
    const cy = at ? at.y : ((stage?.clientHeight ?? 400) / 2 - v.y) / v.k;
    const d = docRef.current;
    const taken = new Set(d.nodes.map((n) => n.id));
    let i = d.nodes.length + 1;
    while (taken.has(`n${i}`)) i += 1;
    const jitter = at ? 0 : (d.nodes.length % 6) * 18;
    const node: DiagramNode = {
      id: `n${i}`, kind, label: kind === 'entity' ? 'Entity' : kind === 'system' ? 'System' : kindLabel(kind).split(' / ')[0],
      x: Math.round(cx - size.w / 2 + jitter), y: Math.round(cy - size.h / 2 + jitter), ...size,
      ...(kind === 'entity' ? { fields: ['id PK'] } : {}),
    };
    commit({ ...d, nodes: [...d.nodes, node] });
    setSel({ type: 'node', id: node.id });
    setEditing({ type: 'node', id: node.id });
    setEditText(node.label);
  };

  const deleteSelection = () => {
    const s = selRef.current;
    if (!s) return;
    const d = docRef.current;
    if (s.type === 'node') {
      commit({
        ...d,
        nodes: d.nodes.filter((n) => n.id !== s.id).map((n) => (n.parent === s.id ? { ...n, parent: undefined } : n)),
        edges: d.edges.filter((e) => e.from !== s.id && e.to !== s.id),
      });
    } else {
      commit({ ...d, edges: d.edges.filter((e) => e.id !== s.id) });
    }
    setSel(null);
  };

  const duplicateSelection = () => {
    const s = selRef.current;
    if (!s || s.type !== 'node') return;
    const d = docRef.current;
    const src = d.nodes.find((n) => n.id === s.id);
    if (!src) return;
    const taken = new Set(d.nodes.map((n) => n.id));
    let i = d.nodes.length + 1;
    while (taken.has(`n${i}`)) i += 1;
    const copy: DiagramNode = { ...src, id: `n${i}`, x: src.x + 30, y: src.y + 30, fields: src.fields ? [...src.fields] : undefined };
    commit({ ...d, nodes: [...d.nodes, copy] });
    setSel({ type: 'node', id: copy.id });
  };

  const connect = (from: string, to: string) => {
    const d = docRef.current;
    const taken = new Set(d.edges.map((e) => e.id));
    let i = d.edges.length + 1;
    while (taken.has(`e${i}`)) i += 1;
    const edge: DiagramEdge = { id: `e${i}`, from, to, ...(d.type === 'erd' ? { fromLabel: '1', toLabel: 'N' } : {}) };
    commit({ ...d, edges: [...d.edges, edge] });
    setSel({ type: 'edge', id: edge.id });
  };

  const commitLabel = () => {
    if (!editing) return;
    const text = editText.replace(/\s+$/, '');
    if (editing.type === 'node') patchNode(editing.id, { label: text || docRef.current.nodes.find((n) => n.id === editing.id)?.label || 'Node' });
    else patchEdge(editing.id, { label: text || undefined });
    lastKey.current = null;
    setEditing(null);
  };

  /* ---- pointer interaction ---- */

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 2) return; // right click is handled by onContextMenu
    if (editing) commitLabel();
    const target = event.target as Element;
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node');
    const edgeId = target.closest('[data-edge]')?.getAttribute('data-edge');
    const p = worldPoint(event.clientX, event.clientY);
    svgRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const s = selRef.current;
    if (handle === 'connect' && s?.type === 'node') {
      dragRef.current = { kind: 'connect', from: s.id };
      const n = docRef.current.nodes.find((x) => x.id === s.id);
      if (n) setLink({ x1: n.x + n.w / 2, y1: n.y + n.h / 2, x2: p.x, y2: p.y });
      return;
    }
    if (handle === 'resize' && s?.type === 'node') {
      const n = docRef.current.nodes.find((x) => x.id === s.id);
      if (n) dragRef.current = { kind: 'resize', id: n.id, start: p, w: n.w, h: n.h, moved: false };
      return;
    }
    if (nodeId) {
      if (tool === 'connect') {
        dragRef.current = { kind: 'connect', from: nodeId };
        const n = docRef.current.nodes.find((x) => x.id === nodeId);
        if (n) setLink({ x1: n.x + n.w / 2, y1: n.y + n.h / 2, x2: p.x, y2: p.y });
        setSel({ type: 'node', id: nodeId });
        return;
      }
      setSel({ type: 'node', id: nodeId });
      const origin = new Map<string, { x: number; y: number }>();
      const moving = docRef.current.nodes.find((n) => n.id === nodeId);
      if (moving) origin.set(moving.id, { x: moving.x, y: moving.y });
      if (moving?.kind === 'system') {
        for (const kid of docRef.current.nodes.filter((n) => n.parent === moving.id)) origin.set(kid.id, { x: kid.x, y: kid.y });
      }
      dragRef.current = { kind: 'move', start: p, origin, moved: false };
      return;
    }
    if (edgeId) { setSel({ type: 'edge', id: edgeId }); return; }
    setSel(null);
    dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, view: viewRef.current };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'pan') {
      setView({ ...drag.view, x: drag.view.x + event.clientX - drag.startX, y: drag.view.y + event.clientY - drag.startY });
      return;
    }
    const p = worldPoint(event.clientX, event.clientY);
    if (drag.kind === 'connect') {
      setLink((l) => (l ? { ...l, x2: p.x, y2: p.y } : l));
      return;
    }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * viewRef.current.k < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      undoStack.current.push(docRef.current);
      redoStack.current = [];
      lastKey.current = null;
      syncHist();
    }
    const d = docRef.current;
    let nodes: DiagramNode[];
    if (drag.kind === 'move') {
      nodes = d.nodes.map((n) => {
        const o = drag.origin.get(n.id);
        return o ? { ...n, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : n;
      });
    } else {
      nodes = d.nodes.map((n) => (n.id === drag.id
        ? { ...n, w: Math.max(n.kind === 'entity' ? 120 : 40, Math.round(drag.w + dx)), h: n.kind === 'entity' ? n.h : Math.max(30, Math.round(drag.h + dy)) }
        : n));
    }
    const next = drag.kind === 'move' ? { ...d, nodes } : fitContainers({ ...d, nodes });
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    dirtyRef.current = true;
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!drag) return;
    if (drag.kind === 'connect') {
      const p = worldPoint(event.clientX, event.clientY);
      const target = nodeAt(p.x, p.y);
      setLink(null);
      if (target && target.kind !== 'system') connect(drag.from, target.id);
      if (tool === 'connect') setTool('select');
      return;
    }
    if ((drag.kind === 'move' || drag.kind === 'resize') && drag.moved) {
      // Containers re-fit around their children after a node was moved.
      const d = docRef.current;
      const fitted = fitContainers(d);
      docRef.current = fitted;
      setDoc(fitted);
      scheduleSave();
    }
  };

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CanvasMenuEntry[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const onContextMenu = (event: React.MouseEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (editing) commitLabel();
    const target = event.target as Element;
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node');
    const edgeId = target.closest('[data-edge]')?.getAttribute('data-edge');
    const hit: Sel | null = nodeId ? { type: 'node', id: nodeId } : edgeId ? { type: 'edge', id: edgeId } : null;
    svgRef.current?.focus();
    setSel(hit);
    setMenu({ x: event.clientX, y: event.clientY, entries: menuEntries({ at: worldPoint(event.clientX, event.clientY), target: hit }) });
  };

  const menuEntries = (menu: { at: { x: number; y: number }; target: Sel | null }): CanvasMenuEntry[] => {
    const d = docRef.current;
    const t = menu.target;
    if (t) {
      const label = t.type === 'node' ? d.nodes.find((n) => n.id === t.id)?.label : d.edges.find((e) => e.id === t.id)?.label;
      const edit = () => { setEditing({ type: t.type, id: t.id }); setEditText(label ?? ''); };
      return [
        { label: t.type === 'node' ? 'Edit label' : 'Edit edge label', shortcut: 'Enter', onSelect: edit },
        ...(t.type === 'node' ? [
          { label: 'Connect from here', onSelect: () => setTool('connect') } as CanvasMenuEntry,
          { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: duplicateSelection } as CanvasMenuEntry,
        ] : []),
        { separator: true },
        { label: 'Delete', shortcut: 'Del', danger: true, onSelect: deleteSelection },
      ];
    }
    const add = (kind: NodeKind, name: string): CanvasMenuEntry => ({ label: `Add ${name} here`, onSelect: () => addNode(kind, menu.at) });
    return [
      add('process', 'process'), add('decision', 'decision'), add('terminator', 'start / end'), add('database', 'database'), add('actor', 'actor'), add('note', 'note'),
      { separator: true },
      { label: 'Auto layout', onSelect: () => runLayout() },
      { label: 'Fit to screen', shortcut: 'Ctrl+0', onSelect: () => fitView() },
      { separator: true },
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: undoStack.current.length === 0, onSelect: undo },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: redoStack.current.length === 0, onSelect: redo },
    ];
  };

  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const target = event.target as Element;
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node');
    const edgeId = target.closest('[data-edge]')?.getAttribute('data-edge');
    if (nodeId) {
      const n = docRef.current.nodes.find((x) => x.id === nodeId);
      if (n) { setSel({ type: 'node', id: n.id }); setEditing({ type: 'node', id: n.id }); setEditText(n.label); }
    } else if (edgeId) {
      const e = docRef.current.edges.find((x) => x.id === edgeId);
      if (e) { setSel({ type: 'edge', id: e.id }); setEditing({ type: 'edge', id: e.id }); setEditText(e.label ?? ''); }
    }
  };

  // Wheel: ctrl/⌘ or trackpad pinch zooms around the cursor, plain wheel pans.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const v = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-event.deltaY * 0.0025)));
        const px = event.clientX - rect.left, py = event.clientY - rect.top;
        setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k });
      } else {
        setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const stage = stageRef.current;
    const v = viewRef.current;
    const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
    const px = (stage?.clientWidth ?? 600) / 2, py = (stage?.clientHeight ?? 400) / 2;
    setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k });
  };

  const cycleSelection = (dir: 1 | -1) => {
    const list = docRef.current.nodes;
    if (list.length === 0) return;
    const at = selRef.current?.type === 'node' ? list.findIndex((n) => n.id === selRef.current?.id) : -1;
    setSel({ type: 'node', id: list[(at + dir + list.length) % list.length].id });
  };

  const zoomToSelection = () => {
    const s = selRef.current;
    const stage = stageRef.current;
    const n = s?.type === 'node' ? docRef.current.nodes.find((x) => x.id === s.id) : undefined;
    if (!n || !stage || !stage.clientWidth || !stage.clientHeight) return;
    const k = Math.min(1.4, Math.max(MIN_K, Math.min((stage.clientWidth - 160) / n.w, (stage.clientHeight - 160) / n.h)));
    setView({ k, x: (stage.clientWidth - n.w * k) / 2 - n.x * k, y: (stage.clientHeight - n.h * k) / 2 - n.y * k });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); void saveNow(); return; }
    if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (mod && event.key === '0') { event.preventDefault(); fitView(); return; }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); setExportOpen(true); return; }
    if (mod) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
    if (event.key === 'Escape') { setSel(null); setTool('select'); setLink(null); return; }
    if ((event.key === 'Enter' || event.key === 'F2') && selRef.current) {
      const s = selRef.current;
      const label = s.type === 'node' ? docRef.current.nodes.find((n) => n.id === s.id)?.label : docRef.current.edges.find((e) => e.id === s.id)?.label;
      setEditing({ type: s.type, id: s.id }); setEditText(label ?? ''); event.preventDefault();
      return;
    }
    if (event.key === '?') { event.preventDefault(); setHelpOpen(true); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.2); return; }
    if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); fitView(); return; }
    if (event.shiftKey && event.code === 'Digit2') { event.preventDefault(); zoomToSelection(); return; }
    if (event.shiftKey && event.code === 'Digit0') { event.preventDefault(); zoomBy(1 / viewRef.current.k); return; }
    if (event.key === 'Tab') { event.preventDefault(); cycleSelection(event.shiftKey ? -1 : 1); return; }
    if (!event.shiftKey) {
      const lower = event.key.toLowerCase();
      if (lower === 'v') { setTool('select'); setLink(null); return; }
      if (lower === 'c') { setTool('connect'); return; }
      if (lower === 'l') { runLayout(); return; }
      const add = ADD_KEYS.find((a) => a.key === event.key);
      if (add) { event.preventDefault(); addNode(add.kind); return; }
    }
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = arrows[event.key];
    if (move && selRef.current?.type === 'node') {
      event.preventDefault();
      const n = docRef.current.nodes.find((x) => x.id === selRef.current?.id);
      if (n) patchNode(n.id, { x: n.x + move[0], y: n.y + move[1] }, `nudge:${n.id}`);
    }
  };

  useEffect(() => { if (editing) editRef.current?.select(); }, [editing]);

  /* ---- diagram-level actions ---- */

  const runLayout = (direction = docRef.current.direction) => {
    commit(autoLayout(docRef.current, direction));
    window.requestAnimationFrame(() => fitView(docRef.current));
  };

  const createDiagram = async (type: DiagramType, rawName: string) => {
    const base = nameSlug(rawName || type);
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    const title = rawName.trim() || (TEMPLATES.find((t) => t.type === type)?.label ?? 'Diagram');
    await saveNow();
    const diagram = templateDiagram(type, title);
    try {
      await saveDiagram({ owner: USER_OWNER, slug }, diagram, 'editor');
      setCreating(null); setNewName('');
      await refreshList();
      await openDiagram(`${USER_OWNER}/${slug}`);
    } catch (error) {
      notify(`Could not create the diagram: ${String(error)}`, 'error');
    }
  };

  const deleteDiagramFile = async (key: string) => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeDiagram(ref);
      const rest = await listDiagramRefs();
      setRefs(rest);
      if (key === currentRef.current) {
        if (rest[0]) await openDiagram(refKey(rest[0])); else { setCurrent(null); setOpenDiagram(null); const empty = emptyDiagram(); docRef.current = empty; setDoc(empty); }
      }
    } catch (error) {
      notify(`Could not delete the diagram: ${String(error)}`, 'error');
    }
  };

  const copyText = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${what} copied to the clipboard.`, 'success'); }
    catch { notify(`Could not copy ${what}.`, 'error'); }
  };

  const savePng = async () => {
    const svg = renderDiagramSvg(docRef.current, { palette: LIGHT_PALETTE });
    const img = new window.Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('render failed')); img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = img.width * 2; canvas.height = img.height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Diagram image copied to the clipboard.', 'success');
    } catch (error) {
      notify(`Could not copy the image: ${String(error)}`, 'error');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const saveSvg = async () => {
    const ref = refOf(currentRef.current);
    if (!ref) return;
    const path = diagramPath(ref).replace(/\.diagram\.json$/, '.svg');
    try {
      await writeWorktreeFile(path, renderDiagramSvg(docRef.current));
      notifyDiagramChanged({ key: refKey(ref), source: 'editor' });
      notify(`Saved ${path}`, 'success');
    } catch (error) {
      notify(`Could not save the SVG: ${String(error)}`, 'error');
    }
  };

  /* ---- render ---- */

  const selectedNode = sel?.type === 'node' ? doc.nodes.find((n) => n.id === sel.id) : undefined;
  const selectedEdge = sel?.type === 'edge' ? doc.edges.find((e) => e.id === sel.id) : undefined;
  const issues = useMemo(() => validateDiagram(doc), [doc]);
  // The chat shows (and sends) whatever is selected on the canvas.
  const canvasContext = useMemo<CanvasSelection | null>(() => {
    if (!current || !sel) return null;
    if (sel.type === 'node') {
      const node = doc.nodes.find((n) => n.id === sel.id);
      if (!node) return null;
      const fields = node.fields?.length ? ` {${node.fields.join('; ')}}` : '';
      const links = doc.edges.filter((e) => e.from === node.id || e.to === node.id).slice(0, 8)
        .map((e) => `  - edge ${e.id}: ${e.from} -> ${e.to}${e.label ? ` "${e.label}"` : ''}`);
      return { kind: 'diagram', doc: current, items: [{ id: node.id, name: node.label || node.id, type: node.kind,
        outline: [`- ${node.id} [${node.kind}] "${node.label}"${fields}${node.parent ? ` (in ${node.parent})` : ''}`, ...links].join('\n') }] };
    }
    const edge = doc.edges.find((e) => e.id === sel.id);
    if (!edge) return null;
    const label = (id: string) => doc.nodes.find((n) => n.id === id)?.label ?? id;
    return { kind: 'diagram', doc: current, items: [{ id: edge.id, name: edge.label || `${label(edge.from)} → ${label(edge.to)}`, type: 'connection',
      outline: `- edge ${edge.id}: ${edge.from} ("${label(edge.from)}") ${edge.dashed ? '-->' : '->'} ${edge.to} ("${label(edge.to)}")${edge.label ? ` "${edge.label}"` : ''}${edge.fromLabel || edge.toLabel ? ` (${edge.fromLabel ?? ''}..${edge.toLabel ?? ''})` : ''}` }] };
  }, [current, sel, doc]);
  const markup = useMemo(() => renderDiagramContent(doc, {
    palette: THEME_PALETTE,
    interactive: true,
    selectedNodes: sel?.type === 'node' ? [sel.id] : [],
    selectedEdges: sel?.type === 'edge' ? [sel.id] : [],
    handles: tool === 'select' && sel?.type === 'node' && !editing,
    editingNode: editing?.type === 'node' ? editing.id : null,
    editingEdge: editing?.type === 'edge' ? editing.id : null,
  }), [doc, sel, tool, editing]);

  const editorBox = (() => {
    if (!editing) return null;
    const v = view;
    if (editing.type === 'node') {
      const n = doc.nodes.find((x) => x.id === editing.id);
      if (!n) return null;
      const w = Math.max(120, n.w * v.k);
      const top = n.kind === 'entity' || n.kind === 'system' ? n.y : n.y + n.h / 2 - 16;
      return { left: (n.x + n.w / 2) * v.k + v.x - w / 2, top: top * v.k + v.y + (n.kind === 'entity' || n.kind === 'system' ? 0 : 0), width: w, height: n.kind === 'entity' || n.kind === 'system' ? 30 * v.k : Math.min(110, Math.max(34, n.h * v.k * 0.6)) };
    }
    const e = doc.edges.find((x) => x.id === editing.id);
    const a = doc.nodes.find((n) => n.id === e?.from), b = doc.nodes.find((n) => n.id === e?.to);
    if (!e || !a || !b) return null;
    const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2, my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
    return { left: mx * v.k + v.x - 70, top: my * v.k + v.y - 14, width: 140, height: 30 };
  })();

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const gridStyle: CSSProperties = { backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` };

  return (
    <div className="screen dgm">
      <header className="screen-header">
        <h1 className="screen-header__title">Diagram</h1>
        <span className="screen-header__meta">Design flows, ER diagrams and architecture — the agent can edit the same canvas</span>
        {current && <span className={`dgm__save dgm__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <button type="button" className="primary-button" onClick={() => setCreating((c) => (c ? null : 'flowchart'))}>
          <Plus size={12} strokeWidth={1.5} /> New diagram
        </button>
      </header>

      <div className="screen-body dgm__body">
        <aside className="dgm__side" aria-label="Diagrams and shapes">
          <section className="dgm__section">
            <h2 className="dgm__heading"><Layers size={12} /> Diagrams <span className="dgm__count">{refs.length}</span></h2>
            {creating && (
              <div className="dgm__new">
                <div className="dgm__templates" role="radiogroup" aria-label="Template">
                  {TEMPLATES.map((t) => (
                    <button key={t.type} type="button" role="radio" aria-checked={creating === t.type} title={t.hint}
                      className={`dgm__chip${creating === t.type ? ' dgm__chip--on' : ''}`} onClick={() => setCreating(t.type)}>{t.label}</button>
                  ))}
                </div>
                <div className="dgm__new-row">
                  <input className="dgm__input" autoFocus placeholder="Diagram name…" aria-label="New diagram name" value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void createDiagram(creating, newName); if (e.key === 'Escape') { setCreating(null); setNewName(''); } }} />
                  <button type="button" className="dgm__icon-btn dgm__icon-btn--ok" aria-label="Create diagram" onClick={() => void createDiagram(creating, newName)}><Check size={13} /></button>
                  <button type="button" className="dgm__icon-btn" aria-label="Cancel" onClick={() => { setCreating(null); setNewName(''); }}><X size={13} /></button>
                </div>
              </div>
            )}
            {refs.length === 0 && !creating && <p className="dgm__empty">No diagrams yet — create one, or ask the agent.</p>}
            {Array.from(refs.reduce((map, ref) => map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]), new Map<string, OwnedRef[]>())).map(([owner, list]) => (
              <div key={owner} className="dgm__group">
                <div className="dgm__owner">{owner}</div>
                <ul className="dgm__list">
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <li key={key} className={`dgm__item${key === current ? ' dgm__item--active' : ''}`}>
                        <button type="button" className="dgm__item-main" onClick={() => { if (key !== current) void openDiagram(key); }} title={diagramPath(ref)}>
                          <Workflow size={12} strokeWidth={1.5} />
                          <span>{ref.slug}</span>
                        </button>
                        {confirmDelete === key ? (
                          <span className="dgm__confirm">
                            <button type="button" className="dgm__icon-btn dgm__icon-btn--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteDiagramFile(key)}><Check size={12} /></button>
                            <button type="button" className="dgm__icon-btn" aria-label="Keep diagram" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </span>
                        ) : (
                          <button type="button" className="dgm__icon-btn dgm__item-del" aria-label={`Delete ${ref.slug}`} title="Delete diagram" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>

          <section className="dgm__section dgm__section--palette">
            <h2 className="dgm__heading"><LayoutTemplate size={12} /> Shapes</h2>
            <div className="dgm__palette">
              {PALETTE_KINDS.map((kind) => (
                <button key={kind} type="button" className="dgm__kind" disabled={!current} title={`Add ${kindLabel(kind).toLowerCase()}`}
                  aria-label={`Add ${kindLabel(kind)}`} onClick={() => addNode(kind)}>
                  <KindPreview kind={kind} />
                  <span>{kindLabel(kind)}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <div className="dgm__main">
          {current ? (
            <>
              <div className="dgm__toolbar" role="toolbar" aria-label="Diagram tools">
                <button type="button" className={`dgm__tool${tool === 'select' ? ' dgm__tool--on' : ''}`} aria-pressed={tool === 'select'} title="Select and move" onClick={() => setTool('select')}><MousePointer2 size={14} /></button>
                <button type="button" className={`dgm__tool${tool === 'connect' ? ' dgm__tool--on' : ''}`} aria-pressed={tool === 'connect'} title="Connect: drag from one shape to another" onClick={() => setTool(tool === 'connect' ? 'select' : 'connect')}><GitFork size={14} /> <span>Connect</span></button>
                <span className="dgm__sep" />
                <button type="button" className="dgm__tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
                <button type="button" className="dgm__tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
                <span className="dgm__sep" />
                <button type="button" className="dgm__tool" title="Arrange automatically" onClick={() => runLayout()}><LayoutTemplate size={14} /> <span>Auto layout</span></button>
                <span className="dgm__sep" />
                <button type="button" className="dgm__tool" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}><ZoomOut size={14} /></button>
                <span className="dgm__zoom">{Math.round(view.k * 100)}%</span>
                <button type="button" className="dgm__tool" aria-label="Zoom in" onClick={() => zoomBy(1.2)}><ZoomIn size={14} /></button>
                <button type="button" className="dgm__tool" aria-label="Fit to screen" title="Fit to screen" onClick={() => fitView()}><Maximize size={14} /></button>
                <button type="button" className="dgm__tool" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
                <span className="dgm__grow" />
                <div className="dgm__menu">
                  <button type="button" className="dgm__tool" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}><ImageIcon size={14} /> <span>Export</span></button>
                  {exportOpen && (
                    <div className="dgm__popup" role="menu" onClick={() => setExportOpen(false)}>
                      <button type="button" role="menuitem" onClick={() => void saveSvg()}><ImageIcon size={13} /> Save SVG to workspace</button>
                      <button type="button" role="menuitem" onClick={() => void copyText(renderDiagramSvg(docRef.current), 'SVG')}><Copy size={13} /> Copy SVG</button>
                      <button type="button" role="menuitem" onClick={() => void savePng()}><ImageIcon size={13} /> Copy PNG image</button>
                      <button type="button" role="menuitem" onClick={() => void copyText(toMermaid(docRef.current), 'Mermaid')}><FileCode2 size={13} /> Copy Mermaid</button>
                    </div>
                  )}
                </div>
              </div>
              <div className={`dgm__stage${tool === 'connect' ? ' dgm__stage--connect' : ''}`} ref={stageRef} style={gridStyle}>
                <svg
                  ref={svgRef}
                  className="dgm__svg"
                  tabIndex={0}
                  role="application"
                  aria-label={`Diagram canvas: ${doc.title}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onDoubleClick={onDoubleClick}
                  onContextMenu={onContextMenu}
                  onKeyDown={onKeyDown}
                >
                  <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                    <g dangerouslySetInnerHTML={{ __html: markup }} />
                    {link && <line x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} className="dgm__link" />}
                  </g>
                </svg>
                {helpOpen && <ShortcutHelp title="Diagram shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
                {menu && <CanvasContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} label="Diagram context menu" />}
                {doc.nodes.length === 0 && (
                  <div className="dgm__hint">
                    <strong>Empty diagram</strong>
                    <span>Add shapes from the left, or ask the agent: “draw the login flow”.</span>
                  </div>
                )}
                {editing && editorBox && (
                  <textarea
                    ref={editRef}
                    className="dgm__editor"
                    aria-label="Edit label"
                    value={editText}
                    style={{ left: editorBox.left, top: editorBox.top, width: editorBox.width, height: editorBox.height }}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitLabel}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitLabel(); svgRef.current?.focus(); }
                      if (e.key === 'Escape') { setEditing(null); svgRef.current?.focus(); }
                      e.stopPropagation();
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="dgm__welcome">
              <Workflow size={34} strokeWidth={1.25} />
              <h2>Diagram editor</h2>
              <p>Create a diagram to start. Pick a template, or ask the SA agent to design one from your requirements.</p>
              <div className="dgm__welcome-grid">
                {TEMPLATES.map((t) => (
                  <button key={t.type} type="button" className="dgm__template" onClick={() => void createDiagram(t.type, t.label)}>
                    <strong>{t.label}</strong><span>{t.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {current && (
          <aside className="dgm__inspector" aria-label="Properties">
            {selectedNode ? (
              <>
                <h2 className="dgm__heading">{kindLabel(selectedNode.kind)}</h2>
                <label className="dgm__field"><span>Label</span>
                  <input className="dgm__input" aria-label="Node label" value={selectedNode.label} onChange={(e) => patchNode(selectedNode.id, { label: e.target.value }, `label:${selectedNode.id}`)} onBlur={() => { lastKey.current = null; }} />
                </label>
                <label className="dgm__field"><span>Shape</span>
                  <select className="dgm__input" aria-label="Node shape" value={selectedNode.kind} onChange={(e) => {
                    const kind = e.target.value as NodeKind;
                    const size = defaultSize(kind, selectedNode.fields);
                    patchNode(selectedNode.id, { kind, ...(kind === 'entity' ? { fields: selectedNode.fields?.length ? selectedNode.fields : ['id PK'] } : {}), w: Math.max(selectedNode.w, size.w), h: size.h });
                  }}>
                    {NODE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
                  </select>
                </label>
                {selectedNode.kind === 'entity' && (
                  <label className="dgm__field"><span>Fields <em>(name type PK/FK, one per line)</em></span>
                    <textarea className="dgm__input dgm__input--area" aria-label="Entity fields" rows={6} spellCheck={false}
                      value={(selectedNode.fields ?? []).join('\n')}
                      onChange={(e) => patchNode(selectedNode.id, { fields: e.target.value.split('\n').slice(0, 40) }, `fields:${selectedNode.id}`)}
                      onBlur={(e) => { lastKey.current = null; patchNode(selectedNode.id, { fields: e.target.value.split('\n').map((f) => f.trim()).filter(Boolean) }); }} />
                  </label>
                )}
                {selectedNode.kind !== 'system' && doc.nodes.some((n) => n.kind === 'system') && (
                  <label className="dgm__field"><span>Inside boundary</span>
                    <select className="dgm__input" aria-label="Boundary" value={selectedNode.parent ?? ''} onChange={(e) => patchNode(selectedNode.id, { parent: e.target.value || undefined })}>
                      <option value="">(none)</option>
                      {doc.nodes.filter((n) => n.kind === 'system').map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                    </select>
                  </label>
                )}
                <label className="dgm__field dgm__field--row"><span>Fill</span>
                  <input type="color" aria-label="Fill colour" value={/^#[0-9a-f]{6}$/i.test(selectedNode.fill ?? '') ? selectedNode.fill : '#2a3558'} onChange={(e) => patchNode(selectedNode.id, { fill: e.target.value }, `fill:${selectedNode.id}`)} onBlur={() => { lastKey.current = null; }} />
                  {selectedNode.fill && <button type="button" className="dgm__link-btn" onClick={() => patchNode(selectedNode.id, { fill: undefined })}>Reset</button>}
                </label>
                <div className="dgm__actions">
                  <button type="button" className="outline-button" onClick={duplicateSelection}><Copy size={12} /> Duplicate</button>
                  <button type="button" className="outline-button dgm__danger" onClick={deleteSelection}><Trash2 size={12} /> Delete</button>
                </div>
                <p className="dgm__tip">Double-click or press Enter to rename. Drag the blue arrow to another shape to connect.</p>
              </>
            ) : selectedEdge ? (
              <>
                <h2 className="dgm__heading">Connection</h2>
                <p className="dgm__tip dgm__tip--top">{doc.nodes.find((n) => n.id === selectedEdge.from)?.label} → {doc.nodes.find((n) => n.id === selectedEdge.to)?.label}</p>
                <label className="dgm__field"><span>Label</span>
                  <input className="dgm__input" aria-label="Edge label" value={selectedEdge.label ?? ''} onChange={(e) => patchEdge(selectedEdge.id, { label: e.target.value || undefined }, `elabel:${selectedEdge.id}`)} onBlur={() => { lastKey.current = null; }} />
                </label>
                <div className="dgm__pair">
                  <label className="dgm__field"><span>Source end</span>
                    <input className="dgm__input" aria-label="Source cardinality" placeholder="1" value={selectedEdge.fromLabel ?? ''} onChange={(e) => patchEdge(selectedEdge.id, { fromLabel: e.target.value || undefined }, `ef:${selectedEdge.id}`)} onBlur={() => { lastKey.current = null; }} />
                  </label>
                  <label className="dgm__field"><span>Target end</span>
                    <input className="dgm__input" aria-label="Target cardinality" placeholder="N" value={selectedEdge.toLabel ?? ''} onChange={(e) => patchEdge(selectedEdge.id, { toLabel: e.target.value || undefined }, `et:${selectedEdge.id}`)} onBlur={() => { lastKey.current = null; }} />
                  </label>
                </div>
                <label className="dgm__field"><span>Arrow</span>
                  <select className="dgm__input" aria-label="Arrow style" value={selectedEdge.arrow ?? 'end'} onChange={(e) => patchEdge(selectedEdge.id, { arrow: e.target.value === 'end' ? undefined : (e.target.value as 'both' | 'none') })}>
                    <option value="end">Arrow at target</option><option value="both">Arrows both ends</option><option value="none">No arrow</option>
                  </select>
                </label>
                <label className="dgm__check"><input type="checkbox" checked={selectedEdge.dashed === true} onChange={(e) => patchEdge(selectedEdge.id, { dashed: e.target.checked || undefined })} /> Dashed line</label>
                <div className="dgm__actions">
                  <button type="button" className="outline-button" onClick={() => patchEdge(selectedEdge.id, { from: selectedEdge.to, to: selectedEdge.from, fromLabel: selectedEdge.toLabel, toLabel: selectedEdge.fromLabel })}>Reverse</button>
                  <button type="button" className="outline-button dgm__danger" onClick={deleteSelection}><Trash2 size={12} /> Delete</button>
                </div>
              </>
            ) : (
              <>
                <h2 className="dgm__heading">Diagram</h2>
                <label className="dgm__field"><span>Title</span>
                  <input className="dgm__input" aria-label="Diagram title" value={doc.title} onChange={(e) => commit({ ...docRef.current, title: e.target.value }, 'title')} onBlur={() => { lastKey.current = null; }} />
                </label>
                <label className="dgm__field"><span>Type</span>
                  <select className="dgm__input" aria-label="Diagram type" value={doc.type} onChange={(e) => commit({ ...docRef.current, type: e.target.value as DiagramType })}>
                    {DIAGRAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="dgm__field"><span>Layout direction</span>
                  <select className="dgm__input" aria-label="Layout direction" value={doc.direction} onChange={(e) => runLayout(e.target.value as 'TB' | 'LR')}>
                    <option value="TB">Top to bottom</option><option value="LR">Left to right</option>
                  </select>
                </label>
                <p className="dgm__stats">{doc.nodes.length} shapes · {doc.edges.length} connections</p>
                {issues.length > 0 && (
                  <div className="dgm__issues" role="status">
                    <strong>Check</strong>
                    <ul>{issues.slice(0, 6).map((issue) => <li key={issue}>{issue}</li>)}</ul>
                  </div>
                )}
                <p className="dgm__tip">Ask the SA agent to draft or change this diagram — it edits the same file and the canvas updates live.</p>
              </>
            )}
          </aside>
        )}

        {aiOpen && (
          <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.55, Math.max(280, w - dx)))} />
        )}
        {aiOpen ? (
          <AiAgentPanel
            width={aiWidth}
            fileName={repository?.name ?? 'pigry'}
            defaultTeam={teamForScreen('diagram')}
            onCollapse={() => setAiOpen(false)}
            canvasSelection={canvasContext}
          />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>
    </div>
  );
}
