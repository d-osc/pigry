import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, CheckSquare, ChevronDown, ChevronLeft, Eraser, FileText, Highlighter, ImagePlus, IndentDecrease, IndentIncrease,
  Italic, Keyboard, Link2, List, ListOrdered, ListTree, MessageSquarePlus, Minus, Paintbrush, PenLine, Plus, Printer, Redo2, Strikethrough, Trash2, Type, Underline, Undo2, X,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import {
  DocError, FONTS, FONT_SIZES, PARA_STYLES, acceptSuggestion, addComment, cellAtPos, cleanupRefs, clearFormatting, deleteComment, deleteRange, docListLabels, docStats, emptyDoc,
  ensureTrailingPara, fillFields, findAll, footnoteNumbers, formatRange, indent, insertBlockAt, insertFragment, insertInline, insertText, isCollapsed, isTextRun, listSuggestions,
  makeTable, newId, orderRange, orderedComments, outline, paraLen, parasIn, rejectSuggestion, replaceAll, replaceRange, replyComment, resolveComment, setParaProps, splitPara,
  suggestDelete, suggestInsert, tableDeleteCol, tableDeleteRow, tableInsertCol, tableInsertRow, tableMerge, tableUnmerge, textBlocks, toggleList, toggleMark,
  type Align, type Doc, type DocStats, type ListKind, type Marks, type ParaStyle, type Pos, type Range as DocRange, type Run, type Table,
} from './docs';
import { TEMPLATES, docToHtml, docToMarkdown, docToText, blocksHtml, markdownToDoc, templateDoc, textToBlocks, type TemplateId } from './docsFormat';
import { reviewDoc } from './docsOps';
import { docxBytes } from './docsDocx';
import { domToDoc, fixupDom, htmlToBlocks, offsetIn, paraElements, readSelection, relabel, suggestDeleteSelection, suggestTypeText, suggestWrapComposed, toHex, writeSelection, domRangeOf } from './docsDom';
import { PX_PER_IN, docPageCss, layoutPages, pageGeometry } from './docsRender';
import { DOCS_CHANGED, DOCS_OPEN, docsPath, listDocRefs, loadDoc, registerDocsFlush, removeDoc, saveDoc, setOpenDoc, takePendingOpenDoc, type DocsChange, type DocsOpenRequest } from './docsStore';
import { blockIndex } from './docsOps';
import {
  EquationDialog, FindDialog, HeaderFooterDialog, LimitsDialog, LinkDialog, NewDocDialog, PageSetupDialog, PromptDialog, ReviewDialog, SpecialCharsDialog, TableDialog, TableGrid,
  TemplateThumb, WordCountDialog, type FindState, type HeaderFooterValue,
} from './DocsDialogs';
import './DocsScreen.css';

const LAST_KEY = 'pigry:docs-last';
const COUNT_KEY = 'pigry:docs-wordcount';
const SAVE_DELAY = 900;
const SYNC_DELAY = 250;
const HISTORY_LIMIT = 100;
const AUTHOR = USER_OWNER;
const TEXT_COLORS = ['#000000', '#434343', '#666666', '#999999', '#ffffff', '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc', '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0', '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'];
const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];
const MENU_NAMES = ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools'];

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Text', items: [{ keys: 'Ctrl+B / Ctrl+I / Ctrl+U', label: 'Bold / italic / underline' }, { keys: 'Alt+Shift+5', label: 'Strikethrough' }, { keys: 'Ctrl+. / Ctrl+,', label: 'Superscript / subscript' }, { keys: 'Ctrl+Shift+> / Ctrl+Shift+<', label: 'Bigger / smaller font' }, { keys: 'Ctrl+\\', label: 'Clear formatting' }, { keys: 'Ctrl+K', label: 'Insert or edit link' }] },
  { title: 'Paragraphs', items: [{ keys: 'Ctrl+Alt+0', label: 'Normal text' }, { keys: 'Ctrl+Alt+1 … 6', label: 'Heading 1 … 6' }, { keys: 'Ctrl+Shift+7 / 8 / 9', label: 'Numbered / bulleted list / checklist' }, { keys: 'Ctrl+Shift+L / E / R / J', label: 'Align left / centre / right / justify' }, { keys: 'Ctrl+] / Ctrl+[', label: 'Increase / decrease indent' }, { keys: 'Tab / Shift+Tab', label: 'Indent a list item, or next / previous table cell' }, { keys: 'Shift+Enter', label: 'Line break' }, { keys: 'Ctrl+Enter', label: 'Page break' }] },
  { title: 'Insert and review', items: [{ keys: 'Ctrl+Alt+M', label: 'Comment' }, { keys: 'Ctrl+Alt+F', label: 'Footnote' }, { keys: 'Ctrl+Alt+Shift+X', label: 'Switch editing / suggesting' }, { keys: 'Ctrl+F / Ctrl+H', label: 'Find / find and replace' }, { keys: 'Ctrl+Shift+C', label: 'Word count' }] },
  { title: 'Edit', items: [{ keys: 'Ctrl+Z / Ctrl+Y', label: 'Undo / redo' }, { keys: 'Ctrl+Shift+V', label: 'Paste without formatting' }, { keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Ctrl+S', label: 'Save now' }, { keys: 'Ctrl+/', label: 'This list' }] },
];

interface MenuEntry { label?: string; keys?: string; cmd?: string; disabled?: boolean; separator?: boolean; checked?: boolean; sub?: MenuEntry[] }
const TABLE_MENU: MenuEntry[] = [
  { label: 'Insert row above', cmd: 'table:rowAbove' }, { label: 'Insert row below', cmd: 'table:rowBelow' },
  { label: 'Insert column left', cmd: 'table:colLeft' }, { label: 'Insert column right', cmd: 'table:colRight' },
  { separator: true },
  { label: 'Delete row', cmd: 'table:deleteRow' }, { label: 'Delete column', cmd: 'table:deleteCol' }, { label: 'Delete table', cmd: 'table:deleteTable' },
  { separator: true },
  { label: 'Merge cells', cmd: 'table:merge' }, { label: 'Unmerge cells', cmd: 'table:unmerge' },
  { label: 'Cell background', sub: [...['#f3f3f3', '#d9ead3', '#fff2cc', '#c9daf8', '#f4cccc', '#d9d2e9'].map((c) => ({ label: c, cmd: `table:bg:${c}` })), { label: 'None', cmd: 'table:bg:' }] },
];
interface HistoryEntry { doc: Doc; sel: DocRange | null }
interface Fmt { style: ParaStyle; font: string; size: number; b: boolean; i: boolean; u: boolean; s: boolean; sup: boolean; sub: boolean; color: string; bg: string; align: Align; list: ListKind | null; lh: number; link: string | null; inTable: boolean; comment: string | null }
const NO_FMT: Fmt = { style: 'normal', font: 'Arial', size: 11, b: false, i: false, u: false, s: false, sup: false, sub: false, color: '#000000', bg: '', align: 'left', list: null, lh: 1.15, link: null, inTable: false, comment: null };
type Dialog =
  | { kind: 'new'; template?: TemplateId } | { kind: 'find'; replace: boolean } | { kind: 'link'; text: string; url: string; canEditText: boolean } | { kind: 'page' } | { kind: 'hf' }
  | { kind: 'count'; selection: DocStats | null } | { kind: 'chars' } | { kind: 'equation'; initial: string; at?: Pos } | { kind: 'table' } | { kind: 'review' } | { kind: 'limits' }
  | { kind: 'prompt'; title: string; label: string; initial: string; onOk: (v: string) => void } | null;

const download = (blob: Blob, name: string): void => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 1500); };
const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const sameContent = (a: Doc, b: Doc): boolean => JSON.stringify([a.blocks, a.suggestions, a.footnotes]) === JSON.stringify([b.blocks, b.suggestions, b.footnotes]);
const nowIso = (): string => new Date().toISOString();
const today = (): string => new Date().toISOString().slice(0, 10);
const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
const imageSize = (src: string): Promise<{ w: number; h: number }> => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => resolve({ w: 0, h: 0 }); img.src = src; });
type HighlightCtor = new (...ranges: Range[]) => unknown;
const highlights = (): Map<string, unknown> | null => (typeof CSS !== 'undefined' ? ((CSS as unknown as { highlights?: Map<string, unknown> }).highlights ?? null) : null);
const HighlightClass = (): HighlightCtor | null => ((window as unknown as { Highlight?: HighlightCtor }).Highlight ?? null);
const caretRange = (pos: Pos): DocRange => ({ from: pos, to: pos });
const runAtOffset = (runs: Run[], o: number): Run | undefined => { let at = 0; for (const r of runs) { const len = isTextRun(r) ? r.t.length : 1; if (o >= at && o < at + len) return r; at += len; } return undefined; };

export function DocsScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setModeState] = useState<'editing' | 'suggesting'>('editing');
  const [zoom, setZoom] = useState(1);
  const [showOutline, setShowOutline] = useState(() => window.innerWidth >= 1300);
  const [showRuler, setShowRuler] = useState(true);
  const [showComments, setShowComments] = useState(true);
  const [spell, setSpell] = useState(true);
  const [showCount, setShowCount] = useState(() => { try { return localStorage.getItem(COUNT_KEY) === '1'; } catch { return false; } });
  const [menu, setMenu] = useState<string | null>(null);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [fmt, setFmt] = useState<Fmt>(NO_FMT);
  const [pages, setPages] = useState(1);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ range: DocRange; text: string; quote: string } | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [imgSel, setImgSel] = useState<{ pos: Pos; w: number; alt: string; x: number; y: number } | null>(null);
  const [selWords, setSelWords] = useState<number | null>(null);
  const [findStatus, setFindStatus] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [ctx, setCtx] = useState<{ entries: MenuEntry[]; x: number; y: number } | null>(null);
  const [focusFn, setFocusFn] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<Doc | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const syncTimer = useRef<number | null>(null);
  const layoutRaf = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const lastSel = useRef<DocRange | null>(null);
  const burstSel = useRef<DocRange | null>(null);
  const composing = useRef(false);
  const modeRef = useRef<'editing' | 'suggesting'>('editing');
  const plainPaste = useRef(false);
  const pendingSize = useRef(11);
  const paintRef = useRef<Marks | null>(null);
  const [painting, setPainting] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<FindState | null>(null);
  const pendingRender = useRef<{ doc: Doc; block?: string } | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const refOf = (key: string | null): OwnedRef | null => { if (!key) return null; const { owner, slug } = parseRefName(key, ['.doc.json']); return { owner: owner ?? USER_OWNER, slug }; };
  const setMode = (m: 'editing' | 'suggesting'): void => { modeRef.current = m; setModeState(m); };
  const who = () => ({ author: AUTHOR, at: nowIso(), newId: () => (docRef.current ? newId(docRef.current, 's') : `s${Date.now()}`) });

  /* ---------- layout and rendering ---------- */

  const geometry = useMemo(() => pageGeometry(doc ?? emptyDoc()), [doc]);
  const geoRef = useRef(geometry);
  useEffect(() => { geoRef.current = geometry; }, [geometry]);

  const runLayout = useCallback(() => {
    layoutRaf.current = null;
    const el = surfaceRef.current;
    if (!el || composing.current) return;
    setPages(layoutPages(el, geoRef.current));
  }, []);
  const scheduleLayout = useCallback(() => { if (layoutRaf.current === null) layoutRaf.current = window.requestAnimationFrame(runLayout); }, [runLayout]);

  const renderDoc = useCallback((d: Doc, sel: DocRange | null, focus = true) => {
    const el = surfaceRef.current;
    if (!el) return;
    el.innerHTML = blocksHtml(d, { editor: true });
    const n = textBlocks(d).length;
    if (sel && n) {
      const clamp = (p: Pos): Pos => { const b = Math.max(0, Math.min(n - 1, p.b)); const para = textBlocks(d)[b].para; return { b, o: Math.max(0, Math.min(paraLen(para), p.o)) }; };
      lastSel.current = { from: clamp(sel.from), to: clamp(sel.to) };
      // Writing a selection into the page moves focus there, so only do it when the page should have focus.
      if (focus) { el.focus({ preventScroll: true }); writeSelection(el, lastSel.current); }
    }
    runLayout();
  }, [runLayout]);

  /* ---------- persistence ---------- */

  const [dirtyTick, setDirtyTick] = useState(0);
  const markDirty = useCallback((): void => {
    dirtyRef.current = true;
    setDirty(true);
    setDirtyTick((t) => t + 1);
  }, []);
  const pushUndo = (d: Doc, sel: DocRange | null): void => {
    undoStack.current.push({ doc: d, sel });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
  };

  /** Reads the edited page back into the model (after typing); returns true when something changed. */
  const sync = useCallback((): boolean => {
    if (syncTimer.current !== null) { window.clearTimeout(syncTimer.current); syncTimer.current = null; }
    const el = surfaceRef.current, base = docRef.current;
    if (!el || !base || composing.current) return false;
    fixupDom(el);
    for (const f of [...el.querySelectorAll('font[size="7"]')]) {
      const span = document.createElement('span');
      span.style.fontSize = `${pendingSize.current}pt`;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    }
    const { doc: next, paraEls } = domToDoc(el, base);
    const tbs = textBlocks(next);
    paraEls.forEach((p, i) => { const id = tbs[i]?.para.id; if (id && p.getAttribute('data-id') !== id) p.setAttribute('data-id', id); });
    [...el.children].forEach((child, i) => { const b = next.blocks[i]; if (b && b.type !== 'p' && child.getAttribute('data-id') !== b.id) child.setAttribute('data-id', b.id); });
    const labels = docListLabels(next);
    relabel(paraEls, tbs.map((t) => (t.para.list ? labels.get(t.para) : undefined)));
    const fns = footnoteNumbers(next);
    for (const f of el.querySelectorAll<HTMLElement>('.dc-fn')) { const n = String(fns.get(f.dataset.fn ?? '') ?? ''); if (f.textContent !== n) f.textContent = n; }
    if (sameContent(next, base)) { docRef.current = { ...base, seq: next.seq }; return false; }
    pushUndo(base, burstSel.current ?? lastSel.current);
    burstSel.current = null;
    docRef.current = next;
    setDoc(next);
    syncHist();
    markDirty();
    return true;
  }, [markDirty]);
  const scheduleSync = useCallback(() => { if (syncTimer.current !== null) window.clearTimeout(syncTimer.current); syncTimer.current = window.setTimeout(() => { sync(); }, SYNC_DELAY); }, [sync]);

  const saveNow = useCallback(async () => {
    sync();
    const ref = refOf(currentRef.current), d = docRef.current;
    if (!ref || !d || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveDoc(ref, d, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the document: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
  }, [notify, sync]);
  // Autosave a moment after the last change.
  useEffect(() => {
    if (!dirtyTick) return;
    const t = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [dirtyTick, saveNow]);
  useEffect(() => registerDocsFlush(saveNow), [saveNow]);
  useEffect(() => () => {
    const ref = refOf(currentRef.current), d = docRef.current;
    if (dirtyRef.current && ref && d) void saveDoc(ref, d, 'editor');
  }, []);

  /** The selection in model terms (or the last one, when focus is in a toolbar control or dialog). */
  const currentSel = (): DocRange | null => {
    const el = surfaceRef.current;
    const s = window.getSelection();
    if (el && s && s.anchorNode && el.contains(s.anchorNode)) { const r = readSelection(el); if (r) { lastSel.current = r; return r; } }
    return lastSel.current;
  };

  /** Runs a model command: syncs typing first, applies fn to a copy, re-renders and records undo. */
  const exec = (label: string, fn: (d: Doc, sel: DocRange | null) => DocRange | Pos | null | void, opts: { keepFocus?: boolean } = {}): boolean => {
    if (!docRef.current || !surfaceRef.current) return false;
    sync();
    const cur = docRef.current;
    const sel = currentSel();
    const next = structuredClone(cur);
    let res: DocRange | Pos | null | void;
    try { res = fn(next, sel); }
    catch (e) { notify(e instanceof DocError || e instanceof Error ? e.message : String(e), 'error'); return false; }
    ensureTrailingPara(next);
    cleanupRefs(next);
    pushUndo(cur, sel);
    docRef.current = next;
    setDoc(next);
    const newSel = res === undefined ? sel : res === null ? null : 'from' in res ? res : caretRange(res);
    renderDoc(next, newSel, !opts.keepFocus);
    syncHist();
    markDirty();
    void label;
    return true;
  };
  const withSel = (fn: (d: Doc, sel: DocRange) => DocRange | Pos | null | void, label: string, needText = false) => exec(label, (d, sel) => {
    if (!sel) throw new DocError('Click in the document first');
    if (needText && isCollapsed(sel)) throw new DocError('Select some text first');
    return fn(d, sel);
  });

  const undo = (): void => {
    sync();
    const e = undoStack.current.pop();
    if (!e || !docRef.current) return;
    redoStack.current.push({ doc: docRef.current, sel: currentSel() });
    docRef.current = e.doc; setDoc(e.doc); renderDoc(e.doc, e.sel); syncHist(); markDirty();
  };
  const redo = (): void => {
    sync();
    const e = redoStack.current.pop();
    if (!e || !docRef.current) return;
    undoStack.current.push({ doc: docRef.current, sel: currentSel() });
    docRef.current = e.doc; setDoc(e.doc); renderDoc(e.doc, e.sel); syncHist(); markDirty();
  };

  /* ---------- opening files ---------- */

  const scrollToBlock = (top: number): void => {
    const el = surfaceRef.current, d = docRef.current;
    if (!el || !d) return;
    const b = textBlocks(d).findIndex((t) => t.top >= top);
    const target = (el.children[top] as HTMLElement | undefined) ?? null;
    if (b >= 0) { el.focus({ preventScroll: true }); writeSelection(el, caretRange({ b, o: 0 })); lastSel.current = caretRange({ b, o: 0 }); }
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };

  const openDocFile = useCallback(async (key: string, block?: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { doc: d, warnings } = await loadDoc(ref);
      undoStack.current = []; redoStack.current = [];
      dirtyRef.current = false; setDirty(false);
      const nextKey = refKey(ref);
      docRef.current = d; currentRef.current = nextKey;
      setDoc(d); setCurrent(nextKey); setOpenDoc(nextKey);
      setDraft(null); setImgSel(null);
      syncHist();
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      // The page element may not exist yet (empty state): the layout effect below renders once it does.
      pendingRender.current = { doc: d, block };
      setRenderTick((t) => t + 1);
      if (warnings.length) notify(`Document opened with ${warnings.length} repaired issue(s).`);
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [notify, saveNow]);

  useLayoutEffect(() => {
    const p = pendingRender.current;
    if (!p || !surfaceRef.current) return;
    pendingRender.current = null;
    renderDoc(p.doc, caretRange({ b: 0, o: 0 }), true);
    if (p.block !== undefined) { try { const top = blockIndex(p.doc, /^\d+$/.test(p.block) ? Number(p.block) : p.block); window.setTimeout(() => scrollToBlock(top), 30); } catch { /* unknown block */ } }
  }, [renderTick, current, renderDoc]);

  const refreshList = useCallback(async () => { try { setRefs(await listDocRefs()); } catch { setRefs([]); } }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listDocRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: DocsOpenRequest | null = takePendingOpenDoc();
      const wanted = request?.key ?? last;
      const found = list.find((r) => refKey(r) === wanted) ?? (request ? undefined : list[0]);
      if (found) await openDocFile(refKey(found), request?.block);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<DocsChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setDoc(null); docRef.current = null; currentRef.current = null; setOpenDoc(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openDocFile(change.key); }
    };
    const onOpen = (event: Event) => { const r = (event as CustomEvent<DocsOpenRequest>).detail; takePendingOpenDoc(); void openDocFile(r.key, r.block); };
    window.addEventListener(DOCS_CHANGED, onChanged);
    window.addEventListener(DOCS_OPEN, onOpen);
    return () => { window.removeEventListener(DOCS_CHANGED, onChanged); window.removeEventListener(DOCS_OPEN, onOpen); };
  }, [openDocFile, refreshList]);

  // Re-lay out the pages when the page setup or zoom changes.
  useLayoutEffect(() => { scheduleLayout(); }, [geometry, zoom, scheduleLayout, showRuler]);
  useEffect(() => { const onResize = () => scheduleLayout(); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize); }, [scheduleLayout]);
  useEffect(() => { if (!focusFn) return; const t = document.querySelector<HTMLTextAreaElement>(`[data-footnote="${focusFn}"]`); t?.focus(); t?.scrollIntoView({ block: 'center' }); }, [focusFn]);

  /* ---------- toolbar state from the selection ---------- */

  const readFmt = useCallback(() => {
    const el = surfaceRef.current;
    const s = window.getSelection();
    if (!el || !s || !s.focusNode || !el.contains(s.focusNode)) return;
    const r = readSelection(el);
    if (r) lastSel.current = r;
    const node = s.focusNode.nodeType === 3 ? s.focusNode.parentElement : (s.focusNode as HTMLElement);
    if (!node) return;
    const els = paraElements(el);
    const para = els.find((p) => p.contains(node)) ?? null;
    const cs = window.getComputedStyle(node);
    const within = (sel: string) => { const hit = node.closest(sel); return !!hit && el.contains(hit); };
    const style = (para?.getAttribute('data-style') as ParaStyle | null) ?? (para && /^H[1-6]$/.test(para.tagName) ? (`h${para.tagName[1]}` as ParaStyle) : 'normal');
    const pcs = para ? window.getComputedStyle(para) : null;
    const lhRaw = para?.style.lineHeight;
    const bgEl = node.closest('[style*="background"]') as HTMLElement | null;
    const comment = (node.closest('.dc-c') as HTMLElement | null)?.getAttribute('data-c')?.split(/\s+/)[0] ?? null;
    setFmt({
      style, font: (cs.fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim(), size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2,
      b: Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold', i: cs.fontStyle === 'italic', u: within('u,[style*="underline"]'), s: within('s,strike,[style*="line-through"]'),
      sup: within('sup:not(.dc-fn)'), sub: within('sub'), color: toHex(cs.color) ?? '#000000', bg: bgEl && el.contains(bgEl) ? toHex(bgEl.style.backgroundColor) ?? '' : '',
      align: ((pcs?.textAlign === 'center' || pcs?.textAlign === 'right' || pcs?.textAlign === 'justify') ? pcs.textAlign : 'left') as Align,
      list: (para?.getAttribute('data-list') as ListKind | null) ?? null, lh: lhRaw ? parseFloat(lhRaw) : 1.15,
      link: (node.closest('a') as HTMLAnchorElement | null)?.getAttribute('href') ?? null, inTable: within('td'), comment,
    });
    if (comment) setActiveComment(comment);
    setSelWords(s.isCollapsed ? null : docStats(docRef.current ?? emptyDoc(), r ?? undefined).words);
    if (currentRef.current) setOpenDoc(currentRef.current, s.isCollapsed ? null : s.toString().slice(0, 300));
    if (paintRef.current && !s.isCollapsed && r) {
      const marks = paintRef.current;
      paintRef.current = null;
      setPainting(false);
      exec('Paint format', (d) => { clearFormatting(d, r); formatRange(d, r, marks as Record<string, unknown>); return r; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let raf: number | null = null;
    const onSel = () => { if (raf === null) raf = window.requestAnimationFrame(() => { raf = null; readFmt(); }); };
    document.addEventListener('selectionchange', onSel);
    return () => { document.removeEventListener('selectionchange', onSel); if (raf !== null) window.cancelAnimationFrame(raf); };
  }, [readFmt]);
  // Highlight the text of the active comment.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    for (const s of el.querySelectorAll('.dc-c--active')) s.classList.remove('dc-c--active');
    if (activeComment) for (const s of el.querySelectorAll<HTMLElement>('.dc-c')) if ((s.getAttribute('data-c') ?? '').split(/\s+/).includes(activeComment)) s.classList.add('dc-c--active');
  }, [activeComment, doc]);

  /* ---------- commands ---------- */

  const focusEditor = (): void => { const el = surfaceRef.current; const sel = lastSel.current; if (!el) return; el.focus({ preventScroll: true }); if (sel) writeSelection(el, sel); };
  /** Inline formatting: a selection is formatted in the model; at a caret it applies to what is typed next. */
  const inline = (patch: Record<string, unknown>, label: string, typing?: () => void): void => {
    const sel = currentSel();
    if (!sel) return;
    if (isCollapsed(sel)) { focusEditor(); typing?.(); return; }
    exec(label, (d) => { formatRange(d, sel, patch); return sel; });
  };
  const toggle = (key: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'code', label: string): void => {
    const sel = currentSel();
    if (!sel) return;
    if (isCollapsed(sel)) {
      focusEditor();
      const cmd = { b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough', sup: 'superscript', sub: 'subscript', code: '' }[key];
      if (cmd) { document.execCommand('styleWithCSS', false, 'false'); document.execCommand(cmd); }
      return;
    }
    exec(label, (d) => { toggleMark(d, sel, key); return sel; });
  };
  const setColor = (color: string, bg: boolean): void => {
    setTool(null);
    inline(bg ? { bg: color || null } : { color: color === '#000000' ? null : color }, bg ? 'Highlight colour' : 'Text colour', () => {
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand(bg ? 'hiliteColor' : 'foreColor', false, color || 'transparent');
    });
  };
  const setFont = (font: string): void => { setTool(null); inline({ font: font === (docRef.current?.font.family ?? 'Arial') ? null : font }, 'Font', () => { document.execCommand('styleWithCSS', false, 'false'); document.execCommand('fontName', false, font); }); };
  const setSize = (size: number): void => {
    const n = Math.max(1, Math.min(400, Math.round(size * 2) / 2));
    setTool(null);
    inline({ size: n }, 'Font size', () => { pendingSize.current = n; document.execCommand('styleWithCSS', false, 'false'); document.execCommand('fontSize', false, '7'); });
  };
  const setStyle = (style: ParaStyle): void => { setTool(null); withSel((d, sel) => { for (const p of parasIn(d, sel)) setParaProps(p, { style, sb: null, sa: null, ...(style !== 'normal' ? { list: null } : {}) }); }, 'Paragraph style'); };
  const setAlign = (align: Align): void => { withSel((d, sel) => { for (const p of parasIn(d, sel)) setParaProps(p, { align }); }, 'Align'); };
  const setLineHeight = (lh: number): void => { setTool(null); withSel((d, sel) => { for (const p of parasIn(d, sel)) setParaProps(p, { lh: lh === 1.15 ? null : lh }); }, 'Line spacing'); };
  const setSpace = (key: 'sb' | 'sa', value: number | null): void => { setTool(null); withSel((d, sel) => { for (const p of parasIn(d, sel)) setParaProps(p, { [key]: value }); }, 'Paragraph spacing'); };
  const list = (kind: ListKind): void => { withSel((d, sel) => { toggleList(d, sel, kind); }, 'List'); };
  const removeList = (): void => { withSel((d, sel) => { for (const p of parasIn(d, sel)) setParaProps(p, { list: null }); }, 'Remove list'); };
  const doIndent = (delta: 1 | -1): void => { withSel((d, sel) => { indent(d, sel, delta); }, delta > 0 ? 'Indent' : 'Outdent'); };
  const clearFmt = (): void => { withSel((d, sel) => { clearFormatting(d, sel); for (const p of parasIn(d, sel)) setParaProps(p, { style: 'normal', align: null, lh: null, sb: null, sa: null }); }, 'Clear formatting'); };
  const insertAtCaret = (label: string, fn: (d: Doc, pos: Pos, sel: DocRange) => DocRange | Pos | void): void => {
    withSel((d, sel) => {
      const r = orderRange(sel);
      const pos = isCollapsed(r) ? r.from : modeRef.current === 'suggesting' ? (suggestDelete(d, r, AUTHOR, nowIso()), r.to) : deleteRange(d, r);
      return fn(d, pos, r);
    }, label);
  };
  const insertChar = (ch: string): void => insertAtCaret('Insert character', (d, pos) => (modeRef.current === 'suggesting' ? suggestInsert(d, pos, ch, AUTHOR, nowIso()).pos : insertText(d, pos, ch)));
  const insertBlock = (type: 'hr' | 'pagebreak' | 'toc'): void => insertAtCaret(type === 'hr' ? 'Horizontal line' : type === 'pagebreak' ? 'Page break' : 'Table of contents', (d, pos) => insertBlockAt(d, pos, { type, id: 'x' }));
  const insertTable = (rows: number, cols: number): void => {
    setTool(null); setMenu(null);
    insertAtCaret('Insert table', (d, pos) => {
      const after = insertBlockAt(d, pos, makeTable(d, rows, cols));
      const tbs = textBlocks(d);
      const tableTop = (tbs[after.b]?.top ?? d.blocks.length) - 1;
      const first = tbs.findIndex((t) => t.top === tableTop);
      return first >= 0 ? { b: first, o: 0 } : after;
    });
  };
  const insertFootnote = (): void => {
    let id = '';
    insertAtCaret('Footnote', (d, pos) => { id = newId(d, 'f'); d.footnotes.push({ id, text: '' }); return insertInline(d, pos, { fn: id }); });
    if (id) setFocusFn(id);
  };
  const insertImageFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) { notify('Choose an image file (PNG, JPEG, GIF, WebP or SVG).', 'error'); return; }
    const src = await readFileAsDataUrl(file);
    const { w, h } = await imageSize(src);
    const maxW = geoRef.current.contentW;
    const width = w > maxW ? maxW : w, height = w > maxW ? Math.round((h * maxW) / w) : h;
    insertAtCaret('Insert image', (d, pos) => insertInline(d, pos, { img: src, ...(width ? { w: width } : {}), ...(height ? { h: height } : {}), alt: file.name.replace(/\.[^.]+$/, '') }));
  };
  const openLink = (): void => {
    const sel = currentSel();
    if (!sel) return;
    const el = surfaceRef.current;
    const text = el ? (domRangeOf(el, orderRange(sel))?.toString() ?? '') : '';
    setDialog({ kind: 'link', text, url: fmt.link ?? '', canEditText: isCollapsed(sel) });
  };
  const applyLink = (text: string, url: string): void => {
    setDialog(null);
    const sel = lastSel.current;
    if (!sel) return;
    exec('Link', (d) => {
      const r = orderRange(sel);
      if (isCollapsed(r)) {
        // Inside an existing link: change the whole link.
        const tb = textBlocks(d)[r.from.b];
        const run = tb && runAtOffset(tb.para.runs, Math.max(0, r.from.o - 1));
        if (run?.link && !text) {
          let at = 0, start = -1, end = -1;
          for (const x of tb.para.runs) { const len = isTextRun(x) ? x.t.length : 1; if (x.link === run.link) { if (start < 0) start = at; end = at + len; } else if (start >= 0 && end <= r.from.o) { start = -1; } at += len; }
          if (start >= 0) { formatRange(d, { from: { b: r.from.b, o: start }, to: { b: r.from.b, o: end } }, { link: url }); return r; }
        }
        const end = insertText(d, r.from, text || url, { ...{}, link: url });
        return caretRange(end);
      }
      formatRange(d, r, { link: url });
      return r;
    });
  };
  const removeLink = (): void => {
    setDialog(null);
    const sel = lastSel.current;
    if (!sel) return;
    exec('Remove link', (d) => {
      const r = orderRange(sel);
      if (!isCollapsed(r)) { formatRange(d, r, { link: null }); return r; }
      const tb = textBlocks(d)[r.from.b];
      const run = runAtOffset(tb.para.runs, Math.max(0, r.from.o - 1));
      if (run?.link) tb.para.runs = tb.para.runs.map((x) => (x.link === run.link ? { ...x, link: undefined } : x)).map((x) => { const n = { ...x }; if (n.link === undefined) delete n.link; return n; });
      return r;
    });
  };
  const startComment = (): void => {
    const sel = currentSel();
    if (!sel || isCollapsed(sel)) { notify('Select the text you want to comment on.'); return; }
    setShowComments(true);
    const el = surfaceRef.current;
    setDraft({ range: orderRange(sel), text: '', quote: el ? (domRangeOf(el, orderRange(sel))?.toString() ?? '').slice(0, 120) : '' });
  };
  const submitComment = (): void => {
    if (!draft || !draft.text.trim()) return;
    const range = draft.range;
    setDraft(null);
    let id = '';
    exec('Comment', (d) => { id = addComment(d, range, draft.text, AUTHOR, nowIso()); return range; }, { keepFocus: true });
    if (id) setActiveComment(id);
  };
  const tableCmd = (label: string, fn: (d: Doc, cell: { top: number; r: number; c: number }, sel: DocRange) => DocRange | Pos | void): void => {
    setCtx(null);
    withSel((d, sel) => {
      const cell = cellAtPos(d, orderRange(sel).from);
      if (!cell) throw new DocError('Put the cursor in a table first');
      return fn(d, cell, sel);
    }, label);
  };
  const mergeCells = (): void => tableCmd('Merge cells', (d, a, sel) => {
    const z = cellAtPos(d, orderRange(sel).to);
    if (!z || z.top !== a.top) throw new DocError('Select two or more cells of one table');
    tableMerge(d, a.top, a.r, a.c, z.r, z.c);
    const first = textBlocks(d).findIndex((t) => t.top === a.top && t.cell && t.cell.r === Math.min(a.r, z.r) && t.cell.c === Math.min(a.c, z.c));
    return { b: Math.max(0, first), o: 0 };
  });
  const cellBackground = (color: string): void => tableCmd('Cell background', (d, a, sel) => {
    const z = cellAtPos(d, orderRange(sel).to) ?? a;
    const t = d.blocks[a.top] as Table;
    for (let r = Math.min(a.r, z.r); r <= Math.max(a.r, z.r); r++) for (let c = Math.min(a.c, z.c); c <= Math.max(a.c, z.c); c++) { const cell = t.rows[r][c]; if (color) cell.bg = color; else delete cell.bg; }
  });
  const moveCell = (back: boolean): boolean => {
    const el = surfaceRef.current;
    const s = window.getSelection();
    const td = (s?.focusNode?.nodeType === 3 ? s.focusNode.parentElement : (s?.focusNode as HTMLElement | null))?.closest('td');
    if (!el || !td || !el.contains(td)) return false;
    const table = td.closest('table')!;
    const cells = [...table.querySelectorAll('td')];
    const i = cells.indexOf(td);
    const next = cells[i + (back ? -1 : 1)];
    if (next) {
      const range = document.createRange();
      range.selectNodeContents(next.querySelector('p,h1,h2,h3,h4,h5,h6') ?? next);
      s!.removeAllRanges(); s!.addRange(range);
      return true;
    }
    if (back) return true;
    // Tab in the last cell adds a row (as in Google Docs).
    tableCmd('Insert row', (d, cell) => { const t = d.blocks[cell.top] as Table; tableInsertRow(d, cell.top, t.rows.length); return { b: textBlocks(d).findIndex((x) => x.top === cell.top && x.cell?.r === t.rows.length - 1), o: 0 }; });
    return true;
  };

  /* ---------- find ---------- */

  const findMatches = (o: FindState): DocRange[] => {
    sync();
    const d = docRef.current;
    if (!d || !o.find) return [];
    try { return findAll(d, o.find, { matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex }); } catch (e) { setFindStatus(e instanceof Error ? e.message : String(e)); return []; }
  };
  const paintFind = (matches: DocRange[], cur: DocRange | null): void => {
    const reg = highlights(), H = HighlightClass(), el = surfaceRef.current;
    if (!reg || !H || !el) return;
    const els = paraElements(el);
    reg.set('dc-find', new H(...matches.slice(0, 2000).map((m) => domRangeOf(el, m, els)).filter((r): r is Range => !!r)));
    const c = cur ? domRangeOf(el, cur, els) : null;
    if (c) reg.set('dc-find-current', new H(c)); else reg.delete('dc-find-current');
  };
  const clearFind = (): void => { const reg = highlights(); reg?.delete('dc-find'); reg?.delete('dc-find-current'); findRef.current = null; setFindStatus(''); };
  const selectMatch = (m: DocRange): void => {
    const el = surfaceRef.current;
    if (!el) return;
    writeSelection(el, m);
    lastSel.current = m;
    const r = domRangeOf(el, m);
    const box = r?.getBoundingClientRect();
    const canvas = canvasRef.current;
    if (box && canvas) { const cb = canvas.getBoundingClientRect(); if (box.top < cb.top + 40 || box.bottom > cb.bottom - 20) canvas.scrollTop += box.top - cb.top - cb.height / 3; }
  };
  const onFindChange = (o: FindState): void => {
    findRef.current = o;
    const m = findMatches(o);
    paintFind(m, null);
    setFindStatus(o.find ? `${m.length} match${m.length === 1 ? '' : 'es'}` : '');
  };
  const findNext = (o: FindState, back: boolean): void => {
    const m = findMatches(o);
    if (!m.length) { paintFind([], null); setFindStatus('No matches'); return; }
    const sel = lastSel.current ? orderRange(lastSel.current) : null;
    const after = (r: DocRange) => !sel || r.from.b > sel.to.b || (r.from.b === sel.to.b && r.from.o >= sel.to.o) ;
    const before = (r: DocRange) => !sel || r.to.b < sel.from.b || (r.to.b === sel.from.b && r.to.o <= sel.from.o);
    let i = back ? m.map(before).lastIndexOf(true) : m.findIndex(after);
    if (i < 0) i = back ? m.length - 1 : 0;
    selectMatch(m[i]);
    paintFind(m, m[i]);
    setFindStatus(`${i + 1} of ${m.length}`);
  };
  const replaceCurrent = (o: FindState): void => {
    const m = findMatches(o);
    const sel = lastSel.current ? orderRange(lastSel.current) : null;
    const hit = sel && m.find((r) => r.from.b === sel.from.b && r.from.o === sel.from.o && r.to.o === sel.to.o);
    if (!hit) { findNext(o, false); return; }
    exec('Replace', (d) => {
      const text = o.replace;
      if (modeRef.current === 'suggesting') { suggestDelete(d, hit, AUTHOR, nowIso()); if (text) suggestInsert(d, hit.to, text, AUTHOR, nowIso()); return caretRange(hit.to); }
      return replaceRange(d, hit, o.regex ? findMatchText(d, hit).replace(new RegExp(o.find, o.matchCase ? 'u' : 'iu'), text) : text);
    });
    findNext(o, false);
  };
  const findMatchText = (d: Doc, r: DocRange): string => { const p = textBlocks(d)[r.from.b].para; return p.runs.map((x) => (isTextRun(x) ? x.t : '￼')).join('').slice(r.from.o, r.to.o); };
  const replaceEvery = (o: FindState): void => {
    let n = 0;
    exec('Replace all', (d) => {
      if (modeRef.current === 'suggesting') {
        const m = findAll(d, o.find, { matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex });
        for (let i = m.length - 1; i >= 0; i--) { suggestDelete(d, m[i], AUTHOR, nowIso()); if (o.replace) suggestInsert(d, m[i].to, o.replace, AUTHOR, nowIso()); }
        n = m.length;
      } else n = replaceAll(d, o.find, o.replace, { matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex });
    }, { keepFocus: true });
    paintFind([], null);
    setFindStatus(`Replaced ${n} match${n === 1 ? '' : 'es'}${modeRef.current === 'suggesting' && n ? ' as suggestions' : ''}`);
  };

  /* ---------- files ---------- */

  const newDocument = async (name: string, template: TemplateId): Promise<void> => {
    const slug = nameSlug(name || (template === 'blank' ? 'untitled' : TEMPLATES.find((t) => t.id === template)?.label ?? 'document'), ['.doc.json']);
    const ref: OwnedRef = { owner: USER_OWNER, slug };
    if (refs.some((r) => r.owner === ref.owner && r.slug === ref.slug)) { notify(`A document called "${slug}" already exists.`, 'error'); return; }
    setDialog(null);
    const title = name.trim() || (template === 'blank' ? 'Untitled document' : TEMPLATES.find((t) => t.id === template)?.label ?? 'Document');
    await saveNow();
    try {
      await saveDoc(ref, templateDoc(template, title, today()), 'editor');
      await refreshList();
      await openDocFile(refKey(ref));
    } catch (error) { notify(`Could not create the document: ${String(error)}`, 'error'); }
  };
  const copyDocument = async (): Promise<void> => {
    await saveNow();
    const d = docRef.current;
    if (!d) return;
    let n = 1, slug = '';
    do { slug = `${refOf(currentRef.current)?.slug ?? 'document'}-copy${n > 1 ? `-${n}` : ''}`; n++; } while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug));
    const ref = { owner: USER_OWNER, slug };
    await saveDoc(ref, { ...structuredClone(d), title: `Copy of ${d.title}` }, 'editor');
    await refreshList();
    await openDocFile(refKey(ref));
  };
  const deleteFile = async (key: string): Promise<void> => {
    const ref = refOf(key);
    if (!ref) return;
    setConfirmDelete(null);
    try {
      if (key === currentRef.current) dirtyRef.current = false;
      await removeDoc(ref);
      if (key === currentRef.current) { setCurrent(null); setDoc(null); docRef.current = null; currentRef.current = null; setOpenDoc(null); }
      await refreshList();
    } catch (error) { notify(`Could not delete: ${String(error)}`, 'error'); }
  };
  const importFile = async (file: File): Promise<void> => {
    const lower = file.name.toLowerCase();
    const title = file.name.replace(/\.[^.]+$/, '');
    let d: Doc;
    try {
      if (lower.endsWith('.docx')) {
        const { default: mammoth } = await import('mammoth');
        const res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
        d = emptyDoc(title); d.blocks = htmlToBlocks(d, res.value);
      } else {
        const text = await file.text();
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) d = markdownToDoc(text, title);
        else if (lower.endsWith('.html') || lower.endsWith('.htm')) { d = emptyDoc(title); d.blocks = htmlToBlocks(d, text); }
        else { d = emptyDoc(title); d.blocks = textToBlocks(d, text); }
      }
      ensureTrailingPara(d);
      let slug = nameSlug(title, ['.doc.json']), n = 2;
      while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${nameSlug(title)}-${n++}`;
      const ref = { owner: USER_OWNER, slug };
      await saveNow();
      await saveDoc(ref, d, 'editor');
      await refreshList();
      await openDocFile(refKey(ref));
      notify(`Imported ${file.name}.`);
    } catch (error) { notify(`Could not import ${file.name}: ${String(error)}`, 'error'); }
  };
  const exportAs = async (format: 'docx' | 'md' | 'html' | 'txt'): Promise<void> => {
    await saveNow();
    const ref = refOf(currentRef.current), d = docRef.current;
    if (!ref || !d) return;
    const base = docsPath(ref).replace(/\.doc\.json$/, '');
    const fileBase = nameSlug(d.title) || 'document';
    try {
      if (format === 'docx') {
        const bytes = docxBytes(d);
        await writeWorktreeBinary(`${base}.docx`, toBase64(bytes));
        download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), `${fileBase}.docx`);
      } else if (format === 'md') {
        const images: { path: string; data: string }[] = [];
        const text = docToMarkdown(d, { imageRef: (src, n) => { const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(src); if (!m) return src; const ext = m[1] === 'jpeg' ? 'jpg' : m[1] === 'svg+xml' ? 'svg' : m[1]; const path = `${base}-img${n}.${ext}`; images.push({ path, data: m[2] }); return path.slice(path.lastIndexOf('/') + 1); } });
        for (const img of images) await writeWorktreeBinary(img.path, img.data);
        await writeWorktreeFile(`${base}.md`, text);
        download(new Blob([text], { type: 'text/markdown' }), `${fileBase}.md`);
      } else {
        const text = format === 'html' ? docToHtml(d) : docToText(d);
        await writeWorktreeFile(`${base}.${format}`, text);
        download(new Blob([text], { type: format === 'html' ? 'text/html' : 'text/plain' }), `${fileBase}.${format}`);
      }
      notify(`Saved ${base}.${format}${format === 'docx' ? ' (suggestions become Word tracked changes)' : ''}.`);
    } catch (error) { notify(`Could not export: ${String(error)}`, 'error'); }
  };
  const print = (): void => {
    sync();
    const d = docRef.current;
    if (!d) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.appendChild(frame);
    frame.srcdoc = docToHtml(d);
    frame.onload = () => { try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { notify('Printing is not available here — use File ▸ Download ▸ Web page and print it from a browser.'); } window.setTimeout(() => frame.remove(), 60_000); };
  };

  /* ---------- editor events ---------- */

  const newParagraph = (): void => {
    withSel((d, sel) => {
      const r = orderRange(sel);
      let pos = r.from;
      if (!isCollapsed(r)) pos = modeRef.current === 'suggesting' ? (suggestDelete(d, r, AUTHOR, nowIso()), r.to) : deleteRange(d, r);
      return splitPara(d, pos);
    }, 'New paragraph');
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const k = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (e.nativeEvent.isComposing || composing.current) return;
    if (imgSel) setImgSel(null);
    if (mod && e.altKey && e.shiftKey && key === 'x') return k(() => setMode(modeRef.current === 'editing' ? 'suggesting' : 'editing'));
    if (mod && e.altKey && /^Digit[0-6]$/.test(e.code)) { const n = Number(e.code.slice(5)); return k(() => setStyle(n === 0 ? 'normal' : (`h${n}` as ParaStyle))); }
    if (mod && e.altKey && key === 'm') return k(startComment);
    if (mod && e.altKey && key === 'f') return k(insertFootnote);
    if (mod && e.shiftKey && e.code === 'Digit7') return k(() => list('number'));
    if (mod && e.shiftKey && e.code === 'Digit8') return k(() => list('bullet'));
    if (mod && e.shiftKey && e.code === 'Digit9') return k(() => list('check'));
    if (mod && e.shiftKey && key === 'l') return k(() => setAlign('left'));
    if (mod && e.shiftKey && key === 'e') return k(() => setAlign('center'));
    if (mod && e.shiftKey && key === 'r') return k(() => setAlign('right'));
    if (mod && e.shiftKey && key === 'j') return k(() => setAlign('justify'));
    if (mod && e.shiftKey && key === 'c') return k(openCount);
    if (mod && e.shiftKey && (e.code === 'Period' || key === '>')) return k(() => setSize((fmt.size || 11) + (fmt.size >= 12 ? 2 : 1)));
    if (mod && e.shiftKey && (e.code === 'Comma' || key === '<')) return k(() => setSize(Math.max(1, (fmt.size || 11) - (fmt.size > 12 ? 2 : 1))));
    if (mod && e.shiftKey && key === 'v') { plainPaste.current = true; return; }
    if (mod && e.shiftKey && key === 'z') return k(redo);
    if (e.altKey && e.shiftKey && (e.code === 'Digit5' || key === '%')) return k(() => toggle('s', 'Strikethrough'));
    if (mod && !e.altKey && !e.shiftKey) {
      if (key === 'b') return k(() => toggle('b', 'Bold'));
      if (key === 'i') return k(() => toggle('i', 'Italic'));
      if (key === 'u') return k(() => toggle('u', 'Underline'));
      if (key === '.') return k(() => toggle('sup', 'Superscript'));
      if (key === ',') return k(() => toggle('sub', 'Subscript'));
      if (key === '\\') return k(clearFmt);
      if (key === 'k') return k(openLink);
      if (key === 'f') return k(() => setDialog({ kind: 'find', replace: false }));
      if (key === 'h') return k(() => setDialog({ kind: 'find', replace: true }));
      if (key === ']') return k(() => doIndent(1));
      if (key === '[') return k(() => doIndent(-1));
      if (key === 'z') return k(undo);
      if (key === 'y') return k(redo);
      if (key === 's') return k(() => { void saveNow(); });
      if (key === '/') return k(() => setHelpOpen(true));
      if (key === 'p') return k(print);
      if (key === 'enter') return k(() => insertBlock('pagebreak'));
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (moveCell(e.shiftKey)) { e.preventDefault(); return; }
      if (fmt.list) return k(() => doIndent(e.shiftKey ? -1 : 1));
      return k(() => { if (!e.shiftKey) document.execCommand('insertText', false, '\t'); });
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod) return k(newParagraph);
    if (e.key === 'Backspace' && !mod && fmt.list) {
      const sel = currentSel();
      if (sel && isCollapsed(sel) && sel.from.o === 0) return k(() => withSel((d, s) => { const p = textBlocks(d)[s.from.b].para; if ((p.lvl ?? 0) > 0) setParaProps(p, { lvl: (p.lvl ?? 0) - 1 }); else setParaProps(p, { list: null }); }, 'Remove bullet'));
    }
  };
  /** Native beforeinput (React's onBeforeInput is a different, synthetic event without inputType). */
  const onBeforeInput = (ev: InputEvent): void => {
    const e = ev;
    const el = surfaceRef.current;
    if (!el) return;
    if (ev.inputType === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (ev.inputType === 'historyRedo') { e.preventDefault(); redo(); return; }
    if (ev.inputType === 'insertParagraph') { e.preventDefault(); newParagraph(); return; }
    if (!burstSel.current) burstSel.current = currentSel();
    if (modeRef.current !== 'suggesting' || ev.isComposing || composing.current) return;
    if (ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText') {
      const text = ev.data ?? ev.dataTransfer?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      suggestTypeText(el, text, who());
      scheduleSync(); scheduleLayout();
      return;
    }
    if ((ev.inputType ?? '').startsWith('delete') && ev.inputType !== 'deleteByDrag') {
      e.preventDefault();
      if (ev.inputType === 'deleteByCut') return;
      suggestDeleteSelection(el, /Backward/.test(ev.inputType) ? 'backward' : 'forward', who());
      scheduleSync(); scheduleLayout();
    }
  };
  // Re-attached on every render so the listener always sees the current state.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const h = (e: Event) => onBeforeInput(e as InputEvent);
    el.addEventListener('beforeinput', h);
    return () => el.removeEventListener('beforeinput', h);
  });
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const plain = plainPaste.current;
    plainPaste.current = false;
    const data = e.clipboardData;
    const file = [...data.files].find((f) => f.type.startsWith('image/'));
    if (file) { void insertImageFile(file); return; }
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (!html && !text) return;
    insertAtCaret('Paste', (d, pos) => {
      if (modeRef.current === 'suggesting') return suggestInsert(d, pos, text.replace(/\r\n?/g, '\n'), AUTHOR, nowIso()).pos;
      const blocks = !plain && html ? htmlToBlocks(d, html) : textToBlocks(d, text);
      if (!blocks.length) return pos;
      return insertFragment(d, pos, blocks);
    });
  };
  const onCut = (e: ReactClipboardEvent<HTMLDivElement>): void => {
    if (modeRef.current !== 'suggesting') return;
    const s = window.getSelection();
    const el = surfaceRef.current;
    if (!s || s.isCollapsed || !el) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', s.toString());
    suggestDeleteSelection(el, 'forward', who());
    scheduleSync();
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const at = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (at) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(at); }
    void insertImageFile(file);
  };
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const check = target.closest('[data-list="check"]') as HTMLElement | null;
    if (check && e.clientX < check.getBoundingClientRect().left + 2) {
      e.preventDefault();
      const el = surfaceRef.current!;
      sync();
      const b = paraElements(el).indexOf(check);
      if (b >= 0) exec('Check', (d) => { const p = textBlocks(d)[b].para; setParaProps(p, { checked: !p.checked }); return caretRange({ b, o: paraLen(p) }); });
    }
  };
  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const el = surfaceRef.current!;
    const goto = target.closest('[data-goto]') as HTMLElement | null;
    if (goto) { e.preventDefault(); const id = goto.getAttribute('data-goto'); const top = docRef.current?.blocks.findIndex((b) => b.id === id) ?? -1; if (top >= 0) scrollToBlock(top); return; }
    const a = target.closest('a[href]');
    if (a && el.contains(a) && !(e.ctrlKey || e.metaKey)) e.preventDefault();
    const fn = target.closest('.dc-fn') as HTMLElement | null;
    if (fn) { setFocusFn(null); window.setTimeout(() => setFocusFn(fn.dataset.fn ?? null), 0); return; }
    const eq = target.closest('.dc-eq') as HTMLElement | null;
    if (eq) {
      const els = paraElements(el);
      const para = els.find((p) => p.contains(eq));
      if (para) { const parent = eq.parentNode!; const o = offsetIn(para, parent, [...parent.childNodes].indexOf(eq)); setDialog({ kind: 'equation', initial: eq.getAttribute('data-eq') ?? '', at: { b: els.indexOf(para), o } }); }
      return;
    }
    if (target.tagName === 'IMG' && el.contains(target)) {
      for (const i of el.querySelectorAll('img.dc-img--on')) i.classList.remove('dc-img--on');
      target.classList.add('dc-img--on');
      const els = paraElements(el);
      const para = els.find((p) => p.contains(target));
      if (para) {
        const parent = target.parentNode!;
        const o = offsetIn(para, parent, [...parent.childNodes].indexOf(target));
        const rect = target.getBoundingClientRect();
        setImgSel({ pos: { b: els.indexOf(para), o }, w: (target as HTMLImageElement).width, alt: target.getAttribute('alt') ?? '', x: rect.left, y: rect.bottom + 6 });
      }
      return;
    }
    if (imgSel) { for (const i of el.querySelectorAll('img.dc-img--on')) i.classList.remove('dc-img--on'); setImgSel(null); }
  };
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const sugg = target.closest('ins[data-s],del[data-s]') as HTMLElement | null;
    const inTable = !!target.closest('td');
    if (!sugg && !inTable) return; // the system menu keeps the spelling suggestions
    e.preventDefault();
    const entries: MenuEntry[] = [];
    if (sugg) {
      const id = sugg.getAttribute('data-s')!;
      entries.push({ label: 'Accept suggestion', cmd: `accept:${id}` }, { label: 'Reject suggestion', cmd: `reject:${id}` });
      if (inTable) entries.push({ separator: true });
    }
    if (inTable) entries.push(...TABLE_MENU);
    setCtx({ entries, x: e.clientX, y: e.clientY });
  };

  /* ---------- image toolbar ---------- */

  const setImage = (patch: { w?: number; alt?: string; remove?: boolean }): void => {
    if (!imgSel) return;
    const at = imgSel.pos;
    setImgSel(null);
    exec('Image', (d) => {
      const tb = textBlocks(d)[at.b];
      const run = tb && runAtOffset(tb.para.runs, at.o);
      if (!run || !('img' in run)) throw new DocError('The image moved — click it again');
      if (patch.remove) { tb.para.runs = tb.para.runs.filter((r) => r !== run); return caretRange(at); }
      if (patch.w) { const ratio = run.w && run.h ? run.h / run.w : 0; run.w = Math.round(patch.w); if (ratio) run.h = Math.round(patch.w * ratio); }
      if (patch.alt !== undefined) { if (patch.alt) run.alt = patch.alt; else delete run.alt; }
      return caretRange({ b: at.b, o: at.o + 1 });
    });
  };

  /* ---------- derived view data ---------- */

  const stats: DocStats | null = useMemo(() => (doc ? docStats(doc) : null), [doc]);
  const heads = useMemo(() => (doc ? outline(doc) : []), [doc]);
  const comments = useMemo(() => (doc ? orderedComments(doc) : []), [doc]);
  const suggestions = useMemo(() => (doc ? listSuggestions(doc) : []), [doc]);
  const notes = useMemo(() => {
    if (!doc) return [];
    const n = footnoteNumbers(doc);
    return doc.footnotes.filter((f) => n.has(f.id)).sort((a, b) => (n.get(a.id) ?? 0) - (n.get(b.id) ?? 0)).map((f) => ({ ...f, n: n.get(f.id) ?? 0 }));
  }, [doc]);
  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);
  const pageCss = useMemo(() => (doc ? docPageCss('.dc-surface', doc) : ''), [doc]);
  const saveState = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  const hfValue: HeaderFooterValue = { header: doc?.header?.text ?? '', headerAlign: doc?.header?.align ?? 'left', footer: doc?.footer?.text ?? '', footerAlign: doc?.footer?.align ?? 'left', firstPageDifferent: !!doc?.firstPageDifferent };

  const selectComment = (id: string): void => {
    setActiveComment(id);
    const d = docRef.current, el = surfaceRef.current;
    if (!d || !el) return;
    const tbs = textBlocks(d);
    for (let b = 0; b < tbs.length; b++) {
      let at = 0, start = -1, end = -1;
      for (const r of tbs[b].para.runs) { const len = isTextRun(r) ? r.t.length : 1; if (r.c?.includes(id)) { if (start < 0) start = at; end = at + len; } at += len; }
      if (start >= 0) { selectMatch({ from: { b, o: start }, to: { b, o: end } }); return; }
    }
  };
  const selectSuggestion = (id: string): void => {
    const el = surfaceRef.current;
    const node = el?.querySelector(`[data-s="${id}"]`);
    node?.scrollIntoView({ block: 'center' });
  };

  /* ---------- menus ---------- */

  const has = !!doc;
  const menuDefs: Record<string, MenuEntry[]> = {
    File: [
      { label: 'New document', cmd: 'new' },
      { label: 'Open', cmd: 'open' },
      { label: 'Make a copy', disabled: !has, cmd: 'copyDoc' },
      { separator: true },
      { label: 'Import file (Markdown, HTML, Word, text)…', cmd: 'import' },
      { label: 'Download', disabled: !has, sub: [
        { label: 'Microsoft Word (.docx)', cmd: 'export:docx' }, { label: 'Markdown (.md)', cmd: 'export:md' }, { label: 'Web page (.html)', cmd: 'export:html' },
        { label: 'Plain text (.txt)', cmd: 'export:txt' }, { label: 'PDF (print)', cmd: 'print' },
      ] },
      { separator: true },
      { label: 'Page setup…', disabled: !has, cmd: 'pageSetup' },
      { label: 'Print', keys: 'Ctrl+P', disabled: !has, cmd: 'print' },
      { separator: true },
      { label: 'Move to trash', disabled: !has, cmd: 'trash' },
    ],
    Edit: [
      { label: 'Undo', keys: 'Ctrl+Z', disabled: hist.undo === 0, cmd: 'undo' },
      { label: 'Redo', keys: 'Ctrl+Y', disabled: hist.redo === 0, cmd: 'redo' },
      { separator: true },
      { label: 'Cut', keys: 'Ctrl+X', cmd: 'clip:cut' },
      { label: 'Copy', keys: 'Ctrl+C', cmd: 'clip:copy' },
      { label: 'Paste without formatting', keys: 'Ctrl+Shift+V', cmd: 'pastePlain' },
      { label: 'Select all', keys: 'Ctrl+A', cmd: 'clip:selectAll' },
      { separator: true },
      { label: 'Find and replace', keys: 'Ctrl+H', disabled: !has, cmd: 'find:replace' },
    ],
    View: [
      { label: 'Mode', sub: [{ label: 'Editing', checked: mode === 'editing', cmd: 'mode:editing' }, { label: 'Suggesting', checked: mode === 'suggesting', cmd: 'mode:suggesting' }] },
      { separator: true },
      { label: 'Show outline', checked: showOutline, cmd: 'view:outline' },
      { label: 'Show ruler', checked: showRuler, cmd: 'view:ruler' },
      { label: 'Show comments', checked: showComments, cmd: 'view:comments' },
      { label: 'Show word count', checked: showCount, cmd: 'view:count' },
      { separator: true },
      { label: 'Zoom', sub: ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: zoom === z, cmd: `zoom:${z}` })) },
    ],
    Insert: [
      { label: 'Image…', disabled: !has, cmd: 'image' },
      { label: 'Table…', disabled: !has, cmd: 'tableDialog' },
      { label: 'Horizontal line', disabled: !has, cmd: 'block:hr' },
      { label: 'Page break', keys: 'Ctrl+Enter', disabled: !has, cmd: 'block:pagebreak' },
      { label: 'Table of contents', disabled: !has, cmd: 'block:toc' },
      { separator: true },
      { label: 'Link', keys: 'Ctrl+K', disabled: !has, cmd: 'link' },
      { label: 'Comment', keys: 'Ctrl+Alt+M', disabled: !has, cmd: 'comment' },
      { label: 'Footnote', keys: 'Ctrl+Alt+F', disabled: !has, cmd: 'footnote' },
      { label: 'Equation…', disabled: !has, cmd: 'equation' },
      { label: 'Special characters…', disabled: !has, cmd: 'chars' },
      { label: 'Date', disabled: !has, cmd: 'date' },
      { separator: true },
      { label: 'Headers & footers…', disabled: !has, cmd: 'hf' },
      { label: 'Page numbers', disabled: !has, cmd: 'pageNumbers' },
    ],
    Format: [
      { label: 'Text', disabled: !has, sub: [
        { label: 'Bold', keys: 'Ctrl+B', cmd: 'mark:b' }, { label: 'Italic', keys: 'Ctrl+I', cmd: 'mark:i' }, { label: 'Underline', keys: 'Ctrl+U', cmd: 'mark:u' },
        { label: 'Strikethrough', keys: 'Alt+Shift+5', cmd: 'mark:s' }, { label: 'Superscript', keys: 'Ctrl+.', cmd: 'mark:sup' }, { label: 'Subscript', keys: 'Ctrl+,', cmd: 'mark:sub' },
        { label: 'Code', cmd: 'mark:code' },
      ] },
      { label: 'Paragraph styles', disabled: !has, sub: PARA_STYLES.map((st) => ({ label: st.label, keys: st.id === 'normal' ? 'Ctrl+Alt+0' : /^h\d$/.test(st.id) ? `Ctrl+Alt+${st.id[1]}` : undefined, checked: fmt.style === st.id, cmd: `style:${st.id}` })) },
      { label: 'Align & indent', disabled: !has, sub: [
        { label: 'Left', keys: 'Ctrl+Shift+L', cmd: 'align:left' }, { label: 'Centre', keys: 'Ctrl+Shift+E', cmd: 'align:center' }, { label: 'Right', keys: 'Ctrl+Shift+R', cmd: 'align:right' },
        { label: 'Justified', keys: 'Ctrl+Shift+J', cmd: 'align:justify' }, { separator: true }, { label: 'Increase indent', keys: 'Ctrl+]', cmd: 'indent:1' }, { label: 'Decrease indent', keys: 'Ctrl+[', cmd: 'indent:-1' },
      ] },
      { label: 'Line & paragraph spacing', disabled: !has, sub: [
        ...[1, 1.15, 1.5, 2].map((lh) => ({ label: lh === 1 ? 'Single' : lh === 2 ? 'Double' : String(lh), checked: Math.abs(fmt.lh - lh) < 0.01, cmd: `lh:${lh}` })),
        { separator: true }, { label: 'Add space before paragraph', cmd: 'space:sb:10' }, { label: 'Remove space before paragraph', cmd: 'space:sb:0' },
        { label: 'Add space after paragraph', cmd: 'space:sa:10' }, { label: 'Remove space after paragraph', cmd: 'space:sa:0' },
      ] },
      { label: 'Bullets & numbering', disabled: !has, sub: [
        { label: 'Bulleted list', keys: 'Ctrl+Shift+8', cmd: 'list:bullet' }, { label: 'Numbered list', keys: 'Ctrl+Shift+7', cmd: 'list:number' }, { label: 'Checklist', keys: 'Ctrl+Shift+9', cmd: 'list:check' },
        { label: 'Remove list', cmd: 'list:none' },
      ] },
      { label: 'Table', disabled: !has, sub: TABLE_MENU },
      { separator: true },
      { label: 'Clear formatting', keys: 'Ctrl+\\', disabled: !has, cmd: 'clear' },
    ],
    Tools: [
      { label: 'Word count', keys: 'Ctrl+Shift+C', disabled: !has, cmd: 'count' },
      { label: 'Spelling (system spell checker)', checked: spell, cmd: 'spell' },
      { label: 'Writing review', disabled: !has, cmd: 'review' },
      { label: 'Review suggested edits', disabled: !has || !suggestions.length, sub: [{ label: 'Accept all', cmd: 'accept:all' }, { label: 'Reject all', cmd: 'reject:all' }] },
      { label: 'Document outline', checked: showOutline, cmd: 'view:outline' },
      { separator: true },
      { label: 'Keyboard shortcuts', keys: 'Ctrl+/', cmd: 'shortcuts' },
      { label: 'What is not supported', cmd: 'limits' },
    ],
  };
  /** Runs a menu command ("name" or "name:argument"). */
  const runCmd = (cmd: string): void => {
    const cut = cmd.indexOf(':');
    const name = cut < 0 ? cmd : cmd.slice(0, cut), arg = cut < 0 ? '' : cmd.slice(cut + 1);
    setCtx(null);
    switch (name) {
      case 'new': setDialog({ kind: 'new' }); return;
      case 'open': setFilesOpen(true); return;
      case 'copyDoc': void copyDocument(); return;
      case 'import': fileInput.current?.click(); return;
      case 'export': void exportAs(arg as 'docx' | 'md' | 'html' | 'txt'); return;
      case 'print': print(); return;
      case 'pageSetup': setDialog({ kind: 'page' }); return;
      case 'trash': if (current) { setFilesOpen(true); setConfirmDelete(current); } return;
      case 'undo': undo(); return;
      case 'redo': redo(); return;
      case 'clip': focusEditor(); document.execCommand(arg); return;
      case 'pastePlain': void navigator.clipboard?.readText().then((t) => { if (t) insertAtCaret('Paste', (d, pos) => insertFragment(d, pos, textToBlocks(d, t))); }).catch(() => notify('Use Ctrl+Shift+V to paste without formatting.')); return;
      case 'find': setDialog({ kind: 'find', replace: arg === 'replace' }); return;
      case 'mode': setMode(arg === 'suggesting' ? 'suggesting' : 'editing'); focusEditor(); return;
      case 'view':
        if (arg === 'outline') setShowOutline((v) => !v);
        else if (arg === 'ruler') setShowRuler((v) => !v);
        else if (arg === 'comments') setShowComments((v) => !v);
        else { const v = !showCount; setShowCount(v); try { localStorage.setItem(COUNT_KEY, v ? '1' : '0'); } catch { /* ignore */ } }
        return;
      case 'zoom': setZoom(Number(arg) || 1); return;
      case 'image': imageInput.current?.click(); return;
      case 'tableDialog': setDialog({ kind: 'table' }); return;
      case 'block': insertBlock(arg as 'hr' | 'pagebreak' | 'toc'); return;
      case 'link': openLink(); return;
      case 'comment': startComment(); return;
      case 'footnote': insertFootnote(); return;
      case 'equation': setDialog({ kind: 'equation', initial: '' }); return;
      case 'chars': setDialog({ kind: 'chars' }); return;
      case 'date': insertChar(today()); return;
      case 'hf': setDialog({ kind: 'hf' }); return;
      case 'pageNumbers': exec('Page numbers', (d) => { d.footer = { text: '{page}', align: 'right' }; }, { keepFocus: true }); return;
      case 'mark': toggle(arg as 'b', `Format ${arg}`); return;
      case 'style': setStyle(arg as ParaStyle); return;
      case 'align': setAlign(arg as Align); return;
      case 'indent': doIndent(arg === '1' ? 1 : -1); return;
      case 'lh': setLineHeight(Number(arg)); return;
      case 'space': { const [k, v] = arg.split(':'); setSpace(k as 'sb' | 'sa', Number(v)); return; }
      case 'list': if (arg === 'none') removeList(); else list(arg as ListKind); return;
      case 'table': tableAction(arg); return;
      case 'clear': clearFmt(); return;
      case 'count': openCount(); return;
      case 'spell': setSpell((v) => !v); return;
      case 'review': sync(); setDialog({ kind: 'review' }); return;
      case 'accept': exec('Accept', (d) => { acceptSuggestion(d, arg); }, { keepFocus: true }); return;
      case 'reject': exec('Reject', (d) => { rejectSuggestion(d, arg); }, { keepFocus: true }); return;
      case 'shortcuts': setHelpOpen(true); return;
      case 'limits': setDialog({ kind: 'limits' }); return;
    }
  };
  const tableAction = (arg: string): void => {
    if (arg === 'merge') { mergeCells(); return; }
    if (arg.startsWith('bg')) { cellBackground(arg.slice(3)); return; }
    tableCmd('Table', (d, c) => {
      const t = d.blocks[c.top] as Table;
      const near = (): Pos => ({ b: Math.max(0, Math.min(textBlocks(d).length - 1, textBlocks(d).findIndex((x) => x.top >= c.top))), o: 0 });
      switch (arg) {
        case 'rowAbove': tableInsertRow(d, c.top, c.r); return;
        case 'rowBelow': tableInsertRow(d, c.top, c.r + (t.rows[c.r][c.c].rs ?? 1)); return;
        case 'colLeft': tableInsertCol(d, c.top, c.c); return;
        case 'colRight': tableInsertCol(d, c.top, c.c + (t.rows[c.r][c.c].cs ?? 1)); return;
        case 'deleteRow': tableDeleteRow(d, c.top, c.r); return near();
        case 'deleteCol': tableDeleteCol(d, c.top, c.c); return near();
        case 'deleteTable': d.blocks.splice(c.top, 1); ensureTrailingPara(d); return near();
        case 'unmerge': tableUnmerge(d, c.top, c.r, c.c); return;
      }
    });
  };
  const openCount = (): void => {
    sync();
    const d = docRef.current, sel = lastSel.current;
    setDialog({ kind: 'count', selection: d && sel && !isCollapsed(sel) ? docStats(d, sel) : null });
  };

  const toolPopup = (id: string, body: ReactNode, wide = false) => (tool === id ? <div className={`dc__popup dc-toolpop${wide ? ' dc-toolpop--wide' : ''}`} role="menu" aria-label={id} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>{body}</div> : null);
  const palette = (bg: boolean) => (
    <div className="dc-palette">
      {bg && <button type="button" className="dc-palette__none" onClick={() => setColor('', true)}>None</button>}
      <div className="dc-palette__grid">{TEXT_COLORS.map((c) => <button key={c} type="button" aria-label={`${bg ? 'Highlight' : 'Text'} ${c}`} title={c} style={{ background: c }} onClick={() => setColor(c, bg)} />)}</div>
      <label className="dc-palette__custom">Custom <input type="color" aria-label={bg ? 'Custom highlight colour' : 'Custom text colour'} onChange={(e) => setColor(e.target.value, bg)} /></label>
    </div>
  );
  const styleLabel = PARA_STYLES.find((s) => s.id === fmt.style)?.label ?? 'Normal text';
  const g = geometry;
  const date = today();

  return (
    <div className="screen dc">
      <header className="screen-header">
        <h1 className="screen-header__title">Docs</h1>
        <span className="screen-header__meta">Google Docs-style documents — the Writer agent works on the same files</span>
        {current && <span className={`dc__save dc__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="dc__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => { setFilesOpen((o) => !o); setConfirmDelete(null); }}>
            <FileText size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Documents'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="dc__popup dc__popup--list" role="menu" aria-label="Documents">
              {refs.length === 0 && <p className="dc-note dc-pad">No documents yet — create one, or ask the Writer agent.</p>}
              {grouped.map(([owner, items]) => (
                <div key={owner}>
                  <div className="dc__owner">{owner}</div>
                  {items.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`dc__file${key === current ? ' dc__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="dc__file-main" title={docsPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openDocFile(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="dc-icon dc-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteFile(key)}><Check size={12} /></button>
                            <button type="button" className="dc-icon" aria-label="Keep document" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="dc-icon dc__file-del" aria-label={`Delete ${ref.slug}`} title="Delete document" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New document</button>
      </header>

      <div className="screen-body dc__body">
        <div className="dc__main" onPointerDown={(e) => { const t = e.target as HTMLElement; if (!t.closest('.dc__menu, .dc-toolwrap, .dc__popup')) { if (menu) setMenu(null); if (tool) setTool(null); } if (ctx && !t.closest('.dc-ctx')) setCtx(null); }}>
          {doc ? (
            <>
              <div className="dc__titlerow">
                <FileText size={22} className="dc__logo" strokeWidth={1.5} />
                <input className="dc__title" aria-label="Document title" defaultValue={doc.title} key={`${current}:${doc.title}`} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== doc.title) exec('Rename', (d) => { d.title = v; }, { keepFocus: true }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
                <span className="dc-grow" />
                <div className="dc-toolwrap">
                  <button type="button" className={`dc-mode dc-mode--${mode}`} aria-label="Editing mode" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'mode' ? null : 'mode')}>
                    <PenLine size={13} /> {mode === 'editing' ? 'Editing' : 'Suggesting'} <ChevronDown size={11} />
                  </button>
                  {tool === 'mode' && (
                    <div className="dc__popup dc-toolpop dc-toolpop--right" role="menu" aria-label="Mode">
                      <button type="button" role="menuitemradio" aria-checked={mode === 'editing'} onClick={() => { setMode('editing'); setTool(null); focusEditor(); }}><span><b>Editing</b> Edit the document directly</span></button>
                      <button type="button" role="menuitemradio" aria-checked={mode === 'suggesting'} onClick={() => { setMode('suggesting'); setTool(null); focusEditor(); }}><span><b>Suggesting</b> Edits become suggestions</span></button>
                    </div>
                  )}
                </div>
              </div>
              <nav className="dc__menubar" aria-label="Docs menu">
                {MENU_NAMES.map((name) => ({ name, entries: menuDefs[name] })).map(({ name, entries }) => (
                  <div key={name} className="dc__menu">
                    <button type="button" className={`dc__menu-btn${menu === name ? ' dc__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMenu(menu === name ? null : name); setSubOpen(null); }} onMouseEnter={() => { if (menu) { setMenu(name); setSubOpen(null); } }}>{name}</button>
                    {menu === name && <MenuPopup entries={entries} label={name} subOpen={subOpen} setSubOpen={setSubOpen} onCommand={runCmd} onClose={() => { setMenu(null); setSubOpen(null); }} />}
                  </div>
                ))}
                <span className="dc-grow" />
                <TB label="Keyboard shortcuts" icon={<Keyboard size={15} />} onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (Ctrl+/)" />
              </nav>
              <div className="dc__toolbar" role="toolbar" aria-label="Formatting toolbar">
                <TB label="Undo" icon={<Undo2 size={15} />} onClick={undo} disabled={hist.undo === 0} title="Undo (Ctrl+Z)" />
                <TB label="Redo" icon={<Redo2 size={15} />} onClick={redo} disabled={hist.redo === 0} title="Redo (Ctrl+Y)" />
                <TB label="Print" icon={<Printer size={15} />} onClick={print} title="Print (Ctrl+P)" />
                <TB label="Paint format" icon={<Paintbrush size={15} />} on={painting} onClick={() => { const sel = currentSel(); if (painting) { paintRef.current = null; setPainting(false); return; } const d = docRef.current; if (!sel || !d) return; const tb = textBlocks(d)[orderRange(sel).from.b]; const run = tb && runAtOffset(tb.para.runs, orderRange(sel).from.o); const m: Marks = {}; if (run) for (const k of ['b', 'i', 'u', 's', 'sup', 'sub', 'code', 'color', 'bg', 'font', 'size'] as const) if (run[k] !== undefined) (m as Record<string, unknown>)[k] = run[k]; paintRef.current = m; setPainting(true); }} />
                <select className="dc-tbselect" aria-label="Zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}</select>
                <span className="dc-sep" />
                <div className="dc-toolwrap">
                  <button type="button" className="dc-tbdrop dc-tbdrop--style" aria-label="Styles" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Styles' ? null : 'Styles')}>{styleLabel}<ChevronDown size={11} /></button>
                  {toolPopup('Styles', <>{PARA_STYLES.map((s) => <button key={s.id} type="button" role="menuitemradio" aria-checked={fmt.style === s.id} className={`dc-stylepick dc-stylepick--${s.id}`} onClick={() => setStyle(s.id)}><span>{s.label}</span></button>)}</>, true)}
                </div>
                <span className="dc-sep" />
                <div className="dc-toolwrap">
                  <button type="button" className="dc-tbdrop dc-tbdrop--font" aria-label="Font" aria-haspopup="menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setTool(tool === 'Font' ? null : 'Font')} style={{ fontFamily: fmt.font }}>{fmt.font}<ChevronDown size={11} /></button>
                  {toolPopup('Font', <>{FONTS.map((f) => <button key={f} type="button" role="menuitemradio" aria-checked={fmt.font === f} style={{ fontFamily: f }} onClick={() => setFont(f)}><span>{f}</span></button>)}</>)}
                </div>
                <span className="dc-sep" />
                <TB label="Decrease font size" icon={<Minus size={13} />} onClick={() => setSize(Math.max(1, fmt.size - 1))} />
                <div className="dc-toolwrap">
                  <input className="dc-tbsize" aria-label="Font size" key={`${fmt.size}`} defaultValue={fmt.size} onFocus={(e) => { e.target.select(); setTool('Size'); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const n = Number((e.target as HTMLInputElement).value); if (n >= 1 && n <= 400) setSize(n); } if (e.key === 'Escape') { setTool(null); focusEditor(); } }} />
                  {toolPopup('Size', <>{FONT_SIZES.map((n) => <button key={n} type="button" role="menuitem" onClick={() => setSize(n)}><span>{n}</span></button>)}</>)}
                </div>
                <TB label="Increase font size" icon={<Plus size={13} />} onClick={() => setSize(fmt.size + 1)} />
                <span className="dc-sep" />
                <TB label="Bold" icon={<Bold size={15} />} on={fmt.b} onClick={() => toggle('b', 'Bold')} title="Bold (Ctrl+B)" />
                <TB label="Italic" icon={<Italic size={15} />} on={fmt.i} onClick={() => toggle('i', 'Italic')} title="Italic (Ctrl+I)" />
                <TB label="Underline" icon={<Underline size={15} />} on={fmt.u} onClick={() => toggle('u', 'Underline')} title="Underline (Ctrl+U)" />
                <TB label="Strikethrough" icon={<Strikethrough size={15} />} on={fmt.s} onClick={() => toggle('s', 'Strikethrough')} title="Strikethrough (Alt+Shift+5)" />
                <div className="dc-toolwrap">
                  <TB label="Text colour" icon={<span className="dc-tbcolor"><Type size={14} /><i style={{ background: fmt.color }} /></span>} onClick={() => setTool(tool === 'Text colour' ? null : 'Text colour')} />
                  {toolPopup('Text colour', palette(false))}
                </div>
                <div className="dc-toolwrap">
                  <TB label="Highlight colour" icon={<span className="dc-tbcolor"><Highlighter size={14} /><i style={{ background: fmt.bg || 'transparent' }} /></span>} onClick={() => setTool(tool === 'Highlight colour' ? null : 'Highlight colour')} />
                  {toolPopup('Highlight colour', palette(true))}
                </div>
                <span className="dc-sep" />
                <TB label="Insert link" icon={<Link2 size={15} />} on={!!fmt.link} onClick={openLink} title="Insert link (Ctrl+K)" />
                <TB label="Add comment" icon={<MessageSquarePlus size={15} />} onClick={startComment} title="Add comment (Ctrl+Alt+M)" />
                <TB label="Insert image" icon={<ImagePlus size={15} />} onClick={() => imageInput.current?.click()} />
                <div className="dc-toolwrap">
                  <TB label="Insert table" icon={<span className="dc-tbtext">⊞</span>} onClick={() => setTool(tool === 'Table' ? null : 'Table')} />
                  {toolPopup('Table', <TableGrid onPick={insertTable} />)}
                </div>
                <span className="dc-sep" />
                <TB label="Left align" icon={<AlignLeft size={15} />} on={fmt.align === 'left'} onClick={() => setAlign('left')} title="Left align (Ctrl+Shift+L)" />
                <TB label="Center align" icon={<AlignCenter size={15} />} on={fmt.align === 'center'} onClick={() => setAlign('center')} title="Centre align (Ctrl+Shift+E)" />
                <TB label="Right align" icon={<AlignRight size={15} />} on={fmt.align === 'right'} onClick={() => setAlign('right')} title="Right align (Ctrl+Shift+R)" />
                <TB label="Justify" icon={<AlignJustify size={15} />} on={fmt.align === 'justify'} onClick={() => setAlign('justify')} title="Justify (Ctrl+Shift+J)" />
                <div className="dc-toolwrap">
                  <TB label="Line & paragraph spacing" icon={<span className="dc-tbtext">↕≡</span>} onClick={() => setTool(tool === 'Spacing' ? null : 'Spacing')} />
                  {toolPopup('Spacing', <>{[1, 1.15, 1.5, 2].map((lh) => <button key={lh} type="button" role="menuitemradio" aria-checked={Math.abs(fmt.lh - lh) < 0.01} onClick={() => setLineHeight(lh)}><span>{lh === 1 ? 'Single' : lh === 2 ? 'Double' : lh}</span></button>)}<hr /><button type="button" role="menuitem" onClick={() => setSpace('sb', 10)}><span>Add space before paragraph</span></button><button type="button" role="menuitem" onClick={() => setSpace('sa', 10)}><span>Add space after paragraph</span></button><button type="button" role="menuitem" onClick={() => { setSpace('sb', 0); }}><span>Remove space before paragraph</span></button></>)}
                </div>
                <TB label="Checklist" icon={<CheckSquare size={15} />} on={fmt.list === 'check'} onClick={() => list('check')} title="Checklist (Ctrl+Shift+9)" />
                <TB label="Bulleted list" icon={<List size={15} />} on={fmt.list === 'bullet'} onClick={() => list('bullet')} title="Bulleted list (Ctrl+Shift+8)" />
                <TB label="Numbered list" icon={<ListOrdered size={15} />} on={fmt.list === 'number'} onClick={() => list('number')} title="Numbered list (Ctrl+Shift+7)" />
                <TB label="Decrease indent" icon={<IndentDecrease size={15} />} onClick={() => doIndent(-1)} title="Decrease indent (Ctrl+[)" />
                <TB label="Increase indent" icon={<IndentIncrease size={15} />} onClick={() => doIndent(1)} title="Increase indent (Ctrl+])" />
                <TB label="Clear formatting" icon={<Eraser size={15} />} onClick={clearFmt} title="Clear formatting (Ctrl+\)" />
                <span className="dc-sep" />
                <TB label="Show outline" icon={<ListTree size={15} />} on={showOutline} onClick={() => setShowOutline((v) => !v)} />
              </div>
              <div className="dc__work">
                {showOutline && (
                  <aside className="dc-outline" aria-label="Document outline">
                    <div className="dc-side__head">Outline<button type="button" className="dc-icon" aria-label="Close outline" onClick={() => setShowOutline(false)}><X size={13} /></button></div>
                    {heads.length ? <ul>{heads.map((h) => <li key={h.id}><button type="button" className={`dc-outline__item dc-outline__item--${h.level}`} onClick={() => scrollToBlock(h.top)}>{h.text}</button></li>)}</ul>
                      : <p className="dc-note">Headings you add to the document will appear here.</p>}
                  </aside>
                )}
                <div className="dc-canvas" ref={canvasRef} onScroll={() => { if (imgSel) setImgSel(null); }}>
                  {showRuler && <Ruler g={g} margins={doc.page.margins} zoom={zoom} onChange={(m) => exec('Margins', (d) => { d.page.margins = m; }, { keepFocus: true })} />}
                  <div className="dc-pages" style={{ zoom, width: g.pageW, minHeight: pages * g.stride - 16 }} data-pages={pages}
                    onMouseDown={(e) => { if ((e.target as HTMLElement).classList.contains('dc-sheet')) { e.preventDefault(); const el = surfaceRef.current; const d = docRef.current; if (el && d) { const n = textBlocks(d).length - 1; el.focus(); writeSelection(el, caretRange({ b: n, o: paraLen(textBlocks(d)[n].para) })); } } }}>
                    {Array.from({ length: pages }, (_, k) => (
                      <div key={k} className="dc-sheet" style={{ top: k * g.stride, height: g.pageH, background: doc.page.color ?? '#ffffff' }} onDoubleClick={(e) => { const y = e.nativeEvent.offsetY; if (y < g.mt || y > g.pageH - g.mb) setDialog({ kind: 'hf' }); }}>
                        {doc.header && !(doc.firstPageDifferent && k === 0) && <div className="dc-hf dc-hf--head" style={{ top: Math.max(8, g.mt / 2 - 8), left: g.ml, right: g.pageW - g.ml - g.contentW, textAlign: doc.header.align ?? 'left' }}>{fillFields(doc.header.text, { page: k + 1, pages, title: doc.title, date })}</div>}
                        {doc.footer && !(doc.firstPageDifferent && k === 0) && <div className="dc-hf dc-hf--foot" style={{ bottom: Math.max(8, g.mb / 2 - 8), left: g.ml, right: g.pageW - g.ml - g.contentW, textAlign: doc.footer.align ?? 'left' }} data-testid={`footer-${k + 1}`}>{fillFields(doc.footer.text, { page: k + 1, pages, title: doc.title, date })}</div>}
                      </div>
                    ))}
                    <style>{pageCss}</style>
                    <div ref={surfaceRef} className={`dc-surface dc-surface--${mode}`} role="textbox" aria-multiline="true" aria-label="Document" data-testid="docs-surface" contentEditable suppressContentEditableWarning spellCheck={spell} lang="en"
                      style={{ marginLeft: g.ml, paddingTop: g.mt, width: g.contentW }}
                      onKeyDown={onKeyDown} onInput={() => { if (!composing.current) { scheduleSync(); scheduleLayout(); } }}
                      onCompositionStart={() => { composing.current = true; if (!burstSel.current) burstSel.current = currentSel(); }}
                      onCompositionEnd={(e) => { composing.current = false; if (modeRef.current === 'suggesting' && surfaceRef.current) suggestWrapComposed(surfaceRef.current, e.data, who()); scheduleSync(); scheduleLayout(); }}
                      onPaste={onPaste} onCut={onCut} onDrop={onDrop} onMouseDown={onMouseDown} onClick={onClick} onContextMenu={onContextMenu} onBlur={() => sync()} />
                  </div>
                  {notes.length > 0 && (
                    <section className="dc-notes" style={{ width: g.pageW * zoom }} aria-label="Footnotes">
                      <h3>Footnotes</h3>
                      {notes.map((f) => (
                        <label key={f.id} className="dc-note-row"><sup>{f.n}</sup>
                          <textarea data-footnote={f.id} aria-label={`Footnote ${f.n}`} rows={1} defaultValue={f.text} key={`${f.id}:${f.text}`} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value; if (v !== f.text) exec('Footnote', (d) => { const x = d.footnotes.find((n) => n.id === f.id); if (x) x.text = v; }, { keepFocus: true }); }} />
                        </label>
                      ))}
                    </section>
                  )}
                </div>
                {showComments && (comments.length > 0 || suggestions.length > 0 || draft) && (
                  <aside className="dc-comments" aria-label="Comments and suggestions">
                    <div className="dc-side__head">Comments{suggestions.length ? ` · ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}` : ''}<button type="button" className="dc-icon" aria-label="Hide comments" onClick={() => setShowComments(false)}><X size={13} /></button></div>
                    {draft && (
                      <div className="dc-card dc-card--on">
                        <div className="dc-card__quote">“{draft.quote}”</div>
                        <textarea className="dc-input dc-area" aria-label="Comment text" rows={3} autoFocus value={draft.text} placeholder="Comment" onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment(); if (e.key === 'Escape') setDraft(null); }} />
                        <div className="dc-row dc-row--end"><button type="button" className="dc-btn" onClick={() => setDraft(null)}>Cancel</button><button type="button" className="dc-btn dc-btn--primary" disabled={!draft.text.trim()} onClick={submitComment}>Comment</button></div>
                      </div>
                    )}
                    {suggestions.map((s) => (
                      <div key={s.id} className="dc-card dc-card--sugg" data-testid="suggestion-card" onClick={() => selectSuggestion(s.id)}>
                        <div className="dc-card__who"><b>{s.author}</b>{s.at && <span>{s.at.slice(0, 16).replace('T', ' ')}</span>}
                          <span className="dc-grow" />
                          <button type="button" className="dc-icon" aria-label={`Accept suggestion ${s.id}`} title="Accept" onClick={(e) => { e.stopPropagation(); exec('Accept', (d) => { acceptSuggestion(d, s.id); }, { keepFocus: true }); }}><Check size={13} /></button>
                          <button type="button" className="dc-icon" aria-label={`Reject suggestion ${s.id}`} title="Reject" onClick={(e) => { e.stopPropagation(); exec('Reject', (d) => { rejectSuggestion(d, s.id); }, { keepFocus: true }); }}><X size={13} /></button>
                        </div>
                        <div className={`dc-card__text dc-card__text--${s.kind}`}>{s.kind === 'ins' ? 'Add' : 'Delete'}: “{s.text.slice(0, 140)}”</div>
                      </div>
                    ))}
                    {comments.map((c) => (
                      <div key={c.id} className={`dc-card${activeComment === c.id ? ' dc-card--on' : ''}${c.resolved ? ' dc-card--resolved' : ''}`} data-testid="comment-card" onClick={() => selectComment(c.id)}>
                        <div className="dc-card__who"><b>{c.author}</b>{c.at && <span>{c.at.slice(0, 16).replace('T', ' ')}</span>}
                          <span className="dc-grow" />
                          <button type="button" className="dc-icon" aria-label={c.resolved ? `Reopen comment ${c.id}` : `Resolve comment ${c.id}`} title={c.resolved ? 'Reopen' : 'Mark as resolved'} onClick={(e) => { e.stopPropagation(); exec('Resolve', (d) => { resolveComment(d, c.id, !c.resolved); }, { keepFocus: true }); }}><Check size={13} /></button>
                          <button type="button" className="dc-icon" aria-label={`Delete comment ${c.id}`} title="Delete" onClick={(e) => { e.stopPropagation(); exec('Delete comment', (d) => { deleteComment(d, c.id); }, { keepFocus: true }); }}><Trash2 size={12} /></button>
                        </div>
                        {c.quote && <div className="dc-card__quote">“{c.quote.slice(0, 120)}”</div>}
                        <div className="dc-card__text">{c.text}</div>
                        {c.replies.map((r, i) => <div key={i} className="dc-card__reply"><b>{r.author}</b> {r.text}</div>)}
                        {activeComment === c.id && !c.resolved && (
                          <div className="dc-card__replybox" onClick={(e) => e.stopPropagation()}>
                            <input className="dc-input" aria-label="Reply" placeholder="Reply" value={replyText[c.id] ?? ''} onChange={(e) => setReplyText({ ...replyText, [c.id]: e.target.value })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.preventDefault(); if (e.key === 'Enter' && (replyText[c.id] ?? '').trim()) { const t = replyText[c.id]; setReplyText({ ...replyText, [c.id]: '' }); exec('Reply', (d) => { replyComment(d, c.id, t, AUTHOR, nowIso()); }, { keepFocus: true }); } }} />
                          </div>
                        )}
                      </div>
                    ))}
                  </aside>
                )}
              </div>
              <div className="dc__status">
                <span data-testid="page-count">{pages} page{pages === 1 ? '' : 's'}</span>
                {(showCount || selWords !== null) && stats && <span data-testid="word-count">{selWords !== null ? `${selWords} of ${stats.words} words` : `${stats.words} words`}</span>}
                {!showCount && selWords === null && stats && <button type="button" className="dc-link" onClick={openCount}>{stats.words} words</button>}
                <span className="dc-grow" />
                {mode === 'suggesting' && <span className="dc__badge">Suggesting</span>}
                {(comments.length > 0 || suggestions.length > 0) && !showComments && <button type="button" className="dc-link" onClick={() => setShowComments(true)}>{comments.filter((c) => !c.resolved).length} comments · {suggestions.length} suggestions</button>}
              </div>
              {imgSel && (
                <div className="dc-imgbar" style={{ left: Math.min(imgSel.x, window.innerWidth - 420), top: Math.min(imgSel.y, window.innerHeight - 60) }} role="toolbar" aria-label="Image options" onMouseDown={(e) => e.preventDefault()}>
                  {[0.25, 0.5, 0.75, 1].map((f) => <button key={f} type="button" className="dc-btn" onClick={() => setImage({ w: g.contentW * f })}>{f === 1 ? 'Full width' : `${f * 100}%`}</button>)}
                  <button type="button" className="dc-btn" onClick={() => { const at = imgSel; setDialog({ kind: 'prompt', title: 'Alt text', label: 'Describe the image for people who cannot see it', initial: at.alt, onOk: (v) => { setDialog(null); setImgSel(at); window.setTimeout(() => setImage({ alt: v }), 0); } }); }}>Alt text</button>
                  <button type="button" className="dc-btn" onClick={() => setImage({ remove: true })}>Remove</button>
                </div>
              )}
            </>
          ) : (
            <div className="dc__welcome">
              <FileText size={34} strokeWidth={1.25} />
              <h2>Docs</h2>
              <p>Documents the Google Docs way: paper-style pages, styles and headings with an outline, lists and checklists, tables, images, footnotes, equations, comments and suggested edits, find and replace, word count, and export to Word, Markdown, HTML or text — saved as files in your repository. Start from a template, import a file, or ask the Writer agent to draft one.</p>
              <div className="dc-gallery" aria-label="Start a new document">
                {TEMPLATES.map((t) => (
                  <button key={t.id} type="button" className="dc-gallery__item" aria-label={`New ${t.label} document`} onClick={() => setDialog({ kind: 'new', template: t.id })}><TemplateThumb id={t.id} /><span>{t.label}</span></button>
                ))}
              </div>
              <div className="dc-row">
                <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New document</button>
                <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><FileText size={12} strokeWidth={1.5} /> Import Markdown, HTML or Word</button>
              </div>
            </div>
          )}
          {ctx && <div className="dc-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 260), top: Math.max(8, Math.min(ctx.y, window.innerHeight - 380)) }}><MenuPopup entries={ctx.entries} label="Context menu" subOpen={subOpen} setSubOpen={setSubOpen} onCommand={runCmd} onClose={() => { setCtx(null); setSubOpen(null); }} /></div>}
          {helpOpen && <ShortcutHelp title="Docs shortcuts" groups={SHORTCUTS} onClose={() => { setHelpOpen(false); focusEditor(); }} />}
          <input ref={fileInput} type="file" hidden aria-label="Import a Markdown, HTML, Word or text file" accept=".md,.markdown,.html,.htm,.txt,.docx" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
          <input ref={imageInput} type="file" hidden aria-label="Insert an image file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void insertImageFile(f); }} />
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('docs')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {dialog?.kind === 'new' && <NewDocDialog initial={dialog.template} onCreate={(n, t) => void newDocument(n, t)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'find' && <FindDialog replaceMode={dialog.replace} initial="" status={findStatus} onChange={onFindChange} onNext={findNext} onReplace={replaceCurrent} onReplaceAll={replaceEvery} onClose={() => { setDialog(null); clearFind(); focusEditor(); }} />}
      {dialog?.kind === 'link' && <LinkDialog text={dialog.text} url={dialog.url} canEditText={dialog.canEditText} onOk={applyLink} onRemove={dialog.url ? removeLink : undefined} onClose={() => { setDialog(null); focusEditor(); }} />}
      {dialog?.kind === 'page' && doc && <PageSetupDialog page={doc.page} onOk={(p) => { setDialog(null); exec('Page setup', (d) => { d.page = p; if (!p.color) delete d.page.color; }, { keepFocus: true }); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'hf' && <HeaderFooterDialog value={hfValue} onOk={(v) => { setDialog(null); exec('Headers & footers', (d) => { if (v.header.trim()) d.header = { text: v.header, ...(v.headerAlign !== 'left' ? { align: v.headerAlign } : {}) }; else delete d.header; if (v.footer.trim()) d.footer = { text: v.footer, ...(v.footerAlign !== 'left' ? { align: v.footerAlign } : {}) }; else delete d.footer; if (v.firstPageDifferent) d.firstPageDifferent = true; else delete d.firstPageDifferent; }, { keepFocus: true }); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'count' && stats && <WordCountDialog stats={stats} selection={dialog.selection} pages={pages} showWhileTyping={showCount} onToggle={(v) => { setShowCount(v); try { localStorage.setItem(COUNT_KEY, v ? '1' : '0'); } catch { /* ignore */ } }} onClose={() => { setDialog(null); focusEditor(); }} />}
      {dialog?.kind === 'chars' && <SpecialCharsDialog onInsert={(ch) => insertChar(ch)} onClose={() => { setDialog(null); focusEditor(); }} />}
      {dialog?.kind === 'equation' && <EquationDialog initial={dialog.initial}
        onOk={(tex) => { const at = dialog.at; setDialog(null); if (at) exec('Equation', (d) => { const tb = textBlocks(d)[at.b]; const run = tb && runAtOffset(tb.para.runs, at.o); if (run && 'eq' in run) run.eq = tex; return caretRange({ b: at.b, o: at.o + 1 }); }); else insertAtCaret('Equation', (d, pos) => insertInline(d, pos, { eq: tex })); }}
        onRemove={dialog.at ? () => { const at = dialog.at!; setDialog(null); exec('Remove equation', (d) => { const tb = textBlocks(d)[at.b]; const run = tb && runAtOffset(tb.para.runs, at.o); if (run) tb.para.runs = tb.para.runs.filter((r) => r !== run); return caretRange(at); }); } : undefined}
        onClose={() => { setDialog(null); focusEditor(); }} />}
      {dialog?.kind === 'table' && <TableDialog onOk={(r, c) => { setDialog(null); insertTable(r, c); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'review' && doc && <ReviewDialog lines={reviewDoc(doc)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limits' && <LimitsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'prompt' && <PromptDialog title={dialog.title} label={dialog.label} initial={dialog.initial} onOk={dialog.onOk} onClose={() => setDialog(null)} />}
    </div>
  );
}

function TB({ label, icon, onClick, on = false, disabled = false, title }: { label: string; icon: ReactNode; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`dc-tb${on ? ' dc-tb--on' : ''}`} aria-label={label} title={title ?? label} aria-pressed={on || undefined} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</button>;
}

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
                  <span>{s.checked !== undefined && <Check size={11} style={{ opacity: s.checked ? 1 : 0 }} />}{/^#[0-9a-f]{6}$/i.test(s.label ?? '') ? <i className="dc-dot" style={{ background: s.label }} /> : null} {s.label}</span>
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


/** The ruler above the page: inch ticks, the margins shaded, and handles to drag the left and right margins. */
function Ruler({ g, margins, zoom, onChange }: { g: ReturnType<typeof pageGeometry>; margins: { top: number; right: number; bottom: number; left: number }; zoom: number; onChange: (m: { top: number; right: number; bottom: number; left: number }) => void }) {
  const [drag, setDrag] = useState<{ side: 'left' | 'right'; x0: number; v0: number; v: number } | null>(null);
  const left = drag?.side === 'left' ? drag.v : margins.left;
  const right = drag?.side === 'right' ? drag.v : margins.right;
  const widthIn = g.pageW / PX_PER_IN;
  const ticks: ReactNode[] = [];
  for (let i = 0; i <= Math.floor(widthIn * 8); i++) {
    const x = (i / 8) * PX_PER_IN;
    const major = i % 8 === 0, half = i % 4 === 0;
    ticks.push(<line key={i} x1={x} x2={x} y1={major ? 4 : half ? 9 : 12} y2={16} />);
    if (major && i > 0 && i / 8 < widthIn) ticks.push(<text key={`t${i}`} x={x} y={10} textAnchor="middle">{i / 8}</text>);
  }
  const start = (side: 'left' | 'right') => (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ side, x0: e.clientX, v0: side === 'left' ? margins.left : margins.right, v: side === 'left' ? margins.left : margins.right }); };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dIn = (e.clientX - drag.x0) / (PX_PER_IN * zoom) * (drag.side === 'left' ? 1 : -1);
    const other = drag.side === 'left' ? margins.right : margins.left;
    const v = Math.round(Math.max(0, Math.min(widthIn - other - 1, drag.v0 + dIn)) * 8) / 8;
    setDrag({ ...drag, v });
  };
  const end = () => { if (!drag) return; const v = drag.v; const side = drag.side; setDrag(null); if (v !== (side === 'left' ? margins.left : margins.right)) onChange({ ...margins, [side]: v }); };
  return (
    <div className="dc-ruler" style={{ zoom, width: g.pageW }} aria-label="Ruler" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="dc-ruler__margin" style={{ left: 0, width: left * PX_PER_IN }} />
      <div className="dc-ruler__margin" style={{ right: 0, width: right * PX_PER_IN }} />
      <svg width={g.pageW} height={18} aria-hidden>{ticks}</svg>
      <button type="button" className="dc-ruler__handle" aria-label="Left margin" title={`Left margin ${left}"`} style={{ left: left * PX_PER_IN - 6 }} onPointerDown={start('left')} />
      <button type="button" className="dc-ruler__handle" aria-label="Right margin" title={`Right margin ${right}"`} style={{ left: g.pageW - right * PX_PER_IN - 6 }} onPointerDown={start('right')} />
    </div>
  );
}
