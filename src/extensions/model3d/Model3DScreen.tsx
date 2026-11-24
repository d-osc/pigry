import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box as BoxIcon, Check, ChevronDown, ChevronLeft, Download, Grid3x3, Keyboard, Magnet, MousePointer2, Move, Plus, Redo2, Rotate3d, Scale3d, Trash2, Undo2, X,
  Maximize, Image as ImageIcon, Orbit,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import {
  LIGHT_TYPES, SHADING, applyModelOp, emptyModel, makeObject, starterModel, summarizeModel, triangleCount, type Model3D, type ObjectKind, type Shading,
} from './model3d';
import { arrayBufferToBase64, exportModel, renderModel, textToBase64, type ExportFormat } from './modelScene';
import {
  MODEL_CHANGED, MODEL_OPEN, listModelRefs, loadModel, modelPath, registerModelFlush, removeModel, saveModel, setOpenModel, takePendingOpenModel,
  type ModelChange, type ModelOpenRequest,
} from './model3dStore';
import { Viewport3D, type GizmoMode, type TransformResult, type Viewport3DHandle, type ViewPreset } from './Viewport3D';
import { Outliner, Properties, type Commit, type PropTab } from './ModelPanels';
import './Model3DScreen.css';

const LAST_KEY = 'pigry:model3d-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 80;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Tools', items: [{ keys: 'Q', label: 'Select' }, { keys: 'G', label: 'Move (grab)' }, { keys: 'R', label: 'Rotate' }, { keys: 'S', label: 'Scale' }, { keys: 'Shift+Click', label: 'Add to the selection' }] },
  { title: 'Objects', items: [
    { keys: 'Shift+A', label: 'Add menu' }, { keys: 'Shift+D', label: 'Duplicate' }, { keys: 'X / Delete', label: 'Delete' }, { keys: 'H', label: 'Hide' }, { keys: 'Alt+H', label: 'Show all' },
    { keys: 'A', label: 'Select all' }, { keys: 'Alt+A', label: 'Deselect all' }, { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+S', label: 'Save now' },
  ] },
  { title: 'View', items: [
    { keys: 'Left drag', label: 'Orbit' }, { keys: 'Right drag', label: 'Pan' }, { keys: 'Scroll', label: 'Zoom' }, { keys: 'Numpad 1 / 3 / 7', label: 'Front / Right / Top' },
    { keys: 'Ctrl+Numpad 1 / 3 / 7', label: 'Back / Left / Bottom' }, { keys: 'Numpad 5', label: 'Perspective / Orthographic' }, { keys: 'Numpad .', label: 'Frame the selection' },
    { keys: 'Home', label: 'Frame everything' }, { keys: 'Z', label: 'Cycle the shading (Solid, Material, Wireframe)' }, { keys: 'F12', label: 'Render an image' }, { keys: '?', label: 'This list' },
  ] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; heading?: boolean; checked?: boolean }

const PRIMITIVE_MENU: Array<{ kind: ObjectKind; label: string }> = [
  { kind: 'box', label: 'Cube' }, { kind: 'sphere', label: 'UV Sphere' }, { kind: 'icosphere', label: 'Ico Sphere' }, { kind: 'cylinder', label: 'Cylinder' }, { kind: 'cone', label: 'Cone' },
  { kind: 'torus', label: 'Torus' }, { kind: 'plane', label: 'Plane' }, { kind: 'circle', label: 'Circle' }, { kind: 'capsule', label: 'Capsule' },
];

interface HistoryEntry { model: Model3D; label: string; merge?: string; t: number }

export function Model3DScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [model, setModel] = useState<Model3D | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [mode, setMode] = useState<GizmoMode>('select');
  const [shading, setShading] = useState<Shading>('material');
  const [ortho, setOrtho] = useState(false);
  const [snap, setSnap] = useState(false);
  const [tab, setTab] = useState<PropTab>('object');
  const [menu, setMenu] = useState<string | null>(null);
  const [drawingsOpen, setFilesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStarter, setNewStarter] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const modelRef = useRef<Model3D | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const dragStart = useRef<Model3D | null>(null);
  const viewportRef = useRef<Viewport3DHandle | null>(null);
  const clipboard = useRef<string[]>([]);

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });

  /* ---------- persistence ---------- */

  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key, ['.model.json']);
    return { owner: owner ?? USER_OWNER, slug };
  };

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), m = modelRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !m || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      const view = viewportRef.current?.getView();
      await saveModel(ref, view ? { ...m, view } : m, 'editor');
      setDirty(dirtyRef.current);
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the model: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerModelFlush(saveNow), [saveNow]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), m = modelRef.current;
    if (dirtyRef.current && ref && m) void saveModel(ref, m, 'editor');
  }, []);

  const openModel = useCallback(async (key: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { model: loaded, warnings } = await loadModel(ref);
      undoStack.current = []; redoStack.current = []; dragStart.current = null;
      modelRef.current = loaded;
      const nextKey = refKey(ref);
      currentRef.current = nextKey;
      dirtyRef.current = false;
      setDirty(false);
      setModel(loaded);
      setCurrent(nextKey);
      setSelection([]);
      syncHist();
      setOpenModel(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Model opened with ${warnings.length} repaired issue(s).`);
    } catch (error) {
      notify(`Could not open "${key}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listModelRefs()); } catch { setRefs([]); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listModelRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: ModelOpenRequest | null = takePendingOpenModel();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openModel(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An agent tool wrote the file: show what it built.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<ModelChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setModel(null); modelRef.current = null; setOpenModel(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openModel(change.key); }
    };
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<ModelOpenRequest>).detail;
      takePendingOpenModel();
      void openModel(request.key);
    };
    window.addEventListener(MODEL_CHANGED, onChanged);
    window.addEventListener(MODEL_OPEN, onOpen);
    return () => { window.removeEventListener(MODEL_CHANGED, onChanged); window.removeEventListener(MODEL_OPEN, onOpen); };
  }, [openModel, refreshList]);

  /* ---------- editing with undo ---------- */

  /** Applies a change to a copy of the model. Changes with the same `merge` key within a moment are one undo step. */
  const commit: Commit = useCallback((mutator, label, merge) => {
    const prev = modelRef.current;
    if (!prev) return;
    const next = structuredClone(prev);
    mutator(next);
    const last = undoStack.current[undoStack.current.length - 1];
    if (merge && last && last.merge === merge && Date.now() - last.t < 900) last.t = Date.now();
    else { undoStack.current.push({ model: prev, label, merge, t: Date.now() }); if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift(); }
    redoStack.current = [];
    modelRef.current = next;
    setModel(next);
    syncHist();
    markDirty();
  }, [markDirty]);

  const swapTo = (target: HistoryEntry, from: HistoryEntry[], to: HistoryEntry[]): void => {
    const now = modelRef.current;
    if (!now) return;
    to.push({ model: now, label: target.label, t: 0 });
    modelRef.current = target.model;
    setModel(target.model);
    setSelection((s) => s.filter((id) => target.model.objects.some((o) => o.id === id)));
    void from;
    syncHist();
    markDirty();
  };
  const undo = (): void => { const e = undoStack.current.pop(); if (e) swapTo(e, undoStack.current, redoStack.current); };
  const redo = (): void => { const e = redoStack.current.pop(); if (e) swapTo(e, redoStack.current, undoStack.current); };

  const onTransform = useCallback((id: string, result: TransformResult, final: boolean) => {
    const prev = modelRef.current;
    if (!prev) return;
    if (!dragStart.current) dragStart.current = prev;
    const next = structuredClone(prev);
    const o = next.objects.find((x) => x.id === id);
    if (!o) return;
    o.position = result.position; o.rotation = result.rotation; o.scale = result.scale;
    modelRef.current = next;
    setModel(next);
    if (final) {
      undoStack.current.push({ model: dragStart.current, label: 'Transform', t: Date.now() });
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      dragStart.current = null;
      syncHist();
    }
    markDirty();
  }, [markDirty]);

  const onSelect = useCallback((id: string | null, additive: boolean) => {
    setSelection((s) => (id === null ? (additive ? s : []) : additive ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  }, []);

  /* ---------- object commands ---------- */

  const addObject = (kind: ObjectKind, init: Record<string, unknown> = {}): void => {
    const m = modelRef.current;
    if (!m) return;
    let newId = '';
    commit((draft) => {
      const o = makeObject(kind, draft.objects, init);
      draft.objects.push(o);
      newId = o.id;
    }, `Add ${kind}`);
    setSelection([newId]);
    setTab('object');
  };

  const runOnSelection = (label: string, op: (draft: Model3D, id: string) => void): void => {
    const ids = selection;
    if (ids.length === 0) return;
    commit((draft) => { for (const id of ids) op(draft, id); }, label);
  };

  const duplicateSelection = (): void => {
    if (selection.length === 0) return;
    const before = new Set(modelRef.current?.objects.map((o) => o.id));
    commit((draft) => { for (const id of selection) applyModelOp(draft, { op: 'duplicate', target: id, offset: [0.6, 0, 0.6] }); }, 'Duplicate');
    const fresh = modelRef.current?.objects.filter((o) => !before.has(o.id) && !o.parent).map((o) => o.id) ?? [];
    if (fresh.length) setSelection(fresh);
  };

  const deleteSelection = (): void => {
    if (selection.length === 0) return;
    commit((draft) => { for (const id of selection) { if (draft.objects.some((o) => o.id === id)) applyModelOp(draft, { op: 'remove', target: id }); } }, 'Delete');
    setSelection([]);
  };

  const toggleHideSelection = (): void => runOnSelection('Hide', (d, id) => { const o = d.objects.find((x) => x.id === id); if (o) o.visible = false; });
  const showAll = (): void => commit((d) => { for (const o of d.objects) o.visible = true; }, 'Show all');

  const copySelection = (): void => { clipboard.current = [...selection]; };
  const pasteSelection = (): void => { if (clipboard.current.length) { const prev = selection; setSelection(clipboard.current.filter((id) => modelRef.current?.objects.some((o) => o.id === id))); window.setTimeout(() => { duplicateSelection(); void prev; }, 0); } };

  const createModel = async (): Promise<void> => {
    const base = nameSlug(newName || 'scene');
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    await saveNow();
    try {
      await saveModel({ owner: USER_OWNER, slug }, newStarter ? starterModel(newName.trim() || 'Untitled') : emptyModel(newName.trim() || 'Untitled'), 'editor');
      setCreating(false); setNewName('');
      await refreshList();
      await openModel(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the model: ${String(error)}`, 'error'); }
  };

  const deleteModelFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeModel(ref);
      const rest = await listModelRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openModel(refKey(rest[0])); else { setCurrent(null); setModel(null); modelRef.current = null; setOpenModel(null); } }
    } catch (error) { notify(`Could not delete the model: ${String(error)}`, 'error'); }
  };

  /* ---------- export and render ---------- */

  const exportAs = async (format: ExportFormat): Promise<void> => {
    const ref = refOf(current), m = modelRef.current;
    if (!ref || !m) return;
    try {
      const out = await exportModel(m, format);
      const path = modelPath(ref).replace(/\.model\.json$/, `.${format}`);
      await writeWorktreeBinary(path, typeof out.data === 'string' ? textToBase64(out.data) : arrayBufferToBase64(out.data));
      notify(`Saved ${path}`);
    } catch (error) { notify(`Could not export: ${String(error)}`, 'error'); }
  };

  const downloadAs = async (format: ExportFormat): Promise<void> => {
    const m = modelRef.current;
    if (!m) return;
    try {
      const out = await exportModel(m, format);
      const blob = new Blob([out.data], { type: out.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${nameSlug(m.title)}.${format}`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (error) { notify(`Could not export: ${String(error)}`, 'error'); }
  };

  const renderImage = async (download: boolean): Promise<void> => {
    const ref = refOf(current), m = modelRef.current;
    if (!ref || !m) return;
    try {
      const view = viewportRef.current?.getView();
      const shot = renderModel(m, { width: 1920, height: 1080, position: view?.position, target: view?.target, shading: 'material' });
      const path = modelPath(ref).replace(/\.model\.json$/, '-render.png');
      await writeWorktreeBinary(path, shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1));
      if (download) { const a = document.createElement('a'); a.href = shot.dataUrl; a.download = `${nameSlug(m.title)}-render.png`; a.click(); }
      notify(`Rendered ${shot.width}×${shot.height} → ${path}`);
    } catch (error) { notify(`Could not render: ${String(error)}`, 'error'); }
  };

  /* ---------- menus and keys ---------- */

  const has = !!model;
  const setView = (preset: ViewPreset): void => viewportRef.current?.setView(preset);
  const frame = (all: boolean): void => viewportRef.current?.frame(all ? [] : selection);
  const cycleShading = (): void => setShading((s) => SHADING[(SHADING.indexOf(s) + 1) % SHADING.length]);

  const menus = (): Record<string, MenuEntry[]> => ({
    File: [
      { label: 'New scene…', onSelect: () => setCreating(true) },
      { label: 'Save', keys: 'Ctrl+S', onSelect: () => void saveNow(), disabled: !has },
      { separator: true },
      { label: 'Export GLB (glTF binary) to workspace', onSelect: () => void exportAs('glb'), disabled: !has },
      { label: 'Export OBJ to workspace', onSelect: () => void exportAs('obj'), disabled: !has },
      { label: 'Export STL to workspace', onSelect: () => void exportAs('stl'), disabled: !has },
      { label: 'Download GLB', onSelect: () => void downloadAs('glb'), disabled: !has },
      { label: 'Download STL', onSelect: () => void downloadAs('stl'), disabled: !has },
    ],
    Edit: [
      { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: hist.undo === 0 },
      { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: hist.redo === 0 },
      { separator: true },
      { label: 'Duplicate', keys: 'Shift+D', onSelect: duplicateSelection, disabled: selection.length === 0 },
      { label: 'Copy', keys: 'Ctrl+C', onSelect: copySelection, disabled: selection.length === 0 },
      { label: 'Paste', keys: 'Ctrl+V', onSelect: pasteSelection, disabled: clipboard.current.length === 0 },
      { label: 'Delete', keys: 'X', onSelect: deleteSelection, disabled: selection.length === 0 },
      { separator: true },
      { label: 'Select all', keys: 'A', onSelect: () => setSelection(modelRef.current?.objects.map((o) => o.id) ?? []), disabled: !has },
      { label: 'Deselect all', keys: 'Alt+A', onSelect: () => setSelection([]), disabled: selection.length === 0 },
    ],
    Add: [
      { heading: true, label: 'Mesh' },
      ...PRIMITIVE_MENU.map(({ kind, label }): MenuEntry => ({ label, onSelect: () => addObject(kind, kind === 'plane' ? {} : { position: [0, kind === 'box' ? 0.5 : kind === 'sphere' || kind === 'icosphere' ? 0.5 : 0.5, 0] }), disabled: !has })),
      { heading: true, label: 'Light' },
      ...LIGHT_TYPES.map((type): MenuEntry => ({ label: type === 'sun' ? 'Sun' : `${type[0].toUpperCase()}${type.slice(1)}`, onSelect: () => addObject('light', { light: { type }, lookAt: type === 'sun' || type === 'spot' ? [0, 0, 0] : undefined, position: type === 'sun' ? [5, 8, 4] : [2, 3, 2] }), disabled: !has })),
      { heading: true, label: 'Other' },
      { label: 'Camera', onSelect: () => { const v = viewportRef.current?.getView(); addObject('camera', { position: v?.position ?? [6, 4.5, 8], lookAt: v?.target ?? [0, 0.5, 0] }); }, disabled: !has },
      { label: 'Empty', onSelect: () => addObject('empty'), disabled: !has },
    ],
    Object: [
      { label: 'Move', keys: 'G', onSelect: () => setMode('translate') },
      { label: 'Rotate', keys: 'R', onSelect: () => setMode('rotate') },
      { label: 'Scale', keys: 'S', onSelect: () => setMode('scale') },
      { separator: true },
      { label: 'Snap to grid', checked: snap, onSelect: () => setSnap((s) => !s) },
      { label: 'Drop to the ground', onSelect: () => runOnSelection('Drop to ground', (d, id) => { try { applyModelOp(d, { op: 'align', target: id, ground: true }); } catch { /* not a mesh */ } }), disabled: selection.length === 0 },
      { label: 'Reset location, rotation and scale', onSelect: () => runOnSelection('Reset transform', (d, id) => { const o = d.objects.find((x) => x.id === id); if (o) { o.position = [0, 0, 0]; o.rotation = o.kind === 'plane' || o.kind === 'circle' ? [-90, 0, 0] : [0, 0, 0]; o.scale = [1, 1, 1]; } }), disabled: selection.length === 0 },
      { label: 'Clear parent', onSelect: () => runOnSelection('Clear parent', (d, id) => { const o = d.objects.find((x) => x.id === id); if (o) o.parent = null; }), disabled: selection.length === 0 },
      { separator: true },
      { label: 'Hide', keys: 'H', onSelect: toggleHideSelection, disabled: selection.length === 0 },
      { label: 'Show all', keys: 'Alt+H', onSelect: showAll, disabled: !has },
    ],
    View: [
      { label: 'Front', keys: 'Numpad 1', onSelect: () => setView('front') },
      { label: 'Right', keys: 'Numpad 3', onSelect: () => setView('right') },
      { label: 'Top', keys: 'Numpad 7', onSelect: () => setView('top') },
      { label: 'Back', keys: 'Ctrl+Numpad 1', onSelect: () => setView('back') },
      { label: 'Left', keys: 'Ctrl+Numpad 3', onSelect: () => setView('left') },
      { label: 'Bottom', keys: 'Ctrl+Numpad 7', onSelect: () => setView('bottom') },
      { separator: true },
      { label: 'Orthographic', keys: 'Numpad 5', checked: ortho, onSelect: () => setOrtho((o) => !o) },
      { label: 'Frame selected', keys: 'Numpad .', onSelect: () => frame(false), disabled: selection.length === 0 },
      { label: 'Frame all', keys: 'Home', onSelect: () => frame(true) },
      { separator: true },
      { label: 'Solid shading', checked: shading === 'solid', onSelect: () => setShading('solid') },
      { label: 'Material preview', checked: shading === 'material', onSelect: () => setShading('material') },
      { label: 'Wireframe', checked: shading === 'wireframe', onSelect: () => setShading('wireframe') },
      { separator: true },
      { label: 'Keyboard shortcuts', keys: '?', onSelect: () => setHelpOpen(true) },
    ],
    Render: [
      { label: 'Render image', keys: 'F12', onSelect: () => void renderImage(false), disabled: !has },
      { label: 'Render image and download', onSelect: () => void renderImage(true), disabled: !has },
    ],
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    const act = (fn: () => void): void => { e.preventDefault(); fn(); };
    if (ctrl) {
      if (key === 'z' && !e.shiftKey) return act(undo);
      if (key === 'y' || (key === 'z' && e.shiftKey)) return act(redo);
      if (key === 's') return act(() => void saveNow());
      if (key === 'c') return act(copySelection);
      if (key === 'v') return act(pasteSelection);
      if (key === 'd') return act(duplicateSelection);
      if (e.code === 'Numpad1' || e.code === 'Numpad3' || e.code === 'Numpad7') return act(() => setView(e.code === 'Numpad1' ? 'back' : e.code === 'Numpad3' ? 'left' : 'bottom'));
      return;
    }
    if (e.code === 'Numpad1' || e.code === 'Numpad3' || e.code === 'Numpad7') return act(() => setView(e.code === 'Numpad1' ? 'front' : e.code === 'Numpad3' ? 'right' : 'top'));
    if (e.code === 'Numpad5') return act(() => setOrtho((o) => !o));
    if (e.code === 'NumpadDecimal') return act(() => frame(false));
    if (e.key === 'Home') return act(() => frame(true));
    if (e.key === 'F12') return act(() => void renderImage(false));
    if (e.key === '?') return act(() => setHelpOpen(true));
    if (e.key === 'Escape') { setMenu(null); setHelpOpen(false); return; }
    if (e.key === 'Delete' || key === 'x') return act(deleteSelection);
    if (e.shiftKey && key === 'd') return act(duplicateSelection);
    if (e.shiftKey && key === 'a') return act(() => setMenu('Add'));
    if (e.altKey && key === 'h') return act(showAll);
    if (e.altKey && key === 'a') return act(() => setSelection([]));
    if (e.altKey) return;
    if (key === 'h') return act(toggleHideSelection);
    if (key === 'a') return act(() => setSelection(modelRef.current?.objects.map((o) => o.id) ?? []));
    if (key === 'q') return act(() => setMode('select'));
    if (key === 'g') return act(() => setMode('translate'));
    if (key === 'r') return act(() => setMode('rotate'));
    if (key === 's') return act(() => setMode('scale'));
    if (key === 'z') return act(cycleShading);
  };

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  // The menu callbacks only run when an item is clicked, never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const menuDefs = menus();
  const active = model?.objects.find((o) => o.id === selection[selection.length - 1]);
  const tris = model ? triangleCount(model) : 0;
  const shortSummary = model ? summarizeModel(model).split('\n')[0] : '';

  const gizmoButtons: Array<{ id: GizmoMode; label: string; key: string; icon: typeof Move }> = [
    { id: 'select', label: 'Select', key: 'Q', icon: MousePointer2 }, { id: 'translate', label: 'Move', key: 'G', icon: Move },
    { id: 'rotate', label: 'Rotate', key: 'R', icon: Rotate3d }, { id: 'scale', label: 'Scale', key: 'S', icon: Scale3d },
  ];

  return (
    <div className="screen m3d">
      <header className="screen-header">
        <h1 className="screen-header__title">3D Model</h1>
        <span className="screen-header__meta">Blender-style scene editor — the 3D Artist agent can build on the same scene</span>
        {current && <span className={`m3d__save m3d__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="m3d__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={drawingsOpen} onClick={() => setFilesOpen((o) => !o)}>
            <BoxIcon size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Scenes'} <ChevronDown size={11} />
          </button>
          {drawingsOpen && (
            <div className="m3d__popup m3d__popup--list" role="menu" aria-label="Scenes">
              {refs.length === 0 && <p className="m3d-note">No scenes yet — create one, or ask the 3D Artist agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="m3d__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`m3d__file${key === current ? ' m3d__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="m3d__file-main" title={modelPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openModel(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="m3d-icon m3d-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteModelFile(key)}><Check size={12} /></button>
                            <button type="button" className="m3d-icon" aria-label="Keep scene" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : (
                          <button type="button" className="m3d-icon m3d__file-del" aria-label={`Delete ${ref.slug}`} title="Delete scene" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating((c) => !c)}><Plus size={12} strokeWidth={1.5} /> New scene</button>
      </header>

      {creating && (
        <div className="m3d__new" role="group" aria-label="New scene">
          <input className="m3d-input" autoFocus placeholder="Scene name…" aria-label="New scene name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createModel(); if (e.key === 'Escape') setCreating(false); }} />
          <label className="m3d-check"><input type="checkbox" checked={newStarter} onChange={(e) => setNewStarter(e.target.checked)} /> Start with the default scene (ground, cube, sun, camera)</label>
          <button type="button" className="m3d-btn m3d-btn--primary" onClick={() => void createModel()}>Create</button>
          <button type="button" className="m3d-btn" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      <div className="screen-body m3d__body">
        <div className="m3d__main" onKeyDown={onKeyDown}>
          <nav className="m3d__menubar" aria-label="3D menu">
            {Object.entries(menuDefs).map(([name, entries]) => (
              <div key={name} className="m3d__menu">
                <button type="button" className={`m3d__menu-btn${menu === name ? ' m3d__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => { if (menu) setMenu(name); }}>{name}</button>
                {menu === name && (
                  <div className="m3d__popup" role="menu" aria-label={name}>
                    {entries.map((entry, i) => entry.separator ? <hr key={i} /> : entry.heading ? <div key={i} className="m3d__owner">{entry.label}</div> : (
                      <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onClick={() => { setMenu(null); entry.onSelect?.(); }}>
                        <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
                        {entry.keys && <kbd>{entry.keys}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <span className="m3d-grow" />
            <button type="button" className="m3d-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
            <button type="button" className="m3d-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
            <button type="button" className="m3d-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
          </nav>

          <div className="m3d__work" tabIndex={0} aria-label="3D editor" onPointerDown={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') e.currentTarget.focus(); }}>
            {model ? (
              <>
                <div className="m3d__tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
                  {gizmoButtons.map(({ id, label, key, icon: Icon }) => (
                    <button key={id} type="button" className={`m3d__tool${mode === id ? ' m3d__tool--on' : ''}`} aria-label={label} aria-pressed={mode === id} title={`${label} (${key})`} onClick={() => setMode(id)}><Icon size={16} strokeWidth={1.5} /></button>
                  ))}
                  <span className="m3d__tool-gap" />
                  <button type="button" className={`m3d__tool${snap ? ' m3d__tool--on' : ''}`} aria-label="Snap" aria-pressed={snap} title="Snap to grid, 15° and 0.1 scale steps" onClick={() => setSnap((s) => !s)}><Magnet size={16} strokeWidth={1.5} /></button>
                  <button type="button" className={`m3d__tool${model.world.grid ? ' m3d__tool--on' : ''}`} aria-label="Grid" aria-pressed={model.world.grid} title="Show the grid" onClick={() => commit((d) => { d.world.grid = !d.world.grid; }, 'Grid')}><Grid3x3 size={16} strokeWidth={1.5} /></button>
                </div>
                <div className="m3d__viewport">
                  <div className="m3d__vp-head" role="toolbar" aria-label="Viewport">
                    <div className="m3d-chips" role="radiogroup" aria-label="Shading">
                      {SHADING.map((s) => <button key={s} type="button" role="radio" aria-checked={shading === s} className={`m3d-chip${shading === s ? ' m3d-chip--on' : ''}`} onClick={() => setShading(s)}>{s === 'solid' ? 'Solid' : s === 'material' ? 'Material' : 'Wireframe'}</button>)}
                    </div>
                    <button type="button" className={`m3d-chip${ortho ? ' m3d-chip--on' : ''}`} aria-pressed={ortho} onClick={() => setOrtho((o) => !o)}>{ortho ? 'Orthographic' : 'Perspective'}</button>
                    <div className="m3d-chips" role="group" aria-label="Views">
                      {(['front', 'right', 'top'] as const).map((v) => <button key={v} type="button" className="m3d-chip" onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
                    </div>
                    <button type="button" className="m3d-icon" aria-label="Frame all" title="Frame everything (Home)" onClick={() => frame(true)}><Maximize size={13} /></button>
                    <button type="button" className="m3d-icon" aria-label="Frame selected" title="Frame the selection (Numpad .)" disabled={selection.length === 0} onClick={() => frame(false)}><Orbit size={13} /></button>
                    <button type="button" className="m3d-icon" aria-label="Render image" title="Render an image (F12)" onClick={() => void renderImage(false)}><ImageIcon size={13} /></button>
                    <button type="button" className="m3d-icon" aria-label="Download GLB" title="Download as GLB" onClick={() => void downloadAs('glb')}><Download size={13} /></button>
                  </div>
                  <Viewport3D
                    ref={viewportRef} model={model} selection={selection} mode={mode} shading={shading} ortho={ortho} grid={model.world.grid} snap={snap}
                    onSelect={onSelect} onTransform={onTransform}
                  />
                  <div className="m3d__status" role="status" aria-label="Scene statistics">
                    <span>{model.objects.length} objects</span><span>{tris.toLocaleString('en-US')} triangles</span>
                    {active && <span>{active.name}</span>}
                    <span className="m3d-grow" />
                    <span className="m3d__hint">{mode === 'select' ? 'Click to select · G/R/S to transform · Shift+A add' : `${mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Scale'}: drag the gizmo · Q to select`}</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="m3d__welcome">
                <BoxIcon size={34} strokeWidth={1.25} />
                <h2>3D Model</h2>
                <p>Create a scene to start modelling. Add shapes, lights and cameras, move them with G, R and S, give them materials, and render or export the result — or ask the 3D Artist agent to build it for you.</p>
                <button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={12} strokeWidth={1.5} /> New scene</button>
              </div>
            )}
            {helpOpen && <ShortcutHelp title="3D Model shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
          </div>
        </div>

        {model && (
          <aside className="m3d__dock" aria-label="Scene and properties">
            <section className="m3d__dock-section" aria-label="Outliner">
              <h2 className="m3d__dock-head">Scene Collection <span className="m3d__count">{model.objects.length}</span></h2>
              <Outliner model={model} selection={selection} onSelect={(id, additive) => onSelect(id, additive)} commit={commit} />
            </section>
            <section className="m3d__dock-section m3d__dock-section--props" aria-label="Properties panel">
              <Properties model={model} selection={selection} tab={tab} onTab={setTab} commit={commit} />
              <p className="m3d-note m3d-note--tail">{shortSummary}</p>
            </section>
          </aside>
        )}

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('model3d')} onCollapse={() => setAiOpen(false)} />
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

