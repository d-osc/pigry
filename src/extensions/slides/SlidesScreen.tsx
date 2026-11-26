import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, ChevronDown, ChevronLeft, Eraser, Highlighter, ImagePlus, IndentDecrease, IndentIncrease, Italic, Keyboard,
  LayoutGrid, List, ListOrdered, Lock, MessageSquarePlus, Minus, MousePointer2, Paintbrush, Play, Plus, Presentation, Redo2, Shapes, Slash, Sparkles, Strikethrough, Trash2, Type,
  Underline, Undo2, X,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { PromptDialog, TableGrid } from '../docs/DocsDialogs';
import {
  FONTS, FONT_SIZES, ICONS, LAYOUTS, SHAPES, SIZES, THEMES, addSlide, alignEls, clone, copyEl, deckStats, deleteSlide, distributeEls, duplicateSlide, findAll, findRegex, formatParas,
  groupEls, groupMembers, hasText, marksOf, moveSlides, newId, para, parasText, removeEls, reorder, replaceAll, replaceInPara, resizeBox, rotatedBounds, round1, roleLook,
  shrinkScale, slideTitle, snapBox, unionBox, ungroupEls,
  type AlignTo, type Box, type ChartEl, type Deck, type El, type Guide, type Handle, type LayoutId, type Match, type Para, type ShapeKind, type Slide, type TextEl, type ZOrder,
} from './slides';
import { TEMPLATES, deckToHtml, deckToMarkdown, deckToText, markdownToSlides, templateDeck, type TemplateId } from './slidesFormat';
import { relayout, resizeDeck, reviewDeck } from './slidesOps';
import { SLIDE_CSS, boxPad, elementInner, elementStyle, flowStyle, parasHtml, shapePath, slideHtml } from './slidesRender';
import { pptxWithPictures, slidePng, slidesPdf } from './slidesRaster';
import { domToParas, fixFontSize, formatSelectedParas, placeCaret, toHex } from './slidesDom';
import { SLIDES_CHANGED, SLIDES_OPEN, listDeckRefs, loadDeck, registerSlidesFlush, removeDeck, saveDeck, setOpenDeck, slidesPath, takePendingOpenDeck, type SlidesChange, type SlidesOpenRequest } from './slidesStore';
import { ChartDialog, FindDialog, MarkdownDialog, NewDeckDialog, PageSetupDialog, SlideThumb, TemplateGallery, ThemeDialog, type FindState } from './SlidesDialogs';
import { CommentsPanel, FormatPanel, MotionPanel, ThemePanel, type Edit, type PanelKind } from './SlidesPanels';
import { SlidesPresent } from './SlidesPresent';
import { Modal } from '../docs/DocsDialogs';
import './SlidesScreen.css';

const LAST_KEY = 'pigry:slides-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 100;
const AUTHOR = USER_OWNER;
const MENU_NAMES = ['File', 'Edit', 'View', 'Insert', 'Format', 'Slide', 'Arrange', 'Tools'];
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const TEXT_COLORS = ['#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff', '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#c9daf8', '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#6d9eeb', '#8e7cc3', '#c27ba0'];

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Slides', items: [{ keys: 'Ctrl+M', label: 'New slide' }, { keys: 'Ctrl+D', label: 'Duplicate slide or object' }, { keys: 'Delete', label: 'Delete selected slides or objects' }, { keys: 'Page Up / Page Down', label: 'Previous / next slide' }, { keys: 'Ctrl+↑ / Ctrl+↓', label: 'Move slide up / down (in the filmstrip)' }, { keys: 'Ctrl+Alt+1', label: 'Grid view' }, { keys: 'Ctrl+Alt+Shift+S', label: 'Show or hide speaker notes' }] },
  { title: 'Objects', items: [{ keys: 'Arrows / Shift+Arrows', label: 'Nudge / nudge by one pixel' }, { keys: 'Ctrl+Alt+G / Ctrl+Alt+Shift+G', label: 'Group / ungroup' }, { keys: 'Ctrl+↑ / Ctrl+↓', label: 'Bring forward / send backward' }, { keys: 'Ctrl+Shift+↑ / Ctrl+Shift+↓', label: 'Bring to front / send to back' }, { keys: 'Shift+drag', label: 'Keep proportions, move straight, rotate by 15°' }, { keys: 'Alt+drag', label: 'Move or resize without snapping' }, { keys: 'Enter / Esc', label: 'Edit text / stop editing' }, { keys: 'Tab', label: 'Select the next object' }] },
  { title: 'Text', items: [{ keys: 'Ctrl+B / Ctrl+I / Ctrl+U', label: 'Bold / italic / underline' }, { keys: 'Alt+Shift+5', label: 'Strikethrough' }, { keys: 'Ctrl+Shift+> / Ctrl+Shift+<', label: 'Bigger / smaller text' }, { keys: 'Ctrl+Shift+L / E / R / J', label: 'Align left / centre / right / justify' }, { keys: 'Ctrl+Shift+7 / 8', label: 'Numbered / bulleted list' }, { keys: 'Tab / Shift+Tab', label: 'Indent a list item (while editing)' }, { keys: 'Ctrl+\\', label: 'Clear formatting' }, { keys: 'Ctrl+K', label: 'Insert link' }] },
  { title: 'Edit and present', items: [{ keys: 'Ctrl+Z / Ctrl+Y', label: 'Undo / redo' }, { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', label: 'Copy / cut / paste' }, { keys: 'Ctrl+A', label: 'Select all objects' }, { keys: 'Ctrl+F / Ctrl+H', label: 'Find / find and replace' }, { keys: 'Ctrl+Alt+M', label: 'Comment' }, { keys: 'Ctrl+F5 / Ctrl+Enter', label: 'Present from this slide' }, { keys: 'Ctrl+Shift+F5', label: 'Present from the beginning' }, { keys: 'Ctrl+S', label: 'Save now' }, { keys: 'Ctrl+/', label: 'This list' }] },
  { title: 'While presenting', items: [{ keys: '→ / Space / ←', label: 'Next / previous' }, { keys: 'Number + Enter', label: 'Go to a slide' }, { keys: 'S', label: 'Presenter view (notes, timer, next slide)' }, { keys: 'L', label: 'Laser pointer' }, { keys: 'B / W', label: 'Black / white screen' }, { keys: 'Esc', label: 'Exit' }] },
];

interface MenuEntry { label?: string; keys?: string; cmd?: string; disabled?: boolean; separator?: boolean; checked?: boolean; sub?: MenuEntry[] }
type Dialog =
  | { kind: 'new'; template?: TemplateId } | { kind: 'find'; replace: boolean } | { kind: 'theme' } | { kind: 'chart'; id: string } | { kind: 'markdown' } | { kind: 'page' }
  | { kind: 'review' } | { kind: 'stats' } | { kind: 'limits' } | { kind: 'prompt'; title: string; label: string; initial: string; onOk: (v: string) => void } | null;
type Insert = { kind: 'text' } | { kind: 'shape'; shape: ShapeKind } | { kind: 'line'; arrow: boolean } | null;
interface DragState { kind: 'move' | 'resize' | 'rotate' | 'marquee' | 'insert'; x0: number; y0: number; base: Deck; ids: string[]; handle?: Handle; moved: boolean; additive?: boolean; startSel?: string[] }
interface Fmt { b: boolean; i: boolean; u: boolean; s: boolean; font: string; size: number; color: string; align: string; list: string | null }

const download = (blob: Blob, name: string): void => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 1500); };
const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const today = (): string => new Date().toISOString().slice(0, 10);
const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
const imageSize = (src: string): Promise<{ w: number; h: number }> => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => resolve({ w: 0, h: 0 }); img.src = src; });
/** "left:1px;top:2px" → React style. */
function cssToStyle(css: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) { const i = part.indexOf(':'); if (i < 0) continue; const k = part.slice(0, i).trim(); if (!k) continue; out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = part.slice(i + 1).trim(); }
  return out as CSSProperties;
}
/** The topmost element under a point (rotation-aware; lines by distance). */
function hitTest(slide: Slide, x: number, y: number, tol: number): El | null {
  for (let i = slide.elements.length - 1; i >= 0; i--) {
    const e = slide.elements[i];
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    const r = (-(e.rot ?? 0) * Math.PI) / 180;
    const lx = cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), ly = cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r);
    if (e.type === 'line') {
      const [x1, y1, x2, y2] = e.dir === 'up' ? [e.x, e.y + e.h, e.x + e.w, e.y] : [e.x, e.y, e.x + e.w, e.y + e.h];
      const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((lx - x1) * dx + (ly - y1) * dy) / len));
      if (Math.hypot(lx - (x1 + t * dx), ly - (y1 + t * dy)) <= Math.max(tol, (e.strokeW ?? 3) / 2 + 2)) return e;
      continue;
    }
    if (lx >= e.x - 1 && lx <= e.x + e.w + 1 && ly >= e.y - 1 && ly <= e.y + e.h + 1) return e;
  }
  return null;
}
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export function SlidesScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slideId, setSlideId] = useState<string | null>(null);
  const [slideSel, setSlideSel] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; x?: number; y?: number; all?: boolean } | null>(null);
  const [cellEdit, setCellEdit] = useState<{ id: string; r: number; c: number } | null>(null);
  const [focusArea, setFocusArea] = useState<'canvas' | 'filmstrip'>('canvas');
  const [zoomSetting, setZoomSetting] = useState<number | 'fit'>('fit');
  const [fitZoom, setFitZoom] = useState(0.8);
  const [grid, setGrid] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const [snap, setSnap] = useState(true);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ entries: MenuEntry[]; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [present, setPresent] = useState<{ start: number; presenter: boolean } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [insert, setInsert] = useState<Insert>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [helpOpen, setHelpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState(false);
  const [findStatus, setFindStatus] = useState('');
  const [editFmt, setEditFmt] = useState<Fmt | null>(null);
  const [notesDraft, setNotesDraft] = useState<{ slide: string; text: string } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [painting, setPainting] = useState(false);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);
  const [dirtyTick, setDirtyTick] = useState(0);

  const deckRef = useRef<Deck | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const undoStack = useRef<Deck[]>([]);
  const redoStack = useRef<Deck[]>([]);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const editRef = useRef<{ id: string; slide: string } | null>(null);
  const notesRef = useRef<{ slide: string; text: string } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const clipboard = useRef<{ kind: 'els'; els: El[] } | { kind: 'slides'; slides: Slide[] } | null>(null);
  const paintRef = useRef<Partial<Para['runs'][number]> | null>(null);
  const findRef = useRef<{ state: FindState; matches: Match[]; at: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const imageTarget = useRef<'insert' | 'replace' | 'background'>('insert');
  const dragSlide = useRef<string[] | null>(null);

  const zoom = zoomSetting === 'fit' ? fitZoom : zoomSetting;
  const slide = deck ? deck.slides.find((s) => s.id === slideId) ?? deck.slides[0] ?? null : null;
  const slideNo = deck && slide ? deck.slides.indexOf(slide) + 1 : 0;
  const selEls = useMemo(() => (slide ? slide.elements.filter((e) => sel.includes(e.id)) : []), [slide, sel]);
  const textSel = selEls.filter(hasText);
  const refOf = (key: string | null): OwnedRef | null => { if (!key) return null; const { owner, slug } = parseRefName(key, ['.slides.json']); return { owner: owner ?? USER_OWNER, slug }; };
  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });

  /* ---------- persistence and history ---------- */

  const markDirty = useCallback((): void => { dirtyRef.current = true; setDirty(true); setDirtyTick((t) => t + 1); }, []);
  const pushUndo = (d: Deck): void => { undoStack.current.push(d); if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift(); redoStack.current = []; };

  /** Puts typing that is not in the model yet (the text box being edited, the speaker notes) into a deck copy. */
  const pendingInto = (next: Deck): boolean => {
    let changed = false;
    const ed = editRef.current, flow = flowRef.current;
    if (ed && flow) {
      const s = next.slides.find((x) => x.id === ed.slide);
      const el = s?.elements.find((e) => e.id === ed.id);
      if (s && el && hasText(el)) {
        const look = roleLook(next.theme, el.type === 'text' ? el.role : undefined, s.layout);
        const paras = domToParas(flow, { bold: look.b });
        if (JSON.stringify(paras) !== JSON.stringify(el.paras)) {
          el.paras = paras;
          if (el.type === 'text' && parasText(paras).trim()) delete el.placeholder;
          changed = true;
        }
        if (el.type === 'text' && el.autofit === 'resize') {
          const need = Math.ceil(flow.scrollHeight + boxPad(el) * 2);
          if (Math.abs(need - el.h) > 1) { el.h = need; changed = true; }
        }
      }
    }
    const nd = notesRef.current;
    if (nd) {
      const s = next.slides.find((x) => x.id === nd.slide);
      if (s && s.notes !== nd.text) { s.notes = nd.text; changed = true; }
      notesRef.current = null;
      setNotesDraft(null);
    }
    return changed;
  };
  /** Runs a command on a copy of the deck, records undo and saves soon. */
  const exec = (label: string, fn: (d: Deck) => void | false): boolean => {
    // Typing that is not in the model yet becomes its own undo step first, so a command that fails or changes nothing never drops it.
    syncPending();
    const base = deckRef.current;
    if (!base) return false;
    const next = clone(base);
    try { if (fn(next) === false) return false; }
    catch (e) { notify(e instanceof Error ? e.message : String(e), 'error'); return false; }
    pushUndo(base);
    deckRef.current = next;
    setDeck(next);
    syncHist();
    markDirty();
    void label;
    return true;
  };
  /** Commits pending typing without leaving edit mode (autosave, tools). */
  const syncPending = (): void => {
    const base = deckRef.current;
    if (!base) return;
    const next = clone(base);
    if (!pendingInto(next)) return;
    pushUndo(base);
    deckRef.current = next;
    setDeck(next);
    syncHist();
    markDirty();
  };
  const saveNow = useCallback(async () => {
    syncPending();
    const ref = refOf(currentRef.current), d = deckRef.current;
    if (!ref || !d || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveDeck(ref, d, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the presentation: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);
  useEffect(() => {
    if (!dirtyTick) return;
    const t = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [dirtyTick, saveNow]);
  useEffect(() => registerSlidesFlush(saveNow), [saveNow]);
  useEffect(() => () => {
    const ref = refOf(currentRef.current), d = deckRef.current;
    if (dirtyRef.current && ref && d) void saveDeck(ref, d, 'editor');
  }, []);

  const undo = (): void => {
    stopEditing();
    const prev = undoStack.current.pop();
    if (!prev || !deckRef.current) return;
    redoStack.current.push(deckRef.current);
    deckRef.current = prev; setDeck(prev); syncHist(); markDirty();
  };
  const redo = (): void => {
    stopEditing();
    const next = redoStack.current.pop();
    if (!next || !deckRef.current) return;
    undoStack.current.push(deckRef.current);
    deckRef.current = next; setDeck(next); syncHist(); markDirty();
  };

  /* ---------- text editing ---------- */

  const stopEditing = (commit = true): void => {
    if (!editRef.current) return;
    if (commit) {
      const base = deckRef.current;
      if (base) {
        const next = clone(base);
        if (pendingInto(next)) { pushUndo(base); deckRef.current = next; setDeck(next); syncHist(); markDirty(); }
      }
    }
    editRef.current = null;
    flowRef.current = null;
    setEditing(null);
    setEditFmt(null);
  };
  const startEditing = (el: El, at?: { x: number; y: number }, all = false): void => {
    if (!slide || !hasText(el) || el.locked) return;
    stopEditing();
    setSel([el.id]);
    editRef.current = { id: el.id, slide: slide.id };
    setEditing({ id: el.id, x: at?.x, y: at?.y, all });
  };
  /** The editable box: filled once when it mounts, then the DOM is the state until editing stops. */
  const flowCallback = useCallback((node: HTMLDivElement | null) => {
    flowRef.current = node;
    if (!node) return;
    const d = deckRef.current, ed = editRef.current;
    const s = d?.slides.find((x) => x.id === ed?.slide);
    const el = s?.elements.find((e) => e.id === ed?.id);
    if (!d || !el || !hasText(el)) return;
    node.innerHTML = parasText(el.paras) || el.paras.length > 1 ? parasHtml(el.paras, d.theme, true) : '<div class="sld-p"><br></div>';
  }, []);
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!editing || !flow) return;
    flow.focus({ preventScroll: true });
    placeCaret(flow, editing.x, editing.y, editing.all);
  }, [editing]);
  const readEditFmt = useCallback(() => {
    const flow = flowRef.current;
    const s = window.getSelection();
    if (!flow || !s || !s.focusNode || !flow.contains(s.focusNode)) return;
    const node = s.focusNode.nodeType === 3 ? s.focusNode.parentElement : (s.focusNode as HTMLElement);
    if (!node) return;
    const cs = window.getComputedStyle(node);
    const p = node.closest('.sld-p') as HTMLElement | null;
    const pcs = p ? window.getComputedStyle(p) : null;
    setEditFmt({
      b: Number(cs.fontWeight) >= 600, i: cs.fontStyle === 'italic', u: !!node.closest('u,[style*="underline"]'), s: !!node.closest('s,strike,[style*="line-through"]'),
      font: (cs.fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim(), size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2, color: toHex(cs.color) ?? '#000000',
      align: pcs?.textAlign === 'start' ? 'left' : pcs?.textAlign ?? 'left', list: p?.getAttribute('data-list') ?? null,
    });
  }, []);
  useEffect(() => {
    let raf: number | null = null;
    const onSel = () => { if (raf === null) raf = window.requestAnimationFrame(() => { raf = null; readEditFmt(); }); };
    document.addEventListener('selectionchange', onSel);
    return () => { document.removeEventListener('selectionchange', onSel); if (raf !== null) window.cancelAnimationFrame(raf); };
  }, [readEditFmt]);

  /* ---------- opening files ---------- */

  const openDeckFile = useCallback(async (key: string, slideRef?: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { deck: d, warnings } = await loadDeck(ref);
      undoStack.current = []; redoStack.current = [];
      dirtyRef.current = false; setDirty(false);
      editRef.current = null; flowRef.current = null; notesRef.current = null;
      const nextKey = refKey(ref);
      deckRef.current = d; currentRef.current = nextKey;
      setDeck(d); setCurrent(nextKey); setOpenDeck(nextKey);
      const n = slideRef && /^\d+$/.test(slideRef) ? Number(slideRef) : 1;
      const s = d.slides[n - 1] ?? d.slides[0];
      setSlideId(s?.id ?? null); setSlideSel(s ? [s.id] : []);
      setSel([]); setEditing(null); setCellEdit(null); setNotesDraft(null);
      syncHist();
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Presentation opened with ${warnings.length} repaired issue(s).`);
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [notify, saveNow]);
  const refreshList = useCallback(async () => { try { setRefs(await listDeckRefs()); } catch { setRefs([]); } }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listDeckRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: SlidesOpenRequest | null = takePendingOpenDeck();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? (request ? undefined : list[0]);
      if (found) await openDeckFile(refKey(found), request?.slide);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<SlidesChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setDeck(null); deckRef.current = null; currentRef.current = null; setOpenDeck(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openDeckFile(change.key, String(Math.max(1, (deckRef.current?.slides.findIndex((s) => s.id === slideId) ?? 0) + 1))); }
    };
    const onOpen = (event: Event) => { const r = (event as CustomEvent<SlidesOpenRequest>).detail; takePendingOpenDeck(); void openDeckFile(r.key, r.slide); };
    window.addEventListener(SLIDES_CHANGED, onChanged);
    window.addEventListener(SLIDES_OPEN, onOpen);
    return () => { window.removeEventListener(SLIDES_CHANGED, onChanged); window.removeEventListener(SLIDES_OPEN, onOpen); };
  }, [openDeckFile, refreshList, slideId]);
  useEffect(() => { if (current) setOpenDeck(current, slide ? `slide ${slideNo}${slideTitle(slide) ? ` "${slideTitle(slide)}"` : ''}${selEls.length ? `, ${selEls.map((e) => e.id).join(', ')} selected` : ''}` : null); }, [current, slide, slideNo, selEls]);

  // Fit the slide to the canvas.
  const deckW = deck?.size.w ?? 0, deckH = deck?.size.h ?? 0, hasSlide = !!slide;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !deckW || !deckH) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setFitZoom(Math.max(0.1, Math.min((r.width - 56) / deckW, (r.height - 56) / deckH))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [deckW, deckH, hasSlide, grid, showNotes, panel]);

  /* ---------- files ---------- */

  const newDeck = async (name: string, template: TemplateId): Promise<void> => {
    const slug = nameSlug(name || (template === 'blank' ? 'untitled' : TEMPLATES.find((t) => t.id === template)?.label ?? 'presentation'), ['.slides.json']);
    const ref: OwnedRef = { owner: USER_OWNER, slug };
    if (refs.some((r) => r.owner === ref.owner && r.slug === ref.slug)) { notify(`A presentation called "${slug}" already exists.`, 'error'); return; }
    setDialog(null);
    const title = name.trim() || (template === 'blank' ? 'Untitled presentation' : TEMPLATES.find((t) => t.id === template)?.label ?? 'Presentation');
    await saveNow();
    try { await saveDeck(ref, templateDeck(template, title, today()), 'editor'); await refreshList(); await openDeckFile(refKey(ref)); }
    catch (error) { notify(`Could not create the presentation: ${String(error)}`, 'error'); }
  };
  const copyDeck = async (): Promise<void> => {
    await saveNow();
    const d = deckRef.current;
    if (!d) return;
    let slug = `${nameSlug(d.title, ['.slides.json'])}-copy`, n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${nameSlug(d.title, ['.slides.json'])}-copy-${n++}`;
    const ref = { owner: USER_OWNER, slug };
    await saveDeck(ref, { ...clone(d), title: `Copy of ${d.title}` }, 'editor');
    await refreshList();
    await openDeckFile(refKey(ref));
  };
  const deleteFile = async (key: string): Promise<void> => {
    const ref = refOf(key);
    if (!ref) return;
    setConfirmDelete(null);
    try {
      if (key === currentRef.current) dirtyRef.current = false;
      await removeDeck(ref);
      if (key === currentRef.current) { setCurrent(null); setDeck(null); deckRef.current = null; currentRef.current = null; setOpenDeck(null); }
      await refreshList();
    } catch (error) { notify(`Could not delete: ${String(error)}`, 'error'); }
  };
  const importMarkdownFile = async (file: File): Promise<void> => {
    const title = file.name.replace(/\.[^.]+$/, '');
    const text = await file.text();
    const d = templateDeck('blank', title);
    d.slides = [];
    markdownToSlides(d, text);
    if (!d.slides.length) addSlide(d, 'title', undefined, { title });
    let slug = nameSlug(title, ['.slides.json']), n = 2;
    while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${nameSlug(title, ['.slides.json'])}-${n++}`;
    const ref = { owner: USER_OWNER, slug };
    try { await saveDeck(ref, d, 'editor'); await refreshList(); await openDeckFile(refKey(ref)); notify(`Imported ${file.name} as ${d.slides.length} slides.`, 'success'); }
    catch (error) { notify(`Could not import: ${String(error)}`, 'error'); }
  };
  const exportAs = async (format: 'pptx' | 'pdf' | 'png' | 'png-all' | 'html' | 'md' | 'txt'): Promise<void> => {
    await saveNow();
    const ref = refOf(currentRef.current), d = deckRef.current;
    if (!ref || !d) return;
    const base = slidesPath(ref).replace(/\.slides\.json$/, '');
    const fileBase = nameSlug(d.title) || ref.slug;
    try {
      if (format === 'pptx') {
        const bytes = await pptxWithPictures(d);
        await writeWorktreeBinary(`${base}.pptx`, toBase64(bytes));
        download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${fileBase}.pptx`);
      } else if (format === 'pdf') {
        const bytes = await slidesPdf(d);
        await writeWorktreeBinary(`${base}.pdf`, toBase64(bytes));
        download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }), `${fileBase}.pdf`);
      } else if (format === 'png' || format === 'png-all') {
        const list = format === 'png' && slide ? [slide] : d.slides;
        for (const s of list) {
          const url = await slidePng(d, s, 2);
          const n = d.slides.indexOf(s) + 1;
          await writeWorktreeBinary(`${base}-slide-${n}.png`, url.slice(url.indexOf(',') + 1));
          if (format === 'png') { const a = document.createElement('a'); a.href = url; a.download = `${fileBase}-slide-${n}.png`; a.click(); }
        }
        notify(`Saved ${list.length === 1 ? `${base}-slide-${d.slides.indexOf(list[0]) + 1}.png` : `${list.length} pictures as ${base}-slide-<n>.png`}`, 'success');
        return;
      } else {
        const text = format === 'html' ? deckToHtml(d) : format === 'md' ? deckToMarkdown(d) : deckToText(d);
        await writeWorktreeFile(`${base}.${format}`, text);
        download(new Blob([text], { type: format === 'html' ? 'text/html' : format === 'md' ? 'text/markdown' : 'text/plain' }), `${fileBase}.${format}`);
      }
      notify(`Saved ${base}.${format}`, 'success');
    } catch (error) { notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
  };

  /* ---------- slides ---------- */

  const goSlide = (id: string, extend: 'none' | 'toggle' | 'range' = 'none'): void => {
    stopEditing();
    setCellEdit(null);
    setSlideId(id);
    setSel([]);
    const d = deckRef.current;
    if (extend === 'toggle') setSlideSel((cur) => (cur.includes(id) ? (cur.length > 1 ? cur.filter((x) => x !== id) : cur) : [...cur, id]));
    else if (extend === 'range' && d && slide) { const a = d.slides.indexOf(slide), b = d.slides.findIndex((s) => s.id === id); const [lo, hi] = a < b ? [a, b] : [b, a]; setSlideSel(d.slides.slice(lo, hi + 1).map((s) => s.id)); }
    else setSlideSel([id]);
  };
  const targetSlides = (): string[] => { const ids = deck ? deck.slides.filter((s) => slideSel.includes(s.id)).map((s) => s.id) : []; return ids.length ? ids : slide ? [slide.id] : []; };
  const newSlide = (layout?: LayoutId): void => {
    let made: Slide | null = null;
    exec('New slide', (d) => {
      const at = slide ? d.slides.findIndex((s) => s.id === slide.id) + 1 : d.slides.length;
      const prev = slide?.layout;
      made = addSlide(d, layout ?? (prev === 'title' || !prev ? 'title-body' : prev === 'section' ? 'title-body' : prev), at);
    });
    if (made) goSlide((made as Slide).id);
  };
  const duplicateSlides = (): void => {
    const ids = targetSlides();
    let last: Slide | null = null;
    exec('Duplicate slide', (d) => { for (const id of [...ids].reverse()) { const s = d.slides.find((x) => x.id === id); if (s) last = duplicateSlide(d, s); } });
    if (last) goSlide((last as Slide).id);
  };
  const deleteSlides = (): void => {
    const d = deckRef.current;
    if (!d) return;
    const ids = targetSlides();
    const idx = d.slides.findIndex((s) => ids.includes(s.id));
    exec('Delete slide', (x) => { for (const id of ids) { const s = x.slides.find((y) => y.id === id); if (s) deleteSlide(x, s); } });
    const after = deckRef.current;
    const next = after?.slides[Math.min(Math.max(0, idx), (after?.slides.length ?? 1) - 1)];
    if (next) goSlide(next.id); else { setSlideId(null); setSlideSel([]); }
  };
  const skipSlides = (): void => { const ids = targetSlides(); exec('Skip slide', (d) => { const all = d.slides.filter((s) => ids.includes(s.id)); const on = !all.every((s) => s.hidden); for (const s of all) { if (on) s.hidden = true; else delete s.hidden; } }); };
  const moveSlideBy = (delta: number | 'start' | 'end'): void => {
    const d = deckRef.current;
    if (!d) return;
    const ids = targetSlides();
    const first = d.slides.findIndex((s) => ids.includes(s.id));
    const last = d.slides.length - 1 - [...d.slides].reverse().findIndex((s) => ids.includes(s.id));
    const to = delta === 'start' ? 0 : delta === 'end' ? d.slides.length : delta < 0 ? Math.max(0, first - 1) : Math.min(d.slides.length, last + 2);
    exec('Move slide', (x) => { moveSlides(x, ids, to); });
  };

  /* ---------- elements ---------- */

  const editSel: Edit = (label, fn) => {
    if (!slide) return;
    const sid = slide.id, ids = sel;
    exec(label, (d) => { const s = d.slides.find((x) => x.id === sid); if (!s) return false; fn(d, s, s.elements.filter((e) => ids.includes(e.id))); });
  };
  const addElement = (make: (d: Deck, s: Slide) => El | El[], label: string, thenEdit = false): void => {
    if (!slide) { notify('Add a slide first', 'error'); return; }
    let made: El[] = [];
    const sid = slide.id;
    exec(label, (d) => { const s = d.slides.find((x) => x.id === sid); if (!s) return false; const r = make(d, s); made = Array.isArray(r) ? r : [r]; s.elements.push(...made); });
    setSel(made.map((e) => e.id));
    setFocusArea('canvas');
    if (thenEdit && made[0]) { editRef.current = { id: made[0].id, slide: sid }; setEditing({ id: made[0].id }); }
  };
  const center = (w: number, h: number) => ({ x: Math.round(((deck?.size.w ?? 960) - w) / 2), y: Math.round(((deck?.size.h ?? 540) - h) / 2), w, h });
  const insertTextBox = (box?: Box) => addElement((d) => ({ id: newId(d, 'e'), type: 'text', ...(box ?? center(400, 80)), paras: [para()], autofit: 'none' } as TextEl), 'Text box', true);
  const insertShape = (shape: ShapeKind, box?: Box) => addElement((d) => ({ id: newId(d, 'e'), type: 'shape', shape, ...(box ?? center(200, 140)), fill: '$accent', paras: [para()] }), 'Shape');
  const insertLine = (arrow: boolean, box?: Box & { dir?: 'up' | 'down' }) => addElement((d) => ({ id: newId(d, 'e'), type: 'line', ...(box ?? { ...center(240, 1), dir: 'down' as const }), stroke: '$text', strokeW: 3, ...(arrow ? { end: 'arrow' as const } : {}) }), arrow ? 'Arrow' : 'Line');
  const insertTable = (rows: number, cols: number) => addElement((d) => ({ id: newId(d, 'e'), type: 'table', ...center(Math.min(820, cols * 160), Math.min(420, rows * 44)), header: true, size: 14, rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ({ text: r === 0 ? `Heading ${c + 1}` : '' }))) }), 'Table');
  const insertChart = (chart: ChartEl['chart']) => addElement((d) => ({ id: newId(d, 'e'), type: 'chart', chart, ...center(560, 320), labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: chart === 'pie' || chart === 'doughnut' ? [{ name: 'Share', values: [40, 25, 20, 15] }] : [{ name: '2025', values: [12, 18, 15, 22] }, { name: '2026', values: [16, 21, 24, 30] }], title: 'Chart title' } as ChartEl), 'Chart');
  const insertIcon = (glyph: string) => addElement((d) => ({ id: newId(d, 'e'), type: 'icon', glyph, ...center(96, 96) }), 'Icon');
  const insertEmbed = (kind: 'video' | 'link') => setDialog({ kind: 'prompt', title: kind === 'video' ? 'Insert video' : 'Insert link card', label: kind === 'video' ? 'Video URL (YouTube, Vimeo or a file link)' : 'Link URL', initial: 'https://', onOk: (url) => { setDialog(null); if (!url.trim()) return; addElement((d) => ({ id: newId(d, 'e'), type: 'embed', kind, url: url.trim(), title: kind === 'video' ? 'Video' : url.replace(/^https?:\/\//, '').split('/')[0], ...center(kind === 'video' ? 480 : 360, kind === 'video' ? 270 : 140) }), kind === 'video' ? 'Video' : 'Link'); } });
  const insertImageFile = async (file: File): Promise<void> => {
    const src = await readFileAsDataUrl(file);
    const { w, h } = await imageSize(src);
    const target = imageTarget.current;
    imageTarget.current = 'insert';
    if (target === 'background') { editSel('Background image', (_, s) => { s.background = { type: 'image', src, fit: 'cover' }; }); return; }
    if (target === 'replace') { editSel('Replace image', (_d, _s, els) => { for (const e of els) if (e.type === 'image') e.src = src; }); return; }
    const W = deck?.size.w ?? 960, H = deck?.size.h ?? 540;
    const k = w && h ? Math.min(1, (W * 0.6) / w, (H * 0.6) / h) : 1;
    addElement((d) => ({ id: newId(d, 'e'), type: 'image', src, fit: 'cover', alt: '', ...center(Math.round((w || 400) * k), Math.round((h || 260) * k)) }), 'Image');
  };
  const pickImage = (target: 'insert' | 'replace' | 'background') => { imageTarget.current = target; imageInput.current?.click(); };
  const deleteSel = (): void => { const ids = sel; if (!ids.length) return; editSel('Delete', (_, s) => { removeEls(s, ids); }); setSel([]); };
  const copySel = (cut = false): void => {
    if (focusArea === 'filmstrip' || !sel.length) {
      const d = deckRef.current;
      if (!d) return;
      const ids = targetSlides();
      clipboard.current = { kind: 'slides', slides: clone(d.slides.filter((s) => ids.includes(s.id))) };
      if (cut) deleteSlides();
      return;
    }
    clipboard.current = { kind: 'els', els: clone(selEls) };
    if (cut) deleteSel();
  };
  const paste = (): boolean => {
    const cb = clipboard.current;
    if (!cb) return false;
    if (cb.kind === 'slides') {
      let last: Slide | null = null;
      exec('Paste slides', (d) => {
        let at = slide ? d.slides.findIndex((s) => s.id === slide.id) + 1 : d.slides.length;
        for (const s of cb.slides) { const holder = { ...clone(s), id: 'tmp' }; d.slides.splice(at, 0, holder); const copy = duplicateSlide(d, holder); d.slides.splice(d.slides.indexOf(holder), 1); at = d.slides.indexOf(copy) + 1; last = copy; }
      });
      if (last) goSlide((last as Slide).id);
      return true;
    }
    if (!slide) return false;
    const sameSlide = cb.els.every((e) => slide.elements.some((x) => x.id === e.id));
    let ids: string[] = [];
    addElement((d) => { const groups = new Map<string, string>(); const made = cb.els.map((e) => copyEl(d, e, sameSlide ? 16 : 0, groups)); ids = made.map((e) => e.id); return made; }, 'Paste');
    clipboard.current = { kind: 'els', els: cb.els.map((e) => ({ ...e, x: e.x + (sameSlide ? 16 : 0), y: e.y + (sameSlide ? 16 : 0) })) };
    setSel(ids);
    return true;
  };
  const duplicateSel = (): void => {
    if (!slide || !sel.length) return;
    const ids = sel;
    let made: string[] = [];
    editSel('Duplicate', (d, s) => { const groups = new Map<string, string>(); const copies = s.elements.filter((e) => ids.includes(e.id)).map((e) => copyEl(d, e, 16, groups)); s.elements.push(...copies); made = copies.map((e) => e.id); });
    setSel(made);
  };
  const nudge = (dx: number, dy: number): void => { if (sel.length) editSel('Nudge', (_d, _s, els) => { for (const e of els) if (!e.locked) { e.x = round1(e.x + dx); e.y = round1(e.y + dy); } }); };
  const arrange = (z: ZOrder): void => { const ids = sel; if (ids.length) editSel('Order', (_, s) => { reorder(s, ids, z); }); };
  const align = (to: AlignTo): void => { const ids = sel; if (ids.length) editSel('Align', (d, s) => { alignEls(d, s, ids, to); }); };
  const distribute = (axis: 'h' | 'v'): void => { const ids = sel; if (ids.length >= 3) editSel('Distribute', (_, s) => { distributeEls(s, ids, axis); }); else notify('Select three or more objects to distribute', 'error'); };
  const centerOnPage = (axis: 'h' | 'v'): void => { const ids = sel; editSel('Centre on page', (d, s) => { const els = s.elements.filter((e) => ids.includes(e.id)); const b = unionBox(els); for (const e of els) { if (axis === 'h') e.x = round1(e.x + (d.size.w - b.w) / 2 - b.x); else e.y = round1(e.y + (d.size.h - b.h) / 2 - b.y); } }); };
  const group = (): void => { const ids = sel; if (ids.length < 2) { notify('Select two or more objects to group', 'error'); return; } editSel('Group', (d, s) => { groupEls(d, s, ids); }); };
  const ungroup = (): void => { const ids = sel; editSel('Ungroup', (_, s) => { ungroupEls(s, ids); }); };
  const toggleLock = (): void => { const lock = !selEls.every((e) => e.locked); editSel(lock ? 'Lock' : 'Unlock', (_d, _s, els) => { for (const e of els) { if (lock) e.locked = true; else delete e.locked; } }); };
  const rotateBy = (deg: number): void => editSel('Rotate', (_d, _s, els) => { for (const e of els) { const r = (((e.rot ?? 0) + deg) % 360 + 360) % 360; if (r) e.rot = r; else delete e.rot; } });

  /* ---------- text formatting (edited text, or whole boxes) ---------- */

  const cmd = (name: string, value?: string): void => { flowRef.current?.focus({ preventScroll: true }); document.execCommand('styleWithCSS', false, 'true'); document.execCommand(name, false, value); readEditFmt(); };
  const boxFormat = (label: string, marks: Parameters<typeof formatParas>[1]): void => { if (!textSel.length) { notify('Select a text box or shape first', 'error'); return; } editSel(label, (_d, _s, els) => { for (const e of els) if (hasText(e)) formatParas(e.paras, marks); }); };
  const fmt = editing ? editFmt : (() => { const el = textSel[0]; if (!el || !deck || !slide) return null; const m = marksOf(el.paras); const look = roleLook(deck.theme, el.type === 'text' ? el.role : undefined, slide.layout); return { b: m.b ?? look.b, i: !!m.i, u: !!m.u, s: !!m.s, font: m.font ?? look.font, size: m.size ?? look.size, color: m.color ?? look.color, align: m.align ?? (el.type === 'shape' ? 'center' : look.align), list: m.list ?? null } as Fmt; })();
  const toggleMark = (k: 'b' | 'i' | 'u' | 's'): void => {
    if (editing) { cmd({ b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough' }[k]); return; }
    const on = !(fmt?.[k] ?? false);
    boxFormat('Format', { [k]: on });
  };
  const setFont = (f: string): void => { setTool(null); if (editing) cmd('fontName', f); else boxFormat('Font', { font: f }); };
  const setSize = (n: number): void => {
    setTool(null);
    if (editing) { const flow = flowRef.current; if (!flow) return; cmd('fontSize', '7'); fixFontSize(flow, n); readEditFmt(); return; }
    boxFormat('Font size', { size: n });
  };
  const bumpSize = (dir: 1 | -1): void => { const cur = fmt?.size ?? 18; setSize(dir > 0 ? FONT_SIZES.find((s) => s > cur) ?? cur + 4 : [...FONT_SIZES].reverse().find((s) => s < cur) ?? Math.max(1, cur - 1)); };
  const setColor = (c: string, hl = false): void => { setTool(null); if (editing) cmd(hl ? 'hiliteColor' : 'foreColor', c); else boxFormat('Colour', hl ? { hl: c } : { color: c }); };
  const paraFormat = (label: string, change: { align?: 'left' | 'center' | 'right' | 'justify'; list?: 'bullet' | 'number' | null; indent?: number; lh?: number }): void => {
    setTool(null);
    const flow = flowRef.current;
    if (editing && flow) { formatSelectedParas(flow, change); readEditFmt(); return; }
    if (change.list) { const all = textSel.every((e) => e.paras.every((p) => p.list === change.list)); boxFormat(label, { list: all ? null : change.list }); return; }
    boxFormat(label, change);
  };
  const clearFormatting = (): void => {
    if (editing) { cmd('removeFormat'); return; }
    editSel('Clear formatting', (_d, _s, els) => { for (const e of els) if (hasText(e)) for (const p of e.paras) { p.runs = p.runs.map((r) => ({ t: r.t, ...(r.link ? { link: r.link } : {}) })); delete p.align; delete p.lh; } });
  };
  const insertLinkCmd = (): void => {
    const sel0 = window.getSelection()?.toString() ?? '';
    setDialog({ kind: 'prompt', title: 'Insert link', label: 'Link URL', initial: 'https://', onOk: (url) => {
      setDialog(null);
      const u = url.trim();
      if (!u) return;
      if (editing) { window.setTimeout(() => { cmd('createLink', u); }, 0); return; }
      if (selEls.length) editSel('Link', (_d, _s, els) => { for (const e of els) { if (hasText(e)) formatParas(e.paras, { link: u }); else e.link = u; } });
      else addElement((d) => ({ id: newId(d, 'e'), type: 'text', ...center(400, 60), paras: [{ runs: [{ t: sel0 || u, link: u }] }] } as TextEl), 'Link');
    } });
  };
  const startPaint = (): void => {
    if (painting) { paintRef.current = null; setPainting(false); return; }
    const r = textSel[0]?.paras.flatMap((p) => p.runs)[0];
    if (!r) { notify('Select a text box to copy its formatting', 'error'); return; }
    const m: Partial<Para['runs'][number]> = {};
    for (const k of ['b', 'i', 'u', 's', 'color', 'font', 'size', 'hl'] as const) if (r[k] !== undefined) (m as Record<string, unknown>)[k] = r[k];
    paintRef.current = m;
    setPainting(true);
  };

  /* ---------- find and replace ---------- */

  const runFind = (state: FindState): Match[] => (deckRef.current ? findAll(deckRef.current, state.find, { matchCase: state.matchCase }) : []);
  const showMatch = (m: Match): void => {
    goSlide(m.slide);
    if (m.el) setSel([m.el]);
    if (m.where === 'notes') setShowNotes(true);
  };
  const onFindChange = (state: FindState): void => { const matches = runFind(state); findRef.current = { state, matches, at: -1 }; setFindStatus(state.find ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : ''); };
  const findNext = (back = false): void => {
    const f = findRef.current;
    if (!f || !f.matches.length) { setFindStatus('No matches'); return; }
    f.at = (f.at + (back ? -1 : 1) + f.matches.length) % f.matches.length;
    showMatch(f.matches[f.at]);
    setFindStatus(`${f.at + 1} of ${f.matches.length}`);
  };
  const replaceCurrent = (): void => {
    const f = findRef.current;
    if (!f || f.at < 0 || !f.matches[f.at]) { findNext(); return; }
    const m = f.matches[f.at];
    const re = findRegex(f.state.find, { matchCase: f.state.matchCase });
    if (!re) return;
    exec('Replace', (d) => {
      const s = d.slides.find((x) => x.id === m.slide);
      const el = s?.elements.find((e) => e.id === m.el);
      if (m.where === 'notes' && s) { let done = false; s.notes = s.notes.replace(re, (hit) => { if (done) return hit; done = true; return f.state.replace; }); return; }
      if (el && hasText(el) && m.para !== undefined) {
        replaceInPara(el.paras[m.para], new RegExp(`(?<=^[\\s\\S]{${m.index}})(?:${re.source})`, re.flags), f.state.replace);
      }
      if (el && el.type === 'table' && m.row !== undefined && m.col !== undefined) { const c = el.rows[m.row][m.col]; c.text = c.text.slice(0, m.index) + f.state.replace + c.text.slice(m.index + m.length); }
    });
    onFindChange(f.state);
    findNext();
  };
  const replaceEvery = (): void => {
    const f = findRef.current;
    if (!f || !f.state.find) return;
    let n = 0;
    exec('Replace all', (d) => { n = replaceAll(d, f.state.find, f.state.replace, { matchCase: f.state.matchCase }); if (!n) return false; });
    findRef.current = { state: f.state, matches: runFind(f.state), at: -1 };
    setFindStatus(n ? `Replaced ${n}` : 'No matches');
  };

  /* ---------- canvas pointer handling ---------- */

  const toSlide = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom } : { x: 0, y: 0 };
  };
  const onStageDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!slide || !deck || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (flowRef.current && flowRef.current.contains(target)) return;
    if (target.closest('[contenteditable="true"]')) return;
    mainRef.current?.focus({ preventScroll: true });
    setFocusArea('canvas');
    setCtx(null);
    if (cellEdit) setCellEdit(null);
    if (editRef.current) stopEditing();
    const pt = toSlide(e);
    const base = deckRef.current ?? deck;
    const capture = () => (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (insert) { dragRef.current = { kind: 'insert', x0: pt.x, y0: pt.y, base, ids: [], moved: false }; capture(); return; }
    const handle = target.getAttribute('data-handle') as Handle | 'rot' | null;
    if (handle && sel.length) {
      dragRef.current = { kind: handle === 'rot' ? 'rotate' : 'resize', handle: handle === 'rot' ? undefined : handle, x0: pt.x, y0: pt.y, base, ids: sel, moved: false };
      capture();
      return;
    }
    const hit = hitTest(slide, pt.x, pt.y, 6 / zoom);
    if (hit && paintRef.current && hasText(hit)) {
      const marks = paintRef.current;
      paintRef.current = null; setPainting(false);
      exec('Paint format', (d) => { const el = d.slides.find((s) => s.id === slide.id)?.elements.find((x) => x.id === hit.id); if (el && hasText(el)) for (const p of el.paras) p.runs = p.runs.map((r) => ({ t: r.t, ...(r.link ? { link: r.link } : {}), ...marks })); });
      setSel([hit.id]);
      return;
    }
    if (hit) {
      const ids = groupMembers(slide, hit).map((x) => x.id);
      if (e.shiftKey || e.ctrlKey || e.metaKey) { setSel((cur) => (cur.includes(hit.id) ? cur.filter((x) => !ids.includes(x)) : [...cur, ...ids])); return; }
      const moving = sel.includes(hit.id) ? sel : ids;
      if (!sel.includes(hit.id)) setSel(ids);
      dragRef.current = { kind: 'move', x0: pt.x, y0: pt.y, base, ids: moving, moved: false };
      capture();
      return;
    }
    dragRef.current = { kind: 'marquee', x0: pt.x, y0: pt.y, base, ids: [], moved: false, additive: e.shiftKey || e.ctrlKey, startSel: e.shiftKey || e.ctrlKey ? sel : [] };
    if (!(e.shiftKey || e.ctrlKey)) setSel([]);
    capture();
  };
  const onStageMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const dr = dragRef.current;
    if (!dr || !slide) return;
    const pt = toSlide(e);
    let dx = pt.x - dr.x0, dy = pt.y - dr.y0;
    if (!dr.moved && Math.hypot(dx, dy) * zoom < 3) return;
    dr.moved = true;
    const base = dr.base;
    const bs = base.slides.find((s) => s.id === slide.id);
    if (!bs) return;
    const update = (fn: (e: El) => El): void => {
      const next: Deck = { ...base, slides: base.slides.map((s) => (s.id === bs.id ? { ...s, elements: s.elements.map((x) => (dr.ids.includes(x.id) ? fn(x) : x)) } : s)) };
      deckRef.current = next;
      setDeck(next);
    };
    if (dr.kind === 'marquee' || dr.kind === 'insert') {
      const box = { x: Math.min(dr.x0, pt.x), y: Math.min(dr.y0, pt.y), w: Math.abs(dx), h: Math.abs(dy) };
      setMarquee(box);
      if (dr.kind === 'marquee') {
        const hits = bs.elements.filter((x) => { const b = rotatedBounds(x); return b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h; });
        const ids = new Set(dr.startSel ?? []);
        for (const h of hits) for (const m of groupMembers(bs, h)) ids.add(m.id);
        setSel([...ids]);
      }
      return;
    }
    const els = bs.elements.filter((x) => dr.ids.includes(x.id) && !x.locked);
    if (!els.length) return;
    if (dr.kind === 'move') {
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const box = unionBox(els.map(rotatedBounds));
      let g: Guide[] = [];
      if (snap && !e.altKey) {
        const others = bs.elements.filter((x) => !dr.ids.includes(x.id)).map(rotatedBounds);
        const r = snapBox({ ...box, x: box.x + dx, y: box.y + dy }, others, base.size, 6 / zoom);
        dx += r.dx; dy += r.dy; g = r.guides;
      }
      setGuides(g);
      update((x) => (x.locked ? x : { ...x, x: round1(x.x + dx), y: round1(x.y + dy) }));
      return;
    }
    if (dr.kind === 'resize' && dr.handle) {
      const handle = dr.handle;
      if (els.length === 1) {
        const el = els[0];
        const keep = e.shiftKey || (el.type === 'image' && handle.length === 2) || el.type === 'icon';
        const b = resizeBox(el, handle, dx, dy, { keepRatio: keep, min: el.type === 'line' ? 1 : 8 });
        update((x) => (x.id === el.id ? { ...x, x: round1(b.x), y: round1(b.y), w: round1(b.w), h: round1(b.h) } : x));
      } else {
        const u = unionBox(els);
        const b = resizeBox(u, handle, dx, dy, { keepRatio: e.shiftKey });
        const kx = b.w / (u.w || 1), ky = b.h / (u.h || 1);
        update((x) => (x.locked ? x : { ...x, x: round1(b.x + (x.x - u.x) * kx), y: round1(b.y + (x.y - u.y) * ky), w: round1(Math.max(1, x.w * kx)), h: round1(Math.max(1, x.h * ky)) }));
      }
      return;
    }
    if (dr.kind === 'rotate' && els.length === 1) {
      const el = els[0];
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI + 90;
      deg = ((deg % 360) + 360) % 360;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else for (const t of [0, 90, 180, 270, 360]) if (Math.abs(deg - t) < 3) deg = t;
      deg = round1(deg % 360);
      update((x) => (x.id === el.id ? (deg ? { ...x, rot: deg } : (() => { const y = { ...x }; delete y.rot; return y; })()) : x));
    }
  };
  const onStageUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const dr = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    setMarquee(null);
    if (!dr || !slide) return;
    if (dr.kind === 'insert') {
      const pt = toSlide(e);
      const box = dr.moved ? { x: Math.round(Math.min(dr.x0, pt.x)), y: Math.round(Math.min(dr.y0, pt.y)), w: Math.max(8, Math.round(Math.abs(pt.x - dr.x0))), h: Math.max(8, Math.round(Math.abs(pt.y - dr.y0))) } : undefined;
      const kind = insert;
      setInsert(null);
      if (kind?.kind === 'text') insertTextBox(box ?? { x: Math.round(dr.x0), y: Math.round(dr.y0), w: 300, h: 60 });
      else if (kind?.kind === 'shape') insertShape(kind.shape, box ?? { x: Math.round(dr.x0), y: Math.round(dr.y0), w: 160, h: 120 });
      else if (kind?.kind === 'line') {
        const down = (pt.x - dr.x0) * (pt.y - dr.y0) >= 0;
        insertLine(kind.arrow, box ? { ...box, h: Math.max(1, Math.round(Math.abs(pt.y - dr.y0))), dir: down ? 'down' : 'up' } : { x: Math.round(dr.x0), y: Math.round(dr.y0), w: 200, h: 1, dir: 'down' });
      }
      return;
    }
    if (dr.kind === 'marquee' || !dr.moved) return;
    pushUndo(dr.base);
    syncHist();
    markDirty();
  };
  const onStageDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!slide) return;
    const target = e.target as HTMLElement;
    if (flowRef.current?.contains(target)) return;
    const pt = toSlide(e);
    const hit = hitTest(slide, pt.x, pt.y, 6 / zoom);
    if (!hit) return;
    if (hasText(hit)) { startEditing(hit, { x: e.clientX, y: e.clientY }); return; }
    if (hit.type === 'table') { const td = target.closest('td'); const tr = td?.parentElement; if (td && tr) { setSel([hit.id]); setCellEdit({ id: hit.id, r: [...(tr.parentElement?.children ?? [])].indexOf(tr), c: [...tr.children].indexOf(td) }); } return; }
    if (hit.type === 'chart') { setSel([hit.id]); setDialog({ kind: 'chart', id: hit.id }); return; }
    if (hit.type === 'image') { setSel([hit.id]); setPanel('format'); }
  };
  // Table cells are typed into in place.
  useLayoutEffect(() => {
    if (!cellEdit || !stageRef.current) return;
    const td = stageRef.current.querySelector<HTMLTableCellElement>(`.sld-el[data-id="${cellEdit.id}"] tr:nth-child(${cellEdit.r + 1}) td:nth-child(${cellEdit.c + 1})`);
    if (!td || td.isContentEditable) return;
    td.contentEditable = 'true';
    td.setAttribute('aria-label', `Cell ${cellEdit.r + 1}, ${cellEdit.c + 1}`);
    td.focus();
    placeCaret(td, undefined, undefined, true);
    const commitCell = (): string => { const v = (td.textContent ?? '').replace(/ /g, ' ').trim(); const { id, r, c } = cellEdit; exec('Edit cell', (d) => { const el = d.slides.find((s) => s.id === slide?.id)?.elements.find((x) => x.id === id); if (el?.type !== 'table' || el.rows[r]?.[c]?.text === v) return false; el.rows[r][c].text = v; }); return v; };
    const onKey = (ev: KeyboardEvent) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); td.blur(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); td.blur(); return; }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        const el = slide?.elements.find((x) => x.id === cellEdit.id);
        if (el?.type !== 'table') return;
        const cols = el.rows[0].length, idx = cellEdit.r * cols + cellEdit.c + (ev.shiftKey ? -1 : 1);
        td.removeEventListener('blur', onBlur);
        commitCell();
        if (idx < 0 || idx >= el.rows.length * cols) { setCellEdit(null); return; }
        setCellEdit({ id: cellEdit.id, r: Math.floor(idx / cols), c: idx % cols });
      }
    };
    const onBlur = () => { commitCell(); td.contentEditable = 'false'; setCellEdit((c) => (c === cellEdit ? null : c)); };
    td.addEventListener('keydown', onKey);
    td.addEventListener('blur', onBlur);
    return () => { td.removeEventListener('keydown', onKey); td.removeEventListener('blur', onBlur); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellEdit, deck]);

  const onContextMenu = (e: ReactMouseEvent): void => {
    if (!slide) return;
    e.preventDefault();
    const pt = toSlide(e);
    const hit = hitTest(slide, pt.x, pt.y, 6 / zoom);
    if (hit && !sel.includes(hit.id)) setSel(groupMembers(slide, hit).map((x) => x.id));
    const any = !!hit || sel.length > 0;
    const entries: MenuEntry[] = any ? [
      { label: 'Cut', keys: 'Ctrl+X', cmd: 'cut' }, { label: 'Copy', keys: 'Ctrl+C', cmd: 'copy' }, { label: 'Paste', keys: 'Ctrl+V', cmd: 'paste' }, { label: 'Duplicate', keys: 'Ctrl+D', cmd: 'dup' }, { label: 'Delete', keys: 'Delete', cmd: 'delete' },
      { separator: true },
      { label: 'Order', sub: [{ label: 'Bring to front', cmd: 'z:front' }, { label: 'Bring forward', cmd: 'z:forward' }, { label: 'Send backward', cmd: 'z:backward' }, { label: 'Send to back', cmd: 'z:back' }] },
      { label: 'Group', keys: 'Ctrl+Alt+G', cmd: 'group' }, { label: 'Ungroup', keys: 'Ctrl+Alt+Shift+G', cmd: 'ungroup' }, { label: 'Lock / unlock', cmd: 'lock' },
      { separator: true },
      { label: 'Format options', cmd: 'panel:format' }, { label: 'Animate', cmd: 'panel:motion' }, { label: 'Comment', keys: 'Ctrl+Alt+M', cmd: 'comment' },
    ] : [
      { label: 'Paste', keys: 'Ctrl+V', cmd: 'paste' }, { separator: true }, { label: 'Change background', cmd: 'panel:format' }, { label: 'Apply layout', sub: LAYOUTS.map((l) => ({ label: l.label, cmd: `layout:${l.id}` })) },
      { label: 'Change theme', cmd: 'panel:theme' }, { label: 'Change transition', cmd: 'panel:motion' }, { separator: true }, { label: 'Comment', keys: 'Ctrl+Alt+M', cmd: 'comment' },
    ];
    setCtx({ entries, x: e.clientX, y: e.clientY });
  };
  const slideContext = (e: ReactMouseEvent, id: string): void => {
    e.preventDefault();
    if (!slideSel.includes(id)) goSlide(id);
    setFocusArea('filmstrip');
    setCtx({ x: e.clientX, y: e.clientY, entries: [
      { label: 'New slide', keys: 'Ctrl+M', cmd: 'slide:new' }, { label: 'Duplicate slide', cmd: 'slide:dup' }, { label: 'Delete slide', cmd: 'slide:delete' }, { label: 'Skip slide', cmd: 'slide:skip' },
      { separator: true }, { label: 'Move slide up', cmd: 'slide:up' }, { label: 'Move slide down', cmd: 'slide:down' },
      { separator: true }, { label: 'Change background', cmd: 'panel:format' }, { label: 'Apply layout', sub: LAYOUTS.map((l) => ({ label: l.label, cmd: `layout:${l.id}` })) }, { label: 'Change transition', cmd: 'panel:motion' },
    ] });
  };

  /* ---------- filmstrip drag and drop ---------- */

  const onThumbDragStart = (e: ReactDragEvent, id: string): void => { const ids = slideSel.includes(id) ? slideSel : [id]; dragSlide.current = ids; e.dataTransfer.setData('text/plain', ids.join(',')); e.dataTransfer.effectAllowed = 'move'; };
  const onThumbDragOver = (e: ReactDragEvent, index: number): void => {
    if (!dragSlide.current) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = grid ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    setDropAt(index + (after ? 1 : 0));
  };
  const onThumbDrop = (e: ReactDragEvent): void => {
    e.preventDefault();
    const ids = dragSlide.current, at = dropAt;
    dragSlide.current = null; setDropAt(null);
    if (!ids || at === null) return;
    exec('Move slides', (d) => { moveSlides(d, ids, at); });
  };

  /* ---------- presenting ---------- */

  const startPresent = (fromStart = false, presenter = false): void => {
    stopEditing();
    void saveNow();
    if (!deckRef.current?.slides.length) { notify('Add a slide first', 'error'); return; }
    setPresent({ start: fromStart ? 0 : Math.max(0, slideNo - 1), presenter });
  };

  /* ---------- commands ---------- */

  const runCmd = (c: string): void => {
    setMenu(null); setSubOpen(null); setCtx(null);
    const [head, arg] = c.split(':');
    switch (head) {
      case 'new': setDialog({ kind: 'new' }); break;
      case 'copyDeck': void copyDeck(); break;
      case 'importMd': fileInput.current?.click(); break;
      case 'pasteMd': setDialog({ kind: 'markdown' }); break;
      case 'page': setDialog({ kind: 'page' }); break;
      case 'export': void exportAs(arg as 'pptx'); break;
      case 'deleteDeck': if (current) { setConfirmDelete(current); setFilesOpen(true); } break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'cut': copySel(true); break;
      case 'copy': copySel(); break;
      case 'paste': if (!paste()) notify('Nothing to paste — copy objects or slides first', 'error'); break;
      case 'dup': if (sel.length) duplicateSel(); else duplicateSlides(); break;
      case 'delete': if (sel.length) deleteSel(); else deleteSlides(); break;
      case 'selectAll': if (slide) setSel(slide.elements.map((e) => e.id)); break;
      case 'find': setDialog({ kind: 'find', replace: arg === 'replace' }); break;
      case 'present': startPresent(arg === 'start', arg === 'presenter'); break;
      case 'grid': setGrid((g) => !g); break;
      case 'notes': setShowNotes((v) => !v); break;
      case 'snap': setSnap((v) => !v); break;
      case 'zoom': setZoomSetting(arg === 'fit' ? 'fit' : arg === 'in' ? Math.min(3, zoom * 1.25) : arg === 'out' ? Math.max(0.1, zoom / 1.25) : Number(arg)); break;
      case 'panel': setPanel((p) => (p === arg ? null : arg as PanelKind)); break;
      case 'comment': setPanel('comments'); setCommentDraft(true); break;
      case 'insert':
        if (arg === 'text') setInsert({ kind: 'text' });
        else if (arg === 'image') pickImage('insert');
        else if (arg === 'line') setInsert({ kind: 'line', arrow: false });
        else if (arg === 'arrow') setInsert({ kind: 'line', arrow: true });
        else if (arg === 'video' || arg === 'link') insertEmbed(arg);
        else if (arg === 'table') setTool('Table');
        else if (arg === 'icon') setTool('Icon');
        break;
      case 'shape': insertShape(arg as ShapeKind); break;
      case 'chart': insertChart(arg as ChartEl['chart']); break;
      case 'mark': toggleMark(arg as 'b'); break;
      case 'sup': case 'sub': if (editing) cmd(head === 'sup' ? 'superscript' : 'subscript'); else boxFormat('Format', { [head]: true }); break;
      case 'size': bumpSize(arg === 'up' ? 1 : -1); break;
      case 'align': paraFormat('Align', { align: arg as 'left' }); break;
      case 'lh': paraFormat('Line spacing', { lh: Number(arg) }); break;
      case 'list': paraFormat('List', { list: arg === 'none' ? null : arg as 'bullet' }); break;
      case 'indent': paraFormat('Indent', { indent: Number(arg) }); break;
      case 'clear': clearFormatting(); break;
      case 'link': insertLinkCmd(); break;
      case 'slide':
        if (arg === 'new') newSlide(); else if (arg === 'dup') duplicateSlides(); else if (arg === 'delete') deleteSlides(); else if (arg === 'skip') skipSlides();
        else if (arg === 'up') moveSlideBy(-1); else if (arg === 'down') moveSlideBy(1); else if (arg === 'start') moveSlideBy('start'); else if (arg === 'end') moveSlideBy('end');
        break;
      case 'newLayout': newSlide(arg as LayoutId); break;
      case 'layout': if (slide) { const ids = targetSlides(); exec('Apply layout', (d) => { for (const id of ids) { const s = d.slides.find((x) => x.id === id); if (s) relayout(d, s, arg as LayoutId); } }); } break;
      case 'theme': setDialog({ kind: 'theme' }); break;
      case 'z': arrange(arg as ZOrder); break;
      case 'alignEl': align(arg as AlignTo); break;
      case 'distribute': distribute(arg as 'h'); break;
      case 'centerPage': centerOnPage(arg as 'h'); break;
      case 'rotate': rotateBy(Number(arg)); break;
      case 'group': group(); break;
      case 'ungroup': ungroup(); break;
      case 'lock': toggleLock(); break;
      case 'review': setDialog({ kind: 'review' }); break;
      case 'stats': setDialog({ kind: 'stats' }); break;
      case 'limits': setDialog({ kind: 'limits' }); break;
      case 'help': setHelpOpen(true); break;
    }
  };
  const has = sel.length > 0;
  const menuDefs: Record<string, MenuEntry[]> = {
    File: [
      { label: 'New presentation', cmd: 'new' }, { label: 'Make a copy', cmd: 'copyDeck' }, { separator: true },
      { label: 'Import Markdown file…', cmd: 'importMd' }, { label: 'Import Markdown outline…', cmd: 'pasteMd' }, { separator: true },
      { label: 'Page setup', cmd: 'page' },
      { label: 'Download', sub: [{ label: 'Microsoft PowerPoint (.pptx)', cmd: 'export:pptx' }, { label: 'PDF document (.pdf)', cmd: 'export:pdf' }, { label: 'PNG image (current slide)', cmd: 'export:png' }, { label: 'PNG images (every slide)', cmd: 'export:png-all' }, { label: 'Web presentation (.html)', cmd: 'export:html' }, { label: 'Markdown outline (.md)', cmd: 'export:md' }, { label: 'Plain text outline (.txt)', cmd: 'export:txt' }] },
      { separator: true }, { label: 'Delete presentation', cmd: 'deleteDeck' },
    ],
    Edit: [
      { label: 'Undo', keys: 'Ctrl+Z', cmd: 'undo', disabled: hist.undo === 0 }, { label: 'Redo', keys: 'Ctrl+Y', cmd: 'redo', disabled: hist.redo === 0 }, { separator: true },
      { label: 'Cut', keys: 'Ctrl+X', cmd: 'cut' }, { label: 'Copy', keys: 'Ctrl+C', cmd: 'copy' }, { label: 'Paste', keys: 'Ctrl+V', cmd: 'paste' }, { label: 'Duplicate', keys: 'Ctrl+D', cmd: 'dup' }, { label: 'Delete', keys: 'Delete', cmd: 'delete' },
      { separator: true }, { label: 'Select all', keys: 'Ctrl+A', cmd: 'selectAll' }, { separator: true }, { label: 'Find', keys: 'Ctrl+F', cmd: 'find' }, { label: 'Find and replace', keys: 'Ctrl+H', cmd: 'find:replace' },
    ],
    View: [
      { label: 'Present', keys: 'Ctrl+F5', cmd: 'present' }, { label: 'Present from beginning', keys: 'Ctrl+Shift+F5', cmd: 'present:start' }, { label: 'Presenter view', cmd: 'present:presenter' }, { separator: true },
      { label: 'Grid view', keys: 'Ctrl+Alt+1', cmd: 'grid', checked: grid }, { label: 'Show speaker notes', keys: 'Ctrl+Alt+Shift+S', cmd: 'notes', checked: showNotes }, { label: 'Snap to guides', cmd: 'snap', checked: snap },
      { separator: true }, { label: 'Zoom in', cmd: 'zoom:in' }, { label: 'Zoom out', cmd: 'zoom:out' }, { label: 'Fit', cmd: 'zoom:fit' }, { separator: true }, { label: 'Comments', cmd: 'panel:comments', checked: panel === 'comments' },
    ],
    Insert: [
      { label: 'Text box', cmd: 'insert:text' }, { label: 'Image…', cmd: 'insert:image' },
      { label: 'Shape', sub: SHAPES.map((s) => ({ label: s.label, cmd: `shape:${s.id}` })) },
      { label: 'Line', cmd: 'insert:line' }, { label: 'Arrow', cmd: 'insert:arrow' },
      { label: 'Table', cmd: 'insert:table' },
      { label: 'Chart', sub: [{ label: 'Column', cmd: 'chart:column' }, { label: 'Bar', cmd: 'chart:bar' }, { label: 'Line', cmd: 'chart:line' }, { label: 'Pie', cmd: 'chart:pie' }, { label: 'Doughnut', cmd: 'chart:doughnut' }] },
      { label: 'Icon', cmd: 'insert:icon' }, { label: 'Video…', cmd: 'insert:video' }, { label: 'Link…', keys: 'Ctrl+K', cmd: 'link' }, { separator: true },
      { label: 'Comment', keys: 'Ctrl+Alt+M', cmd: 'comment' }, { label: 'New slide', keys: 'Ctrl+M', cmd: 'slide:new' },
    ],
    Format: [
      { label: 'Text', sub: [{ label: 'Bold', keys: 'Ctrl+B', cmd: 'mark:b' }, { label: 'Italic', keys: 'Ctrl+I', cmd: 'mark:i' }, { label: 'Underline', keys: 'Ctrl+U', cmd: 'mark:u' }, { label: 'Strikethrough', keys: 'Alt+Shift+5', cmd: 'mark:s' }, { label: 'Superscript', cmd: 'sup' }, { label: 'Subscript', cmd: 'sub' }, { separator: true }, { label: 'Increase font size', keys: 'Ctrl+Shift+>', cmd: 'size:up' }, { label: 'Decrease font size', keys: 'Ctrl+Shift+<', cmd: 'size:down' }] },
      { label: 'Align and indent', sub: [{ label: 'Left', keys: 'Ctrl+Shift+L', cmd: 'align:left' }, { label: 'Centre', keys: 'Ctrl+Shift+E', cmd: 'align:center' }, { label: 'Right', keys: 'Ctrl+Shift+R', cmd: 'align:right' }, { label: 'Justified', keys: 'Ctrl+Shift+J', cmd: 'align:justify' }, { separator: true }, { label: 'Increase indent', cmd: 'indent:1' }, { label: 'Decrease indent', cmd: 'indent:-1' }] },
      { label: 'Line spacing', sub: [1, 1.15, 1.5, 2].map((n) => ({ label: n === 1 ? 'Single' : n === 2 ? 'Double' : String(n), cmd: `lh:${n}` })) },
      { label: 'Bullets and numbering', sub: [{ label: 'Bulleted list', keys: 'Ctrl+Shift+8', cmd: 'list:bullet' }, { label: 'Numbered list', keys: 'Ctrl+Shift+7', cmd: 'list:number' }, { label: 'No list', cmd: 'list:none' }] },
      { separator: true }, { label: 'Clear formatting', keys: 'Ctrl+\\', cmd: 'clear' }, { label: 'Format options', cmd: 'panel:format' },
    ],
    Slide: [
      { label: 'New slide', keys: 'Ctrl+M', cmd: 'slide:new' }, { label: 'Duplicate slide', cmd: 'slide:dup' }, { label: 'Delete slide', cmd: 'slide:delete' }, { label: 'Skip slide', cmd: 'slide:skip', checked: !!slide?.hidden },
      { separator: true },
      { label: 'Move slide', sub: [{ label: 'Up', cmd: 'slide:up' }, { label: 'Down', cmd: 'slide:down' }, { label: 'To beginning', cmd: 'slide:start' }, { label: 'To end', cmd: 'slide:end' }] },
      { separator: true },
      { label: 'Change background', cmd: 'panel:format' }, { label: 'Apply layout', sub: LAYOUTS.map((l) => ({ label: l.label, cmd: `layout:${l.id}`, checked: slide?.layout === l.id })) },
      { label: 'Transition', cmd: 'panel:motion' }, { separator: true }, { label: 'Change theme', cmd: 'panel:theme' }, { label: 'Edit theme', cmd: 'theme' },
    ],
    Arrange: [
      { label: 'Order', disabled: !has, sub: [{ label: 'Bring to front', keys: 'Ctrl+Shift+↑', cmd: 'z:front' }, { label: 'Bring forward', keys: 'Ctrl+↑', cmd: 'z:forward' }, { label: 'Send backward', keys: 'Ctrl+↓', cmd: 'z:backward' }, { label: 'Send to back', keys: 'Ctrl+Shift+↓', cmd: 'z:back' }] },
      { label: 'Align', disabled: !has, sub: [{ label: 'Left', cmd: 'alignEl:left' }, { label: 'Centre', cmd: 'alignEl:center' }, { label: 'Right', cmd: 'alignEl:right' }, { separator: true }, { label: 'Top', cmd: 'alignEl:top' }, { label: 'Middle', cmd: 'alignEl:middle' }, { label: 'Bottom', cmd: 'alignEl:bottom' }] },
      { label: 'Distribute', disabled: sel.length < 3, sub: [{ label: 'Horizontally', cmd: 'distribute:h' }, { label: 'Vertically', cmd: 'distribute:v' }] },
      { label: 'Centre on page', disabled: !has, sub: [{ label: 'Horizontally', cmd: 'centerPage:h' }, { label: 'Vertically', cmd: 'centerPage:v' }] },
      { label: 'Rotate', disabled: !has, sub: [{ label: 'Rotate clockwise 90°', cmd: 'rotate:90' }, { label: 'Rotate counter-clockwise 90°', cmd: 'rotate:-90' }] },
      { separator: true }, { label: 'Group', keys: 'Ctrl+Alt+G', cmd: 'group', disabled: sel.length < 2 }, { label: 'Ungroup', keys: 'Ctrl+Alt+Shift+G', cmd: 'ungroup', disabled: !selEls.some((e) => e.group) },
      { label: selEls.length && selEls.every((e) => e.locked) ? 'Unlock' : 'Lock', cmd: 'lock', disabled: !has },
    ],
    Tools: [
      { label: 'Review presentation', cmd: 'review' }, { label: 'Word count and stats', cmd: 'stats' }, { label: 'Keyboard shortcuts', keys: 'Ctrl+/', cmd: 'help' }, { separator: true }, { label: 'What Slides cannot do yet', cmd: 'limits' },
    ],
  };

  /* ---------- keyboard ---------- */

  const onKeyDown = (e: KeyboardEvent): void => {
    if (present || dialog || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    // Shortcuts work while focus is in the editor, or nowhere in particular (after a panel or the notes lost focus).
    if (!mainRef.current || !(mainRef.current.contains(t) || t === document.body || t === document.documentElement)) return;
    const inEdit = !!flowRef.current && flowRef.current.contains(t);
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (inEdit) {
      if (k === 'Escape') { e.preventDefault(); const id = editRef.current?.id; stopEditing(); if (id) setSel([id]); mainRef.current?.focus({ preventScroll: true }); return; }
      if (k === 'Tab') { e.preventDefault(); paraFormat('Indent', { indent: e.shiftKey ? -1 : 1 }); return; }
      if (ctrl && e.shiftKey && (k === '>' || k === '.')) { e.preventDefault(); bumpSize(1); return; }
      if (ctrl && e.shiftKey && (k === '<' || k === ',')) { e.preventDefault(); bumpSize(-1); return; }
      if (ctrl && e.shiftKey && /^[lerj]$/i.test(k)) { e.preventDefault(); paraFormat('Align', { align: ({ l: 'left', e: 'center', r: 'right', j: 'justify' } as const)[k.toLowerCase() as 'l'] }); return; }
      if (ctrl && e.shiftKey && (k === '7' || k === '&' || e.code === 'Digit7')) { e.preventDefault(); paraFormat('List', { list: 'number' }); return; }
      if (ctrl && e.shiftKey && (k === '8' || k === '*' || e.code === 'Digit8')) { e.preventDefault(); paraFormat('List', { list: 'bullet' }); return; }
      if (e.altKey && e.shiftKey && (k === '5' || e.code === 'Digit5')) { e.preventDefault(); cmd('strikeThrough'); return; }
      if (ctrl && k === '\\') { e.preventDefault(); clearFormatting(); return; }
      if (ctrl && k.toLowerCase() === 'k') { e.preventDefault(); insertLinkCmd(); return; }
      if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); void saveNow(); return; }
      // Everything else is the browser's own text editing (Ctrl+B/I/U, Ctrl+Z…): keep the app's shortcuts out of it.
      if (ctrl) e.stopPropagation();
      return;
    }
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const film = focusArea === 'filmstrip';
    const lower = k.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (ctrl && e.altKey && e.shiftKey && lower === 's') { stop(); setShowNotes((v) => !v); return; }
    if (ctrl && e.altKey && e.shiftKey && lower === 'g') { stop(); ungroup(); return; }
    if (ctrl && e.altKey && lower === 'g') { stop(); group(); return; }
    if (ctrl && e.altKey && lower === 'm') { stop(); runCmd('comment'); return; }
    if (ctrl && e.altKey && (k === '1' || e.code === 'Digit1')) { stop(); setGrid((g) => !g); return; }
    if (k === 'F5' && ctrl) { stop(); startPresent(e.shiftKey); return; }
    if (ctrl && k === 'Enter') { stop(); startPresent(e.shiftKey); return; }
    if (ctrl && lower === 'm') { stop(); newSlide(); return; }
    if (ctrl && lower === 'd') { stop(); if (sel.length && !film) duplicateSel(); else duplicateSlides(); return; }
    if (ctrl && lower === 'z') { stop(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && lower === 'y') { stop(); redo(); return; }
    if (ctrl && lower === 'c') { stop(); copySel(); return; }
    if (ctrl && lower === 'x') { stop(); copySel(true); return; }
    if (ctrl && lower === 'v') { if (clipboard.current) { stop(); paste(); } return; }
    if (ctrl && lower === 'a') { stop(); if (film && deck) setSlideSel(deck.slides.map((s) => s.id)); else if (slide) setSel(slide.elements.map((x) => x.id)); return; }
    if (ctrl && lower === 'f') { stop(); setDialog({ kind: 'find', replace: false }); return; }
    if (ctrl && lower === 'h') { stop(); setDialog({ kind: 'find', replace: true }); return; }
    if (ctrl && lower === 'k' && sel.length) { stop(); insertLinkCmd(); return; }
    if (ctrl && lower === 's') { stop(); void saveNow(); notify('Saved', 'success'); return; }
    if (ctrl && (k === '/' || k === '?')) { stop(); setHelpOpen(true); return; }
    if (ctrl && !e.shiftKey && textSel.length && (lower === 'b' || lower === 'i' || lower === 'u')) { stop(); toggleMark(lower as 'b'); return; }
    if (e.altKey && e.shiftKey && (k === '5' || e.code === 'Digit5')) { stop(); toggleMark('s'); return; }
    if (ctrl && e.shiftKey && (k === '>' || k === '.')) { stop(); bumpSize(1); return; }
    if (ctrl && e.shiftKey && (k === '<' || k === ',')) { stop(); bumpSize(-1); return; }
    if (ctrl && e.shiftKey && /^[lerj]$/.test(lower)) { stop(); paraFormat('Align', { align: ({ l: 'left', e: 'center', r: 'right', j: 'justify' } as const)[lower as 'l'] }); return; }
    if (ctrl && e.shiftKey && e.code === 'Digit7') { stop(); paraFormat('List', { list: 'number' }); return; }
    if (ctrl && e.shiftKey && e.code === 'Digit8') { stop(); paraFormat('List', { list: 'bullet' }); return; }
    if (ctrl && k === '\\') { stop(); clearFormatting(); return; }
    if (ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) {
      stop();
      if (film || !sel.length) { if (e.shiftKey) moveSlideBy(k === 'ArrowUp' ? 'start' : 'end'); else moveSlideBy(k === 'ArrowUp' ? -1 : 1); }
      else arrange(k === 'ArrowUp' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward'));
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { stop(); if (!film && sel.length) deleteSel(); else deleteSlides(); return; }
    if (k === 'Escape') { if (insert) setInsert(null); else if (painting) { paintRef.current = null; setPainting(false); } else setSel([]); setCtx(null); return; }
    if (k === 'PageDown' || k === 'PageUp' || (film && (k === 'ArrowDown' || k === 'ArrowUp' || (grid && (k === 'ArrowLeft' || k === 'ArrowRight'))))) {
      stop();
      if (!deck || !slide) return;
      const i = deck.slides.indexOf(slide) + (k === 'PageDown' || k === 'ArrowDown' || k === 'ArrowRight' ? 1 : -1);
      const s = deck.slides[Math.max(0, Math.min(deck.slides.length - 1, i))];
      if (s) goSlide(s.id, e.shiftKey ? 'range' : 'none');
      return;
    }
    if (!film && sel.length && k.startsWith('Arrow')) { stop(); const step = e.shiftKey ? 1 : 4; nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0); return; }
    if (!film && k === 'Enter' && selEls.length === 1 && hasText(selEls[0])) { stop(); startEditing(selEls[0]); return; }
    if (!film && k === 'Tab' && slide && slide.elements.length) {
      stop();
      const i = sel.length ? slide.elements.findIndex((x) => x.id === sel[sel.length - 1]) : -1;
      const n = (i + (e.shiftKey ? -1 : 1) + slide.elements.length) % slide.elements.length;
      setSel([slide.elements[n].id]);
    }
  };
  const onPaste = async (e: ClipboardEvent): Promise<void> => {
    const target = e.target as HTMLElement;
    if (present || dialog || !e.clipboardData || !mainRef.current || !(mainRef.current.contains(target) || target === document.body)) return;
    if (flowRef.current?.contains(target)) {
      // Plain text into the edited box keeps the look of the slide.
      const text = e.clipboardData.getData('text/plain');
      e.preventDefault();
      document.execCommand('insertText', false, text);
      return;
    }
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); await insertImageFile(file); return; }
    const text = e.clipboardData.getData('text/plain');
    if (text && slide) { e.preventDefault(); addElement((d) => ({ id: newId(d, 'e'), type: 'text', ...center(500, 120), paras: text.split(/\r?\n/).map((l) => ({ runs: l ? [{ t: l }] : [] })), autofit: 'shrink' } as TextEl), 'Paste text'); }
  };

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const pasteRef = useRef<(e: ClipboardEvent) => void>(() => undefined);
  useEffect(() => { keyRef.current = onKeyDown; pasteRef.current = (e) => { void onPaste(e); }; });
  useEffect(() => {
    const onPasteEvent = (e: ClipboardEvent) => pasteRef.current(e);
    document.addEventListener('paste', onPasteEvent);
    return () => document.removeEventListener('paste', onPasteEvent);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    // On the document, so Slides' shortcuts win over the app-wide ones on window (Ctrl+B side bar, Ctrl+1 menus…).
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- rendering ---------- */

  const editingEl = editing && slide ? slide.elements.find((e) => e.id === editing.id) ?? null : null;
  const canvasHtml = useMemo(() => (deck && slide ? slideHtml(deck, slide, { editor: true, skip: editing ? new Set([editing.id]) : undefined }) : ''), [deck, slide, editing]);
  const grouped = useMemo(() => {
    const m = new Map<string, OwnedRef[]>();
    for (const r of refs) m.set(r.owner || '(shared)', [...(m.get(r.owner || '(shared)') ?? []), r]);
    return [...m.entries()];
  }, [refs]);
  const saveState = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  const toolPopup = (name: string, body: ReactNode, wide = false) => (tool === name ? <div className={`dc__popup dc-toolpop${wide ? ' sl-toolpop--wide' : ''}`} role="menu" aria-label={name} onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault(); }}>{body}</div> : null);
  const palette = (hl: boolean) => <Palette hl={hl} theme={deck?.theme ?? null} themeHex={!!editing} onPick={setColor} />;
  const single = selEls.length === 1 ? selEls[0] : null;
  const k = 1 / zoom;
  const stats = deck ? deckStats(deck) : null;

  const editOverlay = (() => {
    if (!deck || !slide || !editingEl || !hasText(editingEl)) return null;
    const look = roleLook(deck.theme, editingEl.type === 'text' ? editingEl.role : undefined, slide.layout);
    const scale = editingEl.type === 'text' ? shrinkScale(editingEl, look) : 1;
    const geom = editingEl.type === 'shape' ? elementInner(deck, slide, { ...editingEl, paras: [para()] }) : '';
    const boxSt: CSSProperties = { padding: boxPad(editingEl) };
    if (editingEl.type === 'text' && editingEl.fill) boxSt.background = editingEl.fill.startsWith('$') ? deck.theme.colors[editingEl.fill.slice(1) as 'accent'] : editingEl.fill;
    return (
      <div className="sld-el sl-edit" style={cssToStyle(elementStyle(editingEl))} data-testid="text-editor-box">
        {geom && <div className="sl-edit__geom" dangerouslySetInnerHTML={{ __html: geom }} />}
        <div className={`sld-box sld-v-${editingEl.valign ?? (editingEl.type === 'shape' ? 'middle' : 'top')}`} style={boxSt}>
          <div key={editingEl.id} ref={flowCallback} className="sld-flow sl-flow" role="textbox" aria-multiline="true" aria-label="Edit text" data-testid="slide-text-editor" contentEditable suppressContentEditableWarning spellCheck
            style={{ ...cssToStyle(flowStyle(deck, slide, editingEl)), ...(scale < 1 ? { zoom: scale } : {}) }} />
        </div>
      </div>
    );
  })();

  return (
    <div className="screen sl">
      <style>{SLIDE_CSS}</style>
      <header className="screen-header">
        <h1 className="screen-header__title">Slides</h1>
        <span className="screen-header__meta">Google Slides-style presentations — the Presenter agent works on the same files</span>
        {current && <span className={`dc__save dc__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="dc__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => { setFilesOpen((o) => !o); setConfirmDelete(null); }}>
            <Presentation size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Presentations'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="dc__popup dc__popup--list" role="menu" aria-label="Presentations">
              {refs.length === 0 && <p className="dc-note dc-pad">No presentations yet — create one, or ask the Presenter agent.</p>}
              {grouped.map(([owner, items]) => (
                <div key={owner}>
                  <div className="dc__owner">{owner}</div>
                  {items.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`dc__file${key === current ? ' dc__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="dc__file-main" title={slidesPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openDeckFile(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="dc-icon dc-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteFile(key)}><Check size={12} /></button>
                            <button type="button" className="dc-icon" aria-label="Keep presentation" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="dc-icon dc__file-del" aria-label={`Delete ${ref.slug}`} title="Delete presentation" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New presentation</button>
      </header>

      <div className="screen-body sl__body">
        <div ref={mainRef} className="sl__main" tabIndex={-1}
          onPointerDown={(e) => { const t = e.target as HTMLElement; if (!t.closest('.dc__menu, .dc-toolwrap, .dc__popup')) { if (menu) setMenu(null); if (tool) setTool(null); } if (ctx && !t.closest('.dc-ctx')) setCtx(null); }}>
          {deck ? (
            <>
              <div className="dc__titlerow">
                <Presentation size={22} className="sl__logo" strokeWidth={1.5} />
                <input className="dc__title" aria-label="Presentation title" defaultValue={deck.title} key={`${current}:${deck.title}`} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== deck.title) exec('Rename', (d) => { d.title = v; }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
                <span className="dc-grow" />
                <button type="button" className={`dc-tb${panel === 'comments' ? ' dc-tb--on' : ''}`} aria-label="Comments" title="Comments" onClick={() => runCmd('panel:comments')}><MessageSquarePlus size={16} /></button>
                <div className="dc-toolwrap sl-present-btn">
                  <button type="button" className="primary-button" onClick={() => startPresent()}><Play size={12} /> Present</button>
                  <button type="button" className="primary-button sl-present-btn__more" aria-label="Presentation options" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Present' ? null : 'Present')}><ChevronDown size={12} /></button>
                  {tool === 'Present' && (
                    <div className="dc__popup dc-toolpop dc-toolpop--right" role="menu" aria-label="Present options">
                      <button type="button" role="menuitem" onClick={() => { setTool(null); startPresent(false, true); }}><span>Presenter view</span></button>
                      <button type="button" role="menuitem" onClick={() => { setTool(null); startPresent(true); }}><span>Present from beginning</span><kbd>Ctrl+Shift+F5</kbd></button>
                    </div>
                  )}
                </div>
              </div>
              <nav className="dc__menubar" aria-label="Slides menu">
                {MENU_NAMES.map((name) => ({ name, entries: menuDefs[name] })).map(({ name, entries }) => (
                  <div key={name} className="dc__menu">
                    <button type="button" className={`dc__menu-btn${menu === name ? ' dc__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMenu(menu === name ? null : name); setSubOpen(null); }} onMouseEnter={() => { if (menu) { setMenu(name); setSubOpen(null); } }}>{name}</button>
                    {menu === name && <MenuPopup entries={entries} label={name} subOpen={subOpen} setSubOpen={setSubOpen} onCommand={runCmd} onClose={() => { setMenu(null); setSubOpen(null); }} />}
                  </div>
                ))}
                <span className="dc-grow" />
                <TB label="Keyboard shortcuts" icon={<Keyboard size={15} />} onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (Ctrl+/)" />
              </nav>
              <div className="dc__toolbar sl__toolbar" role="toolbar" aria-label="Slides toolbar">
                <div className="dc-toolwrap sl-split">
                  <TB label="New slide" icon={<Plus size={15} />} onClick={() => newSlide()} title="New slide (Ctrl+M)" />
                  <button type="button" className="dc-tb sl-split__more" aria-label="New slide with layout" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Layouts' ? null : 'Layouts')}><ChevronDown size={11} /></button>
                  {toolPopup('Layouts', <>{LAYOUTS.map((l) => <button key={l.id} type="button" role="menuitem" onClick={() => { setTool(null); newSlide(l.id); }}><span>{l.label}</span></button>)}</>)}
                </div>
                <TB label="Undo" icon={<Undo2 size={15} />} onClick={undo} disabled={hist.undo === 0} title="Undo (Ctrl+Z)" />
                <TB label="Redo" icon={<Redo2 size={15} />} onClick={redo} disabled={hist.redo === 0} title="Redo (Ctrl+Y)" />
                <TB label="Paint format" icon={<Paintbrush size={15} />} on={painting} onClick={startPaint} />
                <select className="dc-tbselect" aria-label="Zoom" value={zoomSetting === 'fit' ? 'fit' : String(zoomSetting)} onChange={(e) => setZoomSetting(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}>
                  <option value="fit">Fit</option>{ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
                </select>
                <span className="dc-sep" />
                <TB label="Select" icon={<MousePointer2 size={15} />} on={!insert} onClick={() => setInsert(null)} />
                <TB label="Text box" icon={<Type size={15} />} on={insert?.kind === 'text'} onClick={() => setInsert(insert?.kind === 'text' ? null : { kind: 'text' })} title="Text box: click or drag on the slide" />
                <TB label="Insert image" icon={<ImagePlus size={15} />} onClick={() => pickImage('insert')} />
                <div className="dc-toolwrap">
                  <TB label="Shape" icon={<Shapes size={15} />} on={insert?.kind === 'shape'} onClick={() => setTool(tool === 'Shape' ? null : 'Shape')} />
                  {toolPopup('Shape', <div className="sl-shapegrid">{SHAPES.map((s) => <button key={s.id} type="button" role="menuitem" aria-label={s.label} title={s.label} onClick={() => { setTool(null); setInsert({ kind: 'shape', shape: s.id }); }}><ShapeIcon kind={s.id} /></button>)}</div>, true)}
                </div>
                <div className="dc-toolwrap">
                  <TB label="Line" icon={<Slash size={15} />} on={insert?.kind === 'line'} onClick={() => setTool(tool === 'Line' ? null : 'Line')} />
                  {toolPopup('Line', <><button type="button" role="menuitem" onClick={() => { setTool(null); setInsert({ kind: 'line', arrow: false }); }}><span>Line</span></button><button type="button" role="menuitem" onClick={() => { setTool(null); setInsert({ kind: 'line', arrow: true }); }}><span>Arrow</span></button></>)}
                </div>
                <div className="dc-toolwrap">
                  <TB label="Insert table" icon={<span className="dc-tbtext">⊞</span>} onClick={() => setTool(tool === 'Table' ? null : 'Table')} />
                  {toolPopup('Table', <TableGrid onPick={(r, c) => { setTool(null); insertTable(r, c); }} />)}
                </div>
                <div className="dc-toolwrap">
                  <TB label="Insert chart" icon={<span className="dc-tbtext">▥</span>} onClick={() => setTool(tool === 'Chart' ? null : 'Chart')} />
                  {toolPopup('Chart', <>{(['column', 'bar', 'line', 'pie', 'doughnut'] as const).map((c) => <button key={c} type="button" role="menuitem" onClick={() => { setTool(null); insertChart(c); }}><span>{c[0].toUpperCase() + c.slice(1)} chart</span></button>)}</>)}
                </div>
                <div className="dc-toolwrap">
                  <TB label="Insert icon" icon={<Sparkles size={15} />} onClick={() => setTool(tool === 'Icon' ? null : 'Icon')} />
                  {toolPopup('Icon', <div className="sl-icongrid">{ICONS.map((g) => <button key={g} type="button" role="menuitem" aria-label={`Icon ${g}`} onClick={() => { setTool(null); insertIcon(g); }}>{g}</button>)}</div>, true)}
                </div>
                <TB label="Add comment" icon={<MessageSquarePlus size={15} />} onClick={() => runCmd('comment')} title="Comment (Ctrl+Alt+M)" />
                <span className="dc-sep" />
                {(editing || textSel.length > 0) && fmt ? (
                  <>
                    <div className="dc-toolwrap">
                      <button type="button" className="dc-tbdrop dc-tbdrop--font" aria-label="Font" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Font' ? null : 'Font')} style={{ fontFamily: fmt.font }}>{fmt.font}<ChevronDown size={11} /></button>
                      {toolPopup('Font', <>{FONTS.map((f) => <button key={f} type="button" role="menuitemradio" aria-checked={fmt.font === f} style={{ fontFamily: f }} onClick={() => setFont(f)}><span>{f}</span></button>)}</>)}
                    </div>
                    <TB label="Decrease font size" icon={<Minus size={13} />} onClick={() => bumpSize(-1)} />
                    <div className="dc-toolwrap">
                      <input className="dc-tbsize" aria-label="Font size" key={`${fmt.size}`} defaultValue={fmt.size} onMouseDown={(e) => { if (editing) e.preventDefault(); }} onFocus={(e) => { e.target.select(); setTool('Size'); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const n = Number((e.target as HTMLInputElement).value); if (n >= 1 && n <= 400) setSize(n); } if (e.key === 'Escape') setTool(null); }} />
                      {toolPopup('Size', <>{FONT_SIZES.map((n) => <button key={n} type="button" role="menuitem" onClick={() => setSize(n)}><span>{n}</span></button>)}</>)}
                    </div>
                    <TB label="Increase font size" icon={<Plus size={13} />} onClick={() => bumpSize(1)} />
                    <span className="dc-sep" />
                    <TB label="Bold" icon={<Bold size={15} />} on={fmt.b} onClick={() => toggleMark('b')} title="Bold (Ctrl+B)" />
                    <TB label="Italic" icon={<Italic size={15} />} on={fmt.i} onClick={() => toggleMark('i')} title="Italic (Ctrl+I)" />
                    <TB label="Underline" icon={<Underline size={15} />} on={fmt.u} onClick={() => toggleMark('u')} title="Underline (Ctrl+U)" />
                    <TB label="Strikethrough" icon={<Strikethrough size={15} />} on={fmt.s} onClick={() => toggleMark('s')} title="Strikethrough (Alt+Shift+5)" />
                    <div className="dc-toolwrap">
                      <TB label="Text colour" icon={<span className="dc-tbcolor"><Type size={14} /><i style={{ background: fmt.color.startsWith('$') && deck ? deck.theme.colors[fmt.color.slice(1) as 'accent'] : fmt.color }} /></span>} onClick={() => setTool(tool === 'Text colour' ? null : 'Text colour')} />
                      {toolPopup('Text colour', palette(false))}
                    </div>
                    <div className="dc-toolwrap">
                      <TB label="Highlight colour" icon={<span className="dc-tbcolor"><Highlighter size={14} /><i /></span>} onClick={() => setTool(tool === 'Highlight colour' ? null : 'Highlight colour')} />
                      {toolPopup('Highlight colour', palette(true))}
                    </div>
                    <span className="dc-sep" />
                    <TB label="Left align" icon={<AlignLeft size={15} />} on={fmt.align === 'left'} onClick={() => paraFormat('Align', { align: 'left' })} title="Left align (Ctrl+Shift+L)" />
                    <TB label="Center align" icon={<AlignCenter size={15} />} on={fmt.align === 'center'} onClick={() => paraFormat('Align', { align: 'center' })} title="Centre align (Ctrl+Shift+E)" />
                    <TB label="Right align" icon={<AlignRight size={15} />} on={fmt.align === 'right'} onClick={() => paraFormat('Align', { align: 'right' })} title="Right align (Ctrl+Shift+R)" />
                    <TB label="Justify" icon={<AlignJustify size={15} />} on={fmt.align === 'justify'} onClick={() => paraFormat('Align', { align: 'justify' })} title="Justify (Ctrl+Shift+J)" />
                    <div className="dc-toolwrap">
                      <TB label="Line spacing" icon={<span className="dc-tbtext">↕≡</span>} onClick={() => setTool(tool === 'Spacing' ? null : 'Spacing')} />
                      {toolPopup('Spacing', <>{[1, 1.15, 1.5, 2].map((lh) => <button key={lh} type="button" role="menuitem" onClick={() => paraFormat('Line spacing', { lh })}><span>{lh === 1 ? 'Single' : lh === 2 ? 'Double' : lh}</span></button>)}</>)}
                    </div>
                    <TB label="Bulleted list" icon={<List size={15} />} on={fmt.list === 'bullet'} onClick={() => paraFormat('List', { list: 'bullet' })} title="Bulleted list (Ctrl+Shift+8)" />
                    <TB label="Numbered list" icon={<ListOrdered size={15} />} on={fmt.list === 'number'} onClick={() => paraFormat('List', { list: 'number' })} title="Numbered list (Ctrl+Shift+7)" />
                    <TB label="Decrease indent" icon={<IndentDecrease size={15} />} onClick={() => paraFormat('Indent', { indent: -1 })} />
                    <TB label="Increase indent" icon={<IndentIncrease size={15} />} onClick={() => paraFormat('Indent', { indent: 1 })} />
                    <TB label="Clear formatting" icon={<Eraser size={15} />} onClick={clearFormatting} title="Clear formatting (Ctrl+\)" />
                    <span className="dc-sep" />
                    <button type="button" className="dc-btn sl-tbtext" onMouseDown={(e) => e.preventDefault()} onClick={() => runCmd('panel:format')}>Format options</button>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:motion')}>Animate</button>
                  </>
                ) : has ? (
                  <>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:format')}>Format options</button>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:motion')}>Animate</button>
                    {single?.type === 'chart' && <button type="button" className="dc-btn sl-tbtext" onClick={() => setDialog({ kind: 'chart', id: single.id })}>Edit data</button>}
                    {single?.type === 'image' && <button type="button" className="dc-btn sl-tbtext" onClick={() => pickImage('replace')}>Replace image</button>}
                    {selEls.some((e) => e.locked) && <span className="sl-locked"><Lock size={12} /> Locked</span>}
                  </>
                ) : (
                  <>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:format')}>Background</button>
                    <div className="dc-toolwrap">
                      <button type="button" className="dc-btn sl-tbtext" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Layout' ? null : 'Layout')}>Layout <ChevronDown size={11} /></button>
                      {toolPopup('Layout', <>{LAYOUTS.map((l) => <button key={l.id} type="button" role="menuitemradio" aria-checked={slide?.layout === l.id} onClick={() => { setTool(null); runCmd(`layout:${l.id}`); }}><span>{l.label}</span></button>)}</>)}
                    </div>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:theme')}>Theme</button>
                    <button type="button" className="dc-btn sl-tbtext" onClick={() => runCmd('panel:motion')}>Transition</button>
                  </>
                )}
                <span className="dc-grow" />
                <TB label="Grid view" icon={<LayoutGrid size={15} />} on={grid} onClick={() => setGrid((g) => !g)} title="Grid view (Ctrl+Alt+1)" />
              </div>
              <div className="sl__work">
                {!grid && (
                  <nav className="sl-film" aria-label="Slides" onFocus={() => setFocusArea('filmstrip')} onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropAt(null); }}>
                    {deck.slides.map((s, i) => (
                      <div key={s.id} className={`sl-film__item${s.id === slide?.id ? ' sl-film__item--on' : ''}${slideSel.includes(s.id) ? ' sl-film__item--sel' : ''}${s.hidden ? ' sl-film__item--hidden' : ''}${dropAt === i ? ' sl-film__item--drop' : ''}${dropAt === i + 1 && i === deck.slides.length - 1 ? ' sl-film__item--drop-after' : ''}`}
                        draggable onDragStart={(e) => onThumbDragStart(e, s.id)} onDragOver={(e) => onThumbDragOver(e, i)} onDrop={onThumbDrop} onDragEnd={() => { dragSlide.current = null; setDropAt(null); }}
                        onContextMenu={(e) => slideContext(e, s.id)} data-testid="slide-thumb">
                        <span className="sl-film__num">{i + 1}</span>
                        <button type="button" className="sl-film__btn" aria-label={`Slide ${i + 1}${slideTitle(s) ? `: ${slideTitle(s)}` : ''}${s.hidden ? ' (skipped)' : ''}`} aria-current={s.id === slide?.id ? 'true' : undefined}
                          onClick={(e) => { setFocusArea('filmstrip'); goSlide(s.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'none'); }}>
                          <SlideThumb deck={deck} slide={s} width={150} />
                          {s.hidden && <span className="sl-film__skip" title="Skipped in the presentation">⊘</span>}
                          {s.transition && <span className="sl-film__tr" title={`Transition: ${s.transition.type}`}>⟿</span>}
                          {s.comments.some((c) => !c.resolved) && <span className="sl-film__cm" title="Has comments">💬</span>}
                        </button>
                      </div>
                    ))}
                    <button type="button" className="sl-film__add" aria-label="Add slide" onClick={() => newSlide()}><Plus size={14} /></button>
                  </nav>
                )}
                <div className="sl-center">
                  {grid ? (
                    <div className="sl-grid" role="list" aria-label="Slide grid" onFocus={() => setFocusArea('filmstrip')}>
                      {deck.slides.map((s, i) => (
                        <div key={s.id} role="listitem" className={`sl-grid__item${s.id === slide?.id ? ' sl-grid__item--on' : ''}${slideSel.includes(s.id) ? ' sl-grid__item--sel' : ''}${s.hidden ? ' sl-film__item--hidden' : ''}${dropAt === i ? ' sl-grid__item--drop' : ''}`}
                          draggable onDragStart={(e) => onThumbDragStart(e, s.id)} onDragOver={(e) => onThumbDragOver(e, i)} onDrop={onThumbDrop} onContextMenu={(e) => slideContext(e, s.id)}>
                          <button type="button" className="sl-film__btn" aria-label={`Grid slide ${i + 1}`} onClick={(e) => { setFocusArea('filmstrip'); goSlide(s.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'none'); }} onDoubleClick={() => { goSlide(s.id); setGrid(false); }}>
                            <SlideThumb deck={deck} slide={s} width={220} />
                          </button>
                          <span className="sl-grid__label">{i + 1}. {slideTitle(s) || 'Untitled'}{s.hidden ? ' · skipped' : ''}</span>
                        </div>
                      ))}
                    </div>
                  ) : slide ? (
                    <>
                      <div className="sl-canvas" ref={canvasRef} onContextMenu={onContextMenu}>
                        <div className="sl-stagewrap" style={{ width: deck.size.w * zoom, height: deck.size.h * zoom }}>
                          <div ref={stageRef} className={`sl-stage${insert ? ' sl-stage--insert' : ''}`} data-testid="slide-canvas" aria-label={`Slide ${slideNo} canvas`}
                            style={{ width: deck.size.w, height: deck.size.h, transform: `scale(${zoom})`, ['--k' as string]: String(k) } as CSSProperties}
                            onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} onPointerCancel={onStageUp} onDoubleClick={onStageDoubleClick}>
                            <div className="sl-stage__slide" dangerouslySetInnerHTML={{ __html: canvasHtml }} />
                            {editOverlay}
                            {selEls.filter((e) => e.id !== editing?.id).map((e) => (
                              <div key={e.id} className={`sl-selbox${e.locked ? ' sl-selbox--locked' : ''}`} style={cssToStyle(elementStyle(e))} data-testid="selection-box" data-sel={e.id}>
                                {!e.locked && selEls.length === 1 && (e.type === 'line'
                                  ? (e.dir === 'up' ? ['sw', 'ne'] as Handle[] : ['nw', 'se'] as Handle[]).map((h) => <span key={h} className={`sl-handle sl-handle--${h}`} data-handle={h} style={{ cursor: 'move' }} />)
                                  : HANDLES.map((h) => <span key={h} className={`sl-handle sl-handle--${h}`} data-handle={h} aria-label={`Resize ${h}`} style={{ cursor: CURSOR[h] }} />))}
                                {!e.locked && selEls.length === 1 && e.type !== 'line' && <span className="sl-handle sl-handle--rot" data-handle="rot" aria-label="Rotate" />}
                                {e.locked && <span className="sl-lockbadge"><Lock size={10} /></span>}
                              </div>
                            ))}
                            {selEls.length > 1 && !editing && (() => { const u = unionBox(selEls.map(rotatedBounds)); return <div className="sl-selbox sl-selbox--group" style={{ left: u.x, top: u.y, width: u.w, height: u.h }}>{HANDLES.map((h) => <span key={h} className={`sl-handle sl-handle--${h}`} data-handle={h} style={{ cursor: CURSOR[h] }} />)}</div>; })()}
                            {guides.map((g, i) => <div key={i} className={`sl-guide sl-guide--${g.axis}`} data-testid="smart-guide" style={g.axis === 'x' ? { left: g.at, top: g.from, height: g.to - g.from } : { top: g.at, left: g.from, width: g.to - g.from }} />)}
                            {marquee && <div className={`sl-marquee${insert ? ' sl-marquee--insert' : ''}`} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
                          </div>
                        </div>
                        {insert && <div className="sl-insert-hint">Click or drag on the slide to add the {insert.kind === 'line' ? (insert.arrow ? 'arrow' : 'line') : insert.kind === 'text' ? 'text box' : 'shape'} · Esc to cancel</div>}
                      </div>
                      {showNotes && (
                        <div className="sl-notes">
                          <textarea aria-label="Speaker notes" placeholder="Click to add speaker notes" value={notesDraft && notesDraft.slide === slide.id ? notesDraft.text : slide.notes}
                            onChange={(e) => { const v = { slide: slide.id, text: e.target.value }; notesRef.current = v; setNotesDraft(v); }}
                            onBlur={() => syncPending()}
                            onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }} />
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="sl-noslide"><p>This presentation has no slides.</p><button type="button" className="primary-button" onClick={() => newSlide('title')}><Plus size={12} /> Add a slide</button></div>
                  )}
                </div>
                {panel && slide && (
                  panel === 'theme' ? <ThemePanel deck={deck} onApply={(id) => exec('Theme', (d) => { const t = THEME_BY_ID(id); if (t) d.theme = clone(t); })} onEdit={() => setDialog({ kind: 'theme' })} onClose={() => setPanel(null)} />
                    : panel === 'motion' ? <MotionPanel deck={deck} slide={slide} selected={selEls} edit={editSel} onPlay={() => startPresent()} onClose={() => setPanel(null)} />
                      : panel === 'format' ? <FormatPanel key={slide.id} deck={deck} slide={slide} selected={selEls} edit={editSel} onChartData={(id) => setDialog({ kind: 'chart', id })} onPickImage={(bg) => pickImage(bg ? 'background' : 'replace')} onClose={() => setPanel(null)} />
                        : <CommentsPanel slide={slide} selected={selEls} author={AUTHOR} edit={editSel} onSelectEl={(id) => setSel([id])} onClose={() => { setPanel(null); setCommentDraft(false); }} draftOpen={commentDraft} setDraftOpen={setCommentDraft} />
                )}
              </div>
              <div className="dc__status">
                <span data-testid="slide-count">Slide {slideNo} of {deck.slides.length}</span>
                {stats && <span>{stats.words} words</span>}
                {slide?.hidden && <span className="dc__badge">Skipped</span>}
                <span className="dc-grow" />
                <span>{SIZE_LABEL(deck)}</span>
                <span>{deck.theme.name}</span>
              </div>
            </>
          ) : (
            <div className="dc__welcome sl__welcome">
              <Presentation size={34} strokeWidth={1.25} />
              <h2>Slides</h2>
              <p>Presentations the Google Slides way: themes and layouts, text, shapes, images, tables, charts and icons you move, resize and rotate with smart guides, transitions and animations, speaker notes, comments, and a full-screen present mode with presenter view and a laser pointer — saved as files in your repository. Start from a template, import a Markdown outline, or ask the Presenter agent to build a deck.</p>
              <TemplateGallery onPick={(t) => setDialog({ kind: 'new', template: t })} />
              <div className="dc-row">
                <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New presentation</button>
                <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><Presentation size={12} strokeWidth={1.5} /> Import Markdown outline</button>
              </div>
            </div>
          )}
          {ctx && <div className="dc-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 260), top: Math.max(8, Math.min(ctx.y, window.innerHeight - 420)) }}><MenuPopup entries={ctx.entries} label="Context menu" subOpen={subOpen} setSubOpen={setSubOpen} onCommand={runCmd} onClose={() => { setCtx(null); setSubOpen(null); }} /></div>}
          {helpOpen && <ShortcutHelp title="Slides shortcuts" groups={SHORTCUTS} onClose={() => setHelpOpen(false)} />}
          <input ref={fileInput} type="file" hidden aria-label="Import a Markdown outline" accept=".md,.markdown,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importMarkdownFile(f); }} />
          <input ref={imageInput} type="file" hidden aria-label="Insert an image file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void insertImageFile(f); }} />
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('slides')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {present && deck && <SlidesPresent deck={deck} start={present.start} presenter={present.presenter} onExit={(i) => { setPresent(null); const s = deck.slides[i]; if (s) goSlide(s.id); mainRef.current?.focus({ preventScroll: true }); }} />}
      {dialog?.kind === 'new' && <NewDeckDialog initial={dialog.template} onCreate={(n, t) => void newDeck(n, t)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'find' && <FindDialog replaceMode={dialog.replace} status={findStatus} onChange={onFindChange} onNext={findNext} onReplace={replaceCurrent} onReplaceAll={replaceEvery} onClose={() => { setDialog(null); findRef.current = null; setFindStatus(''); }} />}
      {dialog?.kind === 'theme' && deck && <ThemeDialog theme={deck.theme} onOk={(t) => { setDialog(null); exec('Edit theme', (d) => { d.theme = t; }); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'chart' && slide && (() => { const c = slide.elements.find((e) => e.id === dialog.id); return c?.type === 'chart' ? <ChartDialog chart={c} onOk={(v) => { setDialog(null); exec('Chart data', (d) => { const el = d.slides.find((s) => s.id === slide.id)?.elements.find((e) => e.id === c.id); if (el?.type === 'chart') Object.assign(el, v); }); }} onClose={() => setDialog(null)} /> : null; })()}
      {dialog?.kind === 'markdown' && <MarkdownDialog onOk={(md, replace) => { setDialog(null); let first: Slide | undefined; exec('Import outline', (d) => { if (replace) d.slides = []; first = markdownToSlides(d, md)[0]; }); if (first) goSlide(first.id); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'page' && deck && <PageSetupDialog deck={deck} onOk={(size) => { setDialog(null); exec('Page setup', (d) => { resizeDeck(d, size); }); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'review' && deck && <InfoDialog title="Review presentation" lines={reviewDeck(deck)} empty="Nothing to flag: titles, text sizes, contrast, word counts and alt text look fine." onClose={() => setDialog(null)} />}
      {dialog?.kind === 'stats' && stats && <InfoDialog title="Word count and stats" lines={[`${stats.slides} slides (${stats.hidden} skipped)`, `${stats.words} words on slides`, `${stats.notesWords} words in speaker notes`, `${stats.images} images`, `${stats.animations} animations`, `${stats.comments} open comments`, `About ${Math.max(1, Math.round((stats.notesWords || stats.words * 3) / 130))} minutes to present (at ~130 words a minute)`]} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limits' && <InfoDialog title="What Slides cannot do yet" lines={LIMITS} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'prompt' && <PromptDialog title={dialog.title} label={dialog.label} initial={dialog.initial} onOk={dialog.onOk} onClose={() => setDialog(null)} />}
    </div>
  );
}

const THEME_BY_ID = (id: string) => THEMES.find((t) => t.id === id);
const SIZE_LABEL = (deck: Deck): string => (Object.entries(SIZES).find(([, s]) => s.w === deck.size.w && s.h === deck.size.h)?.[0] ?? `${deck.size.w}×${deck.size.h}`);
const LIMITS = [
  'This is an editor inspired by Google Slides, not Google Slides: there is no real-time collaboration, sharing, version-history browser, Q&A or captions, and the history is Git\'s history.',
  'Text boxes have one level of rich text (fonts, sizes, colours, bold/italic/underline/strike, links, lists, alignment, spacing); there are no columns, tab stops, WordArt or spell-check suggestions beyond the system spell checker.',
  'Shapes come from a fixed set; there is no free drawing, curve or polyline tool, connectors do not stay attached to shapes, and images cannot be cropped or masked (choose Fill or Fit instead).',
  'Charts are simple column, bar, line, pie and doughnut charts with their own data; they are not linked to a spreadsheet. Video and link cards open the address when presenting; video does not play inside the slide.',
  'PowerPoint export keeps text, shapes, images, tables, backgrounds, transitions, skipped slides and speaker notes; charts become pictures and object animations and comments are not written. PDF pages are pictures of the slides. PowerPoint files cannot be imported yet — import a Markdown outline instead.',
];

function Palette({ hl, theme, themeHex, onPick }: { hl: boolean; theme: Deck['theme'] | null; themeHex: boolean; onPick: (c: string, hl: boolean) => void }) {
  const what = hl ? 'Highlight' : 'Text colour';
  return (
    <div className="dc-palette">
      <div className="dc-palette__grid">{TEXT_COLORS.map((c) => <button key={c} type="button" className="dc-swatch" style={{ background: c }} aria-label={`${what} ${c}`} onClick={() => onPick(c, hl)} />)}</div>
      {theme && <div className="dc-palette__grid">{(['$accent', '$accent2', '$accent3', '$accent4', '$text', '$title', '$muted'] as const).map((c) => { const hex = theme.colors[c.slice(1) as 'accent']; return <button key={c} type="button" className="dc-swatch" title={`Theme ${c.slice(1)}`} style={{ background: hex }} aria-label={`${what} theme ${c.slice(1)}`} onClick={() => onPick(themeHex ? hex : c, hl)} />; })}</div>}
      <label className="dc-palette__custom">Custom <input type="color" aria-label={hl ? 'Custom highlight colour' : 'Custom text colour'} onChange={(e) => onPick(e.target.value, hl)} /></label>
    </div>
  );
}
function InfoDialog({ title, lines, empty, onClose }: { title: string; lines: string[]; empty?: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} extra={<span />}>
      {lines.length ? <ul className="sl-info">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="dc-note">{empty}</p>}
    </Modal>
  );
}
function TB({ label, icon, onClick, on = false, disabled = false, title }: { label: string; icon: ReactNode; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`dc-tb${on ? ' dc-tb--on' : ''}`} aria-label={label} title={title ?? label} aria-pressed={on || undefined} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</button>;
}
function ShapeIcon({ kind }: { kind: ShapeKind }) {
  return <svg viewBox="-2 -2 28 22" width={24} height={18} aria-hidden><path d={SHAPE_PATHS[kind]} fill="currentColor" fillOpacity={0.18} stroke="currentColor" strokeWidth={1.4} /></svg>;
}
const SHAPE_PATHS = Object.fromEntries(SHAPES.map((s) => [s.id, shapePath(s.id, 24, 18)])) as Record<ShapeKind, string>;
function MenuPopup({ entries, label, subOpen, setSubOpen, onClose, onCommand }: { entries: MenuEntry[]; label: string; subOpen: string | null; setSubOpen: (v: string | null) => void; onClose: () => void; onCommand: (cmd: string) => void }) {
  return (
    <div className="dc__popup" role="menu" aria-label={label} onMouseDown={(e) => e.preventDefault()}>
      {entries.map((entry, i) => entry.separator ? <hr key={i} /> : entry.sub ? (
        <div key={i} className="dc__sub" onMouseEnter={() => setSubOpen(`${label}:${entry.label}`)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={subOpen === `${label}:${entry.label}`} disabled={entry.disabled} onClick={() => setSubOpen(subOpen === `${label}:${entry.label}` ? null : `${label}:${entry.label}`)}><span>{entry.label}</span><kbd>▸</kbd></button>
          {subOpen === `${label}:${entry.label}` && !entry.disabled && (
            <div className="dc__popup dc__popup--sub" role="menu" aria-label={entry.label}>
              {entry.sub.map((s, j) => s.separator ? <hr key={j} /> : (
                <button key={j} type="button" role={s.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={s.checked} disabled={s.disabled} onClick={() => { onClose(); if (s.cmd) onCommand(s.cmd); }}>
                  <span>{s.checked !== undefined && <Check size={11} style={{ opacity: s.checked ? 1 : 0 }} />} {s.label}</span>
                  {s.keys && <kbd>{s.keys}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onMouseEnter={() => setSubOpen(null)} onClick={() => { onClose(); if (entry.cmd) onCommand(entry.cmd); }}>
          <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
          {entry.keys && <kbd>{entry.keys}</kbd>}
        </button>
      ))}
    </div>
  );
}
