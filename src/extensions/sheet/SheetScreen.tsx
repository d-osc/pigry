import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, BarChart3, Bold, Check, ChevronDown, ChevronLeft, DollarSign, Filter, Grid3x3, Italic, Keyboard, Link2,
  ListPlus, Menu, MessageSquare, Minus, Paintbrush, PaintBucket, Percent, Plus, Printer, Redo2, Sheet as SheetIcon, Sigma, Strikethrough, Table2, Trash2, Type, Underline, Undo2, WrapText, X,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { nameSlug, parseRefName, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import {
  applyOps, cellAt, checkWorkbook, emptyWorkbook, findSheet, parseDelimited, rangeText, resolveRange, templateOps, toDelimited, usedRect, validate, validationAt,
  type Op, type Sheet, type Workbook,
} from './sheet';
import { Engine } from './engine';
import { FUNCTIONS, FUNCTION_NAMES } from './functions';
import { addr, colName, norm, parseAddr, tokenize, type Rect } from './formula';
import { NUMBER_FORMATS, displayScalar, formatValue, parseInput } from './numfmt';
import { rangeHtml, layoutOf } from './sheetRender';
import { exportXlsx, importXlsx } from './sheetXlsx';
import { SHEET_CHANGED, SHEET_OPEN, listSheetRefs, loadSheet, registerSheetFlush, removeSheet, saveSheet, setOpenSheet, sheetPath, takePendingOpenSheet, type SheetChange, type SheetOpenRequest } from './sheetStore';
import { SheetGrid, rawText, rectA1, selRect, singleSel, type EditorState, type GridApi, type Selection } from './SheetGrid';
import {
  BandingDialog, ChartDialog, CondFormatDialog, FindDialog, FunctionsDialog, Modal, NamedRangesDialog, NewSheetDialog, NumberFormatDialog, PivotDialog, PromptDialog, ReviewDialog, SortDialog, ValidationDialog,
  type FindOptions, type Template,
} from './SheetDialogs';
import './SheetScreen.css';

const LAST_KEY = 'pigry:sheet-last';
const SAVE_DELAY = 900;
const HISTORY_LIMIT = 100;
const REF_COLORS = ['#1a73e8', '#e8710a', '#9334e6', '#188038', '#d93025', '#007b83', '#b06000', '#c5221f'];
const FONTS = ['Arial', 'Roboto', 'Calibri', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana', 'Trebuchet MS', 'Comic Sans MS', 'Noto Sans Thai', 'Sarabun', 'Tahoma'];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];
const TAB_COLORS = ['#ea4335', '#fbbc04', '#34a853', '#4285f4', '#9334e6', '#ff6d01', '#46bdc6', '#5f6368'];

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Move and select', items: [{ keys: '← ↑ → ↓', label: 'Move one cell' }, { keys: 'Shift+Arrow', label: 'Extend the selection' }, { keys: 'Ctrl+Arrow', label: 'Jump to the edge of the data' }, { keys: 'Ctrl+Shift+Arrow', label: 'Select to the edge of the data' }, { keys: 'Tab / Shift+Tab', label: 'Next / previous cell' }, { keys: 'Home / Ctrl+Home / Ctrl+End', label: 'Row start / A1 / last used cell' }, { keys: 'Page Up / Page Down', label: 'One screen up / down' }, { keys: 'Ctrl+A', label: 'Select all' }, { keys: 'Ctrl+Space / Shift+Space', label: 'Select the column / row' }] },
  { title: 'Edit', items: [{ keys: 'Enter / F2', label: 'Edit the cell' }, { keys: 'Enter / Shift+Enter', label: 'Finish and move down / up' }, { keys: 'Tab', label: 'Finish and move right' }, { keys: 'Alt+Enter', label: 'New line in the cell' }, { keys: 'Ctrl+Enter', label: 'Fill the selection with the entry' }, { keys: 'Esc', label: 'Cancel editing' }, { keys: 'F4', label: 'Toggle $ absolute reference' }, { keys: 'Delete / Backspace', label: 'Clear values' }, { keys: 'Ctrl+D / Ctrl+R', label: 'Fill down / right' }, { keys: 'Ctrl+; / Ctrl+Shift+;', label: 'Insert date / time' }, { keys: 'Space', label: 'Toggle a checkbox' }] },
  { title: 'Clipboard and history', items: [{ keys: 'Ctrl+C / Ctrl+X / Ctrl+V', label: 'Copy / cut / paste (TSV with other apps)' }, { keys: 'Ctrl+Shift+V', label: 'Paste values only' }, { keys: 'Ctrl+Z', label: 'Undo' }, { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'Redo' }, { keys: 'Ctrl+S', label: 'Save now' }] },
  { title: 'Format', items: [{ keys: 'Ctrl+B / Ctrl+I / Ctrl+U', label: 'Bold / italic / underline' }, { keys: 'Alt+Shift+5', label: 'Strikethrough' }, { keys: 'Ctrl+Shift+L / E / R', label: 'Align left / centre / right' }, { keys: 'Ctrl+Shift+1', label: 'Number format' }, { keys: 'Ctrl+Shift+2 / 3', label: 'Time / date format' }, { keys: 'Ctrl+Shift+4 / 5 / 6', label: 'Currency / percent / scientific' }, { keys: 'Ctrl+\\', label: 'Clear formatting' }] },
  { title: 'Tools', items: [{ keys: 'Ctrl+F / Ctrl+H', label: 'Find / find and replace' }, { keys: 'Ctrl+K', label: 'Insert link' }, { keys: 'Shift+F2', label: 'Insert note' }, { keys: 'Ctrl+`', label: 'Show formulas' }, { keys: 'Ctrl+/', label: 'This list' }] },
];

interface MenuEntry { label?: string; keys?: string; onSelect?: () => void; disabled?: boolean; separator?: boolean; checked?: boolean; sub?: MenuEntry[] }
interface Doc { wb: Workbook; engine: Engine }
interface HistoryEntry { doc: Doc; label: string; sheet: string; sel: Selection }
type Dialog =
  | { kind: 'new' } | { kind: 'find'; replace: boolean } | { kind: 'cond' } | { kind: 'validation' } | { kind: 'chart'; id?: string } | { kind: 'names' } | { kind: 'pivot' } | { kind: 'sort' }
  | { kind: 'numfmt' } | { kind: 'banding' } | { kind: 'functions' } | { kind: 'review' } | { kind: 'limits' } | { kind: 'import' }
  | { kind: 'prompt'; title: string; label: string; initial: string; multiline?: boolean; onOk: (v: string) => void } | null;

const isWhole = (r: Rect, s: Sheet, axis: 'col' | 'row'): boolean => (axis === 'col' ? r.r1 === 0 && r.r2 >= s.rows - 1 : r.c1 === 0 && r.c2 >= s.cols - 1);
const download = (blob: Blob, name: string): void => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 1500); };
const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The innermost function call around the end of a formula, for the signature hint. */
function enclosingFn(text: string): string | null {
  const stack: string[] = [];
  let q = false;
  const re = /"|([A-Za-z][A-Za-z0-9.]*)\s*\(|\(|\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === '"') { q = !q; continue; }
    if (q) continue;
    if (m[0] === ')') stack.pop(); else stack.push(m[1] ? m[1].toUpperCase() : '');
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
  return null;
}

export function SheetScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sheetId, setSheetId] = useState('s1');
  const [sel, setSel] = useState<Selection>(singleSel(0, 0));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showFormulas, setShowFormulas] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ctx, setCtx] = useState<{ entries: MenuEntry[]; x: number; y: number } | null>(null);
  const [copyRect, setCopyRect] = useState<{ sheet: string; rect: Rect } | null>(null);
  const [found, setFound] = useState<{ sheet: string; r: number; c: number }[]>([]);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [paint, setPaint] = useState<{ sheet: string; rect: Rect } | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [dctx, setDctx] = useState<{ region: Rect; main: string; ranges: string; headers: { col: string; label: string }[]; sortRange: Rect; sortHeaders: { col: string; label: string }[] } | null>(null);
  const [importChoice, setImportChoice] = useState<'new' | 'insert' | 'replace'>('insert');
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const docRef = useRef<Doc | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLTextAreaElement | null>(null);
  const clipRef = useRef<{ sheet: string; rect: Rect; cut: boolean; text: string } | null>(null);
  const pasteValues = useRef(false);
  const caretTo = useRef<number | null>(null);
  const point = useRef<{ start: number; end: number; anchor: { r: number; c: number }; rect: Rect } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importMode = useRef<'new' | 'insert' | 'replace'>('insert');
  const sheetIdRef = useRef('s1');
  const selRef = useRef<Selection>(singleSel(0, 0));
  const editorRef = useRef<EditorState | null>(null);

  const syncHist = (): void => setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
  const refOf = (key: string | null): OwnedRef | null => { if (!key) return null; const { owner, slug } = parseRefName(key, ['.sheet.json']); return { owner: owner ?? USER_OWNER, slug }; };
  const focusGrid = (): void => { window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0); };
  const setSelection = (next: Selection, scroll = false): void => { selRef.current = next; setSel(next); if (scroll) setScrollNonce((n) => n + 1); };
  const setEditorState = (next: EditorState | null): void => { editorRef.current = next; setEditor(next); };

  /* ---------- persistence ---------- */

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), d = docRef.current;
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!ref || !d || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveSheet(ref, d.wb, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the spreadsheet: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
  }, [notify]);
  useEffect(() => registerSheetFlush(saveNow), [saveNow]);
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
  }, [saveNow]);
  useEffect(() => () => {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const ref = refOf(currentRef.current), d = docRef.current;
    if (dirtyRef.current && ref && d) void saveSheet(ref, d.wb, 'editor');
  }, []);

  const applyOpen = useCallback((wb: Workbook, key: string, sheet?: string, cell?: string) => {
    const engine = new Engine(wb);
    const d = { wb, engine };
    docRef.current = d;
    setDoc(d);
    const s = (sheet ? findSheet(wb, sheet) : undefined) ?? wb.sheets.find((x) => !x.hidden) ?? wb.sheets[0];
    sheetIdRef.current = s.id;
    setSheetId(s.id);
    const target = cell ? resolveRange(wb, cell, s) : null;
    const r = target?.rect;
    setSelection(r ? { ranges: [r], active: { r: r.r1, c: r.c1 }, anchor: { r: r.r1, c: r.c1 } } : singleSel(0, 0), true);
    setEditorState(null);
    currentRef.current = key;
    setCurrent(key);
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50);
  }, []);

  const openSheetFile = useCallback(async (key: string, sheet?: string, cell?: string) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    try {
      const { workbook, warnings } = await loadSheet(ref);
      undoStack.current = []; redoStack.current = [];
      dirtyRef.current = false;
      setDirty(false);
      const nextKey = refKey(ref);
      applyOpen(workbook, nextKey, sheet, cell);
      syncHist();
      setOpenSheet(nextKey);
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
      if (warnings.length) notify(`Spreadsheet opened with ${warnings.length} repaired issue(s).`);
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [saveNow, notify, applyOpen]);

  const refreshList = useCallback(async () => { try { setRefs(await listSheetRefs()); } catch { setRefs([]); } }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listSheetRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: SheetOpenRequest | null = takePendingOpenSheet();
      const wanted = request?.key ?? last;
      const found0 = list.find((r) => refKey(r) === wanted) ?? list[0];
      if (found0) await openSheetFile(refKey(found0), request?.sheet, request?.cell);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<SheetChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { setCurrent(null); setDoc(null); docRef.current = null; setOpenSheet(null); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openSheetFile(change.key, sheetIdRef.current); }
    };
    const onOpen = (event: Event) => { const r = (event as CustomEvent<SheetOpenRequest>).detail; takePendingOpenSheet(); void openSheetFile(r.key, r.sheet, r.cell); };
    window.addEventListener(SHEET_CHANGED, onChanged);
    window.addEventListener(SHEET_OPEN, onOpen);
    return () => { window.removeEventListener(SHEET_CHANGED, onChanged); window.removeEventListener(SHEET_OPEN, onOpen); };
  }, [openSheetFile, refreshList]);

  const wb = doc?.wb ?? null;
  const sheet = wb ? (findSheet(wb, sheetId) ?? wb.sheets.find((s) => !s.hidden) ?? wb.sheets[0]) : null;
  useEffect(() => { if (current) setOpenSheet(current, sheet ? `${sheet.name}!${rectA1(selRect(sel))}` : null); }, [current, sheet, sel]);

  /* ---------- editing with undo ---------- */

  const commit = useCallback((next: Workbook, touched: string[] | 'all', label: string): void => {
    const prev = docRef.current;
    if (!prev) return;
    const engine = prev.engine.update(next, touched);
    const d = { wb: next, engine };
    undoStack.current.push({ doc: prev, label, sheet: sheetIdRef.current, sel: selRef.current });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    docRef.current = d;
    setDoc(d);
    if (!findSheet(next, sheetIdRef.current)) { const s = next.sheets.find((x) => !x.hidden) ?? next.sheets[0]; sheetIdRef.current = s.id; setSheetId(s.id); }
    syncHist();
    markDirty();
  }, [markDirty]);

  /** Applies operations to the open workbook (on the active sheet by default). */
  const run = useCallback((ops: Op[], label: string): boolean => {
    const d = docRef.current;
    if (!d) return false;
    const res = applyOps(d.wb, ops, { sheet: sheetIdRef.current, engine: d.engine });
    if (res.error) { notify(res.error.replace(/^op \d+ \([^)]*\): /, ''), 'error'); return false; }
    commit(res.workbook, res.touched, label);
    if (res.created && /^s\d+$/.test(res.created) && ops.some((o) => o.op === 'sheet_add' || o.op === 'sheet_duplicate')) { sheetIdRef.current = res.created; setSheetId(res.created); setSelection(singleSel(0, 0)); }
    return true;
  }, [commit, notify]);

  const swapTo = (target: HistoryEntry, to: HistoryEntry[]): void => {
    const now = docRef.current;
    if (!now) return;
    to.push({ doc: now, label: target.label, sheet: sheetIdRef.current, sel: selRef.current });
    docRef.current = target.doc;
    setDoc(target.doc);
    const s = findSheet(target.doc.wb, target.sheet) ?? target.doc.wb.sheets[0];
    sheetIdRef.current = s.id; setSheetId(s.id);
    setSelection(target.sel, true);
    syncHist();
    markDirty();
  };
  const undo = (): void => { if (editorRef.current) return; const e = undoStack.current.pop(); if (e) swapTo(e, redoStack.current); };
  const redo = (): void => { if (editorRef.current) return; const e = redoStack.current.pop(); if (e) swapTo(e, undoStack.current); };

  /* ---------- helpers on the selection ---------- */

  const sheetNow = (): Sheet | null => { const d = docRef.current; return d ? findSheet(d.wb, sheetIdRef.current) ?? d.wb.sheets[0] : null; };
  const rangesText = (): string => selRef.current.ranges.map(rectA1).join(',');
  const mainRange = (): string => rectA1(selRect(selRef.current));
  const format = (patch: Record<string, unknown>, label: string): void => {
    const ops = selRef.current.ranges.map((r) => ({ op: 'format', range: rectA1(r), ...patch }));
    run(ops, label);
  };
  /** The block of data around the active cell (like Ctrl+A in a table). */
  const currentRegion = (): Rect => {
    const s = sheetNow(), d = docRef.current;
    const base = selRect(selRef.current);
    if (!s || !d || base.r1 !== base.r2 || base.c1 !== base.c2) return base;
    let r = { ...base };
    const filled = (rr: number, cc: number) => d.engine.value(s.id, rr, cc) !== null;
    for (let guard = 0; guard < 5000; guard++) {
      let grew = false;
      const rowHas = (rr: number) => { if (rr < 0 || rr >= s.rows) return false; for (let c = Math.max(0, r.c1 - 1); c <= Math.min(s.cols - 1, r.c2 + 1); c++) if (filled(rr, c)) return true; return false; };
      const colHas = (cc: number) => { if (cc < 0 || cc >= s.cols) return false; for (let rr = Math.max(0, r.r1 - 1); rr <= Math.min(s.rows - 1, r.r2 + 1); rr++) if (filled(rr, cc)) return true; return false; };
      if (rowHas(r.r1 - 1)) { r = { ...r, r1: r.r1 - 1 }; grew = true; }
      if (rowHas(r.r2 + 1)) { r = { ...r, r2: r.r2 + 1 }; grew = true; }
      if (colHas(r.c1 - 1)) { r = { ...r, c1: r.c1 - 1 }; grew = true; }
      if (colHas(r.c2 + 1)) { r = { ...r, c2: r.c2 + 1 }; grew = true; }
      if (!grew) break;
    }
    return r;
  };
  const headersOf = (rect: Rect): { col: string; label: string }[] => {
    const s = sheetNow(), d = docRef.current;
    if (!s || !d) return [];
    const out: { col: string; label: string }[] = [];
    for (let c = rect.c1; c <= Math.min(rect.c2, rect.c1 + 60); c++) out.push({ col: colName(c), label: d.engine.display(s.id, rect.r1, c).text || colName(c) });
    return out;
  };

  /* ---------- editing ---------- */

  const startEdit = (r: number, c: number, text: string, mode: 'enter' | 'edit', origin: 'cell' | 'bar' = 'cell'): void => {
    const s = sheetNow();
    if (!s) return;
    caretTo.current = text.length;
    point.current = null;
    setAcIndex(0);
    setEditorState({ r, c, text, mode, origin, sheet: s.id });
  };
  const editText = (text: string): void => { const e = editorRef.current; if (!e) return; point.current = null; setAcIndex(0); setEditorState({ ...e, text }); };
  const cancelEdit = (): void => { setEditorState(null); point.current = null; focusGrid(); };

  /** Writes the editor's text; moves the active cell by (dr, dc). Returns false when validation rejected it. */
  const commitEdit = (dr = 0, dc = 0, fillSelection = false): boolean => {
    const e = editorRef.current, d = docRef.current;
    if (!e || !d) return true;
    const s = findSheet(d.wb, e.sheet);
    if (!s) { setEditorState(null); return true; }
    const old = cellAt(s, e.r, e.c);
    const before = old?.f ?? rawText(old, d.engine.display(s.id, e.r, e.c).text);
    let text = e.text;
    // close open parentheses like Sheets does
    if (text.startsWith('=')) { let depth = 0, q = false; for (const ch of text) { if (ch === '"') q = !q; else if (!q && ch === '(') depth++; else if (!q && ch === ')') depth--; } if (depth > 0) text += ')'.repeat(depth); }
    const v = validationAt(s, e.r, e.c);
    if (v && !text.startsWith('=') && text !== '') {
      const parsed = parseInput(text).value;
      const msg = validate(d.wb, s, v, parsed as never, d.engine);
      if (msg) {
        if (v.strict) { notify(`Invalid: ${msg}`, 'error'); return false; }
        notify(`Warning: ${msg}`);
      }
    }
    setEditorState(null);
    point.current = null;
    if (text !== before || fillSelection) {
      const range = fillSelection ? selRef.current.ranges.map(rectA1) : [addr(e.r, e.c)];
      run(range.map((rg) => ({ op: 'set', sheet: e.sheet, range: rg, value: text })), 'Edit cell');
    }
    if (sheetIdRef.current !== e.sheet) { sheetIdRef.current = e.sheet; setSheetId(e.sheet); }
    if (dr || dc) moveActive(dr, dc, false, false, { r: e.r, c: e.c });
    focusGrid();
    return true;
  };

  /** Reference insertion while typing a formula (click a cell, or arrows in point mode). */
  const canPoint = (): boolean => {
    const e = editorRef.current, el = e?.origin === 'bar' ? barRef.current : inputRef.current;
    if (!e || !e.text.startsWith('=') || !el) return false;
    const caret = el.selectionStart ?? e.text.length;
    if (point.current && caret === point.current.end) return true;
    return /[=(,+\-*/^&<>:;{]\s*$/.test(e.text.slice(0, caret));
  };
  const pointRef = (rect: Rect, extend: boolean): boolean => {
    const e = editorRef.current, el = e?.origin === 'bar' ? barRef.current : inputRef.current;
    if (!e || !el) return false;
    const s = sheetNow();
    const r = extend && point.current ? norm({ r1: point.current.anchor.r, c1: point.current.anchor.c, r2: rect.r2, c2: rect.c2 }) : rect;
    const prefix = s && s.id !== e.sheet ? `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name) ? s.name : `'${s.name.replace(/'/g, "''")}'`}!` : '';
    const ref = prefix + rectA1(r);
    const start = point.current ? point.current.start : (el.selectionStart ?? e.text.length);
    const end = point.current ? point.current.end : (el.selectionEnd ?? start);
    const text = e.text.slice(0, start) + ref + e.text.slice(end);
    point.current = { start, end: start + ref.length, anchor: extend && point.current ? point.current.anchor : { r: rect.r1, c: rect.c1 }, rect: r };
    caretTo.current = start + ref.length;
    setEditorState({ ...e, text });
    return true;
  };
  useLayoutEffect(() => {
    if (caretTo.current === null || !editor) return;
    const el = editor.origin === 'bar' ? barRef.current : inputRef.current;
    if (!el) return;
    const pos = Math.min(caretTo.current, el.value.length);
    el.setSelectionRange(pos, pos);
    caretTo.current = null;
  }, [editor]);

  /* ---------- autocomplete and reference colours ---------- */

  const ac = useMemo(() => {
    if (!editor || !editor.text.startsWith('=')) return null;
    const m = /(?:^=|[=(,+\-*/^&<>:;{]\s*)([A-Za-z][A-Za-z0-9.]*)$/.exec(editor.text);
    if (!m) return null;
    const frag = m[1].toUpperCase();
    const items = FUNCTION_NAMES.filter((n) => n.startsWith(frag)).sort((a, b) => (a === frag ? -1 : b === frag ? 1 : a.length - b.length || a.localeCompare(b))).slice(0, 8).map((n) => ({ name: n, syntax: FUNCTIONS[n].syntax }));
    return items.length ? { items, frag: m[1], index: Math.min(acIndex, items.length - 1) } : null;
  }, [editor, acIndex]);
  const signature = useMemo(() => {
    if (!editor || !editor.text.startsWith('=')) return null;
    const fn = enclosingFn(editor.text);
    const f = fn ? FUNCTIONS[fn] : undefined;
    return f ? `${f.syntax} — ${f.desc}` : null;
  }, [editor]);
  const pickSuggestion = (name: string): void => {
    const e = editorRef.current;
    if (!e || !ac) return;
    const text = e.text.slice(0, e.text.length - ac.frag.length) + name + '(';
    caretTo.current = text.length;
    setEditorState({ ...e, text });
  };
  const refBoxes = useMemo(() => {
    if (!editor || !editor.text.startsWith('=') || !wb || !sheet) return [];
    const out: { rect: Rect; color: string }[] = [];
    let i = 0;
    try {
      for (const t of tokenize(editor.text.slice(1))) {
        if (t.type !== 'ref' || !t.ref) continue;
        const color = REF_COLORS[i++ % REF_COLORS.length];
        const home = findSheet(wb, editor.sheet);
        const target = t.ref.sheet ? findSheet(wb, t.ref.sheet) : home;
        if (target !== sheet) continue;
        const r = t.ref;
        out.push({ rect: { r1: r.r1, c1: r.c1, r2: Number.isFinite(r.r2) ? Math.min(r.r2, sheet.rows - 1) : sheet.rows - 1, c2: Number.isFinite(r.c2) ? Math.min(r.c2, sheet.cols - 1) : sheet.cols - 1 }, color });
      }
    } catch { /* partial formula */ }
    return out;
  }, [editor, wb, sheet]);

  const toggleAbsolute = (el: HTMLTextAreaElement): void => {
    const e = editorRef.current;
    if (!e) return;
    const caret = el.selectionStart ?? e.text.length;
    const body = e.text.slice(1);
    for (const t of tokenize(body)) {
      if (t.type !== 'ref' || !(caret - 1 >= t.start && caret - 1 <= t.end)) continue;
      const cycle = (x: string) => x.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/gi, (_m, a: string, col: string, b: string, row: string) => {
        const state = (a ? 2 : 0) + (b ? 1 : 0); // 0 A1 → 3 $A$1 → 1 A$1 → 2 $A1 → 0
        const next = state === 0 ? 3 : state === 3 ? 1 : state === 1 ? 2 : 0;
        return `${next & 2 ? '$' : ''}${col}${next & 1 ? '$' : ''}${row}`;
      });
      const replaced = cycle(t.text);
      const text = '=' + body.slice(0, t.start) + replaced + body.slice(t.end);
      caretTo.current = 1 + t.start + replaced.length;
      setEditorState({ ...e, text });
      return;
    }
  };

  const editorKey = (ev: ReactKeyboardEvent<HTMLTextAreaElement>, el: HTMLTextAreaElement): void => {
    const e = editorRef.current;
    if (!e) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ac && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) { ev.preventDefault(); setAcIndex((i) => (i + (ev.key === 'ArrowDown' ? 1 : ac.items.length - 1)) % ac.items.length); return; }
    if (ac && (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.altKey && !ctrl))) { ev.preventDefault(); pickSuggestion(ac.items[ac.index].name); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); return; }
    if (ev.key === 'Enter' && ev.altKey) {
      ev.preventDefault();
      const start = el.selectionStart ?? e.text.length, end = el.selectionEnd ?? start;
      caretTo.current = start + 1;
      setEditorState({ ...e, text: e.text.slice(0, start) + '\n' + e.text.slice(end) });
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(ctrl ? 0 : ev.shiftKey ? -1 : 1, 0, ctrl); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); commitEdit(0, ev.shiftKey ? -1 : 1); return; }
    if (ev.key === 'F4') { ev.preventDefault(); toggleAbsolute(el); return; }
    if (ev.key === 'F2') { ev.preventDefault(); setEditorState({ ...e, mode: e.mode === 'enter' ? 'edit' : 'enter' }); return; }
    if (ev.key.startsWith('Arrow') && e.mode === 'enter' && e.origin === 'cell') {
      const d = ev.key === 'ArrowDown' ? [1, 0] : ev.key === 'ArrowUp' ? [-1, 0] : ev.key === 'ArrowRight' ? [0, 1] : [0, -1];
      if (canPoint()) {
        ev.preventDefault();
        const s = sheetNow()!;
        const base = point.current ? (ev.shiftKey ? { r: point.current.rect.r2, c: point.current.rect.c2 } : { r: point.current.rect.r1, c: point.current.rect.c1 }) : { r: e.r, c: e.c };
        const r = Math.max(0, Math.min(s.rows - 1, base.r + d[0])), c = Math.max(0, Math.min(s.cols - 1, base.c + d[1]));
        if (ev.shiftKey && point.current) pointRef({ r1: r, c1: c, r2: r, c2: c }, true);
        else { if (point.current) point.current = { ...point.current }; pointRef({ r1: r, c1: c, r2: r, c2: c }, false); }
        return;
      }
      ev.preventDefault();
      commitEdit(d[0], d[1]);
    }
  };

  /* ---------- navigation ---------- */

  const moveActive = (dr: number, dc: number, extend: boolean, jump: boolean, from?: { r: number; c: number }): void => {
    const s = sheetNow(), d = docRef.current;
    if (!s || !d) return;
    const L = layoutOf(s, d.engine);
    const cur = selRef.current;
    let { r, c } = extend ? (() => { const rect = selRect(cur); return { r: cur.anchor.r === rect.r1 ? rect.r2 : rect.r1, c: cur.anchor.c === rect.c1 ? rect.c2 : rect.c1 }; })() : from ?? cur.active;
    const visibleStep = (pos: number, delta: number, n: number, size: (i: number) => number): number => { let p = pos + delta; while (p >= 0 && p < n && !size(p)) p += delta; return p < 0 || p >= n ? pos : p; };
    const filled = (rr: number, cc: number) => d.engine.value(s.id, rr, cc) !== null;
    if (jump) {
      // Ctrl+Arrow: to the edge of the current block, or to the next block
      const step = (rr: number, cc: number) => [rr + dr, cc + dc];
      let [nr, nc] = step(r, c);
      const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < s.rows && cc < s.cols;
      if (!inside(nr, nc)) { /* stay */ }
      else if (filled(r, c) && filled(nr, nc)) { while (inside(nr + dr, nc + dc) && filled(nr + dr, nc + dc)) [nr, nc] = step(nr, nc); r = nr; c = nc; }
      else { while (inside(nr, nc) && !filled(nr, nc)) { if (!inside(nr + dr, nc + dc)) break; [nr, nc] = step(nr, nc); } r = nr; c = nc; }
    } else {
      // move out of a merged cell as a whole
      const m = s.merges.map((x) => resolveRange(d.wb, x, s)!.rect).find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
      if (m && !extend) { if (dr > 0) r = m.r2; if (dr < 0) r = m.r1; if (dc > 0) c = m.c2; if (dc < 0) c = m.c1; }
      if (dr) r = visibleStep(r, dr, s.rows, (i) => L.rows.size(i));
      if (dc) c = visibleStep(c, dc, s.cols, (i) => L.cols.size(i));
      const m2 = s.merges.map((x) => resolveRange(d.wb, x, s)!.rect).find((x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2);
      if (m2 && !extend) { r = m2.r1; c = m2.c1; }
    }
    if (extend) setSelection({ ranges: [norm({ r1: cur.anchor.r, c1: cur.anchor.c, r2: r, c2: c })], active: cur.active, anchor: cur.anchor }, true);
    else setSelection(singleSel(r, c), true);
    setNameBox(null);
  };

  const keyDown = (ev: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const s = sheetNow(), d = docRef.current;
    if (!s || !d) return;
    const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key, low = k.toLowerCase();
    const act = (fn: () => void): void => { ev.preventDefault(); fn(); };
    const cur = selRef.current;
    if (ctrl && ev.shiftKey && low === 'v') { pasteValues.current = true; return; }
    if (ctrl && (low === 'c' || low === 'x' || low === 'v')) return; // native clipboard events
    if (k.startsWith('Arrow')) {
      const dir = k === 'ArrowDown' ? [1, 0] : k === 'ArrowUp' ? [-1, 0] : k === 'ArrowRight' ? [0, 1] : [0, -1];
      return act(() => moveActive(dir[0], dir[1], ev.shiftKey, ctrl));
    }
    if (k === 'Tab') return act(() => moveActive(0, ev.shiftKey ? -1 : 1, false, false));
    if (k === 'Enter' && !ctrl) return act(() => { const cell = cellAt(s, cur.active.r, cur.active.c); startEdit(cur.active.r, cur.active.c, cell?.f ?? rawText(cell, d.engine.display(s.id, cur.active.r, cur.active.c).text), 'edit'); });
    if (k === 'F2' && ev.shiftKey) return act(() => noteDialog());
    if (k === 'F2') return act(() => { const cell = cellAt(s, cur.active.r, cur.active.c); startEdit(cur.active.r, cur.active.c, cell?.f ?? rawText(cell, d.engine.display(s.id, cur.active.r, cur.active.c).text), 'edit'); });
    if (k === 'Escape') return act(() => { setCopyRect(null); clipRef.current = null; setPaint(null); setFound([]); });
    if (k === 'Delete' || k === 'Backspace') return act(() => run(cur.ranges.map((r) => ({ op: 'clear', range: rectA1(r), what: 'values' })), 'Delete values'));
    if (k === 'Home' && ctrl) return act(() => setSelection(singleSel(0, 0), true));
    if (k === 'End' && ctrl) return act(() => { const u = usedRect(s); setSelection(singleSel(u?.r2 ?? 0, u?.c2 ?? 0), true); });
    if (k === 'Home') return act(() => setSelection(singleSel(cur.active.r, 0), true));
    if (k === 'End') return act(() => { const u = usedRect(s); setSelection(singleSel(cur.active.r, u?.c2 ?? 0), true); });
    if (k === 'PageDown' || k === 'PageUp') return act(() => moveActive(k === 'PageDown' ? 20 : -20, 0, ev.shiftKey, false));
    if (k === ' ' && !ctrl && !ev.shiftKey && validationAt(s, cur.active.r, cur.active.c)?.type === 'checkbox') return act(() => { const v = d.engine.value(s.id, cur.active.r, cur.active.c); run(cur.ranges.map((r) => ({ op: 'set', range: rectA1(r), value: v !== true })), 'Toggle checkbox'); });
    if (k === ' ' && ctrl) return act(() => setSelection({ ranges: [{ r1: 0, r2: s.rows - 1, c1: selRect(cur).c1, c2: selRect(cur).c2 }], active: cur.active, anchor: cur.anchor }));
    if (k === ' ' && ev.shiftKey) return act(() => setSelection({ ranges: [{ c1: 0, c2: s.cols - 1, r1: selRect(cur).r1, r2: selRect(cur).r2 }], active: cur.active, anchor: cur.anchor }));
    if (ev.altKey && ev.shiftKey && (k === '5' || k === '%')) return act(() => format({ strike: !cellAt(s, cur.active.r, cur.active.c)?.s?.s }, 'Strikethrough'));
    if (!ctrl) return;
    if (ev.shiftKey && /^[1-6!@#$%^]$/.test(k)) {
      const map: Record<string, string> = { '1': 'number', '!': 'number', '2': 'time', '@': 'time', '3': 'date', '#': 'date', '4': 'currency', $: 'currency', '5': 'percent', '%': 'percent', '6': 'scientific', '^': 'scientific' };
      return act(() => format({ number: map[k] }, 'Number format'));
    }
    if (ev.shiftKey && low === 'l') return act(() => format({ align: 'left' }, 'Align left'));
    if (ev.shiftKey && low === 'e') return act(() => format({ align: 'center' }, 'Align centre'));
    if (ev.shiftKey && low === 'r') return act(() => format({ align: 'right' }, 'Align right'));
    if (ev.shiftKey && (k === ':' || k === ';')) return act(() => { const t = new Date(); run([{ op: 'set', range: addr(cur.active.r, cur.active.c), value: `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}` }], 'Insert time'); });
    if (k === ';') return act(() => { const t = new Date(); run([{ op: 'set', range: addr(cur.active.r, cur.active.c), value: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }], 'Insert date'); });
    if (low === 'z' && !ev.shiftKey) return act(undo);
    if (low === 'y' || (low === 'z' && ev.shiftKey)) return act(redo);
    if (low === 's') return act(() => void saveNow());
    if (low === 'b') return act(() => format({ bold: !cellAt(s, cur.active.r, cur.active.c)?.s?.b }, 'Bold'));
    if (low === 'i') return act(() => format({ italic: !cellAt(s, cur.active.r, cur.active.c)?.s?.i }, 'Italic'));
    if (low === 'u') return act(() => format({ underline: !cellAt(s, cur.active.r, cur.active.c)?.s?.u }, 'Underline'));
    if (low === 'a') return act(() => { const region = currentRegion(); const all = { r1: 0, c1: 0, r2: s.rows - 1, c2: s.cols - 1 }; const same = cur.ranges.length === 1 && rectA1(cur.ranges[0]) === rectA1(region); setSelection({ ranges: [same || (region.r1 === region.r2 && region.c1 === region.c2) ? all : region], active: cur.active, anchor: cur.anchor }); });
    if (low === 'd') return act(() => fillDir('down'));
    if (low === 'r') return act(() => fillDir('right'));
    if (low === 'f') return act(() => openDialog({ kind: 'find', replace: false }));
    if (low === 'h') return act(() => openDialog({ kind: 'find', replace: true }));
    if (low === 'k') return act(() => linkDialog());
    if (k === '\\') return act(() => run(cur.ranges.map((r) => ({ op: 'format', range: rectA1(r), reset: true })), 'Clear formatting'));
    if (k === '`') return act(() => setShowFormulas((x) => !x));
    if (k === '/') return act(() => setHelpOpen(true));
  };
  const fillDir = (dir: 'down' | 'right'): void => {
    const r = selRect(selRef.current);
    if (dir === 'down') {
      if (r.r1 === r.r2) { if (r.r1 === 0) return; run([{ op: 'fill', from: rectA1({ ...r, r1: r.r1 - 1, r2: r.r1 - 1 }), to: rectA1({ ...r, r1: r.r1 - 1 }) }], 'Fill down'); }
      else run([{ op: 'copy', from: rectA1({ ...r, r2: r.r1 }), to: rectA1({ ...r, r1: r.r1 + 1 }) }], 'Fill down');
    } else {
      if (r.c1 === r.c2) { if (r.c1 === 0) return; run([{ op: 'fill', from: rectA1({ ...r, c1: r.c1 - 1, c2: r.c1 - 1 }), to: rectA1({ ...r, c1: r.c1 - 1 }) }], 'Fill right'); }
      else run([{ op: 'copy', from: rectA1({ ...r, c2: r.c1 }), to: rectA1({ ...r, c1: r.c1 + 1 }) }], 'Fill right');
    }
  };

  /* ---------- clipboard ---------- */

  const copy = (ev: ReactClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    const s = sheetNow(), d = docRef.current;
    if (!s || !d) return;
    ev.preventDefault();
    const rect = selRect(selRef.current);
    const used = usedRect(s);
    const r = { ...rect, r2: Math.min(rect.r2, Math.max(rect.r1, used?.r2 ?? rect.r1)), c2: Math.min(rect.c2, Math.max(rect.c1, used?.c2 ?? rect.c1)) };
    const grid = rangeText(s, r, d.engine);
    const text = toDelimited(grid, '\t');
    const html = `<table>${grid.map((row) => `<tr>${row.map((t) => `<td>${esc(t)}</td>`).join('')}</tr>`).join('')}</table>`;
    ev.clipboardData.setData('text/plain', text);
    ev.clipboardData.setData('text/html', html);
    clipRef.current = { sheet: s.id, rect: r, cut, text };
    setCopyRect({ sheet: s.id, rect: r });
  };
  const pasteText = (text: string, valuesOnly: boolean): void => {
    const s = sheetNow();
    if (!s) return;
    const target = selRect(selRef.current);
    const clip = clipRef.current;
    const norm1 = (t: string) => t.replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (clip && norm1(clip.text) === norm1(text) && docRef.current && findSheet(docRef.current.wb, clip.sheet)) {
      const src = `${quote(findSheet(docRef.current.wb, clip.sheet)!.name)}!${rectA1(clip.rect)}`;
      const h = clip.rect.r2 - clip.rect.r1, w = clip.rect.c2 - clip.rect.c1;
      const multiple = (target.r2 - target.r1 + 1) % (h + 1) === 0 && (target.c2 - target.c1 + 1) % (w + 1) === 0;
      const to = multiple && !clip.cut ? rectA1(target) : addr(target.r1, target.c1);
      if (clip.cut) { if (run([{ op: 'move', from: src, to }], 'Cut and paste')) { clipRef.current = null; setCopyRect(null); } }
      else run([{ op: 'copy', from: src, to, paste: valuesOnly ? 'values' : 'all' }], valuesOnly ? 'Paste values' : 'Paste');
      setSelection({ ranges: [{ r1: target.r1, c1: target.c1, r2: Math.max(target.r2, target.r1 + h), c2: Math.max(target.c2, target.c1 + w) }], active: { r: target.r1, c: target.c1 }, anchor: { r: target.r1, c: target.c1 } });
      return;
    }
    let grid = parseDelimited(text.replace(/\r?\n$/, ''), '\t');
    if (!grid.length) return;
    if (grid.length === 1 && grid[0].length === 1 && (target.r1 !== target.r2 || target.c1 !== target.c2)) {
      run([{ op: 'set', range: rectA1(target), value: grid[0][0], raw: false }], 'Paste');
      return;
    }
    if (valuesOnly) grid = grid.map((row) => row.map((v) => (v.startsWith('=') ? `'${v}` : v)));
    if (run([{ op: 'set', range: addr(target.r1, target.c1), values: grid }], 'Paste')) {
      setSelection({ ranges: [{ r1: target.r1, c1: target.c1, r2: target.r1 + grid.length - 1, c2: target.c1 + Math.max(...grid.map((r) => r.length)) - 1 }], active: { r: target.r1, c: target.c1 }, anchor: { r: target.r1, c: target.c1 } });
    }
  };
  const paste = (ev: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    ev.preventDefault();
    const values = pasteValues.current;
    pasteValues.current = false;
    let text = ev.clipboardData.getData('text/plain');
    if (!text) {
      const html = ev.clipboardData.getData('text/html');
      if (html) { const doc0 = new DOMParser().parseFromString(html, 'text/html'); text = [...doc0.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((td) => (td.textContent ?? '').replace(/\t/g, ' ')).join('\t')).join('\n'); }
    }
    if (text) pasteText(text, values);
  };
  const quote = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
  const menuCopy = (cut: boolean): void => { inputRef.current?.focus(); try { if (!document.execCommand(cut ? 'cut' : 'copy')) notify('Use Ctrl+C / Ctrl+X to copy.'); } catch { notify('Use Ctrl+C / Ctrl+X to copy.'); } };
  const menuPaste = async (values: boolean): Promise<void> => {
    try { const text = await navigator.clipboard.readText(); pasteText(text, values); }
    catch { notify('The browser blocked reading the clipboard — press Ctrl+V (or Ctrl+Shift+V for values only).'); }
  };

  /* ---------- workbook files ---------- */

  const uniqueSlug = (base: string): string => { let slug = base, n = 2; while (refs.some((r) => r.owner === USER_OWNER && r.slug === slug)) slug = `${base}-${n++}`; return slug; };
  const createBook = async (wb0: Workbook, name: string): Promise<void> => {
    const slug = uniqueSlug(nameSlug(name || wb0.title || 'sheet'));
    await saveNow();
    try {
      await saveSheet({ owner: USER_OWNER, slug }, wb0, 'editor');
      setDialog(null);
      await refreshList();
      await openSheetFile(`${USER_OWNER}/${slug}`);
    } catch (error) { notify(`Could not create the spreadsheet: ${String(error)}`, 'error'); }
  };
  const newBook = async (name: string, t: Template): Promise<void> => {
    const title = name.trim() || (t === 'budget' ? 'Monthly budget' : t === 'sales' ? 'Sales tracker' : t === 'tasks' ? 'Task list' : 'Untitled spreadsheet');
    let wb0 = emptyWorkbook(title);
    if (t !== 'blank') { const r = applyOps(wb0, templateOps(t)); if (r.error) { notify(r.error, 'error'); return; } wb0 = { ...r.workbook, title: name.trim() || r.workbook.title }; }
    await createBook(wb0, name || (t === 'blank' ? 'sheet' : t));
  };
  const deleteFile = async (key: string): Promise<void> => {
    setConfirmDelete(null);
    const ref = refOf(key);
    if (!ref) return;
    try {
      if (key === currentRef.current) { dirtyRef.current = false; setDirty(false); }
      await removeSheet(ref);
      const rest = await listSheetRefs();
      setRefs(rest);
      if (key === currentRef.current) { if (rest[0]) await openSheetFile(refKey(rest[0])); else { setCurrent(null); setDoc(null); docRef.current = null; setOpenSheet(null); } }
    } catch (error) { notify(`Could not delete the spreadsheet: ${String(error)}`, 'error'); }
  };

  const importFile = async (file: File): Promise<void> => {
    const lower = file.name.toLowerCase();
    const title = file.name.replace(/\.[^.]+$/, '');
    let book: Workbook;
    try {
      if (/\.(xlsx|xlsm|xls|ods)$/.test(lower)) book = (await importXlsx(new Uint8Array(await file.arrayBuffer()), title)).workbook;
      else {
        const text = await file.text();
        const delim = lower.endsWith('.tsv') || (!lower.endsWith('.csv') && text.includes('\t')) ? '\t' : ',';
        const r = applyOps(emptyWorkbook(title), [{ op: 'sheet_rename', sheet: 's1', name: title.slice(0, 90) || 'Sheet1' }, { op: 'set', range: 'A1', values: parseDelimited(text, delim) }]);
        if (r.error) throw new Error(r.error);
        book = r.workbook;
      }
    } catch (error) { notify(`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error'); return; }
    const mode = importMode.current;
    if (mode === 'new' || !docRef.current) { await createBook(book, title); return; }
    const d = docRef.current;
    if (mode === 'replace') {
      const s = sheetNow()!;
      const src = book.sheets[0];
      const next = structuredClone(d.wb);
      const i = next.sheets.findIndex((x) => x.id === s.id);
      next.sheets[i] = { ...src, id: s.id, name: s.name };
      commit(next, 'all', 'Import (replace sheet)');
    } else {
      const next = structuredClone(d.wb);
      for (const src of book.sheets) {
        let name = src.name, n = 2;
        while (next.sheets.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${src.name} (${n++})`;
        next.sheets.push({ ...src, id: `s${next.nextId++}`, name });
      }
      commit(next, 'all', 'Import sheets');
      const last = next.sheets[next.sheets.length - 1];
      sheetIdRef.current = last.id; setSheetId(last.id); setSelection(singleSel(0, 0));
    }
    setDialog(null);
    notify(`Imported ${file.name}.`);
  };

  const exportAs = async (format: 'csv' | 'tsv' | 'xlsx' | 'html'): Promise<void> => {
    const ref = refOf(currentRef.current), d = docRef.current, s = sheetNow();
    if (!ref || !d || !s) return;
    await saveNow();
    const base = sheetPath(ref).replace(/\.sheet\.json$/, '');
    const fileBase = nameSlug(d.wb.title) || 'sheet';
    try {
      if (format === 'xlsx') {
        const bytes = await exportXlsx(d.wb, d.engine);
        await writeWorktreeBinary(`${base}.xlsx`, toBase64(bytes));
        download(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`);
        notify(`Saved ${base}.xlsx (values, formulas, number formats, merges and sizes; cell colours, conditional formats, validation and charts are not written to .xlsx).`);
        return;
      }
      const used = usedRect(s) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
      const rect = { r1: 0, c1: 0, r2: used.r2, c2: used.c2 };
      if (format === 'html') {
        const html = rangeHtml(d.wb, s, rect, d.engine);
        await writeWorktreeFile(`${base}-${nameSlug(s.name)}.html`, html);
        download(new Blob([html], { type: 'text/html' }), `${fileBase}-${nameSlug(s.name)}.html`);
        notify(`Saved ${base}-${nameSlug(s.name)}.html — open it and print to PDF.`);
        return;
      }
      const text = toDelimited(rangeText(s, rect, d.engine), format === 'csv' ? ',' : '\t') + '\r\n';
      const path = `${base}-${nameSlug(s.name)}.${format}`;
      await writeWorktreeFile(path, text);
      download(new Blob([text], { type: format === 'csv' ? 'text/csv' : 'text/tab-separated-values' }), `${fileBase}-${nameSlug(s.name)}.${format}`);
      notify(`Saved ${path}.`);
    } catch (error) { notify(`Could not export: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
  };
  const print = (): void => {
    const d = docRef.current, s = sheetNow();
    if (!d || !s) return;
    const sel0 = selRect(selRef.current);
    const used = usedRect(s) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
    const rect = sel0.r1 === sel0.r2 && sel0.c1 === sel0.c2 ? { r1: 0, c1: 0, r2: used.r2, c2: used.c2 } : { ...sel0, r2: Math.min(sel0.r2, used.r2), c2: Math.min(sel0.c2, used.c2) };
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.appendChild(frame);
    frame.srcdoc = rangeHtml(d.wb, s, rect, d.engine);
    frame.onload = () => { try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { notify('Printing is not available here — use File ▸ Download ▸ Web page and print it from a browser.'); } window.setTimeout(() => frame.remove(), 60_000); };
  };

  /* ---------- find ---------- */

  const findMatches = (o: FindOptions): { sheet: string; r: number; c: number }[] => {
    const d = docRef.current;
    if (!d) return [];
    let re: RegExp;
    try { re = o.regex ? new RegExp(o.whole ? `^(?:${o.find})$` : o.find, o.match_case ? '' : 'i') : new RegExp(o.whole ? `^${o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.match_case ? '' : 'i'); } catch { return []; }
    const out: { sheet: string; r: number; c: number }[] = [];
    const sheets = o.all_sheets ? d.wb.sheets : [sheetNow()!];
    for (const s of sheets) {
      for (const a of Object.keys(s.cells)) {
        const p = parseAddr(a)!;
        const cell = s.cells[a];
        const text = o.formulas && cell.f ? cell.f : d.engine.display(s.id, p.r, p.c).text;
        if (text && re.test(text)) out.push({ sheet: s.id, r: p.r, c: p.c });
      }
    }
    return out.sort((x, y) => d.wb.sheets.findIndex((s) => s.id === x.sheet) - d.wb.sheets.findIndex((s) => s.id === y.sheet) || x.r - y.r || x.c - y.c);
  };
  const findNext = (o: FindOptions, back: boolean): string => {
    const all = findMatches(o);
    setFound(all);
    if (!all.length) return 'No matches.';
    const cur = selRef.current.active, sid = sheetIdRef.current;
    const order = (m: { sheet: string; r: number; c: number }) => [docRef.current!.wb.sheets.findIndex((s) => s.id === m.sheet), m.r, m.c];
    const here = [docRef.current!.wb.sheets.findIndex((s) => s.id === sid), cur.r, cur.c];
    const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const next = back ? [...all].reverse().find((m) => cmp(order(m), here) < 0) ?? all[all.length - 1] : all.find((m) => cmp(order(m), here) > 0) ?? all[0];
    if (next.sheet !== sid) { sheetIdRef.current = next.sheet; setSheetId(next.sheet); }
    setSelection(singleSel(next.r, next.c), true);
    return `${all.indexOf(next) + 1} of ${all.length}`;
  };
  const replaceOne = (o: FindOptions): string => {
    const d = docRef.current, s = sheetNow();
    if (!d || !s) return '';
    const { r, c } = selRef.current.active;
    const hit = findMatches(o).some((m) => m.sheet === s.id && m.r === r && m.c === c);
    if (hit) {
      const cell = cellAt(s, r, c);
      const text = o.formulas && cell?.f ? cell.f : rawText(cell, d.engine.display(s.id, r, c).text);
      const re = new RegExp(o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.match_case ? '' : 'i');
      run([{ op: 'set', range: addr(r, c), value: o.whole ? o.replace : text.replace(re, o.replace) }], 'Replace');
    }
    return findNext(o, false);
  };
  const replaceAll = (o: FindOptions): string => {
    const before = findMatches(o).length;
    if (!before) return 'No matches.';
    run([{ op: 'find_replace', find: o.find, replace: o.replace, match_case: o.match_case, whole: o.whole, regex: o.regex, formulas: o.formulas, all_sheets: o.all_sheets }], 'Replace all');
    setFound([]);
    return `Replaced ${before} cell(s).`;
  };

  /* ---------- small dialogs ---------- */

  const openDialog = (d: Dialog): void => {
    const region = currentRegion();
    const cur = selRect(selRef.current);
    const sortRange = cur.r1 !== cur.r2 ? cur : region;
    setDctx({ region, main: mainRange(), ranges: rangesText(), headers: headersOf(region), sortRange, sortHeaders: headersOf(sortRange) });
    setDialog(d);
  };

  const noteDialog = (): void => {
    const s = sheetNow(); if (!s) return;
    const { r, c } = selRef.current.active;
    openDialog({ kind: 'prompt', title: `Note on ${addr(r, c)}`, label: 'Note', initial: cellAt(s, r, c)?.note ?? '', multiline: true, onOk: (v) => { run([{ op: 'note', cell: addr(r, c), text: v }], 'Note'); setDialog(null); focusGrid(); } });
  };
  const linkDialog = (): void => {
    const s = sheetNow(); if (!s) return;
    const { r, c } = selRef.current.active;
    openDialog({ kind: 'prompt', title: `Link on ${addr(r, c)}`, label: 'URL (https://… or mailto:…)', initial: cellAt(s, r, c)?.link ?? 'https://', onOk: (v) => { if (run([{ op: 'link', cell: addr(r, c), url: v === 'https://' ? '' : v }], 'Link')) { setDialog(null); focusGrid(); } } });
  };
  const insertRowsCols = (axis: 'row' | 'col', after: boolean): void => {
    const r = selRect(selRef.current);
    const count = axis === 'row' ? r.r2 - r.r1 + 1 : r.c2 - r.c1 + 1;
    const s = sheetNow()!;
    const n = Math.min(count, axis === 'row' ? 1000 : 100);
    if (axis === 'row') run([{ op: 'insert_rows', at: (after ? r.r2 + 1 : r.r1) + 1, count: isWhole(r, s, 'col') ? 1 : n }], `Insert ${n} row(s)`);
    else run([{ op: 'insert_cols', at: (after ? r.c2 + 1 : r.c1) + 1, count: isWhole(r, s, 'row') ? 1 : n }], `Insert ${n} column(s)`);
  };
  const deleteRowsCols = (axis: 'row' | 'col'): void => {
    const r = selRect(selRef.current);
    if (axis === 'row') run([{ op: 'delete_rows', at: r.r1 + 1, count: r.r2 - r.r1 + 1 }], 'Delete rows');
    else run([{ op: 'delete_cols', at: r.c1 + 1, count: r.c2 - r.c1 + 1 }], 'Delete columns');
    setSelection(singleSel(r.r1, r.c1));
  };
  const sortBy = (desc: boolean, whole: boolean): void => {
    const s = sheetNow()!;
    const c = selRef.current.active.c;
    const region = whole ? (() => { const u = usedRect(s); return u ? { r1: s.frozenRows > 0 ? s.frozenRows : 0, c1: 0, r2: u.r2, c2: Math.max(u.c2, c) } : null; })() : selRect(selRef.current);
    if (!region) return;
    run([{ op: 'sort', range: rectA1(region), header: whole ? false : false, by: [{ col: c + 1, desc }] }], desc ? 'Sort Z→A' : 'Sort A→Z');
  };
  const toggleFilter = (): void => {
    const s = sheetNow()!;
    if (s.filter) { run([{ op: 'filter_clear' }], 'Remove filter'); return; }
    run([{ op: 'filter', range: rectA1(currentRegion()) }], 'Create a filter');
  };
  const adjustDecimals = (delta: number): void => {
    const s = sheetNow(), d = docRef.current;
    if (!s || !d) return;
    const { r, c } = selRef.current.active;
    const v = d.engine.value(s.id, r, c);
    let nf = cellAt(s, r, c)?.s?.nf ?? '';
    if (!nf) { const dec = typeof v === 'number' ? Math.min(10, (String(v).split('.')[1] ?? '').length) : 0; nf = dec ? `0.${'0'.repeat(dec)}` : '0'; }
    const next = nf.replace(/0(\.0*)?(?=[^0.]*$|%|E|;|")/, (m) => { const dec = Math.max(0, (m.split('.')[1] ?? '').length + delta); return dec ? `0.${'0'.repeat(dec)}` : '0'; });
    format({ number: next }, delta > 0 ? 'More decimals' : 'Fewer decimals');
  };
  const insertFunction = (name: string): void => {
    const s = sheetNow(); if (!s) return;
    setDialog(null);
    const r = selRect(selRef.current);
    const { r: ar, c: ac0 } = selRef.current.active;
    if (['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].includes(name) && (r.r1 !== r.r2 || r.c1 !== r.c2)) {
      // like Sheets: a function on a selected block goes below it
      const target = addr(Math.min(s.rows - 1, r.r2 + 1), r.c1);
      run([{ op: 'set', range: `${target}:${addr(Math.min(s.rows - 1, r.r2 + 1), r.c2)}`, formula: `=${name}(${rectA1({ ...r, c2: r.c1 })})` }], `Insert ${name}`);
      return;
    }
    startEdit(ar, ac0, `=${name}(`, 'enter');
    focusGrid();
  };

  /* ---------- context menus ---------- */

  const contextMenu = (kind: 'cell' | 'col' | 'row', x: number, y: number): void => {
    const s = sheetNow();
    if (!s) return;
    const r = selRect(selRef.current);
    const nr = r.r2 - r.r1 + 1, nc = r.c2 - r.c1 + 1;
    const common: MenuEntry[] = [
      { label: 'Cut', keys: 'Ctrl+X', onSelect: () => menuCopy(true) }, { label: 'Copy', keys: 'Ctrl+C', onSelect: () => menuCopy(false) },
      { label: 'Paste', keys: 'Ctrl+V', onSelect: () => void menuPaste(false) }, { label: 'Paste values only', keys: 'Ctrl+Shift+V', onSelect: () => void menuPaste(true) }, { separator: true },
    ];
    const entries: MenuEntry[] = kind === 'col' ? [
      ...common,
      { label: `Insert ${nc} column${nc > 1 ? 's' : ''} left`, onSelect: () => insertRowsCols('col', false) }, { label: `Insert ${nc} column${nc > 1 ? 's' : ''} right`, onSelect: () => insertRowsCols('col', true) },
      { label: `Delete column${nc > 1 ? 's' : ''} ${colName(r.c1)}${nc > 1 ? ` – ${colName(r.c2)}` : ''}`, onSelect: () => deleteRowsCols('col') },
      { label: 'Clear column', onSelect: () => run([{ op: 'clear', range: `${colName(r.c1)}:${colName(r.c2)}` }], 'Clear column') },
      { label: 'Hide column', onSelect: () => run([{ op: 'hide_cols', from: r.c1 + 1, to: r.c2 + 1 }], 'Hide column') },
      { label: 'Resize column to fit data', onSelect: () => run([{ op: 'col_width', from: r.c1 + 1, to: r.c2 + 1, fit: true }], 'Fit column') }, { separator: true },
      { label: 'Sort sheet A → Z', onSelect: () => sortBy(false, true) }, { label: 'Sort sheet Z → A', onSelect: () => sortBy(true, true) },
      { label: `Freeze up to column ${colName(r.c2)}`, onSelect: () => run([{ op: 'freeze', cols: r.c2 + 1 }], 'Freeze columns') },
    ] : kind === 'row' ? [
      ...common,
      { label: `Insert ${nr} row${nr > 1 ? 's' : ''} above`, onSelect: () => insertRowsCols('row', false) }, { label: `Insert ${nr} row${nr > 1 ? 's' : ''} below`, onSelect: () => insertRowsCols('row', true) },
      { label: `Delete row${nr > 1 ? 's' : ''} ${r.r1 + 1}${nr > 1 ? ` – ${r.r2 + 1}` : ''}`, onSelect: () => deleteRowsCols('row') },
      { label: 'Clear row', onSelect: () => run([{ op: 'clear', range: `${r.r1 + 1}:${r.r2 + 1}` }], 'Clear row') },
      { label: 'Hide row', onSelect: () => run([{ op: 'hide_rows', from: r.r1 + 1, to: r.r2 + 1 }], 'Hide row') },
      { label: 'Reset row height', onSelect: () => run([{ op: 'row_height', from: r.r1 + 1, to: r.r2 + 1, reset: true }], 'Reset row height') }, { separator: true },
      { label: `Freeze up to row ${r.r2 + 1}`, onSelect: () => run([{ op: 'freeze', rows: r.r2 + 1 }], 'Freeze rows') },
    ] : [
      ...common,
      { label: `Insert ${nr} row${nr > 1 ? 's' : ''} above`, onSelect: () => insertRowsCols('row', false) }, { label: `Insert ${nc} column${nc > 1 ? 's' : ''} left`, onSelect: () => insertRowsCols('col', false) },
      { label: 'Delete row', onSelect: () => deleteRowsCols('row') }, { label: 'Delete column', onSelect: () => deleteRowsCols('col') },
      { label: 'Clear contents', keys: 'Delete', onSelect: () => run(selRef.current.ranges.map((x) => ({ op: 'clear', range: rectA1(x), what: 'values' })), 'Clear') }, { separator: true },
      { label: 'Sort range A → Z', onSelect: () => sortBy(false, false), disabled: nr < 2 }, { label: 'Sort range Z → A', onSelect: () => sortBy(true, false), disabled: nr < 2 },
      { label: s.filter ? 'Remove filter' : 'Create a filter', onSelect: toggleFilter }, { separator: true },
      { label: 'Insert note', keys: 'Shift+F2', onSelect: noteDialog }, { label: 'Insert link', keys: 'Ctrl+K', onSelect: linkDialog },
      { label: 'Data validation', onSelect: () => openDialog({ kind: 'validation' }) }, { label: 'Conditional formatting', onSelect: () => openDialog({ kind: 'cond' }) },
      { label: 'Define named range', onSelect: () => openDialog({ kind: 'names' }) },
    ];
    setCtx({ entries, x, y });
  };

  /* ---------- sheet tabs ---------- */

  const switchSheet = (id: string): void => {
    if (editorRef.current) {
      // switching sheets while typing a formula lets you point at the other sheet
      if (!editorRef.current.text.startsWith('=')) commitEdit();
    }
    sheetIdRef.current = id; setSheetId(id);
    setSelection(singleSel(0, 0));
    setFound([]);
  };
  const tabMenu = (s: Sheet, x: number, y: number): void => {
    const d = docRef.current!;
    const visible = d.wb.sheets.filter((x0) => !x0.hidden);
    const i = d.wb.sheets.indexOf(s);
    setCtx({
      x, y, entries: [
        { label: 'Delete', onSelect: () => run([{ op: 'sheet_delete', sheet: s.id }], 'Delete sheet'), disabled: visible.length <= 1 },
        { label: 'Duplicate', onSelect: () => run([{ op: 'sheet_duplicate', sheet: s.id }], 'Duplicate sheet') },
        { label: 'Rename', onSelect: () => setRenaming(s.id) },
        { label: 'Change colour', sub: [...TAB_COLORS.map((c) => ({ label: c, onSelect: () => run([{ op: 'sheet_set', sheet: s.id, color: c }], 'Tab colour') })), { label: 'Reset', onSelect: () => run([{ op: 'sheet_set', sheet: s.id, color: null }], 'Tab colour') }] },
        { label: 'Hide sheet', onSelect: () => run([{ op: 'sheet_set', sheet: s.id, hidden: true }], 'Hide sheet'), disabled: visible.length <= 1 },
        { label: s.gridlines ? 'Hide gridlines' : 'Show gridlines', onSelect: () => run([{ op: 'sheet_set', sheet: s.id, gridlines: !s.gridlines }], 'Gridlines') },
        { separator: true },
        { label: 'Move left', onSelect: () => run([{ op: 'sheet_move', sheet: s.id, to: i }], 'Move sheet'), disabled: i === 0 },
        { label: 'Move right', onSelect: () => run([{ op: 'sheet_move', sheet: s.id, to: i + 2 }], 'Move sheet'), disabled: i === d.wb.sheets.length - 1 },
      ],
    });
  };

  /* ---------- menus ---------- */

  const has = !!doc;
  /* The callbacks below only run when a menu item is clicked, never while rendering. */
  const menus = (): Record<string, MenuEntry[]> => {
    const s = sheet;
    const r = selRect(sel);
    return {
      File: [
        { label: 'New spreadsheet…', onSelect: () => openDialog({ kind: 'new' }) },
        { label: 'Import…', onSelect: () => openDialog({ kind: 'import' }) },
        { label: 'Rename…', disabled: !has, onSelect: () => openDialog({ kind: 'prompt', title: 'Rename spreadsheet', label: 'Title', initial: wb?.title ?? '', onOk: (v) => { run([{ op: 'workbook', title: v }], 'Rename'); setDialog(null); } }) },
        { label: 'Save now', keys: 'Ctrl+S', disabled: !has, onSelect: () => void saveNow() },
        { separator: true },
        { label: 'Download', disabled: !has, sub: [
          { label: 'Microsoft Excel (.xlsx)', onSelect: () => void exportAs('xlsx') },
          { label: 'Comma-separated values (.csv, current sheet)', onSelect: () => void exportAs('csv') },
          { label: 'Tab-separated values (.tsv, current sheet)', onSelect: () => void exportAs('tsv') },
          { label: 'Web page (.html, print-friendly)', onSelect: () => void exportAs('html') },
        ] },
        { label: 'Print…', keys: 'Ctrl+P', disabled: !has, onSelect: print },
      ],
      Edit: [
        { label: 'Undo', keys: 'Ctrl+Z', onSelect: undo, disabled: hist.undo === 0 },
        { label: 'Redo', keys: 'Ctrl+Y', onSelect: redo, disabled: hist.redo === 0 },
        { separator: true },
        { label: 'Cut', keys: 'Ctrl+X', disabled: !has, onSelect: () => menuCopy(true) },
        { label: 'Copy', keys: 'Ctrl+C', disabled: !has, onSelect: () => menuCopy(false) },
        { label: 'Paste', keys: 'Ctrl+V', disabled: !has, onSelect: () => void menuPaste(false) },
        { label: 'Paste values only', keys: 'Ctrl+Shift+V', disabled: !has, onSelect: () => void menuPaste(true) },
        { label: 'Paste format only', disabled: !has || !copyRect, onSelect: () => { const c = clipRef.current; if (c && docRef.current) run([{ op: 'copy', from: `${quote(findSheet(docRef.current.wb, c.sheet)!.name)}!${rectA1(c.rect)}`, to: mainRange(), paste: 'formats' }], 'Paste format'); } },
        { separator: true },
        { label: 'Find and replace', keys: 'Ctrl+H', disabled: !has, onSelect: () => openDialog({ kind: 'find', replace: true }) },
        { label: 'Delete values', keys: 'Delete', disabled: !has, onSelect: () => run(sel.ranges.map((x) => ({ op: 'clear', range: rectA1(x), what: 'values' })), 'Delete values') },
        { label: `Delete row${r.r2 > r.r1 ? 's' : ''} ${r.r1 + 1}${r.r2 > r.r1 ? `–${r.r2 + 1}` : ''}`, disabled: !has, onSelect: () => deleteRowsCols('row') },
        { label: `Delete column${r.c2 > r.c1 ? 's' : ''} ${colName(r.c1)}${r.c2 > r.c1 ? `–${colName(r.c2)}` : ''}`, disabled: !has, onSelect: () => deleteRowsCols('col') },
        { label: 'Select all', keys: 'Ctrl+A', disabled: !has, onSelect: () => s && setSelection({ ranges: [{ r1: 0, c1: 0, r2: s.rows - 1, c2: s.cols - 1 }], active: sel.active, anchor: sel.anchor }) },
      ],
      View: [
        { label: 'Gridlines', checked: s?.gridlines ?? true, disabled: !has, onSelect: () => s && run([{ op: 'sheet_set', sheet: s.id, gridlines: !s.gridlines }], 'Gridlines') },
        { label: 'Formulas', keys: 'Ctrl+`', checked: showFormulas, onSelect: () => setShowFormulas((x) => !x) },
        { separator: true },
        { label: 'Freeze', disabled: !has, sub: [
          { label: 'No rows', onSelect: () => run([{ op: 'freeze', rows: 0 }], 'Freeze') }, { label: '1 row', onSelect: () => run([{ op: 'freeze', rows: 1 }], 'Freeze') }, { label: '2 rows', onSelect: () => run([{ op: 'freeze', rows: 2 }], 'Freeze') },
          { label: `Up to row ${sel.active.r + 1}`, onSelect: () => run([{ op: 'freeze', rows: sel.active.r + 1 }], 'Freeze') }, { separator: true },
          { label: 'No columns', onSelect: () => run([{ op: 'freeze', cols: 0 }], 'Freeze') }, { label: '1 column', onSelect: () => run([{ op: 'freeze', cols: 1 }], 'Freeze') }, { label: '2 columns', onSelect: () => run([{ op: 'freeze', cols: 2 }], 'Freeze') },
          { label: `Up to column ${colName(sel.active.c)}`, onSelect: () => run([{ op: 'freeze', cols: sel.active.c + 1 }], 'Freeze') },
        ] },
        { label: 'Hidden sheets', disabled: !wb?.sheets.some((x) => x.hidden), sub: (wb?.sheets.filter((x) => x.hidden) ?? []).map((x) => ({ label: `Show ${x.name}`, onSelect: () => run([{ op: 'sheet_set', sheet: x.id, hidden: false }], 'Show sheet') })) },
        { label: 'Show all hidden rows and columns', disabled: !s || (!s.hiddenRows.length && !s.hiddenCols.length), onSelect: () => s && run([{ op: 'show_rows', from: 1, to: s.rows }, { op: 'show_cols', from: 1, to: s.cols }], 'Show hidden') },
        { separator: true },
        { label: 'Zoom', sub: [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((zz) => ({ label: `${Math.round(zz * 100)}%`, checked: zoom === zz, onSelect: () => setZoom(zz) })) },
        { label: 'Keyboard shortcuts', keys: 'Ctrl+/', onSelect: () => setHelpOpen(true) },
      ],
      Insert: [
        { label: `${r.r2 - r.r1 + 1} row${r.r2 > r.r1 ? 's' : ''} above`, disabled: !has, onSelect: () => insertRowsCols('row', false) },
        { label: `${r.r2 - r.r1 + 1} row${r.r2 > r.r1 ? 's' : ''} below`, disabled: !has, onSelect: () => insertRowsCols('row', true) },
        { label: `${r.c2 - r.c1 + 1} column${r.c2 > r.c1 ? 's' : ''} left`, disabled: !has, onSelect: () => insertRowsCols('col', false) },
        { label: `${r.c2 - r.c1 + 1} column${r.c2 > r.c1 ? 's' : ''} right`, disabled: !has, onSelect: () => insertRowsCols('col', true) },
        { label: 'Sheet', keys: 'Shift+F11', disabled: !has, onSelect: () => run([{ op: 'sheet_add', name: nextSheetName() }], 'Add sheet') },
        { separator: true },
        { label: 'Chart', disabled: !has, onSelect: () => openDialog({ kind: 'chart' }) },
        { label: 'Pivot table', disabled: !has, onSelect: () => openDialog({ kind: 'pivot' }) },
        { label: 'Function', disabled: !has, sub: [...['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((n) => ({ label: n, onSelect: () => insertFunction(n) })), { separator: true }, { label: 'All functions…', onSelect: () => openDialog({ kind: 'functions' }) }] },
        { separator: true },
        { label: 'Link', keys: 'Ctrl+K', disabled: !has, onSelect: linkDialog },
        { label: 'Checkbox', disabled: !has, onSelect: () => run([{ op: 'validation', range: mainRange(), type: 'checkbox' }], 'Insert checkbox') },
        { label: 'Dropdown', disabled: !has, onSelect: () => openDialog({ kind: 'validation' }) },
        { label: 'Note', keys: 'Shift+F2', disabled: !has, onSelect: noteDialog },
      ],
      Format: [
        { label: 'Number', disabled: !has, sub: [...NUMBER_FORMATS.map((f) => ({ label: `${f.label}   ${f.sample}`, onSelect: () => format({ number: f.pattern || 'auto' }, f.label) })), { separator: true }, { label: 'Custom number format…', onSelect: () => openDialog({ kind: 'numfmt' }) }] },
        { label: 'Text', disabled: !has, sub: [
          { label: 'Bold', keys: 'Ctrl+B', onSelect: () => format({ bold: !activeFmt?.b }, 'Bold') }, { label: 'Italic', keys: 'Ctrl+I', onSelect: () => format({ italic: !activeFmt?.i }, 'Italic') },
          { label: 'Underline', keys: 'Ctrl+U', onSelect: () => format({ underline: !activeFmt?.u }, 'Underline') }, { label: 'Strikethrough', keys: 'Alt+Shift+5', onSelect: () => format({ strike: !activeFmt?.s }, 'Strikethrough') },
        ] },
        { label: 'Alignment', disabled: !has, sub: [
          { label: 'Left', keys: 'Ctrl+Shift+L', onSelect: () => format({ align: 'left' }, 'Align') }, { label: 'Centre', keys: 'Ctrl+Shift+E', onSelect: () => format({ align: 'center' }, 'Align') }, { label: 'Right', keys: 'Ctrl+Shift+R', onSelect: () => format({ align: 'right' }, 'Align') },
          { separator: true }, { label: 'Top', onSelect: () => format({ valign: 'top' }, 'Align') }, { label: 'Middle', onSelect: () => format({ valign: 'middle' }, 'Align') }, { label: 'Bottom', onSelect: () => format({ valign: 'bottom' }, 'Align') },
        ] },
        { label: 'Wrapping', disabled: !has, sub: [{ label: 'Overflow', onSelect: () => format({ wrap: 'overflow' }, 'Wrap') }, { label: 'Wrap', onSelect: () => format({ wrap: 'wrap' }, 'Wrap') }, { label: 'Clip', onSelect: () => format({ wrap: 'clip' }, 'Wrap') }] },
        { label: 'Rotation', disabled: !has, sub: [0, 45, 90, -45, -90].map((d0) => ({ label: d0 === 0 ? 'None' : `${d0}°`, onSelect: () => format({ rotate: d0 }, 'Rotate') })) },
        { label: 'Font size', disabled: !has, sub: SIZES.map((n) => ({ label: String(n), onSelect: () => format({ size: n }, 'Font size') })) },
        { label: 'Merge cells', disabled: !has, sub: [{ label: 'Merge all', onSelect: () => run([{ op: 'merge', range: mainRange() }], 'Merge') }, { label: 'Merge horizontally', onSelect: () => run([{ op: 'merge', range: mainRange(), mode: 'horizontal' }], 'Merge') }, { label: 'Merge vertically', onSelect: () => run([{ op: 'merge', range: mainRange(), mode: 'vertical' }], 'Merge') }, { label: 'Unmerge', onSelect: () => run([{ op: 'unmerge', range: mainRange() }], 'Unmerge') }] },
        { separator: true },
        { label: 'Conditional formatting', disabled: !has, onSelect: () => openDialog({ kind: 'cond' }) },
        { label: 'Alternating colours', disabled: !has, onSelect: () => openDialog({ kind: 'banding' }) },
        { label: 'Clear formatting', keys: 'Ctrl+\\', disabled: !has, onSelect: () => run(sel.ranges.map((x) => ({ op: 'format', range: rectA1(x), reset: true })), 'Clear formatting') },
      ],
      Data: [
        { label: `Sort sheet by column ${colName(sel.active.c)} (A → Z)`, disabled: !has, onSelect: () => sortBy(false, true) },
        { label: `Sort sheet by column ${colName(sel.active.c)} (Z → A)`, disabled: !has, onSelect: () => sortBy(true, true) },
        { label: 'Sort range…', disabled: !has, onSelect: () => openDialog({ kind: 'sort' }) },
        { separator: true },
        { label: s?.filter ? 'Remove filter' : 'Create a filter', disabled: !has, onSelect: toggleFilter },
        { label: 'Data validation…', disabled: !has, onSelect: () => openDialog({ kind: 'validation' }) },
        { label: 'Named ranges…', disabled: !has, onSelect: () => openDialog({ kind: 'names' }) },
        { label: 'Pivot table…', disabled: !has, onSelect: () => openDialog({ kind: 'pivot' }) },
        { separator: true },
        { label: 'Data cleanup', disabled: !has, sub: [
          { label: 'Remove duplicates (first row is a header)', onSelect: () => run([{ op: 'remove_duplicates', range: rectA1(currentRegion()), header: true }], 'Remove duplicates') },
          { label: 'Trim whitespace', onSelect: () => run(sel.ranges.map((x) => ({ op: 'trim', range: rectA1(x) })), 'Trim whitespace') },
        ] },
        { label: 'Split text to columns', disabled: !has, sub: [['Detect automatically', 'auto'], ['Comma', ','], ['Semicolon', ';'], ['Period', '.'], ['Space', ' '], ['Tab', '\t']].map(([l, d0]) => ({ label: l, onSelect: () => run([{ op: 'split', range: rectA1({ ...r, c2: r.c1 }), delimiter: d0 }], 'Split text') })) },
      ],
      Tools: [
        { label: 'Review spreadsheet', disabled: !has, onSelect: () => openDialog({ kind: 'review' }) },
        { label: 'Function list', onSelect: () => openDialog({ kind: 'functions' }) },
        { label: 'Keyboard shortcuts', keys: 'Ctrl+/', onSelect: () => setHelpOpen(true) },
        { label: 'What is not supported', onSelect: () => openDialog({ kind: 'limits' }) },
      ],
    };
  };

  const nextSheetName = (): string => { let n = (wb?.sheets.length ?? 0) + 1; while (wb?.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++; return `Sheet${n}`; };

  /* ---------- derived view data ---------- */

  const activeCell = sheet ? cellAt(sheet, sel.active.r, sel.active.c) : undefined;
  const activeFmt = activeCell?.s;
  const barText = editor ? editor.text : sheet && doc ? (activeCell?.f ?? rawText(activeCell, doc.engine.display(sheet.id, sel.active.r, sel.active.c).text)) : '';
  const stats = (() => {
    if (!doc || !sheet) return null;
    const rect0 = sel.ranges;
    let n = 0, count = 0, counta = 0, sum = 0, min = Infinity, max = -Infinity, cells = 0;
    const used = usedRect(sheet);
    if (!used) return null;
    for (const rg of rect0) {
      const r2 = Math.min(rg.r2, used.r2), c2 = Math.min(rg.c2, used.c2);
      for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= c2; c++) {
        if (++cells > 200_000) break;
        const v = doc.engine.value(sheet.id, r, c);
        if (v === null) continue;
        counta++;
        if (typeof v === 'number') { count++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
      }
    }
    n = rect0.reduce((a, rg) => a + (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1), 0);
    if (n < 2 || counta === 0) return null;
    const nf = activeFmt?.nf;
    const f = (v: number) => formatValue(v, nf && !/[yd]/i.test(nf) ? nf : undefined).text;
    return { sum: count ? f(sum) : '0', avg: count ? f(sum / count) : '—', count, counta, min: count ? f(min) : '—', max: count ? f(max) : '—' };
  })();

  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    for (const ref of refs) map.set(ref.owner || 'legacy', [...(map.get(ref.owner || 'legacy') ?? []), ref]);
    return [...map.entries()];
  }, [refs]);

  const api: GridApi = {
    select: (next) => { setSelection(next); setNameBox(null); if (paint && docRef.current) { const p = paint; setPaint(null); run([{ op: 'copy', from: `${quote(findSheet(docRef.current.wb, p.sheet)!.name)}!${rectA1(p.rect)}`, to: rectA1(selRect(next)), paste: 'formats' }], 'Paint format'); } },
    startEdit: (r, c, text, mode) => startEdit(r, c, text, mode),
    editText,
    editorKey,
    keyDown,
    pointRef,
    canPoint,
    commitEdit: () => { commitEdit(); },
    run,
    copy,
    paste,
    contextMenu,
    chartEdit: (id) => openDialog({ kind: 'chart', id }),
  };

  const saveState = !current ? '' : saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved';
  // eslint-disable-next-line react-hooks/refs
  const menuDefs = menus();
  const runAndClose = (ops: Op[], label: string): boolean => run(ops, label);
  const selText = sheet ? rectA1(selRect(sel)) : 'A1';
  const nameShown = nameBox ?? (selText.includes(':') ? selText : addr(sel.active.r, sel.active.c));
  const gotoName = (text: string): void => {
    const d = docRef.current, s = sheetNow();
    if (!d || !s) return;
    const t = text.trim();
    const res = resolveRange(d.wb, t, s);
    if (res) {
      if (res.sheet.id !== s.id) { sheetIdRef.current = res.sheet.id; setSheetId(res.sheet.id); }
      setSelection({ ranges: [res.rect], active: { r: res.rect.r1, c: res.rect.c1 }, anchor: { r: res.rect.r1, c: res.rect.c1 } }, true);
    } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) { if (run([{ op: 'name_set', name: t, range: `${quote(s.name)}!${rectA1(selRect(selRef.current))}` }], 'Name range')) notify(`Named ${rectA1(selRect(selRef.current))} "${t}".`); }
    else notify(`"${t}" is not a cell, range or name.`, 'error');
    setNameBox(null);
    focusGrid();
  };

  /* ---------- toolbar popups ---------- */

  const toolPopup = (id: string, content: React.ReactNode) => (tool === id ? <div className="sh-pop sh-toolpop" role="menu" aria-label={id} onPointerLeave={() => undefined}>{content}</div> : null);
  const borderOps = (where: string, style = 'solid', color = '#000000'): void => { run(sel.ranges.map((x) => ({ op: 'border', range: rectA1(x), where, style, color })), 'Borders'); };

  return (
    <div className="screen sh">
      <header className="screen-header">
        <h1 className="screen-header__title">Sheet</h1>
        <span className="screen-header__meta">Google Sheets-style spreadsheets — the Data Analyst agent works on the same files</span>
        {current && <span className={`sh__save sh__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="sh__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => { setFilesOpen((o) => !o); setConfirmDelete(null); }}>
            <Table2 size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Spreadsheets'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="sh__popup sh__popup--list" role="menu" aria-label="Spreadsheets">
              {refs.length === 0 && <p className="sh-note sh-pad">No spreadsheets yet — create one, or ask the Data Analyst agent.</p>}
              {grouped.map(([owner, list]) => (
                <div key={owner}>
                  <div className="sh__owner">{owner}</div>
                  {list.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`sh__file${key === current ? ' sh__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="sh__file-main" title={sheetPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openSheetFile(key); }}>{ref.slug}</button>
                        {confirmDelete === key ? (
                          <>
                            <button type="button" className="sh-icon sh-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteFile(key)}><Check size={12} /></button>
                            <button type="button" className="sh-icon" aria-label="Keep spreadsheet" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="sh-icon sh__file-del" aria-label={`Delete ${ref.slug}`} title="Delete spreadsheet" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => openDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New spreadsheet</button>
      </header>

      <div className="screen-body sh__body">
        <div className="sh__main" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.sh__menu, .sh-toolwrap, .sh-pop')) { if (menu) setMenu(null); if (tool) setTool(null); } if (ctx && !(e.target as HTMLElement).closest('.sh-ctx')) setCtx(null); }}>
          {doc && wb && sheet ? (
            <>
              <div className="sh__titlerow">
                <SheetIcon size={22} className="sh__logo" strokeWidth={1.5} />
                <input className="sh__title" aria-label="Spreadsheet title" defaultValue={wb.title} key={`${current}:${wb.title}`} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== wb.title) run([{ op: 'workbook', title: e.target.value.trim() }], 'Rename'); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
              </div>
              <nav className="sh__menubar" aria-label="Sheet menu">
                {Object.entries(menuDefs).map(([name, entries]) => (
                  <div key={name} className="sh__menu">
                    <button type="button" className={`sh__menu-btn${menu === name ? ' sh__menu-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={menu === name} onClick={() => { setMenu(menu === name ? null : name); setSubOpen(null); }} onMouseEnter={() => { if (menu) { setMenu(name); setSubOpen(null); } }}>{name}</button>
                    {menu === name && <MenuPopup entries={entries} label={name} subOpen={subOpen} setSubOpen={setSubOpen} onClose={() => { setMenu(null); setSubOpen(null); }} />}
                  </div>
                ))}
                <span className="sh-grow" />
                <TB label={'Keyboard shortcuts'} icon={<Keyboard size={15} />} onClick={() => setHelpOpen(true)} on={false} disabled={false} title={'Keyboard shortcuts (Ctrl+/)'} />
              </nav>
              <div className="sh__toolbar" role="toolbar" aria-label="Formatting toolbar">
                <TB label={'Undo'} icon={<Undo2 size={15} />} onClick={undo} on={false} disabled={hist.undo === 0} title={'Undo (Ctrl+Z)'} />
                <TB label={'Redo'} icon={<Redo2 size={15} />} onClick={redo} on={false} disabled={hist.redo === 0} title={'Redo (Ctrl+Y)'} />
                <TB label={'Print'} icon={<Printer size={15} />} onClick={print} disabled={!has} />
                <TB label={'Paint format'} icon={<Paintbrush size={15} />} onClick={() => setPaint(paint ? null : { sheet: sheet.id, rect: selRect(sel) })} on={!!paint} disabled={!has} />
                <select className="sh-tbselect" aria-label="Zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{[0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((zz) => <option key={zz} value={zz}>{Math.round(zz * 100)}%</option>)}</select>
                <span className="sh-sep" />
                <TB label={'Format as currency'} icon={<DollarSign size={15} />} onClick={() => format({ number: 'currency' }, 'Currency')} disabled={!has} />
                <TB label={'Format as percent'} icon={<Percent size={15} />} onClick={() => format({ number: 'percent' }, 'Percent')} disabled={!has} />
                <TB label={'Decrease decimal places'} icon={<span className="sh-tbtext">.0</span>} onClick={() => adjustDecimals(-1)} disabled={!has} />
                <TB label={'Increase decimal places'} icon={<span className="sh-tbtext">.00</span>} onClick={() => adjustDecimals(1)} disabled={!has} />
                <div className="sh-toolwrap">
                  <TB label={'More formats'} icon={<span className="sh-tbtext">123<ChevronDown size={10} /></span>} onClick={() => setTool(tool === 'formats' ? null : 'formats')} disabled={!has} />
                  {toolPopup('formats', <>{NUMBER_FORMATS.map((f) => <button key={f.id} type="button" role="menuitem" onClick={() => { setTool(null); format({ number: f.pattern || 'auto' }, f.label); }}><span>{f.label}</span><kbd>{f.sample}</kbd></button>)}<hr /><button type="button" role="menuitem" onClick={() => { setTool(null); openDialog({ kind: 'numfmt' }); }}>Custom number format…</button></>)}
                </div>
                <span className="sh-sep" />
                <select className="sh-tbselect sh-tbselect--font" aria-label="Font" value={activeFmt?.ff ?? 'Arial'} onChange={(e) => format({ font: e.target.value }, 'Font')}>{FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                <span className="sh-sep" />
                <TB label={'Decrease font size'} icon={<Minus size={13} />} onClick={() => format({ size: Math.max(6, (activeFmt?.fs ?? 10) - 1) }, 'Font size')} disabled={!has} />
                <input className="sh-tbsize" aria-label="Font size" key={`${sel.active.r}:${sel.active.c}:${activeFmt?.fs ?? 10}`} defaultValue={activeFmt?.fs ?? 10} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const n = Number((e.target as HTMLInputElement).value); if (n >= 6 && n <= 72) format({ size: n }, 'Font size'); focusGrid(); } }} />
                <TB label={'Increase font size'} icon={<Plus size={13} />} onClick={() => format({ size: Math.min(72, (activeFmt?.fs ?? 10) + 1) }, 'Font size')} disabled={!has} />
                <span className="sh-sep" />
                <TB label={'Bold'} icon={<Bold size={15} />} onClick={() => format({ bold: !activeFmt?.b }, 'Bold')} on={!!activeFmt?.b} disabled={!has} title={'Bold (Ctrl+B)'} />
                <TB label={'Italic'} icon={<Italic size={15} />} onClick={() => format({ italic: !activeFmt?.i }, 'Italic')} on={!!activeFmt?.i} disabled={!has} title={'Italic (Ctrl+I)'} />
                <TB label={'Strikethrough'} icon={<Strikethrough size={15} />} onClick={() => format({ strike: !activeFmt?.s }, 'Strikethrough')} on={!!activeFmt?.s} disabled={!has} title={'Strikethrough (Alt+Shift+5)'} />
                <TB label={'Underline'} icon={<Underline size={15} />} onClick={() => format({ underline: !activeFmt?.u }, 'Underline')} on={!!activeFmt?.u} disabled={!has} title={'Underline (Ctrl+U)'} />
                <label className="sh-tb sh-tbcolor" title="Text colour"><Type size={14} /><i style={{ background: activeFmt?.color ?? '#000000' }} /><input type="color" aria-label="Text colour" value={activeFmt?.color ?? '#000000'} onChange={(e) => format({ color: e.target.value }, 'Text colour')} /></label>
                <span className="sh-sep" />
                <label className="sh-tb sh-tbcolor" title="Fill colour"><PaintBucket size={14} /><i style={{ background: activeFmt?.fill ?? '#ffffff' }} /><input type="color" aria-label="Fill colour" value={activeFmt?.fill ?? '#ffffff'} onChange={(e) => format({ fill: e.target.value }, 'Fill colour')} /></label>
                <div className="sh-toolwrap">
                  <TB label={'Borders'} icon={<Grid3x3 size={15} />} onClick={() => setTool(tool === 'borders' ? null : 'borders')} disabled={!has} />
                  {toolPopup('borders', <div className="sh-bordergrid">{[['all', 'All borders'], ['inner', 'Inner borders'], ['horizontal', 'Horizontal borders'], ['vertical', 'Vertical borders'], ['outer', 'Outer borders'], ['left', 'Left border'], ['top', 'Top border'], ['right', 'Right border'], ['bottom', 'Bottom border'], ['none', 'Clear borders']].map(([w, l]) => <button key={w} type="button" role="menuitem" onClick={() => { setTool(null); borderOps(w); }}>{l}</button>)}<hr /><button type="button" role="menuitem" onClick={() => { setTool(null); borderOps('bottom', 'thick'); }}>Thick bottom border</button><button type="button" role="menuitem" onClick={() => { setTool(null); borderOps('outer', 'dashed', '#5f6368'); }}>Dashed outer border</button><button type="button" role="menuitem" onClick={() => { setTool(null); borderOps('bottom', 'double'); }}>Double bottom border</button></div>)}
                </div>
                <div className="sh-toolwrap">
                  <TB label={'Merge cells'} icon={<span className="sh-tbtext">⇔<ChevronDown size={10} /></span>} onClick={() => setTool(tool === 'merge' ? null : 'merge')} disabled={!has} />
                  {toolPopup('merge', <>{[['all', 'Merge all'], ['horizontal', 'Merge horizontally'], ['vertical', 'Merge vertically']].map(([m, l]) => <button key={m} type="button" role="menuitem" onClick={() => { setTool(null); run([{ op: 'merge', range: mainRange(), mode: m }], l); }}>{l}</button>)}<button type="button" role="menuitem" onClick={() => { setTool(null); run([{ op: 'unmerge', range: mainRange() }], 'Unmerge'); }}>Unmerge</button></>)}
                </div>
                <span className="sh-sep" />
                <TB label={'Align left'} icon={<AlignLeft size={15} />} onClick={() => format({ align: 'left' }, 'Align left')} on={activeFmt?.ha === 'left'} disabled={!has} />
                <TB label={'Align centre'} icon={<AlignCenter size={15} />} onClick={() => format({ align: 'center' }, 'Align centre')} on={activeFmt?.ha === 'center'} disabled={!has} />
                <TB label={'Align right'} icon={<AlignRight size={15} />} onClick={() => format({ align: 'right' }, 'Align right')} on={activeFmt?.ha === 'right'} disabled={!has} />
                <TB label={'Align top'} icon={<ArrowUpToLine size={15} />} onClick={() => format({ valign: 'top' }, 'Align top')} on={activeFmt?.va === 'top'} disabled={!has} />
                <TB label={'Align bottom'} icon={<ArrowDownToLine size={15} />} onClick={() => format({ valign: 'bottom' }, 'Align bottom')} on={activeFmt?.va === 'bottom' || !activeFmt?.va} disabled={!has} />
                <TB label={'Wrap text'} icon={<WrapText size={15} />} onClick={() => format({ wrap: activeFmt?.wrap === 'wrap' ? 'overflow' : 'wrap' }, 'Wrap')} on={activeFmt?.wrap === 'wrap'} disabled={!has} />
                <span className="sh-sep" />
                <TB label={'Insert link'} icon={<Link2 size={15} />} onClick={linkDialog} disabled={!has} />
                <TB label={'Insert note'} icon={<MessageSquare size={15} />} onClick={noteDialog} disabled={!has} />
                <TB label={'Insert chart'} icon={<BarChart3 size={15} />} onClick={() => openDialog({ kind: 'chart' })} disabled={!has} />
                <TB label={sheet.filter ? 'Remove filter' : 'Create a filter'} icon={<Filter size={15} />} onClick={toggleFilter} on={!!sheet.filter} disabled={!has} />
                <div className="sh-toolwrap">
                  <TB label={'Functions'} icon={<Sigma size={15} />} onClick={() => setTool(tool === 'fn' ? null : 'fn')} disabled={!has} />
                  {toolPopup('fn', <>{['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((n) => <button key={n} type="button" role="menuitem" onClick={() => { setTool(null); insertFunction(n); }}>{n}</button>)}<hr /><button type="button" role="menuitem" onClick={() => { setTool(null); openDialog({ kind: 'functions' }); }}>More functions…</button></>)}
                </div>
              </div>
              <div className="sh__fbar">
                <input className="sh__namebox" aria-label="Name box" value={nameShown} onChange={(e) => setNameBox(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => setNameBox(null)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') gotoName((e.target as HTMLInputElement).value); if (e.key === 'Escape') { setNameBox(null); focusGrid(); } }} />
                <span className="sh__fx" aria-hidden>fx</span>
                <textarea ref={barRef} className="sh__formula" aria-label="Formula bar" rows={1} spellCheck={false} value={barText}
                  onFocus={() => { if (!editorRef.current && sheet) { const cell = cellAt(sheet, sel.active.r, sel.active.c); startEdit(sel.active.r, sel.active.c, cell?.f ?? rawText(cell, doc.engine.display(sheet.id, sel.active.r, sel.active.c).text), 'edit', 'bar'); } }}
                  onChange={(e) => { if (editorRef.current) editText(e.target.value); }}
                  onKeyDown={(e) => { e.stopPropagation(); if (editorRef.current) editorKey(e, e.currentTarget); }} />
              </div>
              <SheetGrid wb={wb} sheet={sheet} engine={doc.engine} zoom={zoom} sel={sel} editor={editor} refs={refBoxes}
                copyRect={copyRect && copyRect.sheet === sheet.id ? copyRect.rect : null} found={found.filter((f) => f.sheet === sheet.id)}
                showFormulas={showFormulas} scrollNonce={scrollNonce} api={api} inputRef={inputRef}
                autocomplete={ac ? { items: ac.items, index: ac.index } : null} signature={signature} onPickSuggestion={pickSuggestion} />
              <div className="sh__tabs" role="tablist" aria-label="Sheets">
                <button type="button" className="sh-icon" aria-label="Add sheet" title="Add sheet" onClick={() => run([{ op: 'sheet_add', name: nextSheetName() }], 'Add sheet')}><Plus size={15} /></button>
                <button type="button" className="sh-icon" aria-label="All sheets" title="All sheets" onClick={(e) => setCtx({ x: e.clientX, y: e.clientY - 10 - wb.sheets.length * 26, entries: wb.sheets.map((s) => ({ label: `${s.name}${s.hidden ? ' (hidden)' : ''}`, checked: s.id === sheet.id, onSelect: () => { if (s.hidden) run([{ op: 'sheet_set', sheet: s.id, hidden: false }], 'Show sheet'); switchSheet(s.id); } })) })}><Menu size={15} /></button>
                <div className="sh__tablist">
                  {wb.sheets.filter((s) => !s.hidden).map((s) => (
                    <div key={s.id} role="tab" aria-selected={s.id === sheet.id} tabIndex={0} className={`sh__tab${s.id === sheet.id ? ' sh__tab--on' : ''}`} style={s.color ? { boxShadow: `inset 0 -3px 0 ${s.color}` } : undefined}
                      draggable onDragStart={(e) => e.dataTransfer.setData('text/x-sheet', s.id)} onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { const id = e.dataTransfer.getData('text/x-sheet'); if (id && id !== s.id) run([{ op: 'sheet_move', sheet: id, to: wb.sheets.indexOf(s) + 1 }], 'Move sheet'); }}
                      onClick={() => { if (s.id !== sheet.id) switchSheet(s.id); }} onDoubleClick={() => setRenaming(s.id)}
                      onContextMenu={(e) => { e.preventDefault(); tabMenu(s, e.clientX, e.clientY - 280); }}>
                      {renaming === s.id ? (
                        <input className="sh__tabinput" aria-label="Sheet name" autoFocus defaultValue={s.name} onFocus={(e) => e.target.select()} onBlur={(e) => { setRenaming(null); if (e.target.value.trim() && e.target.value !== s.name) run([{ op: 'sheet_rename', sheet: s.id, name: e.target.value.trim() }], 'Rename sheet'); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                      ) : <span>{s.name}</span>}
                      <button type="button" className="sh__tabmenu" aria-label={`Sheet ${s.name} options`} onClick={(e) => { e.stopPropagation(); tabMenu(s, e.clientX, e.clientY - 280); }}><ChevronDown size={11} /></button>
                    </div>
                  ))}
                </div>
                <span className="sh-grow" />
                {stats && <span className="sh__stats" data-testid="selection-stats">Sum: {stats.sum} · Average: {stats.avg} · Count: {stats.count} · Min: {stats.min} · Max: {stats.max}</span>}
              </div>
              <div className="sh-sr" aria-live="polite" data-testid="active-cell">{addr(sel.active.r, sel.active.c)}: {displayScalar(doc.engine.value(sheet.id, sel.active.r, sel.active.c) as never) || ''}</div>
            </>
          ) : (
            <div className="sh__welcome">
              <Table2 size={34} strokeWidth={1.25} />
              <h2>Sheet</h2>
              <p>Spreadsheets the Google Sheets way: formulas with more than 200 functions, cross-sheet references, number formats, conditional formatting, dropdowns and checkboxes, filters, pivot tables, charts, CSV and Excel import/export — saved as files in your repository. Start from a template or a blank sheet, import a file, or ask the Data Analyst agent to build one.</p>
              <div className="sh-row">
                <button type="button" className="primary-button" onClick={() => openDialog({ kind: 'new' })}><Plus size={12} strokeWidth={1.5} /> New spreadsheet</button>
                <button type="button" className="secondary-button" onClick={() => { importMode.current = 'new'; fileInput.current?.click(); }}><ListPlus size={12} strokeWidth={1.5} /> Import CSV / Excel</button>
              </div>
            </div>
          )}
          {ctx && <div className="sh-ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 280), top: Math.max(8, Math.min(ctx.y, window.innerHeight - 40)) }}><MenuPopup entries={ctx.entries} label="Context menu" subOpen={subOpen} setSubOpen={setSubOpen} onClose={() => { setCtx(null); setSubOpen(null); focusGrid(); }} /></div>}
          {helpOpen && <ShortcutHelp title="Sheet shortcuts" groups={SHORTCUTS} onClose={() => { setHelpOpen(false); focusGrid(); }} />}
          <input ref={fileInput} type="file" hidden aria-label="Import a CSV, TSV or Excel file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('sheet')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {dialog?.kind === 'new' && <NewSheetDialog onCreate={(n, t) => void newBook(n, t)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'import' && (
        <Modal title="Import a file" onClose={() => setDialog(null)}>
          <p className="sh-note">CSV, TSV and text files, and Excel workbooks (.xlsx, .xlsm, .xls, .ods). From Excel files values, formulas, number formats, merges and column widths are read; cell colours, charts and validation are not.</p>
          <div className="sh-chips" role="radiogroup" aria-label="Import location">
            {([['insert', 'Insert new sheet(s)'], ['replace', 'Replace current sheet'], ['new', 'Create new spreadsheet']] as const).map(([m, l]) => <button key={m} type="button" role="radio" aria-checked={importChoice === m} className={`sh-chip-btn${importChoice === m ? ' sh-chip-btn--on' : ''}`} onClick={() => { importMode.current = m; setImportChoice(m); fileInput.current?.click(); }}>{l}…</button>)}
          </div>
        </Modal>
      )}
      {dialog?.kind === 'prompt' && <PromptDialog title={dialog.title} label={dialog.label} initial={dialog.initial} multiline={dialog.multiline} onOk={dialog.onOk} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'find' && <FindDialog initial="" replaceMode={dialog.replace} onFind={findNext} onReplace={replaceOne} onReplaceAll={replaceAll} onClose={() => { setDialog(null); setFound([]); focusGrid(); }} />}
      {dialog?.kind === 'cond' && sheet && <CondFormatDialog sheet={sheet} range={dctx?.ranges ?? 'A1'} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'validation' && sheet && <ValidationDialog sheet={sheet} range={dctx?.main ?? 'A1'} existing={validationAt(sheet, sel.active.r, sel.active.c)} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'chart' && sheet && <ChartDialog sheet={sheet} range={dctx ? rectA1(dctx.region) : 'A1'} chart={dialog.id ? wb?.sheets.flatMap((s) => s.charts).find((c) => c.id === dialog.id) : undefined} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'names' && wb && sheet && <NamedRangesDialog wb={wb} range={`${quote(sheet.name)}!${dctx?.main ?? 'A1'}`} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'pivot' && sheet && <PivotDialog range={dctx ? rectA1(dctx.region) : 'A1'} headers={dctx?.headers ?? []} onRun={(ops, l) => { const ok = run(ops, l); if (ok) { const name = String(ops[0].target ?? '').split('!')[0]; const s = docRef.current && findSheet(docRef.current.wb, name.replace(/^'|'$/g, '')); if (s) { sheetIdRef.current = s.id; setSheetId(s.id); setSelection(singleSel(0, 0)); } } return ok; }} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'sort' && sheet && <SortDialog range={dctx ? rectA1(dctx.sortRange) : 'A1'} headers={dctx?.sortHeaders ?? []} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'numfmt' && sheet && doc && <NumberFormatDialog sample={doc.engine.value(sheet.id, sel.active.r, sel.active.c)} initial={activeFmt?.nf ?? '#,##0.00'} onApply={(p) => { format({ number: p }, 'Custom number format'); setDialog(null); focusGrid(); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'banding' && <BandingDialog range={dctx ? rectA1(dctx.region) : 'A1'} onRun={runAndClose} onClose={() => { setDialog(null); focusGrid(); }} />}
      {dialog?.kind === 'functions' && <FunctionsDialog onInsert={insertFunction} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'review' && doc && <ReviewDialog lines={checkWorkbook(doc.wb, doc.engine).filter((l) => !l.startsWith('formula errors'))} errors={doc.engine.errors(50)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limits' && (
        <Modal title="What is not supported (compared with Google Sheets)" wide onClose={() => setDialog(null)}>
          <ul className="sh-review">
            <li>No real-time collaboration, sharing, comments threads, version history browser or protected ranges — the file lives in Git and Git is the history.</li>
            <li>No QUERY, IMPORTRANGE, IMPORTHTML/XML/DATA, GOOGLEFINANCE, GOOGLETRANSLATE, IMAGE, SPARKLINE, LAMBDA/LET/MAP/REDUCE, database (D*) and most engineering functions; Apps Script and macros are not available.</li>
            <li>Pivot tables are summary tables built from live formulas (SUMIFS etc.), not the interactive pivot editor; slicers, row/column grouping, filter views and Explore are missing.</li>
            <li>Charts: column, bar, stacked, line, area, combo, pie, doughnut and scatter (with trendline). No maps, gauges, histograms, candlestick, treemaps or per-point formatting.</li>
            <li>Excel export writes values, formulas, number formats, merges and sizes, but not cell colours/borders/fonts, conditional formatting, validation or charts (SheetJS Community Edition limitation). Print goes through a print-friendly HTML page.</li>
            <li>Dates follow Google Sheets serial numbers; locale settings (comma decimal separators, other date orders) and time zones are not configurable.</li>
          </ul>
        </Modal>
      )}
    </div>
  );
}

function TB({ label, icon, onClick, on = false, disabled = false, title }: { label: string; icon: React.ReactNode; onClick: () => void; on?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`sh-tb${on ? ' sh-tb--on' : ''}`} aria-label={label} title={title ?? label} aria-pressed={on || undefined} disabled={disabled} onClick={onClick}>{icon}</button>;
}

function MenuPopup({ entries, label, subOpen, setSubOpen, onClose }: { entries: MenuEntry[]; label: string; subOpen: string | null; setSubOpen: (v: string | null) => void; onClose: () => void }) {
  return (
    <div className="sh__popup" role="menu" aria-label={label}>
      {entries.map((entry, i) => entry.separator ? <hr key={i} /> : entry.sub ? (
        <div key={i} className="sh__sub" onMouseEnter={() => setSubOpen(`${label}:${entry.label}`)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={subOpen === `${label}:${entry.label}`} disabled={entry.disabled} onClick={() => setSubOpen(subOpen === `${label}:${entry.label}` ? null : `${label}:${entry.label}`)}><span>{entry.label}</span><kbd>▸</kbd></button>
          {subOpen === `${label}:${entry.label}` && !entry.disabled && (
            <div className="sh__popup sh__popup--sub" role="menu" aria-label={entry.label}>
              {entry.sub.map((s, j) => s.separator ? <hr key={j} /> : (
                <button key={j} type="button" role={s.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={s.checked} disabled={s.disabled} onClick={() => { onClose(); s.onSelect?.(); }}>
                  <span>{s.checked !== undefined && <Check size={11} style={{ opacity: s.checked ? 1 : 0 }} />}{/^#[0-9a-f]{6}$/i.test(s.label ?? '') ? <i className="sh-dot" style={{ background: s.label }} /> : null} {s.label}</span>
                  {s.keys && <kbd>{s.keys}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button key={i} type="button" role={entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={entry.checked} disabled={entry.disabled} onMouseEnter={() => setSubOpen(null)} onClick={() => { onClose(); entry.onSelect?.(); }}>
          <span>{entry.checked !== undefined && <Check size={11} style={{ opacity: entry.checked ? 1 : 0 }} />} {entry.label}</span>
          {entry.keys && <kbd>{entry.keys}</kbd>}
        </button>
      ))}
    </div>
  );
}

