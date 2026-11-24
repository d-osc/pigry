import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Check, ChevronLeft, Code2, Copy, Keyboard, FileText, Workflow, PenTool, GitFork, Hexagon, Image as ImageIcon, Layers, Maximize, MousePointer2, PenLine,
  Plus, Redo2, Smile, SquareStack, StickyNote, Trash2, Type, Undo2, X, ZoomIn, ZoomOut, LayoutGrid,
} from 'lucide-react';
import { CanvasContextMenu, type CanvasMenuEntry } from '../../app/CanvasContextMenu';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { THEME_CHANGED_EVENT, currentResolvedTheme } from '../../lib/theme';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel, type CanvasSelection } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import {
  STAMPS, SHAPE_KINDS, applyBoardOps, applyItemFields, boardToMarkdown, boundsOf, childrenOf, defaultSize, describeItem,
  emptyBoard, itemsInRect, renderBoardContent, renderBoardSvg, reparentByPosition, snapBox, stepZOrder, templateBoard,
  topLevelIds, withChildren, boxOf, embedKey, type EmbedContent, type EmbedKind, type Board, type BoardColor, type BoardItem, type BoardTemplate, type Guide, type ItemType, type ShapeKind,
} from './board';
import { HANDLES, computeResize, handlePoint, type Handle } from '../design/designEdit';
import {
  BOARD_CHANGED, BOARD_OPEN, boardPath, listBoardRefs, loadBoard, notifyBoardChanged, registerBoardFlush, removeBoard, saveBoard,
  setOpenBoard, takePendingOpenBoard, type BoardChange, type BoardOpenRequest,
} from './boardStore';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { svgSize, svgToPng } from '../design/designRaster';
import { collectEmbeds, fitEmbedSize, invalidateEmbeds, loadEmbed } from './boardEmbeds';
import { collectCodes, invalidateCodes } from './boardCode';
import { CODE_ROW, codeHeaderHit, codeKey, commitFileAt, describeCode, fitCodeSize, type CodeRef, type CodeSnapshot } from '../../lib/codeSnap';
import { BoardCodePicker } from './BoardCodePicker';
import { DIAGRAM_CHANGED, listDiagramRefs, requestOpenDiagram, type DiagramChange } from '../diagram/diagramStore';
import { DESIGN_CHANGED, listDesignRefs, loadDesign, requestOpenDesign, type DesignChange } from '../design/designStore';
import { BoardItems } from './BoardItems';
import { BoardColors, BoardProperties, VOTER, type BoardAction } from './BoardProperties';
import './BoardScreen.css';

interface View { x: number; y: number; k: number }
type Tool = 'select' | 'sticky' | 'text' | 'shape' | 'connector' | 'section' | 'pen' | 'stamp';

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: { x: number; y: number }; additive: boolean; base: string[] }
  | { kind: 'move'; start: { x: number; y: number }; ids: string[]; origin: Map<string, { x: number; y: number }>; startBoard: Board; box: { x: number; y: number; w: number; h: number }; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; start: { x: number; y: number }; box: { x: number; y: number; w: number; h: number }; startBoard: Board; moved: boolean }
  | { kind: 'draw'; tool: Tool; start: { x: number; y: number } }
  | { kind: 'connect'; from: string | null; fromPoint: [number, number] }
  | { kind: 'pen'; points: Array<[number, number]> };

const MIN_K = 0.1;
const MAX_K = 4;
const LAST_KEY = 'pigry:board-last';
const SAVE_DELAY = 700;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Tools', items: [
    { keys: 'V', label: 'Select' }, { keys: 'S', label: 'Sticky note' }, { keys: 'T', label: 'Text' }, { keys: 'R', label: 'Shape' },
    { keys: 'C', label: 'Connector' }, { keys: 'G', label: 'Section' }, { keys: 'P', label: 'Pen' }, { keys: 'E', label: 'Stamp' },
    { keys: 'K', label: 'Add code (file lines, compare, commit)' }, { keys: 'I', label: 'Embed a diagram or design' },
  ] },
  { title: 'Edit', items: [
    { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+C', label: 'Copy' }, { keys: 'Ctrl+X', label: 'Cut' },
    { keys: 'Ctrl+V', label: 'Paste' }, { keys: 'Ctrl+D', label: 'Duplicate' }, { keys: 'Delete / Backspace', label: 'Delete' },
    { keys: 'Enter / F2', label: 'Edit the text' }, { keys: 'Ctrl+S', label: 'Save now' },
  ] },
  { title: 'Arrange', items: [
    { keys: 'Ctrl+G', label: 'Put in a new section' }, { keys: 'Ctrl+Shift+G', label: 'Take out of its section' },
    { keys: ']', label: 'Bring forward' }, { keys: '[', label: 'Send backward' }, { keys: 'Ctrl+]', label: 'Bring to front' }, { keys: 'Ctrl+[', label: 'Send to back' },
    { keys: 'Ctrl+Shift+L', label: 'Lock / unlock' }, { keys: 'Arrows', label: 'Nudge (Shift = 10)' },
  ] },
  { title: 'Select', items: [
    { keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Tab / Shift+Tab', label: 'Next / previous item' }, { keys: 'Shift+Click', label: 'Add to the selection' }, { keys: 'Esc', label: 'Clear selection / back to Select' },
  ] },
  { title: 'View', items: [
    { keys: '+ / -', label: 'Zoom in / out' }, { keys: 'Ctrl+Scroll', label: 'Zoom at the cursor' }, { keys: 'Shift+0', label: 'Zoom to 100%' },
    { keys: 'Shift+1 / Ctrl+0', label: 'Fit everything' }, { keys: 'Shift+2', label: 'Zoom to the selection' }, { keys: 'Space+Drag', label: 'Pan' },
    { keys: 'Ctrl+Shift+E', label: 'Export' }, { keys: '?', label: 'This list' },
  ] },
];

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof StickyNote }> = [
  { id: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
  { id: 'sticky', label: 'Sticky note', key: 'S', icon: StickyNote },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
  { id: 'shape', label: 'Shape', key: 'R', icon: Hexagon },
  { id: 'connector', label: 'Connector', key: 'C', icon: GitFork },
  { id: 'section', label: 'Section', key: 'G', icon: SquareStack },
  { id: 'pen', label: 'Pen', key: 'P', icon: PenLine },
  { id: 'stamp', label: 'Stamp', key: 'E', icon: Smile },
];

const TEMPLATES: Array<{ kind: BoardTemplate; label: string; hint: string }> = [
  { kind: 'brainstorm', label: 'Brainstorm', hint: 'Ideas, questions, next steps' },
  { kind: 'retro', label: 'Retrospective', hint: 'Went well, to improve, actions' },
  { kind: 'journey', label: 'Journey map', hint: 'Stages from awareness to retention' },
  { kind: 'matrix', label: 'Impact / effort', hint: 'Four-quadrant prioritisation' },
  { kind: 'blank', label: 'Blank', hint: 'An empty infinite canvas' },
];

const nextId = (b: Board, prefix: string): string => {
  const taken = new Set(b.items.map((i) => i.id));
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
};

export function BoardScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Board>(() => emptyBoard());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [newColor, setNewColor] = useState<BoardColor>('yellow');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('round');
  const [stamp, setStamp] = useState(STAMPS[0]);
  const [view, setView] = useState<View>({ x: 120, y: 80, k: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [guides, setGuides] = useState<Guide[]>([]);
  const [rubber, setRubber] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [link, setLink] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [penLive, setPenLive] = useState<Array<[number, number]> | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<BoardTemplate>('brainstorm');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [embeds, setEmbeds] = useState<Record<string, EmbedContent>>({});
  const [codes, setCodes] = useState<Record<string, CodeSnapshot>>({});
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeTheme, setCodeTheme] = useState<'light' | 'dark'>(() => currentResolvedTheme());
  useEffect(() => {
    const sync = () => setCodeTheme(currentResolvedTheme());
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, sync);
  }, []);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedSources, setEmbedSources] = useState<{ diagrams: OwnedRef[]; designs: Array<{ ref: OwnedRef; frames: Array<{ id: string; name: string }> }> } | null>(null);

  const docRef = useRef(doc);
  const dirtyRef = useRef(false);
  const currentRef = useRef<string | null>(null);
  const viewRef = useRef(view);
  const selRef = useRef<string[]>([]);
  const toolRef = useRef<Tool>('select');
  const colorRef = useRef<BoardColor>('yellow');
  const shapeRef = useRef<ShapeKind>('round');
  const stampRef = useRef(STAMPS[0]);
  const undoStack = useRef<Board[]>([]);
  const redoStack = useRef<Board[]>([]);
  const lastKey = useRef<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const clipRef = useRef<BoardItem[]>([]);
  const spaceRef = useRef(false);

  useLayoutEffect(() => { docRef.current = doc; }, [doc]);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  useLayoutEffect(() => { selRef.current = sel; }, [sel]);
  useLayoutEffect(() => { toolRef.current = tool; }, [tool]);
  useLayoutEffect(() => { colorRef.current = newColor; }, [newColor]);
  useLayoutEffect(() => { shapeRef.current = shapeKind; }, [shapeKind]);
  useLayoutEffect(() => { stampRef.current = stamp; }, [stamp]);
  useLayoutEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useLayoutEffect(() => { currentRef.current = current; }, [current]);
  useLayoutEffect(() => { spaceRef.current = spaceDown; }, [spaceDown]);

  const syncHist = () => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const refOf = (key: string | null): OwnedRef | null => {
    if (!key) return null;
    const { owner, slug } = parseRefName(key);
    return { owner: owner ?? USER_OWNER, slug };
  };

  /* ---- embedded diagrams and designs ---- */

  const embedKeys = useMemo(() => doc.items.filter((i) => i.type === 'embed' && i.embed).map((i) => embedKey(i.embed!)).join('|'), [doc]);

  // Load what the board's embeds show (cached; refreshed below when a source changes).
  useEffect(() => {
    if (!embedKeys) return;
    let cancelled = false;
    void collectEmbeds(docRef.current, USER_OWNER).then((loaded) => { if (!cancelled) setEmbeds((current) => ({ ...current, ...loaded })); });
    return () => { cancelled = true; };
  }, [embedKeys]);

  // Code cards (file lines, compares, commits) read the repository.
  const codeKeys = useMemo(() => doc.items.filter((i) => i.type === 'code' && i.code).map((i) => codeKey(i.code!)).join('\n'), [doc]);
  useEffect(() => {
    if (!codeKeys) return;
    let cancelled = false;
    void collectCodes(docRef.current).then((loaded) => { if (!cancelled) setCodes((current) => ({ ...current, ...loaded })); });
    return () => { cancelled = true; };
  }, [codeKeys]);

  const refreshCodes = () => {
    invalidateCodes();
    void collectCodes(docRef.current, { refresh: true }).then((loaded) => setCodes((current) => ({ ...current, ...loaded })));
  };

  const addCode = async (code: CodeRef) => {
    setCodeOpen(false);
    const loaded = await collectCodes({ ...docRef.current, items: [{ id: 'probe', type: 'code', x: 0, y: 0, w: 0, h: 0, code }] }, { refresh: true });
    const snap = loaded[codeKey(code)];
    if (!snap || snap.error) { notify(`Could not read ${describeCode(code)}: ${snap?.error ?? 'nothing to show'}`, 'error'); return; }
    const size = fitCodeSize(snap);
    const stage = stageRef.current;
    const v = viewRef.current;
    const cx = ((stage?.clientWidth ?? 800) / 2 - v.x) / v.k, cy = ((stage?.clientHeight ?? 500) / 2 - v.y) / v.k;
    let x = Math.round(cx - size.w / 2);
    const y = Math.round(cy - size.h / 2);
    const boxes = docRef.current.items.filter((i) => i.type === 'embed' || i.type === 'code');
    for (let guard = 0; guard < 50 && boxes.some((b) => x < b.x + b.w && x + size.w > b.x && y < b.y + b.h && y + size.h > b.y); guard += 1) x += size.w + 40;
    const item = addItem('code', { x, y, w: size.w, h: size.h, code, text: '' });
    setCodes((current) => ({ ...current, [codeKey(code)]: snap }));
    setSel([item.id]);
  };

  /** Double-click on a file row of a commit/compare card switches the card to that file's diff. */
  const showFileDiff = (item: BoardItem, event: React.MouseEvent): boolean => {
    const c = item.code;
    if (!c || c.kind === 'file' || c.path) return false;
    const snap = codes[codeKey(c)];
    const p = worldPoint(event.clientX, event.clientY);
    const row = Math.floor((p.y - item.y - 34 - 7) / CODE_ROW);
    const path = snap?.commit ? commitFileAt(snap, item.w, p.y - item.y - 34) : snap?.lines[row]?.k === 'file' ? snap.lines[row].p : undefined;
    if (!path) return false;
    showCodePath(item.id, path);
    return true;
  };

  const showCodePath = (id: string, path: string | null) => {
    const item = docRef.current.items.find((i) => i.id === id);
    const c = item?.code;
    if (!item || !c || c.kind === 'file') return;
    const { path: _drop, ...rest } = c;
    void _drop;
    patchItems([id], { code: path ? { ...rest, path } : rest, ...(path ? { w: Math.max(item.w, 560), h: Math.max(item.h, 360) } : {}) });
  };

  const openCodeSource = (item: BoardItem) => {
    const c = item.code;
    if (!c) return;
    if (c.kind === 'commit' && c.oid && !c.path) { window.dispatchEvent(new CustomEvent('pigry:goto-commit', { detail: { oid: c.oid } })); return; }
    const path = c.path;
    if (path) window.dispatchEvent(new CustomEvent('pigry:goto-file', { detail: { path, line: c.start } }));
  };

  // A diagram or design that is shown on this board was edited: redraw it live.
  useEffect(() => {
    const refresh = (kind: EmbedKind, key: string) => {
      if (!docRef.current.items.some((i) => i.type === 'embed' && i.embed?.kind === kind && i.embed.ref === key)) return;
      invalidateEmbeds(kind, key);
      void collectEmbeds(docRef.current, USER_OWNER, { refresh: true }).then((loaded) => setEmbeds((current) => ({ ...current, ...loaded })));
    };
    const onDiagram = (event: Event) => refresh('diagram', (event as CustomEvent<DiagramChange>).detail.key);
    const onDesign = (event: Event) => refresh('design', (event as CustomEvent<DesignChange>).detail.key);
    window.addEventListener(DIAGRAM_CHANGED, onDiagram);
    window.addEventListener(DESIGN_CHANGED, onDesign);
    return () => { window.removeEventListener(DIAGRAM_CHANGED, onDiagram); window.removeEventListener(DESIGN_CHANGED, onDesign); };
  }, []);

  const openEmbedPicker = async () => {
    setEmbedOpen((open) => !open);
    try {
      const [diagrams, designRefs] = await Promise.all([listDiagramRefs(), listDesignRefs()]);
      const designs = await Promise.all(designRefs.slice(0, 30).map(async (ref) => {
        try { const { design } = await loadDesign(ref); return { ref, frames: design.nodes.slice(0, 12).map((n) => ({ id: n.id, name: n.name })) }; } catch { return { ref, frames: [] }; }
      }));
      setEmbedSources({ diagrams, designs });
    } catch { setEmbedSources({ diagrams: [], designs: [] }); }
  };

  const addEmbed = async (kind: EmbedKind, ref: string, node?: string) => {
    setEmbedOpen(false);
    const result = await loadEmbed({ kind, ref, node }, USER_OWNER);
    if (!result.content || !result.ref) { notify(`Could not embed ${ref}: ${result.error ?? 'nothing to show'}`, 'error'); return; }
    const size = fitEmbedSize(result.content);
    const stage = stageRef.current;
    const v = viewRef.current;
    const cx = ((stage?.clientWidth ?? 800) / 2 - v.x) / v.k, cy = ((stage?.clientHeight ?? 500) / 2 - v.y) / v.k;
    const embed = { kind, ref: result.ref, ...(result.node ? { node: result.node } : {}) };
    // Don't stack on top of existing embeds: slide to the right until the spot is free
    let ex = Math.round(cx - size.w / 2);
    const ey = Math.round(cy - size.h / 2);
    const boxes = doc.items.filter((i) => i.type === 'embed' || i.type === 'code');
    for (let guard = 0; guard < 50 && boxes.some((b) => ex < b.x + b.w && ex + size.w > b.x && ey < b.y + b.h && ey + size.h > b.y); guard += 1) ex += size.w + 40;
    const item = addItem('embed', { x: ex, y: ey, w: size.w, h: size.h, embed, text: result.title ?? '' });
    setEmbeds((current) => ({ ...current, [embedKey(embed)]: result.content! }));
    setSel([item.id]);
  };

  const openEmbedSource = (item: BoardItem) => {
    if (!item.embed) return;
    if (item.embed.kind === 'diagram') requestOpenDiagram(item.embed.ref); else requestOpenDesign(item.embed.ref, item.embed.node);
  };

  /* ---- persistence ---- */

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current);
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try {
      await saveBoard(ref, docRef.current, 'editor');
      setDirty(dirtyRef.current);
    } catch (error) {
      dirtyRef.current = true;
      notify(`Could not save the board: ${String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [notify]);

  useEffect(() => registerBoardFlush(saveNow), [saveNow]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const ref = refOf(currentRef.current);
    if (dirtyRef.current && ref) void saveBoard(ref, docRef.current, 'editor');
  }, []);

  const fitView = useCallback((target?: Board, only?: string | string[]) => {
    const stage = stageRef.current;
    const b = target ?? docRef.current;
    if (!stage) return;
    const box = boundsOf(b, Array.isArray(only) ? only : only ? [only] : undefined) ?? { x: 0, y: 0, w: 900, h: 600 };
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    const k = Math.min(1, Math.max(MIN_K, Math.min((w - 140) / Math.max(box.w, 1), (h - 140) / Math.max(box.h, 1))));
    setView({ k, x: (w - box.w * k) / 2 - box.x * k, y: (h - box.h * k) / 2 - box.y * k });
  }, []);

  const openBoard = useCallback(async (key: string, opts?: { keepSelection?: boolean; asUndo?: boolean; item?: string }) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { board, warnings } = await loadBoard(ref);
      if (opts?.asUndo) { undoStack.current.push(docRef.current); redoStack.current = []; } else { undoStack.current = []; redoStack.current = []; }
      lastKey.current = null;
      docRef.current = board;
      setDoc(board);
      const nextKey = refKey(ref);
      setCurrent(nextKey);
      currentRef.current = nextKey;
      setDirty(false);
      syncHist();
      // The requested item may be an id or the note's exact text.
      const focus = opts?.item ? board.items.find((i) => i.id === opts.item)?.id ?? board.items.find((i) => (i.text ?? '').trim().toLowerCase() === opts.item!.trim().toLowerCase())?.id : undefined;
      if (!opts?.keepSelection) { setSel(focus ? [focus] : []); setEditing(null); setTool('select'); }
      else setSel((s) => s.filter((id) => board.items.some((i) => i.id === id)));
      setOpenBoard(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Board opened with ${warnings.length} repaired issue(s).`);
      window.requestAnimationFrame(() => { if (!opts?.asUndo) fitView(board, focus); });
    } catch (error) {
      notify(`Could not open "${key}": ${String(error)}`, 'error');
    }
  }, [saveNow, notify, fitView]);

  const refreshList = useCallback(async () => {
    try { setRefs(await listBoardRefs()); } catch { setRefs([]); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listBoardRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: BoardOpenRequest | null = takePendingOpenBoard();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found) await openBoard(refKey(found), { item: request?.item });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agent tools write the files — reload what is open; the editor stays the source of truth otherwise.
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<BoardChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setOpenBoard(null); setDoc(emptyBoard()); return; }
      if (change.source === 'agent') void openBoard(change.key, { keepSelection: true, asUndo: true });
    };
    const onOpen = (event: Event) => {
      const request = (event as CustomEvent<BoardOpenRequest>).detail;
      takePendingOpenBoard();
      void openBoard(request.key, { item: request.item });
    };
    window.addEventListener(BOARD_CHANGED, onChanged);
    window.addEventListener(BOARD_OPEN, onOpen);
    return () => {
      window.removeEventListener(BOARD_CHANGED, onChanged);
      window.removeEventListener(BOARD_OPEN, onOpen);
    };
  }, [openBoard, refreshList]);

  /* ---- editing model ---- */

  const commit = useCallback((next: Board, key?: string) => {
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

  const mutate = useCallback((fn: (draft: Board) => void, key?: string) => {
    const draft = structuredClone(docRef.current);
    fn(draft);
    commit(draft, key);
  }, [commit]);

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = prev; setDoc(prev); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
    setSel((s) => s.filter((id) => prev.items.some((i) => i.id === id)));
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current);
    lastKey.current = null;
    docRef.current = next; setDoc(next); setDirty(true); dirtyRef.current = true; syncHist(); scheduleSave();
    setSel((s) => s.filter((id) => next.items.some((i) => i.id === id)));
  };

  const patchItems = (ids: string[], patch: Record<string, unknown>, key?: string) => {
    mutate((draft) => {
      for (const id of ids) {
        const item = draft.items.find((i) => i.id === id);
        if (!item) continue;
        applyItemFields(item, patch);
        if (item.type === 'section' && (patch.w !== undefined || patch.h !== undefined)) { /* sections keep their children where they are */ }
      }
    }, key);
  };

  /** New items are created through this helper so ids, author and defaults stay consistent. */
  const addItem = (type: ItemType, props: Partial<BoardItem>, parent?: string): BoardItem => {
    const d = docRef.current;
    const size = defaultSize(type, props.shape);
    const item: BoardItem = {
      id: nextId(d, type === 'connector' ? 'c' : type === 'section' ? 's' : 'n'), type, x: 0, y: 0, w: size.w, h: size.h, ...props,
      ...(type === 'sticky' || type === 'text' || type === 'shape' ? { author: USER_OWNER } : {}),
      ...(parent ? { parent } : {}),
    };
    const next = structuredClone(d);
    next.items.push(item);
    if (type === 'sticky' || type === 'shape' || type === 'text') reparentByPosition(next, item);
    commit(next);
    return item;
  };

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - v.x) / v.k, y: (clientY - (rect?.top ?? 0) - v.y) / v.k };
  };

  const idAt = (target: Element | null): string | null => target?.closest('[data-id]')?.getAttribute('data-id') ?? null;

  /** Top-most non-connector item under a canvas point (sections only when nothing else is there). */
  const itemAt = (px: number, py: number, exclude?: string): BoardItem | undefined => {
    const hit = (i: BoardItem) => i.id !== exclude && !i.locked && i.type !== 'connector' && px >= i.x && px <= i.x + i.w && py >= i.y && py <= i.y + i.h;
    const items = docRef.current.items;
    return [...items].reverse().find((i) => i.type !== 'section' && hit(i)) ?? [...items].reverse().find((i) => i.type === 'section' && hit(i));
  };

  const beginEdit = (id: string) => {
    const item = docRef.current.items.find((i) => i.id === id);
    if (!item || item.type === 'pen' || item.type === 'stamp') return;
    setSel([id]);
    setEditing(id);
    setEditText(item.text ?? '');
  };

  const commitText = () => {
    const id = editing;
    if (!id) return;
    setEditing(null);
    const item = docRef.current.items.find((i) => i.id === id);
    if (item && (item.text ?? '') !== editText) patchItems([id], { text: editText });
  };

  const selectedItems = useMemo(() => sel.map((id) => doc.items.find((i) => i.id === id)).filter((i): i is BoardItem => !!i), [sel, doc]);

  const runOps = (ops: Array<Record<string, unknown>>): { ok: boolean; errors: string[] } => {
    const result = applyBoardOps(docRef.current, ops as never, USER_OWNER);
    if (result.log.length > 0) commit(result.board);
    return { ok: result.errors.length === 0, errors: result.errors };
  };

  const doAction = (action: BoardAction) => {
    const d = docRef.current;
    const ids = topLevelIds(d, selRef.current);
    if (ids.length === 0) return;
    if (action === 'delete') { if (runOps(ids.map((id) => ({ op: 'remove', id }))).ok) setSel([]); return; }
    if (action === 'duplicate') {
      const before = new Set(d.items.map((i) => i.id));
      const result = applyBoardOps(d, ids.filter((id) => d.items.find((i) => i.id === id)?.type !== 'connector').map((id) => ({ op: 'duplicate', id })), USER_OWNER);
      commit(result.board);
      setSel(result.board.items.filter((i) => !before.has(i.id) && !i.parent).map((i) => i.id));
      return;
    }
    if (action === 'group') {
      const before = new Set(d.items.map((i) => i.id));
      const result = applyBoardOps(d, [{ op: 'group', ids, section: 'Section' }], USER_OWNER);
      commit(result.board);
      const added = result.board.items.find((i) => !before.has(i.id));
      if (added) setSel([added.id]);
      return;
    }
    if (action === 'ungroup') { runOps([{ op: 'ungroup', ids }]); return; }
    if (action === 'arrange') {
      const section = selRef.current.map((id) => d.items.find((i) => i.id === id)).find((i) => i?.type === 'section');
      if (section) runOps([{ op: 'arrange', section: section.id }]);
      return;
    }
    if (action === 'vote' || action === 'unvote') {
      const only = selRef.current[0];
      if (only) runOps([{ op: 'vote', id: only, by: VOTER, remove: action === 'unvote' }]);
      return;
    }
    mutate((draft) => { for (const id of action === 'forward' ? [...ids].reverse() : ids) stepZOrder(draft, id, action === 'forward' ? 1 : -1); });
  };

  const copySelection = () => {
    const d = docRef.current;
    const ids = withChildren(d, topLevelIds(d, selRef.current));
    clipRef.current = d.items.filter((i) => ids.includes(i.id)).map((i) => structuredClone(i));
  };
  const pasteClipboard = () => {
    if (clipRef.current.length === 0) return;
    const d = structuredClone(docRef.current);
    const taken = new Set(d.items.map((i) => i.id));
    const map = new Map<string, string>();
    const copies = clipRef.current.map((src) => {
      const copy = structuredClone(src);
      let n = taken.size + 1;
      const prefix = src.type === 'section' ? 's' : src.type === 'connector' ? 'c' : 'n';
      while (taken.has(`${prefix}${n}`)) n += 1;
      copy.id = `${prefix}${n}`;
      taken.add(copy.id);
      map.set(src.id, copy.id);
      copy.x += 40; copy.y += 40;
      return copy;
    });
    for (const copy of copies) {
      if (copy.parent) copy.parent = map.get(copy.parent) ?? undefined;
      if (copy.from) copy.from = map.get(copy.from) ?? copy.from;
      if (copy.to) copy.to = map.get(copy.to) ?? copy.to;
      if (!copy.parent && copy.type !== 'connector' && copy.type !== 'section') reparentByPosition({ ...d, items: [...d.items, ...copies] }, copy);
    }
    d.items.push(...copies);
    commit(d);
    setSel(copies.filter((c) => !c.parent && c.type !== 'connector').map((c) => c.id));
  };

  /* ---- pointer interaction ---- */

  const createAt = (kind: Tool, p: { x: number; y: number }, size?: { w: number; h: number }) => {
    const color = colorRef.current;
    let item: BoardItem | null = null;
    if (kind === 'sticky') { const s = defaultSize('sticky'); item = addItem('sticky', { x: Math.round(p.x - s.w / 2), y: Math.round(p.y - s.h / 2), color, text: '' }); }
    else if (kind === 'text') { item = addItem('text', { x: Math.round(p.x), y: Math.round(p.y - 14), text: 'Text', fontSize: 18, w: 120 }); }
    else if (kind === 'stamp') { const s = defaultSize('stamp'); item = addItem('stamp', { x: Math.round(p.x - s.w / 2), y: Math.round(p.y - s.h / 2), emoji: stampRef.current }); }
    else if (kind === 'shape') {
      const shape = shapeRef.current;
      const s = size && size.w > 12 && size.h > 12 ? size : defaultSize('shape', shape);
      item = addItem('shape', { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(s.w), h: Math.round(s.h), shape, color: colorRef.current === 'yellow' ? 'white' : color, text: '' });
    } else if (kind === 'section') {
      const s = size && size.w > 24 && size.h > 24 ? size : defaultSize('section');
      item = addItem('section', { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(s.w), h: Math.round(s.h), color: colorRef.current === 'yellow' ? 'gray' : color, text: 'Section' });
    }
    if (!item) return;
    setSel([item.id]);
    setTool('select');
    if (item.type === 'sticky' || item.type === 'text' || item.type === 'shape' || item.type === 'section') { setEditing(item.id); setEditText(item.type === 'text' ? 'Text' : item.type === 'section' ? 'Section' : ''); }
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 2) return; // right click is handled by onContextMenu
    downRef.current = { x: event.clientX, y: event.clientY };
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
    if (currentTool === 'sticky' || currentTool === 'text' || currentTool === 'stamp') { createAt(currentTool, p); dragRef.current = null; return; }
    if (currentTool === 'shape' || currentTool === 'section') { dragRef.current = { kind: 'draw', tool: currentTool, start: p }; setRubber({ x: p.x, y: p.y, w: 0, h: 0 }); return; }
    if (currentTool === 'pen') { dragRef.current = { kind: 'pen', points: [[p.x, p.y]] }; setPenLive([[p.x, p.y]]); return; }
    if (currentTool === 'connector') {
      const hit = itemAt(p.x, p.y);
      dragRef.current = { kind: 'connect', from: hit?.id ?? null, fromPoint: [p.x, p.y] };
      const origin = hit ? [hit.x + hit.w / 2, hit.y + hit.h / 2] : [p.x, p.y];
      setLink({ x1: origin[0], y1: origin[1], x2: p.x, y2: p.y });
      return;
    }

    const handle = target.closest('[data-handle]')?.getAttribute('data-handle');
    const only = selRef.current.length === 1 ? d.items.find((i) => i.id === selRef.current[0]) : undefined;
    if (handle === 'connect' && only) {
      dragRef.current = { kind: 'connect', from: only.id, fromPoint: [only.x + only.w / 2, only.y + only.h / 2] };
      setLink({ x1: only.x + only.w / 2, y1: only.y + only.h / 2, x2: p.x, y2: p.y });
      return;
    }
    if (handle && only && handle !== 'connect') {
      dragRef.current = { kind: 'resize', id: only.id, handle: handle as Handle, start: p, box: { x: only.x, y: only.y, w: only.w, h: only.h }, startBoard: d, moved: false };
      return;
    }
    const id = idAt(target);
    if (id) {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      let next = selRef.current;
      if (additive) next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
      else if (!next.includes(id)) next = [id];
      setSel(next);
      if (additive && !next.includes(id)) return;
      const top = topLevelIds(d, next).filter((x) => { const it = d.items.find((i) => i.id === x); return it && !it.locked && it.type !== 'connector'; });
      const moving = withChildren(d, top);
      const origin = new Map<string, { x: number; y: number }>();
      for (const mid of moving) { const it = d.items.find((i) => i.id === mid); if (it && it.type !== 'connector') origin.set(mid, { x: it.x, y: it.y }); }
      const box = boundsOf(d, top);
      if (box && top.length > 0) dragRef.current = { kind: 'move', start: p, ids: top, origin, startBoard: d, box, moved: false };
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
    if (drag.kind === 'pan') { setView({ ...drag.view, x: drag.view.x + event.clientX - drag.startX, y: drag.view.y + event.clientY - drag.startY }); return; }
    const p = worldPoint(event.clientX, event.clientY);
    const k = viewRef.current.k;
    if (drag.kind === 'pen') {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) * k >= 2.5) { drag.points.push([p.x, p.y]); setPenLive([...drag.points]); }
      return;
    }
    if (drag.kind === 'draw') { setRubber({ x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) }); return; }
    if (drag.kind === 'connect') { setLink((l) => (l ? { ...l, x2: p.x, y2: p.y } : l)); return; }
    if (drag.kind === 'marquee') {
      const rect = { x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
      setRubber(rect);
      const hit = itemsInRect(docRef.current, rect).filter((id) => { const it = docRef.current.items.find((i) => i.id === id); return it?.type !== 'section' || (rect.w > it.w * 0.8 && rect.h > it.h * 0.8) || !it.parent; });
      setSel(drag.additive ? Array.from(new Set([...drag.base, ...hit])) : hit);
      return;
    }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * k < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      undoStack.current.push(drag.startBoard);
      redoStack.current = [];
      lastKey.current = null;
      syncHist();
    }
    const next = structuredClone(drag.startBoard);
    if (drag.kind === 'move') {
      let mx = dx, my = dy;
      if (drag.ids.length === 1 && !event.altKey) {
        const movingSet = new Set(drag.origin.keys());
        const targets = next.items.filter((i) => !movingSet.has(i.id) && i.type !== 'connector' && i.type !== 'pen').map((i) => boxOf(next, i));
        const snap = snapBox({ x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h }, targets, 6 / k);
        mx += snap.dx; my += snap.dy;
        setGuides(snap.guides);
      } else setGuides([]);
      for (const [id, o] of drag.origin) {
        const item = next.items.find((i) => i.id === id);
        if (item) { item.x = Math.round(o.x + mx); item.y = Math.round(o.y + my); }
      }
    } else {
      const item = next.items.find((i) => i.id === drag.id);
      if (!item) return;
      const box = computeResize(drag.box, drag.handle, dx, dy, event.shiftKey, 24);
      item.x = Math.round(box.x); item.y = Math.round(box.y); item.w = Math.round(box.w); item.h = Math.round(box.h);
    }
    docRef.current = next;
    setDoc(next);
    setDirty(true);
    dirtyRef.current = true;
  };

  const finishDraw = (drag: Extract<Drag, { kind: 'draw' }>, end: { x: number; y: number }) => {
    const clicked = Math.hypot(end.x - drag.start.x, end.y - drag.start.y) * viewRef.current.k < 5;
    const x = Math.min(drag.start.x, end.x), y = Math.min(drag.start.y, end.y);
    createAt(drag.tool, { x, y }, clicked ? undefined : { w: Math.abs(end.x - drag.start.x), h: Math.abs(end.y - drag.start.y) });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGuides([]); setRubber(null); setLink(null); setPenLive(null);
    if (!drag) return;
    const p = worldPoint(event.clientX, event.clientY);
    if (drag.kind === 'draw') { finishDraw(drag, p); return; }
    if (drag.kind === 'pen') {
      if (drag.points.length >= 2) {
        const xs = drag.points.map((q) => q[0]), ys = drag.points.map((q) => q[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        const item = addItem('pen', { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(Math.max(...xs) - x)), h: Math.max(1, Math.round(Math.max(...ys) - y)), color: colorRef.current === 'yellow' ? 'blue' : colorRef.current, width: 3, points: drag.points.map((q) => [Math.round((q[0] - x) * 10) / 10, Math.round((q[1] - y) * 10) / 10] as [number, number]) });
        setSel([item.id]);
      }
      return;
    }
    if (drag.kind === 'connect') {
      const target = itemAt(p.x, p.y, drag.from ?? undefined);
      const far = Math.hypot(p.x - drag.fromPoint[0], p.y - drag.fromPoint[1]) * viewRef.current.k > 12;
      if (far && (drag.from || target)) {
        const props: Partial<BoardItem> = {};
        if (drag.from) props.from = drag.from; else props.fromPoint = [Math.round(drag.fromPoint[0]), Math.round(drag.fromPoint[1])];
        if (target) props.to = target.id; else props.toPoint = [Math.round(p.x), Math.round(p.y)];
        const item = addItem('connector', { ...props, arrow: 'end', route: 'straight', w: 0, h: 0 });
        setSel([item.id]);
      }
      if (toolRef.current === 'connector') setTool('select');
      return;
    }
    if (drag.kind === 'resize' && drag.moved) { scheduleSave(); return; }
    if (drag.kind !== 'move' || !drag.moved) return;
    // Drop: adopt moved notes into the section under them (or release them).
    const d = structuredClone(docRef.current);
    for (const id of drag.ids) {
      const item = d.items.find((i) => i.id === id);
      if (item && item.type !== 'section') reparentByPosition(d, item);
    }
    docRef.current = d; setDoc(d);
    scheduleSave();
  };

  const [menu, setMenu] = useState<{ x: number; y: number; entries: CanvasMenuEntry[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const onContextMenu = (event: React.MouseEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (editing) commitText();
    const id = idAt(event.target as Element) ?? idAt(document.elementFromPoint(event.clientX, event.clientY));
    svgRef.current?.focus();
    const now = id ? (selRef.current.includes(id) ? selRef.current : [id]) : [];
    setSel(now);
    setMenu({ x: event.clientX, y: event.clientY, entries: menuEntries({ at: worldPoint(event.clientX, event.clientY), id, sel: now }) });
  };

  const menuEntries = (menu: { at: { x: number; y: number }; id: string | null; sel: string[] }): CanvasMenuEntry[] => {
    const d = docRef.current;
    if (menu.id) {
      const item = d.items.find((i) => i.id === menu.id);
      const chosen = menu.sel.map((id) => d.items.find((i) => i.id === id)).filter((i): i is BoardItem => !!i);
      const one = chosen.length === 1;
      const editable = one && item && ['sticky', 'text', 'shape', 'section', 'connector'].includes(item.type);
      return [
        ...(item?.type === 'code' && item.code ? [
          { label: item.code.kind === 'commit' && !item.code.path ? 'Open commit' : 'Open file', onSelect: () => openCodeSource(item) } as CanvasMenuEntry,
          { label: 'Refresh code', onSelect: refreshCodes } as CanvasMenuEntry,
        ] : []),
        ...(item?.type === 'embed' && item.embed ? [{ label: `Open in ${item.embed.kind === 'design' ? 'Design' : 'Diagram'} editor`, onSelect: () => openEmbedSource(item) } as CanvasMenuEntry] : []),
        ...(editable ? [{ label: 'Edit text', shortcut: 'Enter', onSelect: () => beginEdit(item!.id) } as CanvasMenuEntry] : []),
        ...(one && item?.type === 'sticky' ? [{ label: (item.votes ?? []).includes(VOTER) ? 'Remove my vote' : 'Vote', onSelect: () => doAction((item.votes ?? []).includes(VOTER) ? 'unvote' : 'vote') } as CanvasMenuEntry] : []),
        ...(one && item?.type === 'section' ? [{ label: 'Arrange notes in a grid', onSelect: () => doAction('arrange') } as CanvasMenuEntry] : []),
        { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => doAction('duplicate') },
        { label: 'Copy', shortcut: 'Ctrl+C', onSelect: copySelection },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipRef.current.length === 0, onSelect: pasteClipboard },
        { separator: true },
        ...(chosen.some((i) => i.type !== 'section' && i.type !== 'connector') ? [{ label: 'Put in a new section', shortcut: 'Ctrl+G', onSelect: () => doAction('group') } as CanvasMenuEntry] : []),
        ...(chosen.some((i) => i.parent) ? [{ label: 'Take out of section', onSelect: () => doAction('ungroup') } as CanvasMenuEntry] : []),
        { label: 'Bring forward', shortcut: ']', onSelect: () => doAction('forward') },
        { label: 'Send backward', shortcut: '[', onSelect: () => doAction('backward') },
        { label: item?.locked ? 'Unlock' : 'Lock in place', onSelect: () => mutate((draft) => { for (const id of selRef.current) { const it = draft.items.find((i) => i.id === id); if (it) it.locked = it.locked ? undefined : true; } }) },
        { separator: true },
        { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => doAction('delete') },
      ];
    }
    const add = (kind: Tool, name: string): CanvasMenuEntry => ({ label: `Add ${name} here`, onSelect: () => createAt(kind, menu.at) });
    return [
      add('sticky', 'sticky note'), add('text', 'text'), add('stamp', 'stamp'),
      { label: 'Embed diagram or design…', onSelect: () => void openEmbedPicker() },
      { label: 'Add code…', onSelect: () => setCodeOpen(true) },
      { separator: true },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipRef.current.length === 0, onSelect: pasteClipboard },
      { label: 'Select all', shortcut: 'Ctrl+A', onSelect: () => setSel(d.items.filter((i) => !i.parent || i.type === 'section').map((i) => i.id)) },
      { label: 'Fit to screen', shortcut: 'Ctrl+0', onSelect: () => fitView() },
      { separator: true },
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: undoStack.current.length === 0, onSelect: undo },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: redoStack.current.length === 0, onSelect: redo },
    ];
  };

  /** A plain click on a commit/compare card's header: Overview / Changes tabs and the ‹ › file stepper. */
  const onClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const down = downRef.current;
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const id = idAt(event.target as Element) ?? idAt(document.elementFromPoint(event.clientX, event.clientY));
    const item = id ? docRef.current.items.find((i) => i.id === id) : undefined;
    if (!item || item.type !== 'code' || !item.code) return;
    const snap = codes[codeKey(item.code)];
    const p = worldPoint(event.clientX, event.clientY);
    const action = codeHeaderHit(item.code, snap, item.w, p.x - item.x, p.y - item.y);
    if (!action) return;
    if (action.type === 'tab') {
      if (action.id === 'overview') { if (item.code.path) showCodePath(item.id, null); }
      else if (!item.code.path) { const first = snap?.files?.[0]?.path; if (first) showCodePath(item.id, first); }
    } else if (snap?.nav) {
      const next = action.dir < 0 ? snap.nav.prev : snap.nav.next;
      if (next) showCodePath(item.id, next);
    }
  };

  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const id = idAt(event.target as Element) ?? idAt(document.elementFromPoint(event.clientX, event.clientY));
    const hit = id ? docRef.current.items.find((i) => i.id === id) : undefined;
    if (hit?.type === 'embed') { openEmbedSource(hit); return; }
    if (hit?.type === 'code') {
      const local = worldPoint(event.clientX, event.clientY);
      if (local.y - hit.y < 34) return; // header: tabs are handled by the click
      if (!showFileDiff(hit, event)) openCodeSource(hit);
      return;
    }
    if (id) { beginEdit(id); return; }
    if (toolRef.current === 'select') createAt('sticky', worldPoint(event.clientX, event.clientY));
  };

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

  const toggleLock = () => mutate((draft) => { for (const id of selRef.current) { const it = draft.items.find((i) => i.id === id); if (it) it.locked = it.locked ? undefined : true; } });
  const sendToEdge = (dir: 1 | -1) => mutate((draft) => {
    for (const id of dir > 0 ? [...topLevelIds(draft, selRef.current)].reverse() : topLevelIds(draft, selRef.current)) for (let n = 0; n < draft.items.length; n += 1) stepZOrder(draft, id, dir);
  });
  const cycleSelection = (dir: 1 | -1) => {
    const list = docRef.current.items.filter((i) => i.type !== 'connector');
    if (list.length === 0) return;
    const at = list.findIndex((i) => i.id === selRef.current[0]);
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
    if (mod && key === 'g') { event.preventDefault(); doAction(event.shiftKey ? 'ungroup' : 'group'); return; }
    if (mod && key === 'x') { event.preventDefault(); copySelection(); doAction('delete'); return; }
    if (mod && event.key === ']') { event.preventDefault(); sendToEdge(1); return; }
    if (mod && event.key === '[') { event.preventDefault(); sendToEdge(-1); return; }
    if (mod && event.shiftKey && key === 'l') { event.preventDefault(); toggleLock(); return; }
    if (mod && event.shiftKey && key === 'e') { event.preventDefault(); setExportOpen(true); return; }
    if (mod && key === 'c') { event.preventDefault(); copySelection(); return; }
    if (mod && key === 'v') { event.preventDefault(); pasteClipboard(); return; }
    if (mod && key === 'a') { event.preventDefault(); setSel(docRef.current.items.filter((i) => !i.parent || i.type === 'section').map((i) => i.id)); return; }
    if (mod && key === '0') { event.preventDefault(); fitView(); return; }
    if (mod && key === '1') { event.preventDefault(); setView((v) => ({ ...v, k: 1 })); return; }
    if (mod) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); doAction('delete'); return; }
    if (event.key === 'Escape') { if (toolRef.current !== 'select') setTool('select'); else setSel([]); return; }
    if ((event.key === 'Enter' || event.key === 'F2') && selRef.current.length === 1) { beginEdit(selRef.current[0]); event.preventDefault(); return; }
    if (event.key === '[') { doAction('backward'); return; }
    if (event.key === ']') { doAction('forward'); return; }
    if (event.key === '?') { event.preventDefault(); setHelpOpen(true); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / 1.25); return; }
    if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); fitView(); return; }
    if (event.shiftKey && event.code === 'Digit2') { event.preventDefault(); if (selRef.current.length) fitView(undefined, selRef.current); return; }
    if (event.shiftKey && event.code === 'Digit0') { event.preventDefault(); zoomBy(1 / viewRef.current.k); return; }
    if (event.key === 'Tab') { event.preventDefault(); cycleSelection(event.shiftKey ? -1 : 1); return; }
    if (key === 'k' && !event.shiftKey) { event.preventDefault(); setCodeOpen((open) => !open); return; }
    if (key === 'i' && !event.shiftKey) { event.preventDefault(); void openEmbedPicker(); return; }
    const hotkey = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (hotkey) { setTool(hotkey.id); return; }
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = arrows[event.key];
    if (move && selRef.current.length) {
      event.preventDefault();
      const ids = topLevelIds(docRef.current, selRef.current);
      mutate((draft) => {
        for (const id of withChildren(draft, ids)) { const it = draft.items.find((i) => i.id === id); if (it && it.type !== 'connector') { it.x += move[0]; it.y += move[1]; } }
      }, `nudge:${ids.join(',')}`);
    }
  };
  const onKeyUp = (event: React.KeyboardEvent) => { if (event.key === ' ') setSpaceDown(false); };

  // Focus after the click that created the editor has finished — the browser moves focus to the canvas on mousedown and would otherwise blur (and commit) it at once.
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => editRef.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  /* ---- board-level actions ---- */

  const createBoard = async (kind: BoardTemplate, rawName: string) => {
    const base = nameSlug(rawName || TEMPLATES.find((t) => t.kind === kind)?.label || 'board');
    let slug = base, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`;
    const title = rawName.trim() || (TEMPLATES.find((t) => t.kind === kind)?.label ?? 'Board');
    await saveNow();
    try {
      await saveBoard({ owner: USER_OWNER, slug }, templateBoard(kind, title), 'editor');
      setCreating(false); setNewName('');
      await refreshList();
      await openBoard(`${USER_OWNER}/${slug}`);
    } catch (error) {
      notify(`Could not create the board: ${String(error)}`, 'error');
    }
  };

  const deleteBoardFile = async (key: string) => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeBoard(ref);
      const rest = await listBoardRefs();
      setRefs(rest);
      if (key === currentRef.current) {
        if (rest[0]) await openBoard(refKey(rest[0])); else { setCurrent(null); setOpenBoard(null); const empty = emptyBoard(); docRef.current = empty; setDoc(empty); }
      }
    } catch (error) {
      notify(`Could not delete the board: ${String(error)}`, 'error');
    }
  };

  const exportAs = async (format: 'png' | 'svg' | 'md' | 'copy-png') => {
    const ref = refOf(currentRef.current);
    if (!ref) return;
    const d = docRef.current;
    const base = boardPath(ref).replace(/\.board\.json$/, '');
    try {
      if (format === 'md') { await writeWorktreeFile(`${base}.md`, boardToMarkdown(d)); notify(`Saved ${base}.md`, 'success'); }
      else if (format === 'svg') { await writeWorktreeFile(`${base}.svg`, renderBoardSvg(d, { background: null })); notify(`Saved ${base}.svg`, 'success'); }
      else {
        const svg = renderBoardSvg(d, { background: '#f7f8fb' });
        const { width, height } = svgSize(svg);
        const png = await svgToPng(svg, width, height, 2);
        if (format === 'png') { await writeWorktreeBinary(`${base}.png`, png.base64); notify(`Saved ${base}.png`, 'success'); }
        else {
          const blob = await (await fetch(png.dataUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          notify('Image copied to the clipboard.', 'success');
        }
      }
      notifyBoardChanged({ key: refKey(ref), source: 'editor' });
    } catch (error) {
      notify(`Export failed: ${String(error)}`, 'error');
    }
  };

  /* ---- render ---- */

  const markup = useMemo(() => renderBoardContent(doc, { interactive: true, editingId: editing, ink: 'var(--text-primary, #1f2430)', embeds, codes, codeTheme }), [doc, editing, embeds, codes, codeTheme]);
  const k = view.k;
  const selBoxes = selectedItems.map((item) => ({ item, box: boxOf(doc, item) }));
  const only = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const hoverItem = hover && !sel.includes(hover) ? doc.items.find((i) => i.id === hover) : undefined;
  const editItem = editing ? doc.items.find((i) => i.id === editing) : undefined;
  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  // The chat shows (and sends) whatever is selected on the board.
  const canvasContext = useMemo<CanvasSelection | null>(() => {
    if (!current || selectedItems.length === 0) return null;
    return {
      kind: 'board',
      doc: current,
      items: selectedItems.slice(0, 10).map((item) => {
        const kids = item.type === 'section' ? childrenOf(doc, item.id).filter((c) => c.type !== 'connector').slice(0, 12).map((c) => `  - ${describeItem(doc, c)}`) : [];
        return {
          id: item.id,
          name: item.type === 'embed' ? (item.text || item.embed?.ref || 'Embed') : item.type === 'code' ? (item.text || (item.code ? describeCode(item.code) : 'Code')) : item.type === 'connector' ? (item.text || 'Connector') : item.type === 'stamp' ? item.emoji ?? 'Stamp' : item.type === 'pen' ? 'Drawing' : ((item.text ?? '').trim().slice(0, 40) || (item.type === 'section' ? 'Section' : `Empty ${item.type}`)),
          type: item.type,
          outline: [`- ${describeItem(doc, item)}${item.parent ? ` (in section ${item.parent})` : ''}`, ...kids].join('\n'),
        };
      }),
    };
  }, [current, selectedItems, doc]);

  const editorStyle = (): React.CSSProperties | null => {
    if (!editItem) return null;
    if (editItem.type === 'connector') {
      const b = boxOf(doc, editItem);
      return { left: (b.x + b.w / 2) * k + view.x - 70, top: (b.y + b.h / 2) * k + view.y - 14, width: 140, height: 30, textAlign: 'center', fontSize: 13 };
    }
    const header = editItem.type === 'section';
    const size = (editItem.fontSize ?? (editItem.type === 'text' ? 18 : 16)) * k;
    return {
      left: editItem.x * k + view.x + (editItem.type === 'sticky' ? 6 * k : 0),
      top: editItem.y * k + view.y + (header ? 2 * k : editItem.type === 'sticky' ? 6 * k : 0),
      width: Math.max(80, (header ? Math.min(editItem.w, 320) : editItem.w - (editItem.type === 'sticky' ? 12 : 0)) * k),
      height: header ? 30 * k : Math.max(28, (editItem.type === 'text' ? editItem.h + 4 : editItem.h - (editItem.type === 'sticky' ? 12 : 0)) * k),
      fontSize: header ? 16 * k : size, fontWeight: header || editItem.bold ? 700 : 400, textAlign: editItem.align ?? (editItem.type === 'shape' ? 'center' : 'left'),
    };
  };
  const editStyle = editorStyle();

  return (
    <div className="screen brd">
      <header className="screen-header">
        <h1 className="screen-header__title">Board</h1>
        <span className="screen-header__meta">Sticky notes, sections and connectors — the SA agent can run workshops on the same board</span>
        {current && <span className={`brd__save brd__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <button type="button" className="primary-button" onClick={() => setCreating((c) => !c)}><Plus size={12} strokeWidth={1.5} /> New board</button>
      </header>

      <div className="screen-body brd__body">
        <aside className="brd__side" aria-label="Boards and items">
          <section className="brd__section">
            <h2 className="brd__heading"><StickyNote size={12} /> Boards <span className="brd__count">{refs.length}</span></h2>
            {creating && (
              <div className="brd__new">
                <div className="brd__chips" role="radiogroup" aria-label="Template">
                  {TEMPLATES.map((t) => (
                    <button key={t.kind} type="button" role="radio" aria-checked={newKind === t.kind} title={t.hint} className={`brd__chip${newKind === t.kind ? ' brd__chip--on' : ''}`} onClick={() => setNewKind(t.kind)}>{t.label}</button>
                  ))}
                </div>
                <div className="brd__new-row">
                  <input className="brd-input" autoFocus placeholder="Board name…" aria-label="New board name" value={newName} onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void createBoard(newKind, newName); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }} />
                  <button type="button" className="brd-icon brd-icon--ok" aria-label="Create board" onClick={() => void createBoard(newKind, newName)}><Check size={13} /></button>
                  <button type="button" className="brd-icon" aria-label="Cancel" onClick={() => { setCreating(false); setNewName(''); }}><X size={13} /></button>
                </div>
              </div>
            )}
            {refs.length === 0 && !creating && <p className="brd-empty">No boards yet — create one, or ask the SA agent.</p>}
            {grouped.map(([owner, list]) => (
              <div key={owner} className="brd__group">
                <div className="brd__owner">{owner}</div>
                <ul className="brd__list">
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <li key={key} className={`brd__item${key === current ? ' brd__item--active' : ''}`}>
                        <button type="button" className="brd__item-main" title={boardPath(ref)} onClick={() => { if (key !== current) void openBoard(key); }}>
                          <LayoutGrid size={12} strokeWidth={1.5} /><span>{ref.slug}</span>
                        </button>
                        {confirmDelete === key ? (
                          <span className="brd__confirm">
                            <button type="button" className="brd-icon brd-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteBoardFile(key)}><Check size={12} /></button>
                            <button type="button" className="brd-icon" aria-label="Keep board" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </span>
                        ) : (
                          <button type="button" className="brd-icon brd__item-del" aria-label={`Delete ${ref.slug}`} title="Delete board" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
          <section className="brd__section brd__section--items">
            <h2 className="brd__heading"><Layers size={12} /> Items</h2>
            {current && <BoardItems board={doc} selected={sel} onSelect={(id, additive) => setSel((s) => (additive ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]))} />}
          </section>
        </aside>

        <div className="brd__main">
          {current ? (
            <>
              <div className="brd__toolbar" role="toolbar" aria-label="Board tools">
                {TOOLS.map(({ id, label, key, icon: Icon }) => (
                  <button key={id} type="button" className={`brd__tool${tool === id ? ' brd__tool--on' : ''}`} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => setTool(id)}><Icon size={15} strokeWidth={1.5} /></button>
                ))}
                <div className="brd__menu">
                  <button type="button" className="brd__tool" aria-label="Embed diagram or design" title="Embed a diagram or design" aria-haspopup="menu" aria-expanded={embedOpen} onClick={() => void openEmbedPicker()}><Workflow size={15} strokeWidth={1.5} /></button>
                  {embedOpen && (
                    <div className="brd__popup brd__popup--left brd__popup--embed" role="menu" aria-label="Embed">
                      {!embedSources && <p className="brd__popup-note">Loading…</p>}
                      {embedSources && embedSources.diagrams.length === 0 && embedSources.designs.length === 0 && <p className="brd__popup-note">No diagrams or designs yet — create one in the Diagram or Design menu.</p>}
                      {embedSources && embedSources.diagrams.length > 0 && <p className="brd__popup-title"><Workflow size={11} /> Diagrams</p>}
                      {embedSources?.diagrams.map((ref) => (
                        <button key={`d-${refKey(ref)}`} type="button" role="menuitem" onClick={() => void addEmbed('diagram', refKey(ref))}>{refKey(ref)}</button>
                      ))}
                      {embedSources && embedSources.designs.length > 0 && <p className="brd__popup-title"><PenTool size={11} /> Designs</p>}
                      {embedSources?.designs.map(({ ref, frames }) => (
                        <div key={`g-${refKey(ref)}`}>
                          <button type="button" role="menuitem" onClick={() => void addEmbed('design', refKey(ref))}>{refKey(ref)} <em>whole design</em></button>
                          {frames.map((frame) => <button key={frame.id} type="button" role="menuitem" className="brd__popup-sub" onClick={() => void addEmbed('design', refKey(ref), frame.id)}>› {frame.name}</button>)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="brd__menu">
                  <button type="button" className="brd__tool" aria-label="Add code" title="Show code: file lines, a compare or a commit" aria-haspopup="dialog" aria-expanded={codeOpen} onClick={() => setCodeOpen((open) => !open)}><Code2 size={15} strokeWidth={1.5} /></button>
                  {codeOpen && (
                    <div className="brd__popup brd__popup--left brd__popup--code" role="dialog" aria-label="Add code">
                      <BoardCodePicker branches={repository?.branches.map((b) => b.name) ?? []} currentBranch={repository?.currentBranch ?? ''} onAdd={(code) => void addCode(code)} />
                    </div>
                  )}
                </div>
                <span className="brd__sep" />
                <BoardColors value={newColor} onPick={(color) => { setNewColor(color); if (selRef.current.length) patchItems(selRef.current.filter((id) => { const it = docRef.current.items.find((i) => i.id === id); return it && it.type !== 'text' && it.type !== 'stamp'; }), { color }); }} />
                {tool === 'shape' && (
                  <select className="brd__select" aria-label="New shape kind" value={shapeKind} onChange={(e) => setShapeKind(e.target.value as ShapeKind)}>
                    {SHAPE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                )}
                {tool === 'stamp' && (
                  <span className="brd__stamps" role="group" aria-label="Stamp">
                    {STAMPS.map((emoji) => <button key={emoji} type="button" className={stamp === emoji ? 'on' : ''} aria-label={`Stamp ${emoji}`} onClick={() => setStamp(emoji)}>{emoji}</button>)}
                  </span>
                )}
                <span className="brd__sep" />
                <button type="button" className="brd__tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={hist.undo === 0} onClick={undo}><Undo2 size={14} /></button>
                <button type="button" className="brd__tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={hist.redo === 0} onClick={redo}><Redo2 size={14} /></button>
                <span className="brd__sep" />
                <button type="button" className="brd__tool" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={14} /></button>
                <span className="brd__zoom">{Math.round(k * 100)}%</span>
                <button type="button" className="brd__tool" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn size={14} /></button>
                <button type="button" className="brd__tool" aria-label="Fit to screen" title="Fit all (Ctrl+0)" onClick={() => fitView()}><Maximize size={14} /></button>
                <button type="button" className="brd__tool" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}><Keyboard size={14} /></button>
                <span className="brd__grow" />
                <div className="brd__menu">
                  <button type="button" className="brd__tool brd__tool--text" aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen((o) => !o)}><ImageIcon size={14} /> <span>Export</span></button>
                  {exportOpen && (
                    <div className="brd__popup" role="menu" onClick={() => setExportOpen(false)}>
                      <button type="button" role="menuitem" onClick={() => void exportAs('md')}><FileText size={13} /> Save Markdown summary</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('png')}><ImageIcon size={13} /> Save PNG to workspace</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('svg')}><ImageIcon size={13} /> Save SVG to workspace</button>
                      <button type="button" role="menuitem" onClick={() => void exportAs('copy-png')}><Copy size={13} /> Copy as PNG</button>
                    </div>
                  )}
                </div>
              </div>
              <div className={`brd__stage${spaceDown ? ' brd__stage--pan' : ''}${tool !== 'select' ? ' brd__stage--draw' : ''}`} ref={stageRef}
                style={{ backgroundSize: `${24 * k}px ${24 * k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
                <svg
                  ref={svgRef}
                  className="brd__svg"
                  tabIndex={0}
                  role="application"
                  aria-label={`Board canvas: ${doc.title}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={() => setHover(null)}
                  onClick={onClick}
                  onDoubleClick={onDoubleClick}
                  onContextMenu={onContextMenu}
                  onKeyDown={onKeyDown}
                  onKeyUp={onKeyUp}
                >
                  <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
                    <g dangerouslySetInnerHTML={{ __html: markup }} />
                    {hoverItem && hoverItem.type !== 'connector' && <rect className="brd__hover" x={hoverItem.x} y={hoverItem.y} width={hoverItem.w} height={hoverItem.h} style={{ strokeWidth: 1.5 / k }} />}
                    {selBoxes.map(({ item, box }) => item.type === 'connector'
                      ? null
                      : <rect key={item.id} className="brd__sel" x={box.x - 2 / k} y={box.y - 2 / k} width={box.w + 4 / k} height={box.h + 4 / k} style={{ strokeWidth: 2 / k }} />)}
                    {only && only.type !== 'connector' && !only.locked && !editing && tool === 'select' && (() => {
                      const hs = 9 / k;
                      const resizable = only.type !== 'pen' && only.type !== 'stamp';
                      return (
                        <>
                          {resizable && HANDLES.map((h) => {
                            const pt = handlePoint({ x: only.x, y: only.y, w: only.w, h: only.h }, h);
                            return <rect key={h} data-handle={h} className={`brd__handle brd__handle--${h}`} x={pt.x - hs / 2} y={pt.y - hs / 2} width={hs} height={hs} style={{ strokeWidth: 1.5 / k }} />;
                          })}
                          <g data-handle="connect"><circle className="brd__connect" cx={only.x + only.w + 22 / k} cy={only.y + only.h / 2} r={9 / k} /><path className="brd__connect-arrow" d={`M ${only.x + only.w + 17 / k} ${only.y + only.h / 2} h ${10 / k} m ${-4 / k} ${-4 / k} l ${4 / k} ${4 / k} l ${-4 / k} ${4 / k}`} style={{ strokeWidth: 1.6 / k }} /></g>
                        </>
                      );
                    })()}
                    {sel.length > 1 && (() => {
                      const b = boundsOf(doc, sel);
                      return b ? <rect className="brd__sel brd__sel--group" x={b.x - 6 / k} y={b.y - 6 / k} width={b.w + 12 / k} height={b.h + 12 / k} style={{ strokeWidth: 1 / k }} /> : null;
                    })()}
                    {guides.map((g, i) => g.axis === 'x'
                      ? <line key={i} className="brd__guide" x1={g.pos} x2={g.pos} y1={g.from} y2={g.to} style={{ strokeWidth: 1 / k }} />
                      : <line key={i} className="brd__guide" y1={g.pos} y2={g.pos} x1={g.from} x2={g.to} style={{ strokeWidth: 1 / k }} />)}
                    {rubber && <rect className="brd__rubber" x={rubber.x} y={rubber.y} width={rubber.w} height={rubber.h} style={{ strokeWidth: 1 / k }} />}
                    {link && <line className="brd__link" x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} style={{ strokeWidth: 2 / k }} />}
                    {penLive && <polyline className="brd__pen" points={penLive.map((q) => q.join(',')).join(' ')} style={{ strokeWidth: 3 }} />}
                  </g>
                </svg>
                {helpOpen && <ShortcutHelp title="Board shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
                {menu && <CanvasContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={closeMenu} label="Board context menu" />}
                {doc.items.length === 0 && <div className="brd__hint"><strong>Empty board</strong><span>Press S for a sticky note, or double-click anywhere. Ask the SA agent to run a brainstorm or retro.</span></div>}
                {editing && editStyle && (
                  <textarea
                    ref={editRef}
                    className={`brd__editor${editItem?.type === 'sticky' ? ' brd__editor--sticky' : ''}`}
                    aria-label="Edit text"
                    value={editText}
                    style={editStyle}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitText}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { commitText(); svgRef.current?.focus(); }
                      if (e.key === 'Enter' && !e.shiftKey && (editItem?.type === 'connector' || editItem?.type === 'section')) { e.preventDefault(); commitText(); svgRef.current?.focus(); }
                      e.stopPropagation();
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="brd__welcome">
              <StickyNote size={34} strokeWidth={1.25} />
              <h2>Board editor</h2>
              <p>Create a board to start. Pick a template, or ask the SA agent to run a workshop for you.</p>
              <div className="brd__welcome-grid">
                {TEMPLATES.map((t) => (
                  <button key={t.kind} type="button" className="brd__template" onClick={() => void createBoard(t.kind, t.label)}><strong>{t.label}</strong><span>{t.hint}</span></button>
                ))}
              </div>
            </div>
          )}
        </div>

        {current && (
          <aside className="brd__inspector" aria-label="Properties">
            <BoardProperties
              codeSnapshots={codes}
              onShowCodePath={showCodePath}
              board={doc}
              selected={selectedItems}
              onPatch={patchItems}
              onEndEdit={() => { lastKey.current = null; }}
              onAction={doAction}
              onTitle={(title) => mutate((draft) => { draft.title = title; }, 'title')}
              onOpenSource={(item) => (item.type === 'code' ? openCodeSource(item) : openEmbedSource(item))}
              onRefreshCode={refreshCodes}
            />
          </aside>
        )}

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('board')} onCollapse={() => setAiOpen(false)} canvasSelection={canvasContext} />
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
