import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import {
  Brush, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleDashed, Crop, Droplet, Eraser, Hand, Keyboard, Lasso, Maximize, Minus, Move, PaintBucket,
  Palette, Pentagon, Pipette, Plus, Redo2, Square, SquareDashed, Trash2, Type, Undo2, WandSparkles, Blend, X, ZoomIn, ZoomOut, Layers as LayersIcon,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { FONT_STACKS, brushById, emptyDrawing, type BrushPreset, type BrushSettings, type DrawOp, type FontFamily } from './drawing';
import { DrawingSession, type StrokeOptions, type StrokePoint } from './drawingEngine';
import { FILTERS, hexOf, parseColor, type FilterDef, type RGBA, type SelectMode } from './drawingPixels';
import {
  DRAWING_CHANGED, DRAWING_OPEN, drawingPath, listDrawingRefs, loadDrawing, registerDrawingFlush, removeDrawing, saveDrawing, setOpenDrawing,
  takePendingOpenDrawing, type DrawingChange, type DrawingOpenRequest,
} from './drawingStore';
import { BrushPanel, ColorPanel, HistoryPanel, LayersPanel, PalettePanel, Slider } from './DrawingPanels';
import { AmountDialog, FilterDialog, NewDrawingDialog, SizeDialog, TransformDialog, type NewDrawingSpec } from './DrawingDialogs';
import './DrawingScreen.css';

interface View { x: number; y: number; k: number }
interface Rect { x: number; y: number; w: number; h: number }
type Tool =
  | 'brush' | 'eraser' | 'smudge' | 'fill' | 'gradient' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'text' | 'picker'
  | 'select-rect' | 'select-ellipse' | 'lasso' | 'wand' | 'move' | 'crop' | 'pan' | 'zoom';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; view: View }
  | { kind: 'stroke'; smudge: boolean; last: StrokePoint }
  | { kind: 'shape'; tool: Tool; start: { x: number; y: number }; cur: { x: number; y: number }; shift: boolean; alt: boolean }
  | { kind: 'lasso'; points: Array<{ x: number; y: number }>; mode: SelectMode }
  | { kind: 'move'; start: { x: number; y: number }; id: string };

const MIN_K = 0.05;
const MAX_K = 32;
const LAST_KEY = 'pigry:drawing-last';
const SAVE_DELAY = 900;
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof Brush; gap?: boolean }> = [
  { id: 'brush', label: 'Freehand brush', key: 'B', icon: Brush },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: Eraser },
  { id: 'smudge', label: 'Smudge', key: 'S', icon: Droplet },
  { id: 'fill', label: 'Fill (paint bucket)', key: 'F', icon: PaintBucket },
  { id: 'gradient', label: 'Gradient', key: 'G', icon: Blend },
  { id: 'line', label: 'Line', key: 'L', icon: Minus, gap: true },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { id: 'polygon', label: 'Polygon', key: 'P', icon: Pentagon },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
  { id: 'picker', label: 'Colour picker', key: 'I', icon: Pipette },
  { id: 'select-rect', label: 'Rectangular selection', key: 'M', icon: SquareDashed, gap: true },
  { id: 'select-ellipse', label: 'Elliptical selection', key: 'U', icon: CircleDashed },
  { id: 'lasso', label: 'Freehand selection', key: 'Q', icon: Lasso },
  { id: 'wand', label: 'Contiguous selection (magic wand)', key: 'W', icon: WandSparkles },
  { id: 'move', label: 'Move layer', key: 'V', icon: Move, gap: true },
  { id: 'crop', label: 'Crop', key: 'C', icon: Crop },
  { id: 'pan', label: 'Pan', key: 'H', icon: Hand },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: ZoomIn },
];

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Tools', items: TOOLS.map((t) => ({ keys: t.key, label: t.label })) },
  { title: 'Painting', items: [
    { keys: '[ / ]', label: 'Smaller / larger brush' }, { keys: 'X', label: 'Swap foreground and background colour' }, { keys: 'D', label: 'Black and white' },
    { keys: 'Alt+Click', label: 'Pick the colour under the cursor' }, { keys: 'Shift+Drag', label: 'Straight line, square or circle with the shape tools' },
    { keys: 'Alt+Backspace', label: 'Fill with the foreground colour' }, { keys: 'Ctrl+Backspace', label: 'Fill with the background colour' },
  ] },
  { title: 'Edit', items: [
    { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+C', label: 'Copy' }, { keys: 'Ctrl+X', label: 'Cut' },
    { keys: 'Ctrl+V', label: 'Paste as a new layer' }, { keys: 'Delete', label: 'Clear the selection' }, { keys: 'Ctrl+S', label: 'Save now' },
  ] },
  { title: 'Selection', items: [
    { keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Ctrl+Shift+A', label: 'Deselect' }, { keys: 'Ctrl+I', label: 'Invert selection' },
    { keys: 'Shift+Drag', label: 'Add to the selection' }, { keys: 'Alt+Drag', label: 'Subtract from the selection' }, { keys: 'Esc', label: 'Deselect / cancel' },
  ] },
  { title: 'Layers', items: [
    { keys: 'Ctrl+Shift+N', label: 'New layer' }, { keys: 'Ctrl+J', label: 'Duplicate layer' }, { keys: 'Ctrl+E', label: 'Merge down' },
    { keys: 'PageUp / PageDown', label: 'Select the layer above / below' },
  ] },
  { title: 'View', items: [
    { keys: '+ / -', label: 'Zoom in / out' }, { keys: 'Scroll', label: 'Zoom at the cursor' }, { keys: '0', label: 'Fit in the window' }, { keys: '1', label: 'Zoom to 100%' },
    { keys: 'Space+Drag', label: 'Pan' }, { keys: '?', label: 'This list' },
  ] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; heading?: boolean; checked?: boolean }

const signatureOf = (s: DrawingSession): string =>
  `${s.historyLabels.undo.length}|${s.historyLabels.redo.length}|${s.width}x${s.height}|${s.activeId}|${s.selection ? 1 : 0}|${s.stroke ? 1 : 0}|${s.layers.map((l) => `${l.meta.id}:${l.meta.name}:${l.meta.visible ? 1 : 0}${l.meta.locked ? 1 : 0}${l.meta.alphaLock ? 1 : 0}${l.meta.clip ? 1 : 0}:${l.meta.opacity}:${l.meta.blend}`).join(',')}`;

const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));
const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }, square: boolean): Rect => {
  let w = b.x - a.x, h = b.y - a.y;
  if (square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  return { x: w < 0 ? a.x + w : a.x, y: h < 0 ? a.y + h : a.y, w: Math.abs(w), h: Math.abs(h) };
};

type Dialog =
  | { kind: 'new' } | { kind: 'canvas' } | { kind: 'scale' } | { kind: 'transform' }
  | { kind: 'filter'; def: FilterDef }
  | { kind: 'amount'; title: string; label: string; value: number; min: number; max: number; apply: (n: number) => void };

export function DrawingScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [session, setSession] = useState<DrawingSession | null>(null);
  const [tick, setTick] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tool, setTool] = useState<Tool>('brush');
  const [presetId, setPresetId] = useState('pencil');
  const [brush, setBrush] = useState<BrushSettings>(() => ({ ...brushById('pencil') }));
  const [fg, setFg] = useState<RGBA>(BLACK);
  const [bg, setBg] = useState<RGBA>(WHITE);
  const [recent, setRecent] = useState<string[]>([]);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [grid, setGrid] = useState(false);
  const [mirrorX, setMirrorX] = useState(false);
  const [mirrorY, setMirrorY] = useState(false);
  const [opts, setOpts] = useState({
    tolerance: 32, contiguous: true, gradient: 'linear' as 'linear' | 'radial', gradientFade: false, shape: 'stroke' as 'stroke' | 'fill' | 'both', shapeWidth: 4, radius: 0,
    selectMode: 'replace' as SelectMode, wandTolerance: 24, wandAll: false, pickWhole: true, textSize: 48, textFont: 'sans' as FontFamily, textWeight: 400, textItalic: false, smudge: 0.7,
  });
  const [menu, setMenu] = useState<string | null>(null);
  const [drawingsOpen, setDrawingsOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [polyCount, setPolyCount] = useState(0);
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; left: number; top: number; text: string } | null>(null);
  const [docks, setDocks] = useState({ color: true, brush: true, palette: true, layers: true, history: false });
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  const sessionRef = useRef<DrawingSession | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const loadingRef = useRef(false);
  const viewRef = useRef(view);
  const dragRef = useRef<Drag | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const polyRef = useRef<Array<{ x: number; y: number }>>([]);
  const cropRef = useRef<Rect | null>(null);
  const gridRef = useRef(grid);
  const mirrorRef = useRef({ x: mirrorX, y: mirrorY });
  const brushRef = useRef(brush);
  const toolRef = useRef(tool);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const paintFrame = useRef<number | null>(null);
  const antsPhase = useRef(0);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef(false);
  const filterIdRef = useRef('');
  const lastTick = useRef('');
  const spaceHeld = useRef(false);

  useEffect(() => { viewRef.current = view; gridRef.current = grid; mirrorRef.current = { x: mirrorX, y: mirrorY }; brushRef.current = brush; toolRef.current = tool; cropRef.current = crop; });

  /* ---------- painting the canvas ---------- */

  const paintNow = useCallback(() => {
    paintFrame.current = null;
    const s = sessionRef.current, canvas = canvasRef.current, overlay = overlayRef.current, stage = stageRef.current;
    if (!s || !canvas) return;
    if (canvas.width !== s.width || canvas.height !== s.height) { canvas.width = s.width; canvas.height = s.height; }
    const ctx = canvas.getContext('2d');
    if (ctx) s.renderTo(ctx, true);
    if (!overlay || !stage) return;
    if (overlay.width !== stage.clientWidth || overlay.height !== stage.clientHeight) { overlay.width = stage.clientWidth; overlay.height = stage.clientHeight; }
    const o = overlay.getContext('2d');
    if (!o) return;
    const v = viewRef.current;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, overlay.width, overlay.height);
    o.setTransform(v.k, 0, 0, v.k, v.x, v.y);
    const line = 1 / v.k;
    // Pixel grid
    if (gridRef.current && v.k >= 6) {
      o.strokeStyle = 'rgba(128,128,128,0.35)'; o.lineWidth = line; o.beginPath();
      for (let x = 0; x <= s.width; x++) { o.moveTo(x, 0); o.lineTo(x, s.height); }
      for (let y = 0; y <= s.height; y++) { o.moveTo(0, y); o.lineTo(s.width, y); }
      o.stroke();
    } else if (gridRef.current) {
      const step = v.k >= 1 ? 64 : 128;
      o.strokeStyle = 'rgba(128,128,128,0.4)'; o.lineWidth = line; o.beginPath();
      for (let x = step; x < s.width; x += step) { o.moveTo(x, 0); o.lineTo(x, s.height); }
      for (let y = step; y < s.height; y += step) { o.moveTo(0, y); o.lineTo(s.width, y); }
      o.stroke();
    }
    // Symmetry axes
    const mir = mirrorRef.current;
    if (mir.x || mir.y) {
      o.strokeStyle = 'rgba(80,140,255,0.8)'; o.lineWidth = line; o.setLineDash([6 * line, 4 * line]); o.beginPath();
      if (mir.x) { o.moveTo(s.width / 2, 0); o.lineTo(s.width / 2, s.height); }
      if (mir.y) { o.moveTo(0, s.height / 2); o.lineTo(s.width, s.height / 2); }
      o.stroke(); o.setLineDash([]);
    }
    // Selection (marching ants)
    if (s.selection) {
      const edges = s.selectionEdges(), phase = antsPhase.current;
      const step = edges.length > 60000 ? 4 : 2;
      for (let i = 0; i < edges.length; i += step) {
        o.fillStyle = (((edges[i] + edges[i + 1] + phase) >> 2) & 1) === 0 ? '#000' : '#fff';
        o.fillRect(edges[i], edges[i + 1], 1, 1);
      }
    }
    // In-progress drag previews
    const drag = dragRef.current;
    o.lineWidth = line; o.strokeStyle = '#2f7bff'; o.fillStyle = 'rgba(47,123,255,0.12)';
    if (drag?.kind === 'shape') {
      const r = rectOf(drag.start, drag.cur, drag.shift && drag.tool !== 'line' && drag.tool !== 'gradient');
      o.setLineDash([5 * line, 4 * line]);
      if (drag.tool === 'line' || drag.tool === 'gradient') { o.beginPath(); o.moveTo(drag.start.x, drag.start.y); o.lineTo(drag.cur.x, drag.cur.y); o.stroke(); }
      else if (drag.tool === 'ellipse' || drag.tool === 'select-ellipse') { o.beginPath(); o.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); o.fill(); o.stroke(); }
      else { o.fillRect(r.x, r.y, r.w, r.h); o.strokeRect(r.x, r.y, r.w, r.h); }
      o.setLineDash([]);
    }
    if (drag?.kind === 'lasso' && drag.points.length > 1) {
      o.beginPath(); o.moveTo(drag.points[0].x, drag.points[0].y);
      for (const p of drag.points.slice(1)) o.lineTo(p.x, p.y);
      o.stroke();
    }
    const poly = polyRef.current;
    if (poly.length > 0) {
      o.beginPath(); o.moveTo(poly[0].x, poly[0].y);
      for (const p of poly.slice(1)) o.lineTo(p.x, p.y);
      if (cursorRef.current) o.lineTo(cursorRef.current.x, cursorRef.current.y);
      o.stroke();
      for (const p of poly) o.fillRect(p.x - 2 * line, p.y - 2 * line, 4 * line, 4 * line);
    }
    const c = cropRef.current;
    if (c) {
      o.fillStyle = 'rgba(0,0,0,0.5)';
      o.fillRect(0, 0, s.width, c.y); o.fillRect(0, c.y + c.h, s.width, s.height - c.y - c.h);
      o.fillRect(0, c.y, c.x, c.h); o.fillRect(c.x + c.w, c.y, s.width - c.x - c.w, c.h);
      o.strokeStyle = '#fff'; o.strokeRect(c.x, c.y, c.w, c.h);
    }
    // Brush outline
    const cur = cursorRef.current, t = toolRef.current;
    if (cur && (t === 'brush' || t === 'eraser' || t === 'smudge') && !spaceHeld.current) {
      o.strokeStyle = 'rgba(255,255,255,0.95)'; o.lineWidth = 2 * line; o.beginPath(); o.arc(cur.x, cur.y, Math.max(0.5, brushRef.current.size / 2), 0, Math.PI * 2); o.stroke();
      o.strokeStyle = 'rgba(0,0,0,0.85)'; o.lineWidth = line; o.stroke();
    }
  }, []);

  const schedulePaint = useCallback(() => {
    if (paintFrame.current === null) paintFrame.current = window.requestAnimationFrame(paintNow);
  }, [paintNow]);

  /* ---------- persistence ---------- */

  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key, ['.drawing.json']);
    return { owner: owner ?? USER_OWNER, slug };
  };

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), s = sessionRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !s || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      await saveDrawing(ref, s.toDrawing(), 'editor');
      setDirty(dirtyRef.current);
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the drawing: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerDrawingFlush(saveNow), [saveNow]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (paintFrame.current !== null) { window.cancelAnimationFrame(paintFrame.current); paintFrame.current = null; }
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), s = sessionRef.current;
    if (dirtyRef.current && ref && s) void saveDrawing(ref, s.toDrawing(), 'editor');
  }, []);

  // Keep the session subscription, the painted canvas and the panels in step with the document.
  useEffect(() => {
    sessionRef.current = session;
    if (!session) return;
    const off = session.subscribe(() => {
      schedulePaint();
      const sig = signatureOf(session);
      if (sig !== lastTick.current) { lastTick.current = sig; setTick(sig); }
      if (!loadingRef.current) { dirtyRef.current = true; setDirty(true); scheduleSave(); }
    });
    lastTick.current = signatureOf(session);
    window.requestAnimationFrame(() => { setTick(lastTick.current); schedulePaint(); });
    return off;
  }, [session, schedulePaint, scheduleSave]);

  useEffect(() => { schedulePaint(); }, [view, grid, mirrorX, mirrorY, crop, tool, brush.size, stageSize, polyCount, schedulePaint]);

  // Marching ants
  useEffect(() => {
    if (!session?.selection) return;
    const timer = window.setInterval(() => { antsPhase.current = (antsPhase.current + 1) % 8; schedulePaint(); }, 180);
    return () => window.clearInterval(timer);
  }, [session, tick, schedulePaint]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setStageSize({ w: stage.clientWidth, h: stage.clientHeight }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [session]);

  const fitView = useCallback((s?: DrawingSession | null) => {
    const stage = stageRef.current, doc = s ?? sessionRef.current;
    if (!stage || !doc || !stage.clientWidth) return;
    const k = clampK(Math.min(1, (stage.clientWidth - 80) / doc.width, (stage.clientHeight - 80) / doc.height));
    setView({ k, x: (stage.clientWidth - doc.width * k) / 2, y: (stage.clientHeight - doc.height * k) / 2 });
  }, []);

  const openDrawing = useCallback(async (key: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { drawing, warnings } = await loadDrawing(ref);
      loadingRef.current = true;
      const next = await DrawingSession.from(drawing);
      loadingRef.current = false;
      dirtyRef.current = false;
      setDirty(false);
      const nextKey = refKey(ref);
      currentRef.current = nextKey;
      sessionRef.current = next;
      setCurrent(nextKey);
      setSession(next);
      setCrop(null); polyRef.current = []; setPolyCount(0);
      setOpenDrawing(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Drawing opened with ${warnings.length} repaired issue(s).`);
      window.requestAnimationFrame(() => fitView(next));
    } catch (error) {
      loadingRef.current = false;
      notify(`Could not open "${key}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify, fitView]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listDrawingRefs()); } catch { setRefs([]); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listDrawingRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: DrawingOpenRequest | null = takePendingOpenDrawing();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openDrawing(refKey(found));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An agent tool wrote the file: show what it painted.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<DrawingChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setSession(null); sessionRef.current = null; setOpenDrawing(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openDrawing(change.key); }
    };
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<DrawingOpenRequest>).detail;
      takePendingOpenDrawing();
      void openDrawing(request.key);
    };
    window.addEventListener(DRAWING_CHANGED, onChanged);
    window.addEventListener(DRAWING_OPEN, onOpen);
    return () => { window.removeEventListener(DRAWING_CHANGED, onChanged); window.removeEventListener(DRAWING_OPEN, onOpen); };
  }, [openDrawing, refreshList]);

  /* ---------- helpers ---------- */

  const remember = (c: RGBA): void => setRecent((list) => [hexOf({ ...c, a: 255 }), ...list.filter((h) => h !== hexOf({ ...c, a: 255 }))].slice(0, 16));

  /** Applies one drawing operation to the open drawing, reporting a failure instead of throwing. */
  const run = (op: DrawOp): boolean => {
    const s = sessionRef.current;
    if (!s) return false;
    try { s.apply(op); return true; } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };

  const toDoc = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = stageRef.current!.getBoundingClientRect(), v = viewRef.current;
    return { x: (e.clientX - rect.left - v.x) / v.k, y: (e.clientY - rect.top - v.y) / v.k };
  };

  const zoomAt = (factor: number, cx?: number, cy?: number): void => {
    const stage = stageRef.current;
    if (!stage) return;
    const px = cx ?? stage.clientWidth / 2, py = cy ?? stage.clientHeight / 2;
    setView((v) => { const k = clampK(v.k * factor); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }; });
  };

  const zoomTo = (k: number): void => zoomAt(clampK(k) / viewRef.current.k);

  const strokeOptions = (erase: boolean): StrokeOptions => ({ ...brushRef.current, color: fg, erase, mirrorX: mirrorRef.current.x, mirrorY: mirrorRef.current.y });
  const pointOf = (e: ReactPointerEvent | PointerEvent): StrokePoint => ({ ...toDoc(e), p: e.pointerType === 'mouse' ? 1 : e.pressure > 0 ? e.pressure : 0.5 });

  const sampleColor = (pt: { x: number; y: number }, toBg: boolean, whole: boolean): void => {
    const c = sessionRef.current?.sample(pt.x, pt.y, whole);
    if (!c) return;
    const solid = { ...c, a: 255 };
    if (toBg) setBg(solid); else { setFg(solid); }
  };

  const modeOf = (e: { shiftKey: boolean; altKey: boolean }): SelectMode => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : opts.selectMode);

  /* ---------- pointer input ---------- */

  const finishPolygon = (): void => {
    const pts = polyRef.current;
    polyRef.current = []; setPolyCount(0);
    if (pts.length < 3) return;
    const fill = opts.shape !== 'stroke' ? (opts.shape === 'both' ? bg : fg) : undefined;
    const stroke = opts.shape !== 'fill' ? fg : undefined;
    if (run({ op: 'polygon', points: pts.map((p) => [p.x, p.y]), fill: fill ? hexOf(fill) : undefined, stroke: stroke ? hexOf(stroke) : undefined, width: opts.shapeWidth, closed: true })) remember(fg);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sessionRef.current;
    if (!s || textEdit) return;
    stageRef.current?.focus();
    if (e.button === 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = pointOf(e);
    if (e.button === 1 || spaceHeld.current || tool === 'pan') { dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, view: viewRef.current }; return; }
    if (e.altKey && ['brush', 'eraser', 'smudge', 'fill', 'gradient', 'text'].includes(tool)) { sampleColor(pt, false, true); return; }
    switch (tool) {
      case 'brush': case 'eraser':
        if (!s.strokeBegin(s.activeId, strokeOptions(tool === 'eraser'), pt)) { notify('This layer is locked or hidden.', 'error'); return; }
        dragRef.current = { kind: 'stroke', smudge: false, last: pt };
        break;
      case 'smudge':
        if (!s.smudgeBegin(s.activeId, brush.size, opts.smudge, pt)) { notify('This layer is locked or hidden.', 'error'); return; }
        dragRef.current = { kind: 'stroke', smudge: true, last: pt };
        break;
      case 'fill':
        if (run({ op: 'fill', x: pt.x, y: pt.y, color: hexOf(fg), tolerance: opts.tolerance, contiguous: opts.contiguous })) remember(fg);
        break;
      case 'picker': sampleColor(pt, e.button === 2, opts.pickWhole); break;
      case 'wand': s.selectColor(pt.x, pt.y, opts.wandTolerance, opts.contiguous, modeOf(e), opts.wandAll); break;
      case 'line': case 'rect': case 'ellipse': case 'gradient': case 'select-rect': case 'select-ellipse': case 'crop':
        dragRef.current = { kind: 'shape', tool, start: pt, cur: pt, shift: e.shiftKey, alt: e.altKey };
        break;
      case 'lasso': dragRef.current = { kind: 'lasso', points: [pt], mode: modeOf(e) }; break;
      case 'polygon':
        if (polyRef.current.length >= 3 && Math.hypot(pt.x - polyRef.current[0].x, pt.y - polyRef.current[0].y) * view.k < 8) finishPolygon();
        else { polyRef.current = [...polyRef.current, { x: pt.x, y: pt.y }]; setPolyCount(polyRef.current.length); }
        break;
      case 'text': {
        const rect = stageRef.current!.getBoundingClientRect();
        setTextEdit({ x: pt.x, y: pt.y, left: e.clientX - rect.left, top: e.clientY - rect.top, text: '' });
        break;
      }
      case 'move': {
        const layer = s.active;
        if (!layer || layer.meta.locked) { notify('This layer is locked.', 'error'); return; }
        s.moveOffset = { id: layer.meta.id, dx: 0, dy: 0 };
        dragRef.current = { kind: 'move', start: pt, id: layer.meta.id };
        break;
      }
      case 'zoom': zoomAt(e.altKey ? 0.5 : 2, e.clientX - stageRef.current!.getBoundingClientRect().left, e.clientY - stageRef.current!.getBoundingClientRect().top); break;
      default: break;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sessionRef.current;
    if (!s) return;
    const drag = dragRef.current;
    cursorRef.current = toDoc(e);
    if (!drag) { if (toolRef.current === 'brush' || toolRef.current === 'eraser' || toolRef.current === 'smudge' || polyRef.current.length) schedulePaint(); return; }
    if (drag.kind === 'pan') { setView({ ...drag.view, x: drag.view.x + e.clientX - drag.sx, y: drag.view.y + e.clientY - drag.sy }); return; }
    if (drag.kind === 'stroke') {
      const native = e.nativeEvent as PointerEvent;
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [native]) {
        const pt = pointOf(ev);
        if (drag.smudge) s.smudgeMove(pt); else s.strokeMove(pt);
        drag.last = pt;
      }
      return;
    }
    const pt = toDoc(e);
    if (drag.kind === 'shape') { drag.cur = pt; drag.shift = e.shiftKey; drag.alt = e.altKey; }
    else if (drag.kind === 'lasso') drag.points.push(pt);
    else if (drag.kind === 'move') s.moveOffset = { id: drag.id, dx: pt.x - drag.start.x, dy: pt.y - drag.start.y };
    s.touch();
    schedulePaint();
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sessionRef.current, drag = dragRef.current;
    dragRef.current = null;
    if (!s || !drag) return;
    if (drag.kind === 'stroke') {
      if (drag.smudge) s.smudgeEnd(); else { s.strokeEnd(); remember(fg); }
      return;
    }
    if (drag.kind === 'move') {
      const off = s.moveOffset;
      s.moveOffset = null;
      if (off) s.shiftLayer(drag.id, off.dx, off.dy); else s.touch();
      return;
    }
    if (drag.kind === 'lasso') { s.selectShape('polygon', { points: drag.points }, drag.mode); return; }
    if (drag.kind !== 'shape') return;
    const r = rectOf(drag.start, drag.cur, drag.shift && drag.tool !== 'line' && drag.tool !== 'gradient');
    const mode = modeOf(e);
    switch (drag.tool) {
      case 'select-rect': if (r.w > 0 && r.h > 0) s.selectShape('rect', r, mode); else s.deselect(); break;
      case 'select-ellipse': if (r.w > 0 && r.h > 0) s.selectShape('ellipse', r, mode); else s.deselect(); break;
      case 'crop': if (r.w > 3 && r.h > 3) setCrop({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }); break;
      case 'line': {
        let { x: x2, y: y2 } = drag.cur;
        if (drag.shift) { const dx = x2 - drag.start.x, dy = y2 - drag.start.y, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(dx, dy); x2 = drag.start.x + Math.cos(a) * d; y2 = drag.start.y + Math.sin(a) * d; }
        if (run({ op: 'line', x1: drag.start.x, y1: drag.start.y, x2, y2, color: hexOf(fg), width: opts.shapeWidth })) remember(fg);
        break;
      }
      case 'rect': case 'ellipse': {
        if (r.w < 1 || r.h < 1) break;
        const fill = opts.shape !== 'stroke' ? (opts.shape === 'both' ? bg : fg) : undefined, stroke = opts.shape !== 'fill' ? fg : undefined;
        if (run({ op: drag.tool, x: r.x, y: r.y, w: r.w, h: r.h, fill: fill ? hexOf(fill) : undefined, stroke: stroke ? hexOf(stroke) : undefined, width: opts.shapeWidth, radius: opts.radius })) remember(fg);
        break;
      }
      case 'gradient': {
        const to = opts.gradientFade ? { ...fg, a: 0 } : bg;
        if (Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) < 2) break;
        run({ op: 'gradient', x1: drag.start.x, y1: drag.start.y, x2: drag.cur.x, y2: drag.cur.y, from: hexOf(fg), to: hexOf(to), kind: opts.gradient });
        break;
      }
      default: break;
    }
    schedulePaint();
  };

  const onPointerLeave = (): void => { cursorRef.current = null; schedulePaint(); };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const rect = stageRef.current!.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  };

  const commitText = (): void => {
    const edit = textEdit;
    setTextEdit(null);
    if (!edit || !edit.text.trim()) return;
    if (run({ op: 'text', x: edit.x, y: edit.y, text: edit.text, size: opts.textSize, color: hexOf(fg), font: opts.textFont, weight: opts.textWeight, italic: opts.textItalic })) remember(fg);
  };

  useEffect(() => { if (textEdit) textRef.current?.focus(); }, [textEdit]);

  /* ---------- commands (menus, keys) ---------- */

  const s = session;
  const undo = (): void => { if (s?.undo()) schedulePaint(); };
  const redo = (): void => { if (s?.redo()) schedulePaint(); };
  const jump = (steps: number): void => { for (let i = 0; i < Math.abs(steps); i++) { if (steps < 0) s?.undo(); else s?.redo(); } };
  const needSel = (fn: () => void): void => { if (!s?.selection) { notify('Select an area first.'); return; } fn(); };

  const fillWith = (c: RGBA): void => {
    if (!s) return;
    if (s.selection) run({ op: 'fill_selection', color: hexOf(c) });
    else run({ op: 'rect', x: 0, y: 0, w: s.width, h: s.height, fill: hexOf(c) });
  };

  const download = (type: 'image/png' | 'image/jpeg' | 'image/webp'): void => {
    if (!s) return;
    const a = document.createElement('a');
    a.href = s.exportDataUrl(type);
    a.download = `${nameSlug(s.title)}.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`;
    a.click();
  };

  const exportToWorkspace = async (type: 'image/png' | 'image/jpeg' | 'image/webp'): Promise<void> => {
    const ref = refOf(current);
    if (!s || !ref) return;
    const ext = type === 'image/jpeg' ? '.jpg' : `.${type.slice(6)}`;
    const path = drawingPath(ref).replace(/\.drawing\.json$/, ext);
    try {
      const url = s.exportDataUrl(type);
      await writeWorktreeBinary(path, url.slice(url.indexOf(',') + 1));
      notify(`Saved ${path}`);
    } catch (error) { notify(`Could not export: ${String(error)}`, 'error'); }
  };

  const copyImage = async (): Promise<void> => {
    if (!s) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => s.compose(true).toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('the image could not be encoded');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Copied the picture to the clipboard.');
    } catch (error) { notify(`Could not copy: ${String(error)}`, 'error'); }
  };

  const importFile = (file: File | undefined): void => {
    if (!file || !s) return;
    const reader = new FileReader();
    reader.onload = () => {
      const image = new window.Image();
      image.onload = () => { try { s.importImage(image, file.name.replace(/\.[^.]+$/, '')); } catch (error) { notify(String(error), 'error'); } };
      image.onerror = () => notify('That file is not an image.', 'error');
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const createDrawing = async (spec: NewDrawingSpec): Promise<void> => {
    const base = nameSlug(spec.name || 'drawing');
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    await saveNow();
    try {
      await saveDrawing({ owner: USER_OWNER, slug }, emptyDrawing(spec.name.trim() || 'Untitled', spec.width, spec.height, spec.background), 'editor');
      setDialog(null);
      await refreshList();
      await openDrawing(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the drawing: ${String(error)}`, 'error'); }
  };

  const deleteDrawingFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeDrawing(ref);
      const rest = await listDrawingRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openDrawing(refKey(rest[0])); else { setCurrent(null); setSession(null); sessionRef.current = null; setOpenDrawing(null); } }
    } catch (error) { notify(`Could not delete the drawing: ${String(error)}`, 'error'); }
  };

  const previewFilter = useCallback((params: Record<string, number> | null) => {
    const doc = sessionRef.current;
    if (!doc) return;
    if (previewRef.current) { doc.undo(); previewRef.current = false; }
    if (!params) return;
    try { doc.apply({ op: 'filter', filter: filterIdRef.current, params }); previewRef.current = true; } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  }, [notify]);

  const openFilter = (def: FilterDef): void => {
    const layer = s?.active;
    if (!layer || layer.meta.locked || !layer.meta.visible) { notify('Select an unlocked, visible layer to filter.', 'error'); return; }
    filterIdRef.current = def.id; previewRef.current = false;
    setDialog({ kind: 'filter', def });
  };

  const cancelFilter = (): void => { previewFilter(null); setDialog(null); };
  const applyFilterDialog = (params: Record<string, number>): void => {
    if (!previewRef.current) run({ op: 'filter', filter: filterIdRef.current, params });
    previewRef.current = false;
    setDialog(null);
  };

  const amountDialog = (title: string, label: string, value: number, min: number, max: number, apply: (n: number) => void): void => setDialog({ kind: 'amount', title, label, value, min, max, apply });

  /* The callbacks below only run when a menu item is clicked, never while rendering. */
  /* eslint-disable react-hooks/refs */
  const menus = (): Record<string, MenuEntry[]> => {
    const has = !!s;
    const layer = s?.active;
    const filterGroups = (['Adjust', 'Blur', 'Artistic', 'Other'] as const).flatMap((group) => [
      { heading: true, label: group } as MenuEntry,
      ...FILTERS.filter((f) => f.group === group).map((f): MenuEntry => ({ label: f.label, onSelect: () => openFilter(f), disabled: !has })),
    ]);
    return {
      File: [
        { label: 'New drawing…', keys: 'Ctrl+N', onSelect: () => setDialog({ kind: 'new' }) },
        { label: 'Save', keys: 'Ctrl+S', onSelect: () => void saveNow(), disabled: !has },
        { separator: true },
        { label: 'Import image as layer…', onSelect: () => fileRef.current?.click(), disabled: !has },
        { separator: true },
        { label: 'Save PNG to workspace', onSelect: () => void exportToWorkspace('image/png'), disabled: !has },
        { label: 'Save JPEG to workspace', onSelect: () => void exportToWorkspace('image/jpeg'), disabled: !has },
        { label: 'Save WebP to workspace', onSelect: () => void exportToWorkspace('image/webp'), disabled: !has },
        { label: 'Download PNG', onSelect: () => download('image/png'), disabled: !has },
        { label: 'Copy picture to clipboard', onSelect: () => void copyImage(), disabled: !has },
      ],
      Edit: [
        { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: !s?.canUndo },
        { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: !s?.canRedo },
        { separator: true },
        { label: 'Cut', keys: 'Ctrl+X', onSelect: () => s?.copy(true), disabled: !has },
        { label: 'Copy', keys: 'Ctrl+C', onSelect: () => s?.copy(false), disabled: !has },
        { label: 'Paste as new layer', keys: 'Ctrl+V', onSelect: () => { if (!s?.paste()) notify('Nothing to paste — copy something first.'); }, disabled: !has },
        { label: 'Cut selection to a new layer', keys: 'Ctrl+Shift+J', onSelect: () => needSel(() => { s?.copy(true); s?.paste(); }), disabled: !has },
        { separator: true },
        { label: 'Clear', keys: 'Delete', onSelect: () => layer && run({ op: 'layer_clear' }), disabled: !has },
        { label: 'Fill with foreground colour', keys: 'Alt+Backspace', onSelect: () => fillWith(fg), disabled: !has },
        { label: 'Fill with background colour', keys: 'Ctrl+Backspace', onSelect: () => fillWith(bg), disabled: !has },
      ],
      Image: [
        { label: 'Canvas size…', onSelect: () => setDialog({ kind: 'canvas' }), disabled: !has },
        { label: 'Scale image…', onSelect: () => setDialog({ kind: 'scale' }), disabled: !has },
        { label: 'Crop to selection', onSelect: () => needSel(() => { const b = s!.selectionBounds(); if (b) run({ op: 'crop', ...b }); }), disabled: !has },
        { separator: true },
        { label: 'Rotate 90° clockwise', onSelect: () => run({ op: 'rotate', degrees: 90 }), disabled: !has },
        { label: 'Rotate 90° counter-clockwise', onSelect: () => run({ op: 'rotate', degrees: -90 }), disabled: !has },
        { label: 'Rotate 180°', onSelect: () => run({ op: 'rotate', degrees: 180 }), disabled: !has },
        { label: 'Flip image horizontally', onSelect: () => run({ op: 'flip', axis: 'horizontal', layer: 'all' }), disabled: !has },
        { label: 'Flip image vertically', onSelect: () => run({ op: 'flip', axis: 'vertical', layer: 'all' }), disabled: !has },
        { separator: true },
        { label: 'Flatten image', onSelect: () => s?.flatten(), disabled: !has },
        { label: s?.background ? 'Make the background transparent' : 'White background', onSelect: () => { if (s) { s.begin('Change background', []); s.background = s.background ? null : '#ffffff'; s.touch(); } }, disabled: !has },
      ],
      Layer: [
        { label: 'New layer', keys: 'Ctrl+Shift+N', onSelect: () => { try { s?.addLayer(); } catch (error) { notify(String(error instanceof Error ? error.message : error), 'error'); } }, disabled: !has },
        { label: 'Duplicate layer', keys: 'Ctrl+J', onSelect: () => layer && s?.duplicateLayer(layer.meta.id), disabled: !layer },
        { label: 'Merge down', keys: 'Ctrl+E', onSelect: () => layer && s?.mergeDown(layer.meta.id), disabled: !layer || s?.layers.indexOf(layer) === 0 },
        { label: 'Delete layer', onSelect: () => layer && s?.deleteLayer(layer.meta.id), disabled: !layer },
        { separator: true },
        { label: 'Flip layer horizontally', onSelect: () => layer && s?.flipLayer(layer.meta.id, false), disabled: !layer },
        { label: 'Flip layer vertically', onSelect: () => layer && s?.flipLayer(layer.meta.id, true), disabled: !layer },
        { label: 'Transform layer…', onSelect: () => setDialog({ kind: 'transform' }), disabled: !layer },
        { label: 'Clear layer', onSelect: () => layer && s?.clearLayer(layer.meta.id), disabled: !layer },
      ],
      Select: [
        { label: 'Select all', keys: 'Ctrl+A', onSelect: () => s?.selectAll(), disabled: !has },
        { label: 'Deselect', keys: 'Ctrl+Shift+A', onSelect: () => s?.deselect(), disabled: !s?.selection },
        { label: 'Invert selection', keys: 'Ctrl+I', onSelect: () => s?.invertSelection(), disabled: !has },
        { separator: true },
        { label: 'Grow selection…', onSelect: () => amountDialog('Grow selection', 'Grow by', 4, 1, 100, (n) => { s?.growSelection(n); setDialog(null); }), disabled: !s?.selection },
        { label: 'Shrink selection…', onSelect: () => amountDialog('Shrink selection', 'Shrink by', 4, 1, 100, (n) => { s?.growSelection(-n); setDialog(null); }), disabled: !s?.selection },
        { label: 'Feather selection…', onSelect: () => amountDialog('Feather selection', 'Feather radius', 8, 1, 100, (n) => { s?.featherSelection(n); setDialog(null); }), disabled: !s?.selection },
      ],
      Filter: filterGroups,
      View: [
        { label: 'Zoom in', keys: '+', onSelect: () => zoomAt(1.25) },
        { label: 'Zoom out', keys: '-', onSelect: () => zoomAt(1 / 1.25) },
        { label: 'Fit in window', keys: '0', onSelect: () => fitView() },
        { label: 'Actual size (100%)', keys: '1', onSelect: () => zoomTo(1) },
        { separator: true },
        { label: 'Show grid', checked: grid, onSelect: () => setGrid((g) => !g) },
        { label: 'Mirror horizontally (symmetry)', checked: mirrorX, onSelect: () => setMirrorX((m) => !m) },
        { label: 'Mirror vertically (symmetry)', checked: mirrorY, onSelect: () => setMirrorY((m) => !m) },
        { separator: true },
        { label: 'Keyboard shortcuts', keys: '?', onSelect: () => setHelpOpen(true) },
      ],
    };
  };

  /* eslint-enable react-hooks/refs */

  const choosePreset = (preset: BrushPreset): void => {
    setPresetId(preset.id);
    const { id: _id, name: _name, ...settings } = preset;
    void _id; void _name;
    setBrush(settings);
    if (tool !== 'brush' && tool !== 'eraser' && tool !== 'smudge') setTool('brush');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (textEdit) return;
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); spaceHeld.current = true; setSpaceDown(true); return; }
    if (ctrl) {
      const act = (fn: () => void): void => { e.preventDefault(); fn(); };
      if (key === 'z' && !e.shiftKey) return act(undo);
      if (key === 'y' || (key === 'z' && e.shiftKey)) return act(redo);
      if (key === 's') return act(() => void saveNow());
      if (key === 'n' && e.shiftKey) return act(() => { try { s?.addLayer(); } catch { /* layer limit */ } });
      if (key === 'n') return act(() => setDialog({ kind: 'new' }));
      if (key === 'a') return act(() => (e.shiftKey ? s?.deselect() : s?.selectAll()));
      if (key === 'i') return act(() => s?.invertSelection());
      if (key === 'c') return act(() => s?.copy(false));
      if (key === 'x') return act(() => s?.copy(true));
      if (key === 'v') return act(() => s?.paste());
      if (key === 'j' && e.shiftKey) return act(() => needSel(() => { s?.copy(true); s?.paste(); }));
      if (key === 'j') return act(() => { if (s?.active) s.duplicateLayer(s.active.meta.id); });
      if (key === 'e') return act(() => { if (s?.active) s.mergeDown(s.active.meta.id); });
      if (key === 'backspace') return act(() => fillWith(bg));
      if (key === '0') return act(() => fitView());
      return;
    }
    if (e.altKey && e.key === 'Backspace') { e.preventDefault(); fillWith(fg); return; }
    if (e.key === 'Enter') { if (polyRef.current.length) finishPolygon(); else if (crop && s) { run({ op: 'crop', ...crop }); setCrop(null); } return; }
    if (e.key === 'Escape') { if (polyRef.current.length) { polyRef.current = []; setPolyCount(0); } else if (crop) setCrop(null); else s?.deselect(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (s?.active) run({ op: 'layer_clear' }); return; }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      if (!s) return;
      const i = s.layers.findIndex((l) => l.meta.id === s.activeId), next = s.layers[i + (e.key === 'PageUp' ? 1 : -1)];
      if (next) s.setActive(next.meta.id);
      return;
    }
    if (e.key === '[' || e.key === ']') { const d = e.key === ']' ? 1 : -1; setBrush((b) => ({ ...b, size: Math.max(1, Math.min(400, b.size + d * (b.size < 10 ? 1 : b.size < 50 ? 5 : 10))) })); return; }
    if (e.key === '+' || e.key === '=') { zoomAt(1.25); return; }
    if (e.key === '-') { zoomAt(1 / 1.25); return; }
    if (e.key === '?') { setHelpOpen(true); return; }
    if (key === 'x') { const f = fg; setFg(bg); setBg(f); return; }
    if (key === 'd') { setFg(BLACK); setBg(WHITE); return; }
    if (key === '0') { fitView(); return; }
    if (key === '1') { zoomTo(1); return; }
    const hit = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (hit && !e.shiftKey) { setTool(hit.id); if (hit.id !== 'polygon') { polyRef.current = []; setPolyCount(0); } }
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => { if (e.key === ' ') { spaceHeld.current = false; setSpaceDown(false); } };

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const k = view.k;
  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const menuDefs = menus();
  const brushy = tool === 'brush' || tool === 'eraser' || tool === 'smudge';
  const layerNow = s?.active;
  const toggleDock = (key: keyof typeof docks): void => setDocks((d) => ({ ...d, [key]: !d[key] }));

  const dock = (key: keyof typeof docks, title: string, icon: React.ReactNode, body: React.ReactNode) => (
    <section className="drw-dock__section" aria-label={title}>
      <h2 className="drw-dock__head"><button type="button" aria-expanded={docks[key]} onClick={() => toggleDock(key)}>{docks[key] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{icon}{title}</button></h2>
      {docks[key] && <div className="drw-dock__body">{body}</div>}
    </section>
  );

  return (
    <div className="screen drw">
      <header className="screen-header">
        <h1 className="screen-header__title">Drawing</h1>
        <span className="screen-header__meta">Paint with layers, brushes and filters — the Illustrator agent can paint on the same canvas</span>
        {current && <span className={`drw__save drw__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="drw__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={drawingsOpen} onClick={() => setDrawingsOpen((o) => !o)}>
            <LayersIcon size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Drawings'} <ChevronDown size={11} />
          </button>
          {drawingsOpen && (
            <div className="drw__popup drw__popup--list" role="menu" aria-label="Drawings">
              {refs.length === 0 && <p className="drw-note">No drawings yet — create one, or ask the Illustrator agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="drw__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`drw__file${key === current ? ' drw__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="drw__file-main" title={drawingPath(ref)} onClick={() => { setDrawingsOpen(false); if (key !== current) void openDrawing(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="dr-icon dr-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteDrawingFile(key)}><Check size={12} /></button>
                            <button type="button" className="dr-icon" aria-label="Keep drawing" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : (
                          <button type="button" className="dr-icon drw__file-del" aria-label={`Delete ${ref.slug}`} title="Delete drawing" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New drawing</button>
      </header>

      <div className="screen-body drw__body">
        <div className="drw__main">
          <nav className="drw__menubar" aria-label="Drawing menu" onMouseLeave={() => undefined}>
            {/* eslint-disable-next-line react-hooks/refs */}
            {Object.entries(menuDefs).map(([name, entries]) => (
              <div key={name} className="drw__menu">
                <button
                  type="button" className={`drw__menu-btn${menu === name ? ' drw__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name}
                  onClick={() => setMenu(menu === name ? null : name)} onMouseEnter={() => { if (menu) setMenu(name); }}
                >{name}</button>
                {menu === name && (
                  <div className="drw__popup" role="menu" aria-label={name}>
                    {entries.map((entry, i) => entry.separator ? <hr key={i} /> : entry.heading ? <div key={i} className="drw__owner">{entry.label}</div> : (
                      <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onClick={() => { setMenu(null); entry.onSelect?.(); }}>
                        <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
                        {entry.keys && <kbd>{entry.keys}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <span className="dr-grow" />
            <button type="button" className="dr-icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!s?.canUndo} onClick={undo}><Undo2 size={14} /></button>
            <button type="button" className="dr-icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!s?.canRedo} onClick={redo}><Redo2 size={14} /></button>
            <span className="drw__sep" />
            <button type="button" className="dr-icon" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25)}><ZoomOut size={14} /></button>
            <span className="drw__zoom" aria-label="Zoom level">{Math.round(k * 100)}%</span>
            <button type="button" className="dr-icon" aria-label="Zoom in" onClick={() => zoomAt(1.25)}><ZoomIn size={14} /></button>
            <button type="button" className="dr-icon" aria-label="Fit to window" title="Fit in window (0)" onClick={() => fitView()}><Maximize size={14} /></button>
            <button type="button" className="dr-icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
          </nav>

          {s && (
            <div className="drw__opts" role="toolbar" aria-label="Tool options">
              <strong className="drw__opts-name">{TOOLS.find((t) => t.id === tool)?.label}</strong>
              {brushy && (
                <>
                  <Slider label="Size" value={brush.size} min={1} max={400} suffix=" px" onChange={(size) => setBrush((b) => ({ ...b, size }))} />
                  {tool === 'smudge'
                    ? <Slider label="Strength" value={Math.round(opts.smudge * 100)} min={5} max={100} suffix="%" onChange={(v) => setOpts((o) => ({ ...o, smudge: v / 100 }))} />
                    : <Slider label="Opacity" value={Math.round(brush.opacity * 100)} min={1} max={100} suffix="%" onChange={(v) => setBrush((b) => ({ ...b, opacity: v / 100 }))} />}
                  <label className="dr-check"><input type="checkbox" checked={mirrorX} onChange={(e) => setMirrorX(e.target.checked)} /> Mirror ↔</label>
                  <label className="dr-check"><input type="checkbox" checked={mirrorY} onChange={(e) => setMirrorY(e.target.checked)} /> Mirror ↕</label>
                </>
              )}
              {(tool === 'fill' || tool === 'wand') && (
                <>
                  <Slider label="Threshold" value={tool === 'fill' ? opts.tolerance : opts.wandTolerance} min={0} max={255} onChange={(v) => setOpts((o) => (tool === 'fill' ? { ...o, tolerance: v } : { ...o, wandTolerance: v }))} />
                  <label className="dr-check"><input type="checkbox" checked={opts.contiguous} onChange={(e) => setOpts((o) => ({ ...o, contiguous: e.target.checked }))} /> Contiguous</label>
                  {tool === 'wand' && <label className="dr-check"><input type="checkbox" checked={opts.wandAll} onChange={(e) => setOpts((o) => ({ ...o, wandAll: e.target.checked }))} /> Sample all layers</label>}
                </>
              )}
              {tool === 'gradient' && (
                <>
                  <select className="dr-input dr-opt-select" aria-label="Gradient shape" value={opts.gradient} onChange={(e) => setOpts((o) => ({ ...o, gradient: e.target.value as 'linear' | 'radial' }))}><option value="linear">Linear</option><option value="radial">Radial</option></select>
                  <label className="dr-check"><input type="checkbox" checked={opts.gradientFade} onChange={(e) => setOpts((o) => ({ ...o, gradientFade: e.target.checked }))} /> Foreground to transparent</label>
                </>
              )}
              {(tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'polygon') && (
                <>
                  {tool !== 'line' && (
                    <select className="dr-input dr-opt-select" aria-label="Shape style" value={opts.shape} onChange={(e) => setOpts((o) => ({ ...o, shape: e.target.value as 'stroke' | 'fill' | 'both' }))}>
                      <option value="stroke">Outline (foreground)</option><option value="fill">Filled (foreground)</option><option value="both">Outline + fill (background)</option>
                    </select>
                  )}
                  <Slider label="Line width" value={opts.shapeWidth} min={1} max={80} suffix=" px" onChange={(v) => setOpts((o) => ({ ...o, shapeWidth: v }))} />
                  {tool === 'rect' && <Slider label="Corner radius" value={opts.radius} min={0} max={200} suffix=" px" onChange={(v) => setOpts((o) => ({ ...o, radius: v }))} />}
                  {tool === 'polygon' && <span className="drw-note">Click the corners, then Enter or click the first point.</span>}
                </>
              )}
              {(tool === 'select-rect' || tool === 'select-ellipse' || tool === 'lasso' || tool === 'wand') && (
                <div className="dr-chips" role="radiogroup" aria-label="Selection mode">
                  {(['replace', 'add', 'subtract', 'intersect'] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={opts.selectMode === m} className={`dr-chip${opts.selectMode === m ? ' dr-chip--on' : ''}`} onClick={() => setOpts((o) => ({ ...o, selectMode: m }))}>{m[0].toUpperCase() + m.slice(1)}</button>)}
                </div>
              )}
              {tool === 'picker' && <label className="dr-check"><input type="checkbox" checked={opts.pickWhole} onChange={(e) => setOpts((o) => ({ ...o, pickWhole: e.target.checked }))} /> Sample all layers</label>}
              {tool === 'text' && (
                <>
                  <Slider label="Size" value={opts.textSize} min={6} max={400} suffix=" px" onChange={(v) => setOpts((o) => ({ ...o, textSize: v }))} />
                  <select className="dr-input dr-opt-select" aria-label="Font" value={opts.textFont} onChange={(e) => setOpts((o) => ({ ...o, textFont: e.target.value as FontFamily }))}>
                    {(Object.keys(FONT_STACKS) as FontFamily[]).map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <label className="dr-check"><input type="checkbox" checked={opts.textWeight >= 700} onChange={(e) => setOpts((o) => ({ ...o, textWeight: e.target.checked ? 700 : 400 }))} /> Bold</label>
                  <label className="dr-check"><input type="checkbox" checked={opts.textItalic} onChange={(e) => setOpts((o) => ({ ...o, textItalic: e.target.checked }))} /> Italic</label>
                </>
              )}
              {tool === 'crop' && (
                <>
                  <button type="button" className="dr-btn dr-btn--primary" disabled={!crop} onClick={() => { if (crop) { run({ op: 'crop', ...crop }); setCrop(null); } }}>Apply crop</button>
                  <button type="button" className="dr-btn" disabled={!crop} onClick={() => setCrop(null)}>Cancel</button>
                  {crop && <span className="drw-note">{crop.w}×{crop.h}</span>}
                </>
              )}
              {tool === 'move' && <span className="drw-note">Drag to move the pixels of “{layerNow?.meta.name}”. Use Edit › Cut selection to a new layer to move just part of it.</span>}
              {tool === 'pan' && <span className="drw-note">Drag to move the canvas. Hold Space with any tool to pan.</span>}
              {tool === 'zoom' && <span className="drw-note">Click to zoom in, Alt+click to zoom out.</span>}
            </div>
          )}

          <div className="drw__work">
            {s && (
              <div className="drw__tools" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
                {TOOLS.map(({ id, label, key, icon: Icon, gap }) => (
                  <span key={id} className="drw__tool-wrap">
                    {gap && <span className="drw__tool-gap" />}
                    <button type="button" className={`drw__tool${tool === id ? ' drw__tool--on' : ''}`} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => { setTool(id); if (id !== 'polygon') { polyRef.current = []; setPolyCount(0); } }}><Icon size={16} strokeWidth={1.5} /></button>
                  </span>
                ))}
                <span className="drw__tool-gap" />
                <div className="drw__colors" aria-label="Colours">
                  <button type="button" className="drw__fgbg drw__fgbg--bg" style={{ background: hexOf(bg) }} aria-label="Background colour" onClick={() => setBg(fg)} />
                  <button type="button" className="drw__fgbg drw__fgbg--fg" style={{ background: hexOf(fg) }} aria-label="Foreground colour" onClick={() => { const f = fg; setFg(bg); setBg(f); }} />
                </div>
              </div>
            )}

            <div
              ref={stageRef} className={`drw__stage${spaceDown || tool === 'pan' ? ' drw__stage--pan' : ''}${tool === 'zoom' ? ' drw__stage--zoom' : ''}${s ? '' : ' drw__stage--empty'}`}
              tabIndex={0} role="application" aria-label={s ? `Drawing canvas: ${s.title}` : 'Drawing canvas'}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
              onPointerLeave={onPointerLeave} onWheel={onWheel} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onContextMenu={(e) => e.preventDefault()}
            >
              {s ? (
                <>
                  <div className="drw__sheet" style={{ width: s.width, height: s.height, transform: `translate(${view.x}px, ${view.y}px) scale(${k})`, imageRendering: k >= 3 ? 'pixelated' : 'auto' }}>
                    <canvas ref={canvasRef} className="drw__canvas" width={s.width} height={s.height} aria-label="Painting" />
                  </div>
                  <canvas ref={overlayRef} className="drw__overlay" aria-hidden="true" />
                  {textEdit && (
                    <textarea
                      ref={textRef} className="drw__text" aria-label="Text to draw" value={textEdit.text} placeholder="Type, then click away"
                      style={{ left: textEdit.left, top: textEdit.top, fontSize: Math.max(12, opts.textSize * k), fontFamily: FONT_STACKS[opts.textFont], fontWeight: opts.textWeight, fontStyle: opts.textItalic ? 'italic' : 'normal', color: hexOf(fg) }}
                      onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })} onBlur={commitText}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setTextEdit(null); } e.stopPropagation(); }}
                    />
                  )}
                </>
              ) : (
                <div className="drw__welcome">
                  <Palette size={34} strokeWidth={1.25} />
                  <h2>Drawing</h2>
                  <p>Create a drawing to start painting. Pick a size, then paint with layers, brushes and filters — or ask the Illustrator agent to paint for you.</p>
                  <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New drawing</button>
                </div>
              )}
              {helpOpen && <ShortcutHelp title="Drawing shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
            </div>
          </div>
        </div>

        {s && (
          <aside className="drw__dock" aria-label="Dockers">
            {dock('color', 'Colour', <Palette size={12} />, <ColorPanel fg={fg} bg={bg} onFg={setFg} onBg={setBg} onSwap={() => { const f = fg; setFg(bg); setBg(f); }} onReset={() => { setFg(BLACK); setBg(WHITE); }} />)}
            {dock('palette', 'Palette', <Palette size={12} />, <PalettePanel recent={recent} onPick={(hex, asBg) => { const c = parseColor(hex); if (c) { if (asBg) setBg(c); else setFg(c); } }} />)}
            {dock('brush', 'Brushes', <Brush size={12} />, <BrushPanel presetId={presetId} brush={brush} onPreset={choosePreset} onChange={(patch) => setBrush((b) => ({ ...b, ...patch }))} />)}
            {dock('layers', 'Layers', <LayersIcon size={12} />, <LayersPanel session={s} tick={tick} />)}
            {dock('history', 'History', <Undo2 size={12} />, <HistoryPanel session={s} tick={tick} onJump={jump} />)}
          </aside>
        )}

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('drawing')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/*" hidden aria-label="Import an image" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
      {dialog?.kind === 'new' && <NewDrawingDialog onCreate={(spec) => void createDrawing(spec)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'canvas' && s && <SizeDialog title="Canvas size" width={s.width} height={s.height} scale={false} onClose={() => setDialog(null)} onApply={(w, h, anchor) => { s.resizeCanvas(w, h, false, anchor); setDialog(null); fitView(s); }} />}
      {dialog?.kind === 'scale' && s && <SizeDialog title="Scale image" width={s.width} height={s.height} scale onClose={() => setDialog(null)} onApply={(w, h) => { s.resizeCanvas(w, h, true); setDialog(null); fitView(s); }} />}
      {dialog?.kind === 'transform' && s && <TransformDialog onClose={() => setDialog(null)} onApply={(sc, deg, dx, dy) => { if (s.active) s.transformLayer(s.active.meta.id, sc, deg, dx, dy); setDialog(null); }} />}
      {dialog?.kind === 'amount' && <AmountDialog title={dialog.title} label={dialog.label} value={dialog.value} min={dialog.min} max={dialog.max} onClose={() => setDialog(null)} onApply={dialog.apply} />}
      {dialog?.kind === 'filter' && <FilterDialog key={dialog.def.id} def={dialog.def} onPreview={previewFilter} onApply={applyFilterDialog} onCancel={cancelFilter} />}
    </div>
  );
}

