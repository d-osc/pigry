import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Check, ChevronLeft, Circle, Copy, Frame, Keyboard, Image as ImageIcon, Layers, LayoutTemplate, Maximize, Minus, MousePointer2,
  PenTool, Plus, Redo2, Square, Type, Trash2, Undo2, X, ZoomIn, ZoomOut, FileCode2,
} from 'lucide-react';
import { CanvasContextMenu, type CanvasMenuEntry } from '../../app/CanvasContextMenu';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel, type CanvasSelection } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import {
  applyDesignOps, applyNodeFields, emptyDesign, layoutDesign, renderDesignContent, renderDesignHtml, renderDesignSvg,
  summarizeDesign, templateDesign, isAutoLayoutFrame, type Design, type DesignNode, type TemplateKind,
} from './design';
import {
  HANDLES, absoluteBox, computeResize, deepestFrameAt, findNode, handlePoint, nodesInRect, parentOf, reorderIndex,
  selectionBounds, siblingsOf, snapMove, stepZOrder, topLevelSelection, allNodes,
  type Box, type Guide, type Handle,
} from './designEdit';
import {
  DESIGN_CHANGED, DESIGN_OPEN, designPath, listDesignRefs, loadDesign, notifyDesignChanged, registerDesignFlush, removeDesign,
  saveDesign, setOpenDesign, takePendingOpenDesign, type DesignChange, type OpenRequest,
} from './designStore';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { svgSize, svgToPng } from './designRaster';
import { DesignLayers } from './DesignLayers';
import { DesignProperties, type PropAction } from './DesignProperties';
import './DesignScreen.css';

interface View { x: number; y: number; k: number }
type Tool = 'move' | 'frame' | 'rect' | 'ellipse' | 'line' | 'text';

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: { x: number; y: number }; additive: boolean; base: string[] }
  | { kind: 'move'; start: { x: number; y: number }; ids: string[]; origin: Map<string, { x: number; y: number }>; startDesign: Design; box: Box; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; start: { x: number; y: number }; box: Box; startDesign: Design; moved: boolean }
  | { kind: 'draw'; tool: Tool; start: { x: number; y: number } };

const MIN_K = 0.05;
const MAX_K = 8;
const LAST_KEY = 'pigry:design-last';
const SAVE_DELAY = 700;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Tools', items: [
    { keys: 'V', label: 'Move' }, { keys: 'F', label: 'Frame' }, { keys: 'R', label: 'Rectangle' }, { keys: 'O', label: 'Ellipse' },
    { keys: 'L', label: 'Line' }, { keys: 'T', label: 'Text' },
  ] },
  { title: 'Edit', items: [
    { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+C', label: 'Copy' }, { keys: 'Ctrl+X', label: 'Cut' },
    { keys: 'Ctrl+V', label: 'Paste' }, { keys: 'Ctrl+D', label: 'Duplicate' }, { keys: 'Delete / Backspace', label: 'Delete' },
    { keys: 'Enter / F2', label: 'Edit the text' }, { keys: 'Ctrl+S', label: 'Save now' },
  ] },
  { title: 'Arrange', items: [
    { keys: 'Ctrl+G', label: 'Group (wrap in a frame)' }, { keys: ']', label: 'Bring forward' }, { keys: '[', label: 'Send backward' },
    { keys: 'Ctrl+]', label: 'Bring to front' }, { keys: 'Ctrl+[', label: 'Send to back' }, { keys: 'Ctrl+Shift+L', label: 'Lock / unlock' },
    { keys: 'Ctrl+Shift+H', label: 'Show / hide' }, { keys: 'Arrows', label: 'Nudge (Shift = 10)' },
  ] },
  { title: 'Select', items: [
    { keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Tab / Shift+Tab', label: 'Next / previous layer' }, { keys: 'Shift+Click', label: 'Add to the selection' },
    { keys: 'Esc', label: 'Select the parent / back to Move' },
  ] },
  { title: 'View', items: [
    { keys: '+ / -', label: 'Zoom in / out' }, { keys: 'Ctrl+Scroll', label: 'Zoom at the cursor' }, { keys: 'Shift+0', label: 'Zoom to 100%' },
    { keys: 'Shift+1 / Ctrl+0', label: 'Fit everything' }, { keys: 'Shift+2', label: 'Zoom to the selection' }, { keys: 'Space+Drag', label: 'Pan' },
    { keys: 'Ctrl+Shift+E', label: 'Export' }, { keys: '?', label: 'This list' },
  ] },
];

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof Square }> = [
  { id: 'move', label: 'Move', key: 'V', icon: MousePointer2 },
  { id: 'frame', label: 'Frame', key: 'F', icon: Frame },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { id: 'line', label: 'Line', key: 'L', icon: Minus },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
];

const TEMPLATES: Array<{ kind: TemplateKind; label: string; hint: string }> = [
  { kind: 'mobile', label: 'Mobile app', hint: 'iPhone screen with auto layout' },
  { kind: 'desktop', label: 'Desktop dashboard', hint: 'Sidebar, stats and content' },
  { kind: 'components', label: 'Component kit', hint: 'Buttons and inputs' },
  { kind: 'blank', label: 'Blank', hint: 'One empty desktop frame' },
];

/** Adds `spec` through the normal add operation and returns the new design plus the new node's id. */
function addNode(design: Design, parentId: string | null, spec: Record<string, unknown>): { design: Design; id: string | null } {
  const before = new Set(allNodes(design).map((n) => n.id));
  const result = applyDesignOps(design, [{ op: 'add', parent: parentId ?? 'canvas', node: spec }]);
  const added = allNodes(result.design).find((n) => !before.has(n.id));
  return { design: result.design, id: added?.id ?? null };
}

export function DesignScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Design>(() => emptyDesign());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>('move');
  const [view, setView] = useState<View>({ x: 80, y: 80, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [guides, setGuides] = useState<Guide[]>([]);
  const [rubber, setRubber] = useState<Box | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<TemplateKind>('mobile');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const docRef = useRef(doc);
  const dirtyRef = useRef(false);
  const currentRef = useRef<string | null>(null);
  const viewRef = useRef(view);
  const selRef = useRef<string[]>([]);
  const toolRef = useRef<Tool>('move');
  const undoStack = useRef<Design[]>([]);
  const redoStack = useRef<Design[]>([]);
  const lastKey = useRef<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const clipRef = useRef<DesignNode[]>([]);
  const spaceRef = useRef(false);

  useLayoutEffect(() => { docRef.current = doc; }, [doc]);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  useLayoutEffect(() => { selRef.current = sel; }, [sel]);
  useLayoutEffect(() => { toolRef.current = tool; }, [tool]);
  useLayoutEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useLayoutEffect(() => { currentRef.current = current; }, [current]);
  useLayoutEffect(() => { spaceRef.current = spaceDown; }, [spaceDown]);

  const syncHist = () => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
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
      await saveDesign(ref, docRef.current, 'editor');
      setDirty(dirtyRef.current); // edits made while the write was in flight keep it dirty
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the design: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerDesignFlush(saveNow), [saveNow]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const ref = refOf(currentRef.current);
    if (dirtyRef.current && ref) void saveDesign(ref, docRef.current, 'editor');
  }, []);

  const fitView = useCallback((target?: Design, only?: string | string[]) => {
    const stage = stageRef.current;
    const d = target ?? docRef.current;
    if (!stage) return;
    const box = Array.isArray(only) ? selectionBounds(d, only) : only ? absoluteBox(d, only) : selectionBounds(d, d.nodes.map((n) => n.id));
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    const b = box ?? { x: 0, y: 0, w: 800, h: 600 };
    const k = Math.min(1, Math.max(MIN_K, Math.min((w - 120) / Math.max(b.w, 1), (h - 120) / Math.max(b.h, 1))));
    setView({ k, x: (w - b.w * k) / 2 - b.x * k, y: (h - b.h * k) / 2 - b.y * k });
  }, []);

  const openDesign = useCallback(async (key: string, opts?: { keepSelection?: boolean; asUndo?: boolean; node?: string }) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { design, warnings } = await loadDesign(ref);
      if (opts?.asUndo) { undoStack.current.push(docRef.current); redoStack.current = []; } else { undoStack.current = []; redoStack.current = []; }
      lastKey.current = null;
      docRef.current = design;
      setDoc(design);
      const nextKey = refKey(ref);
      setCurrent(nextKey);
      currentRef.current = nextKey;
      setDirty(false);
      syncHist();
      if (!opts?.keepSelection) { setSel(opts?.node ? [opts.node] : []); setEditing(null); setTool('move'); }
      else setSel((s) => s.filter((id) => allNodes(design).some((n) => n.id === id)));
      setOpenDesign(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Design opened with ${warnings.length} repaired issue(s).`);
      window.requestAnimationFrame(() => { if (!opts?.asUndo) fitView(design, opts?.node); });
    } catch (error) {
      notify(`Could not open "${key}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify, fitView]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listDesignRefs()); } catch { setRefs([]); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listDesignRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: OpenRequest | null = takePendingOpenDesign();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openDesign(refKey(found), { node: request?.node });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent tools write the files — reload what is open; the editor stays the source of truth otherwise.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<DesignChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setOpenDesign(null); setDoc(emptyDesign()); return; }
      if (change.source === 'agent') void openDesign(change.key, { keepSelection: true, asUndo: true });
    };
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<OpenRequest>).detail;
      takePendingOpenDesign();
      void openDesign(request.key, { node: request.node });
    };
    window.addEventListener(DESIGN_CHANGED, onChanged);
    window.addEventListener(DESIGN_OPEN, onOpen);
    return () => {
      window.removeEventListener(DESIGN_CHANGED, onChanged);
      window.removeEventListener(DESIGN_OPEN, onOpen);
    };
  }, [openDesign, refreshList]);

  /* ---- editing model ---- */

  const commit = useCallback((next: Design, key?: string) => {
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

  /** Clone → change → re-layout → commit. */
  const mutate = useCallback((fn: (draft: Design) => void, key?: string) => {
    const draft = structuredClone(docRef.current);
    fn(draft);
    commit(layoutDesign(draft), key);
  }, [commit]);

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = prev; setDoc(prev); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
    setSel((s) => s.filter((id) => allNodes(prev).some((n) => n.id === id)));
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = next; setDoc(next); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
    setSel((s) => s.filter((id) => allNodes(next).some((n) => n.id === id)));
  };

  const patchNodes = (ids: string[], patch: Record<string, unknown>, key?: string) => {
    mutate((draft) => {
      for (const id of ids) {
        const node = findNode(draft, id);
        if (!node) continue;
        applyNodeFields(node, patch);
        if (node.type === 'text' && patch.w !== undefined && patch.autoSize === undefined && node.autoSize === 'w') node.autoSize = 'h';
      }
    }, key);
  };

  const runOps = (ops: Array<Record<string, unknown>>): { ok: boolean; errors: string[] } => {
    const result = applyDesignOps(docRef.current, ops as never);
    if (result.log.length > 0) commit(result.design);
    return { ok: result.errors.length === 0, errors: result.errors };
  };

  const selectedNodes = useMemo(() => sel.map((id) => findNode(doc, id)).filter((n): n is DesignNode => !!n), [sel, doc]);

  const doAction = (action: PropAction) => {
    const d = docRef.current;
    const ids = topLevelSelection(d, selRef.current);
    if (ids.length === 0) return;
    if (action === 'delete') {
      if (runOps(ids.map((id) => ({ op: 'remove', id }))).ok) setSel([]);
    } else if (action === 'duplicate') {
      const before = new Set(allNodes(d).map((n) => n.id));
      const result = applyDesignOps(d, ids.map((id) => ({ op: 'duplicate', id })));
      commit(result.design);
      setSel(allNodes(result.design).filter((n) => !before.has(n.id) && !ids.some((id) => findNode(result.design, id)?.children?.some((c) => c.id === n.id))).map((n) => n.id).slice(0, ids.length));
    } else if (action === 'group') {
      const before = new Set(allNodes(d).map((n) => n.id));
      const result = applyDesignOps(d, [{ op: 'wrap', ids, name: 'Group' }]);
      commit(result.design);
      const added = allNodes(result.design).find((n) => !before.has(n.id));
      if (added) setSel([added.id]);
    } else {
      mutate((draft) => { for (const id of action === 'forward' ? [...ids].reverse() : ids) stepZOrder(draft, id, action === 'forward' ? 1 : -1); });
    }
  };

  const copySelection = () => {
    const d = docRef.current;
    clipRef.current = topLevelSelection(d, selRef.current).map((id) => structuredClone(findNode(d, id)!)).filter(Boolean);
  };
  const pasteClipboard = () => {
    if (clipRef.current.length === 0) return;
    const d = docRef.current;
    const first = selRef.current[0] ? findNode(d, selRef.current[0]) : undefined;
    const into = first?.type === 'frame' && !clipRef.current.some((n) => n.id === first.id) ? first : parentOf(d, first?.id ?? '') ?? null;
    let design = d;
    const ids: string[] = [];
    for (const node of clipRef.current) {
      const spec = structuredClone(node) as unknown as Record<string, unknown>;
      if (!isAutoLayoutFrame(into)) { spec.x = (node.x ?? 0) + 24; spec.y = (node.y ?? 0) + 24; }
      const added = addNode(design, into?.id ?? null, spec);
      design = added.design;
      if (added.id) ids.push(added.id);
    }
    commit(design);
    setSel(ids);
  };

  const onLayerMove = (id: string, targetId: string, zone: 'before' | 'after' | 'inside') => {
    const d = docRef.current;
    const target = findNode(d, targetId);
    if (!target) return;
    if (zone === 'inside') { const r = runOps([{ op: 'move', id, parent: targetId }]); if (!r.ok) notify(r.errors[0], 'error'); return; }
    const parent = parentOf(d, targetId) ?? null;
    const list = (parent ? parent.children ?? [] : d.nodes).filter((n) => n.id !== id);
    const at = list.findIndex((n) => n.id === targetId);
    // The layer list shows the top-most layer first, so "before" means higher in z-order.
    const r = runOps([{ op: 'move', id, parent: parent?.id ?? 'canvas', index: zone === 'before' ? at + 1 : at }]);
    if (!r.ok) notify(r.errors[0], 'error');
  };

  /* ---- pointer interaction ---- */

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - v.x) / v.k, y: (clientY - (rect?.top ?? 0) - v.y) / v.k };
  };

  const idAt = (target: Element | null): string | null => target?.closest('[data-id]')?.getAttribute('data-id') ?? null;

  const beginEditText = (id: string) => {
    const node = findNode(docRef.current, id);
    if (!node || node.type !== 'text') return;
    setSel([id]);
    setEditing(id);
    setEditText(node.text ?? '');
  };

  const commitText = () => {
    const id = editing;
    if (!id) return;
    setEditing(null);
    const node = findNode(docRef.current, id);
    if (node && (node.text ?? '') !== editText) patchNodes([id], { text: editText });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 2) return; // right click is handled by onContextMenu
    if (editing) commitText();
    const target = event.target as Element;
    const p = worldPoint(event.clientX, event.clientY);
    svgRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const d = docRef.current;

    if (event.button === 1 || spaceRef.current) {
      dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, view: viewRef.current };
      return;
    }
    const currentTool = toolRef.current;
    if (currentTool !== 'move') {
      dragRef.current = { kind: 'draw', tool: currentTool, start: p };
      setRubber({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | null;
    const only = selRef.current.length === 1 ? findNode(d, selRef.current[0]) : undefined;
    if (handle && only) {
      const box = absoluteBox(d, only.id);
      if (box) dragRef.current = { kind: 'resize', id: only.id, handle, start: p, box, startDesign: d, moved: false };
      return;
    }
    const labelFor = target.closest('[data-label]')?.getAttribute('data-label');
    const id = labelFor ?? idAt(target);
    if (id) {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      let next = selRef.current;
      if (additive) next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
      else if (!next.includes(id)) next = [id];
      setSel(next);
      if (additive && !next.includes(id)) return;
      const ids = topLevelSelection(d, next).filter((x) => !findNode(d, x)?.locked);
      const origin = new Map<string, { x: number; y: number }>();
      for (const x of ids) { const n = findNode(d, x); if (n) origin.set(x, { x: n.x, y: n.y }); }
      const box = selectionBounds(d, ids);
      if (box && ids.length > 0) dragRef.current = { kind: 'move', start: p, ids, origin, startDesign: d, box, moved: false };
      return;
    }
    dragRef.current = { kind: 'marquee', start: p, additive: event.shiftKey, base: selRef.current };
    if (!event.shiftKey) setSel([]);
    setRubber({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      const id = idAt(event.target as Element);
      setHover((h) => (h === id ? h : id));
      return;
    }
    if (drag.kind === 'pan') {
      setView({ ...drag.view, x: drag.view.x + event.clientX - drag.startX, y: drag.view.y + event.clientY - drag.startY });
      return;
    }
    const p = worldPoint(event.clientX, event.clientY);
    const k = viewRef.current.k;
    if (drag.kind === 'draw') {
      setRubber({ x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) });
      return;
    }
    if (drag.kind === 'marquee') {
      const rect = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
      setRubber(rect);
      const hit = nodesInRect(docRef.current, rect);
      setSel(drag.additive ? Array.from(new Set([...drag.base, ...hit])) : hit);
      return;
    }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * k < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      undoStack.current.push(drag.startDesign);
      redoStack.current = [];
      lastKey.current = null;
      syncHist();
    }
    const next = structuredClone(drag.startDesign);
    if (drag.kind === 'move') {
      let mx = dx, my = dy;
      const single = drag.ids.length === 1 ? findNode(next, drag.ids[0]) : undefined;
      const inFlow = single ? isAutoLayoutFrame(parentOf(next, single.id) ?? null) : false;
      if (single && !inFlow && !event.altKey) {
        const snap = snapMove(next, drag.ids, { x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h }, 6 / k);
        mx += snap.dx; my += snap.dy;
        setGuides(snap.guides);
      } else setGuides([]);
      for (const id of drag.ids) {
        const node = findNode(next, id);
        const o = drag.origin.get(id);
        if (node && o) { node.x = Math.round(o.x + mx); node.y = Math.round(o.y + my); }
      }
    } else {
      const node = findNode(next, drag.id);
      if (!node) return;
      const box = computeResize(drag.box, drag.handle, dx, dy, event.shiftKey);
      const base = absoluteBox(next, drag.id) ?? drag.box;
      node.x = Math.round(node.x + (box.x - base.x));
      node.y = Math.round(node.y + (box.y - base.y));
      node.w = Math.round(box.w);
      node.h = Math.round(box.h);
      if (node.type === 'text') node.autoSize = Math.round(box.h) !== Math.round(drag.box.h) ? 'none' : 'h';
      if (node.layout) {
        if (Math.round(box.w) !== Math.round(drag.box.w)) node.layout.hugW = false;
        if (Math.round(box.h) !== Math.round(drag.box.h)) node.layout.hugH = false;
      }
    }
    const laidOut = drag.kind === 'resize' ? layoutDesign(next) : next;
    docRef.current = laidOut;
    setDoc(laidOut);
    setDirty(true);
    dirtyRef.current = true;
  };

  const finishDraw = (drag: Extract<Drag, { kind: 'draw' }>, end: { x: number; y: number }) => {
    const d = docRef.current;
    const clicked = Math.hypot(end.x - drag.start.x, end.y - drag.start.y) * viewRef.current.k < 4;
    const x = Math.min(drag.start.x, end.x), y = Math.min(drag.start.y, end.y);
    let w = Math.abs(end.x - drag.start.x);
    const h = Math.abs(end.y - drag.start.y);
    const parent = deepestFrameAt(d, drag.start.x, drag.start.y);
    const parentBox = parent ? absoluteBox(d, parent.id) : null;
    const inFlow = isAutoLayoutFrame(parent);
    const rel = { x: Math.round(x - (parentBox?.x ?? 0)), y: Math.round(y - (parentBox?.y ?? 0)) };
    let spec: Record<string, unknown>;
    switch (drag.tool) {
      case 'frame': spec = { type: 'frame', ...(parent ? rel : { x: Math.round(x), y: Math.round(y) }), w: clicked ? 320 : Math.round(w), h: clicked ? 480 : Math.round(h), fill: '#ffffff' }; break;
      case 'rect': spec = { type: 'rect', ...rel, w: clicked ? 100 : Math.round(w), h: clicked ? 100 : Math.round(h) }; break;
      case 'ellipse': spec = { type: 'ellipse', ...rel, w: clicked ? 100 : Math.round(w), h: clicked ? 100 : Math.round(h) }; break;
      case 'line': w = clicked ? 100 : w; spec = { type: 'line', ...rel, w: Math.round(w), h: Math.round(clicked ? 0 : end.y - drag.start.y) }; break;
      default: spec = { type: 'text', ...rel, text: 'Text', fontSize: 16, fill: '#111111', ...(clicked ? {} : { w: Math.max(20, Math.round(w)) }) };
    }
    if (inFlow) { delete spec.x; delete spec.y; }
    if (!parent) { spec.x = Math.round(x); spec.y = Math.round(y); }
    const added = addNode(d, parent?.id ?? null, spec);
    if (added.id) {
      commit(added.design);
      setSel([added.id]);
      if (drag.tool === 'text') { setEditing(added.id); setEditText('Text'); }
    }
    setTool('move');
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGuides([]);
    setRubber(null);
    if (!drag) return;
    if (drag.kind === 'draw') { finishDraw(drag, worldPoint(event.clientX, event.clientY)); return; }
    if (drag.kind === 'resize' && drag.moved) { scheduleSave(); return; }
    if (drag.kind !== 'move' || !drag.moved) return;

    // Drop: reorder inside an auto layout frame, or re-parent into the frame under the pointer.
    const d = docRef.current;
    const p = worldPoint(event.clientX, event.clientY);
    const id = drag.ids[0];
    const node = findNode(d, id);
    const parent = node ? parentOf(d, id) ?? null : null;
    if (drag.ids.length === 1 && node && parent && isAutoLayoutFrame(parent)) {
      const index = reorderIndex(parent, id, parent.layout?.dir === 'row' ? node.x + node.w / 2 : node.y + node.h / 2);
      const from = (parent.children ?? []).filter((n) => n.id !== id);
      void from;
      const result = applyDesignOps(d, [{ op: 'move', id, parent: parent.id, index }]);
      docRef.current = result.design; setDoc(result.design); scheduleSave();
      return;
    }
    if (drag.ids.length === 1 && node && !(node.type === 'frame' && !parent)) {
      const exclude = new Set([id, ...allNodes({ ...d, nodes: [node] }).map((n) => n.id)]);
      const frame = deepestFrameAt(d, p.x, p.y, exclude);
      if ((frame?.id ?? null) !== (parent?.id ?? null)) {
        const result = applyDesignOps(d, [{ op: 'move', id, parent: frame?.id ?? 'canvas' }]);
        if (result.errors.length === 0) { docRef.current = result.design; setDoc(result.design); }
      }
    }
    scheduleSave();
  };

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CanvasMenuEntry[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const onContextMenu = (event: React.MouseEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (editing) commitText();
    const id = idAt(event.target as Element);
    svgRef.current?.focus();
    const now = id ? (selRef.current.includes(id) ? selRef.current : [id]) : [];
    setSel(now);
    setMenu({ x: event.clientX, y: event.clientY, entries: menuEntries({ at: worldPoint(event.clientX, event.clientY), id, sel: now }) });
  };

  const menuEntries = (menu: { at: { x: number; y: number }; id: string | null; sel: string[] }): CanvasMenuEntry[] => {
    const d = docRef.current;
    const undoable: CanvasMenuEntry[] = [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: undoStack.current.length === 0, onSelect: undo },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: redoStack.current.length === 0, onSelect: redo },
    ];
    if (menu.id) {
      const node = findNode(d, menu.id);
      const many = menu.sel.length > 1;
      return [
        ...(!many && node?.type === 'text' ? [{ label: 'Edit text', shortcut: 'Enter', onSelect: () => beginEditText(menu.id!) } as CanvasMenuEntry] : []),
        { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => doAction('duplicate') },
        { label: 'Copy', shortcut: 'Ctrl+C', onSelect: copySelection },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipRef.current.length === 0, onSelect: pasteClipboard },
        { separator: true },
        { label: 'Group', shortcut: 'Ctrl+G', onSelect: () => doAction('group') },
        { label: 'Bring forward', shortcut: ']', onSelect: () => doAction('forward') },
        { label: 'Send backward', shortcut: '[', onSelect: () => doAction('backward') },
        { separator: true },
        { label: node?.visible === false ? 'Show' : 'Hide', onSelect: () => mutate((draft) => { for (const id of selRef.current) { const n = findNode(draft, id); if (n) n.visible = n.visible === false ? undefined : false; } }) },
        { label: node?.locked ? 'Unlock' : 'Lock', onSelect: () => mutate((draft) => { for (const id of selRef.current) { const n = findNode(draft, id); if (n) n.locked = n.locked ? undefined : true; } }) },
        { separator: true },
        { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => doAction('delete') },
      ];
    }
    const add = (tool: Tool, name: string): CanvasMenuEntry => ({ label: `Add ${name} here`, onSelect: () => finishDraw({ kind: 'draw', tool, start: menu.at } as never, menu.at) });
    return [
      add('frame', 'frame'), add('rect', 'rectangle'), add('ellipse', 'ellipse'), add('text', 'text'),
      { separator: true },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipRef.current.length === 0, onSelect: pasteClipboard },
      { label: 'Select all', shortcut: 'Ctrl+A', onSelect: () => setSel(d.nodes.map((n) => n.id)) },
      { label: 'Fit to screen', shortcut: 'Ctrl+0', onSelect: () => fitView() },
      { separator: true },
      ...undoable,
    ];
  };

  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const id = idAt(event.target as Element);
    if (id) beginEditText(id);
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
      } else setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [current]);

  const zoomBy = (factor: number) => {
    const stage = stageRef.current;
    const v = viewRef.current;
    const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
    const px = (stage?.clientWidth ?? 600) / 2, py = (stage?.clientHeight ?? 400) / 2;
    setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k });
  };

  const toggleLock = () => mutate((draft) => { for (const id of selRef.current) { const n = findNode(draft, id); if (n) n.locked = n.locked ? undefined : true; } });
  const toggleHidden = () => mutate((draft) => { for (const id of selRef.current) { const n = findNode(draft, id); if (n) n.visible = n.visible === false ? undefined : false; } });
  const sendToEdge = (dir: 1 | -1) => mutate((draft) => {
    const count = allNodes(draft).length;
    for (const id of topLevelSelection(draft, selRef.current)) for (let n = 0; n < count; n += 1) stepZOrder(draft, id, dir);
  });
  const cycleSelection = (dir: 1 | -1) => {
    const list = allNodes(docRef.current);
    if (list.length === 0) return;
    const at = list.findIndex((n) => n.id === selRef.current[0]);
    setSel([list[(at + dir + list.length) % list.length].id]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editing) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === ' ') { event.preventDefault(); setSpaceDown(true); return; }
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { event.preventDefault(); redo(); return; }
    if (mod && key === 's') { event.preventDefault(); void saveNow(); return; }
    if (mod && key === 'd') { event.preventDefault(); doAction('duplicate'); return; }
    if (mod && key === 'g') { event.preventDefault(); doAction('group'); return; }
    if (mod && key === 'x') { event.preventDefault(); copySelection(); doAction('delete'); return; }
    if (mod && event.key === ']') { event.preventDefault(); sendToEdge(1); return; }
    if (mod && event.key === '[') { event.preventDefault(); sendToEdge(-1); return; }
    if (mod && event.shiftKey && key === 'l') { event.preventDefault(); toggleLock(); return; }
    if (mod && event.shiftKey && key === 'h') { event.preventDefault(); toggleHidden(); return; }
    if (mod && event.shiftKey && key === 'e') { event.preventDefault(); setExportOpen(true); return; }
    if (mod && key === 'c') { event.preventDefault(); copySelection(); return; }
    if (mod && key === 'v') { event.preventDefault(); pasteClipboard(); return; }
    if (mod && key === 'a') { event.preventDefault(); setSel(siblingsOf(docRef.current, selRef.current[0] ?? '').map((n) => n.id).concat(selRef.current[0] ? [] : docRef.current.nodes.map((n) => n.id))); return; }
    if (mod && key === '0') { event.preventDefault(); fitView(); return; }
    if (mod && key === '1') { event.preventDefault(); setView((v) => ({ ...v, k: 1 })); return; }
    if (mod) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); doAction('delete'); return; }
    if (event.key === 'Escape') {
      if (toolRef.current !== 'move') setTool('move');
      else if (selRef.current.length) {
        const parent = parentOf(docRef.current, selRef.current[0]);
        setSel(parent ? [parent.id] : []);
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === 'F2') && selRef.current.length === 1) { beginEditText(selRef.current[0]); event.preventDefault(); return; }
    if (event.key === '[') { doAction('backward'); return; }
    if (event.key === ']') { doAction('forward'); return; }
    if (event.key === '?') { event.preventDefault(); setHelpOpen(true); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25); return; }
    if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); fitView(); return; }
    if (event.shiftKey && event.code === 'Digit2') { event.preventDefault(); if (selRef.current.length) fitView(undefined, selRef.current); return; }
    if (event.shiftKey && event.code === 'Digit0') { event.preventDefault(); zoomBy(1 / viewRef.current.k); return; }
    if (event.key === 'Tab') { event.preventDefault(); cycleSelection(event.shiftKey ? -1 : 1); return; }
    const hotkey = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (hotkey) { setTool(hotkey.id); return; }
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = arrows[event.key];
    if (move && selRef.current.length) {
      event.preventDefault();
      const ids = topLevelSelection(docRef.current, selRef.current).filter((id) => !isAutoLayoutFrame(parentOf(docRef.current, id) ?? null));
      mutate((draft) => { for (const id of ids) { const n = findNode(draft, id); if (n) { n.x += move[0]; n.y += move[1]; } } }, `nudge:${ids.join(',')}`);
    }
  };
  const onKeyUp = (event: React.KeyboardEvent) => { if (event.key === ' ') setSpaceDown(false); };

  // Focus after the click that created the editor has finished — the browser moves focus to the canvas on mousedown and would otherwise blur (and commit) it at once.
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => editRef.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  /* ---- design-level actions ---- */

  const createDesign = async (kind: TemplateKind, rawName: string) => {
    const base = nameSlug(rawName || TEMPLATES.find((t) => t.kind === kind)?.label || 'design');
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    const title = rawName.trim() || (TEMPLATES.find((t) => t.kind === kind)?.label ?? 'Design');
    await saveNow();
    try {
      await saveDesign({ owner: USER_OWNER, slug }, templateDesign(kind, title), 'editor');
      setCreating(false); setNewName('');
      await refreshList();
      await openDesign(`${USER_OWNER}/${slug}`);
    } catch (error) {
      notify(`Could not create the design: ${String(error)}`, 'error');
    }
  };

  const deleteDesignFile = async (key: string) => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeDesign(ref);
      const rest = (await listDesignRefs());
      setRefs(rest);
      if (key === currentRef.current) {
        if (rest[0]) await openDesign(refKey(rest[0])); else { setCurrent(null); setOpenDesign(null); const empty = emptyDesign(); docRef.current = empty; setDoc(empty); }
      }
    } catch (error) {
      notify(`Could not delete the design: ${String(error)}`, 'error');
    }
  };

  const exportTarget = (): DesignNode | undefined => {
    const first = selRef.current[0] ? findNode(docRef.current, selRef.current[0]) : undefined;
    return first ?? (docRef.current.nodes.length === 1 ? docRef.current.nodes[0] : undefined);
  };

  const exportAs = async (format: 'svg' | 'png' | 'html' | 'copy-png' | 'copy-svg') => {
    const ref = refOf(currentRef.current);
    if (!ref) return;
    const d = docRef.current;
    const node = exportTarget();
    const suffix = node ? `--${nameSlug(node.name)}` : '';
    const base = designPath(ref).replace(/\.design\.json$/, suffix);
    try {
      if (format === 'html') {
        await writeWorktreeFile(`${base}.html`, renderDesignHtml(d, node?.id));
        notify(`Saved ${base}.html`, 'success');
        return;
      }
      const svg = renderDesignSvg(d, { nodeId: node?.id, background: format === 'svg' || format === 'copy-svg' ? null : '#ffffff', padding: node ? 0 : 40 });
      if (format === 'svg') { await writeWorktreeFile(`${base}.svg`, svg); notify(`Saved ${base}.svg`, 'success'); return; }
      if (format === 'copy-svg') { await navigator.clipboard.writeText(svg); notify('SVG copied to the clipboard.', 'success'); return; }
      const { width, height } = svgSize(svg);
      const png = await svgToPng(svg, width, height, 2);
      if (format === 'png') { await writeWorktreeBinary(`${base}.png`, png.base64); notify(`Saved ${base}.png`, 'success'); return; }
      const blob = await (await fetch(png.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Image copied to the clipboard.', 'success');
    } catch (error) {
      notify(`Export failed: ${String(error)}`, 'error');
    }
    notifyDesignChanged({ key: refKey(ref), source: 'editor' });
  };

  /* ---- render ---- */

  const markup = useMemo(() => renderDesignContent(doc, { interactive: true, editingId: editing }), [doc, editing]);
  const k = view.k;
  const boxes = sel.map((id) => ({ id, box: absoluteBox(doc, id) })).filter((b): b is { id: string; box: Box } => b.box !== null);
  const only = sel.length === 1 ? findNode(doc, sel[0]) : undefined;
  const hoverBox = hover && !sel.includes(hover) ? absoluteBox(doc, hover) : null;
  const editBox = editing ? absoluteBox(doc, editing) : null;
  const editNode = editing ? findNode(doc, editing) : undefined;
  // The chat shows (and sends) whatever layers are selected here.
  const layerContext = useMemo<CanvasSelection | null>(() => {
    if (!current || selectedNodes.length === 0) return null;
    return {
      kind: 'design',
      doc: current,
      items: selectedNodes.slice(0, 8).map((node) => ({ id: node.id, name: node.name, type: node.type, outline: summarizeDesign(doc, node.id, 30) })),
    };
  }, [current, selectedNodes, doc]);
  const exportNode = sel[0] ? findNode(doc, sel[0]) : doc.nodes.length === 1 ? doc.nodes[0] : undefined;
  const exportLabel = exportNode ? `Frame: ${exportNode.name}` : 'Whole canvas';
  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  return (
    <div className="screen dgn">
      <header className="screen-header">
        <h1 className="screen-header__title">Design</h1>
        <span className="screen-header__meta">Frames, auto layout and components — the UX/UI agent can design on the same canvas</span>
        {current && <span className={`dgn__save dgn__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <button type="button" className="primary-button" onClick={() => setCreating((c) => !c)}><Plus size={12} strokeWidth={1.5} /> New design</button>
      </header>

      <div className="screen-body dgn__body">
        <aside className="dgn__side" aria-label="Designs and layers">
          <section className="dgn__section">
            <h2 className="dgn__heading"><PenTool size={12} /> Designs <span className="dgn__count">{refs.length}</span></h2>
            {creating && (
              <div className="dgn__new">
                <div className="dgn__chips" role="radiogroup" aria-label="Template">
                  {TEMPLATES.map((t) => (
                    <button key={t.kind} type="button" role="radio" aria-checked={newKind === t.kind} title={t.hint} className={`dgn__chip${newKind === t.kind ? ' dgn__chip--on' : ''}`} onClick={() => setNewKind(t.kind)}>{t.label}</button>
                  ))}
                </div>
                <div className="dgn__new-row">
                  <input className="dgn-input" autoFocus placeholder="Design name…" aria-label="New design name" value={newName} onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void createDesign(newKind, newName); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }} />
                  <button type="button" className="dgn-icon dgn-icon--ok" aria-label="Create design" onClick={() => void createDesign(newKind, newName)}><Check size={13} /></button>
                  <button type="button" className="dgn-icon" aria-label="Cancel" onClick={() => { setCreating(false); setNewName(''); }}><X size={13} /></button>
                </div>
              </div>
            )}
            {refs.length === 0 && !creating && <p className="dgn-empty">No designs yet — create one, or ask the UX/UI agent.</p>}
            {grouped.map(([owner, list]) => (
              <div key={owner} className="dgn__group">
                <div className="dgn__owner">{owner}</div>
                <ul className="dgn__list">
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <li key={key} className={`dgn__item${key === current ? ' dgn__item--active' : ''}`}>
                        <button type="button" className="dgn__item-main" title={designPath(ref)} onClick={() => { if (key !== current) void openDesign(key); }}>
                          <LayoutTemplate size={12} strokeWidth={1.5} /><span>{ref.slug}</span>
                        </button>
                        {confirmDelete === key ? (
                          <span className="dgn__confirm">
                            <button type="button" className="dgn-icon dgn-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteDesignFile(key)}><Check size={12} /></button>
                            <button type="button" className="dgn-icon" aria-label="Keep design" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </span>
                        ) : (
                          <button type="button" className="dgn-icon dgn__item-del" aria-label={`Delete ${ref.slug}`} title="Delete design" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
          <section className="dgn__section dgn__section--layers">
            <h2 className="dgn__heading"><Layers size={12} /> Layers</h2>
            {current && (
              <DesignLayers
                design={doc}
                selected={sel}
                onSelect={(id, additive) => setSel((s) => (additive ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]))}
                onToggle={(id, key) => mutate((draft) => { const n = findNode(draft, id); if (n) n[key] = n[key] ? undefined : key === 'visible' ? false : true; })}
                onRename={(id, name) => patchNodes([id], { name })}
                onMove={onLayerMove}
              />
            )}
          </section>
        </aside>

        <div className="dgn__main">
          {current ? (
            <>
              <div className="dgn__toolbar" role="toolbar" aria-label="Design tools">
                {TOOLS.map(({ id, label, key, icon: Icon }) => (
                  <button key={id} type="button" className={`dgn__tool${tool === id ? ' dgn__tool--on' : ''}`} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => setTool(id)}><Icon size={15} strokeWidth={1.5} /></button>
                ))}
                <span className="dgn__sep" />
                <button type="button" className="dgn__tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
                <button type="button" className="dgn__tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
                <span className="dgn__sep" />
                <button type="button" className="dgn__tool" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={14} /></button>
                <span className="dgn__zoom">{Math.round(k * 100)}%</span>
                <button type="button" className="dgn__tool" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn size={14} /></button>
                <button type="button" className="dgn__tool" aria-label="Fit to screen" title="Fit all (Ctrl+0)" onClick={() => fitView()}><Maximize size={14} /></button>
                <button type="button" className="dgn__tool" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
                <span className="dgn__grow" />
                <div className="dgn__menu">
                  <button type="button" className="dgn__tool dgn__tool--text" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}><ImageIcon size={14} /> <span>Export</span></button>
                  {exportOpen && (
                    <div className="dgn__popup" role="menu" onClick={() => setExportOpen(false)}>
                      <p className="dgn__popup-note">{exportLabel}</p>
                      <button type="button" role="menuitem" onClick={() => void exportAs('png')}><ImageIcon size={13} /> Save PNG to workspace</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('svg')}><ImageIcon size={13} /> Save SVG to workspace</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('html')}><FileCode2 size={13} /> Save HTML + CSS</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('copy-png')}><Copy size={13} /> Copy as PNG</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('copy-svg')}><Copy size={13} /> Copy as SVG</button>
                    </div>
                  )}
                </div>
              </div>
              <div className={`dgn__stage${spaceDown ? ' dgn__stage--pan' : ''}${tool !== 'move' ? ' dgn__stage--draw' : ''}`} ref={stageRef}>
                <svg
                  ref={svgRef}
                  className="dgn__svg"
                  tabIndex={0}
                  role="application"
                  aria-label={`Design canvas: ${doc.title}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={() => setHover(null)}
                  onDoubleClick={onDoubleClick}
                  onContextMenu={onContextMenu}
                  onKeyDown={onKeyDown}
                  onKeyUp={onKeyUp}
                >
                  <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
                    <g dangerouslySetInnerHTML={{ __html: markup }} />
                    {doc.nodes.map((node) => node.visible === false ? null : (
                      <text key={`label-${node.id}`} data-label={node.id} x={node.x} y={node.y - 8 / k} className={`dgn__label${sel.includes(node.id) ? ' dgn__label--on' : ''}`} style={{ fontSize: 12 / k }}>{node.name}</text>
                    ))}
                    {hoverBox && <rect className="dgn__hover" x={hoverBox.x} y={hoverBox.y} width={hoverBox.w} height={hoverBox.h} style={{ strokeWidth: 1.5 / k }} />}
                    {boxes.map(({ id, box }) => <rect key={id} className="dgn__sel" x={box.x} y={box.y} width={box.w} height={box.h} style={{ strokeWidth: 1.5 / k }} />)}
                    {only && !only.locked && !editing && tool === 'move' && (() => {
                      const box = absoluteBox(doc, only.id);
                      if (!box) return null;
                      const hs = 8 / k;
                      return HANDLES.map((h) => {
                        const pt = handlePoint(box, h);
                        return <rect key={h} data-handle={h} className={`dgn__handle dgn__handle--${h}`} x={pt.x - hs / 2} y={pt.y - hs / 2} width={hs} height={hs} style={{ strokeWidth: 1.5 / k }} />;
                      });
                    })()}
                    {sel.length > 1 && (() => {
                      const b = selectionBounds(doc, sel);
                      return b ? <rect className="dgn__sel dgn__sel--group" x={b.x} y={b.y} width={b.w} height={b.h} style={{ strokeWidth: 1 / k }} /> : null;
                    })()}
                    {guides.map((g, i) => g.axis === 'x'
                      ? <line key={i} className="dgn__guide" x1={g.pos} x2={g.pos} y1={g.from} y2={g.to} style={{ strokeWidth: 1 / k }} />
                      : <line key={i} className="dgn__guide" y1={g.pos} y2={g.pos} x1={g.from} x2={g.to} style={{ strokeWidth: 1 / k }} />)}
                    {rubber && <rect className="dgn__rubber" x={rubber.x} y={rubber.y} width={rubber.w} height={rubber.h} style={{ strokeWidth: 1 / k }} />}
                  </g>
                </svg>
                {helpOpen && <ShortcutHelp title="Design shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
                {menu && <CanvasContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} label="Design context menu" />}
                {doc.nodes.length === 0 && (
                  <div className="dgn__hint"><strong>Empty canvas</strong><span>Press F and drag to draw a frame, or ask the UX/UI agent to design a screen.</span></div>
                )}
                {editing && editBox && editNode && (
                  <textarea
                    ref={editRef}
                    className="dgn__editor"
                    aria-label="Edit text"
                    value={editText}
                    style={{
                      left: editBox.x * k + view.x, top: editBox.y * k + view.y,
                      width: Math.max(60, editBox.w * k + 12), minHeight: Math.max(24, editBox.h * k + 4),
                      fontSize: (editNode.fontSize ?? 16) * k, fontWeight: editNode.fontWeight ?? 400, lineHeight: editNode.lineHeight ?? 1.3,
                      textAlign: editNode.textAlign ?? 'left',
                    }}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitText}
                    onKeyDown={(e) => { if (e.key === 'Escape') { commitText(); svgRef.current?.focus(); } e.stopPropagation(); }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="dgn__welcome">
              <PenTool size={34} strokeWidth={1.25} />
              <h2>Design editor</h2>
              <p>Create a design to start. Pick a template, or ask the UX/UI agent to design a screen from your idea.</p>
              <div className="dgn__welcome-grid">
                {TEMPLATES.map((t) => (
                  <button key={t.kind} type="button" className="dgn__template" onClick={() => void createDesign(t.kind, t.label)}><strong>{t.label}</strong><span>{t.hint}</span></button>
                ))}
              </div>
            </div>
          )}
        </div>

        {current && (
          <aside className="dgn__inspector" aria-label="Properties">
            <DesignProperties
              design={doc}
              selected={selectedNodes}
              parentOf={(id) => parentOf(doc, id)}
              onPatch={patchNodes}
              onEndEdit={() => { lastKey.current = null; }}
              onAction={doAction}
              onTokens={(colors) => mutate((draft) => { for (const [name, value] of Object.entries(colors)) { if (value === null) delete draft.tokens.colors[name]; else draft.tokens.colors[name.replace(/[^\w-]+/g, '-')] = value; } }, `tokens:${Object.keys(colors).join(',')}`)}
              onTitle={(title) => mutate((draft) => { draft.title = title; }, 'title')}
            />
          </aside>
        )}

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('design')} onCollapse={() => setAiOpen(false)} canvasSelection={layerContext} />
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
