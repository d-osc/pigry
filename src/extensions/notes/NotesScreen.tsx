import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import {
  Archive, Bell, Check, CheckSquare, ChevronDown, ChevronLeft, ImagePlus, LayoutGrid, Lightbulb, Menu, Pencil, Plus, Rows3, Search, Tag, Trash2, X,
} from 'lucide-react';
import { ShortcutHelp, type ShortcutGroup } from '../../app/ShortcutHelp';
import { ResizeHandle } from '../../app/ResizeHandle';
import { AiAgentPanel } from '../../screens/explorer/AiAgentPanel';
import { teamForScreen } from '../../lib/agentExtras';
import { useRepository } from '../../hooks/useRepository';
import { nameSlug, refKey, USER_OWNER, type OwnedRef } from '../../lib/ownedFiles';
import { Modal, PromptDialog } from '../docs/DocsDialogs';
import {
  COLORS, DEFAULT_NOTEBOOK, archiveNote, convertNote, copyNote, counts, deleteForever, deleteLabel, emptyBook, emptyTrash, ensureLabel, hasFilter, isEmptyNote, moveNote,
  newId, newNote, nextOccurrence, parseStamp, pinNote, renameLabel, restoreNote, setNoteLabel, trashNote, visibleNotes, masonry,
  type ChecklistItem, type Filter, type Note, type Notebook, type NoteColor, type TypeFilter, type View,
} from './notes';
import { NOTES_CHANGED, NOTES_OPEN, listBookRefs, loadBook, notesPath, registerNotesFlush, removeBook, saveBook, setOpenBook, takePendingOpenBook, type NotesChange, type NotesOpenRequest } from './notesStore';
import { NoteCard, NoteEditor, type MoreItem } from './NotesParts';
import './NotesScreen.css';

const LAST_KEY = 'pigry:notes-last';
const LAYOUT_KEY = 'pigry:notes-layout';
const SAVE_DELAY = 700;
const CARD_W = 240;
const GAP = 16;
const DEFAULT_KEY = `${USER_OWNER}/${DEFAULT_NOTEBOOK}`;

const SHORTCUTS: ShortcutGroup[] = [
  { title: 'Notes', items: [{ keys: 'C', label: 'Take a note' }, { keys: 'L', label: 'New list' }, { keys: '/', label: 'Search' }, { keys: 'Ctrl+G', label: 'Grid or list view' }, { keys: 'J / K', label: 'Next / previous note' }, { keys: 'Enter', label: 'Open the selected note' }] },
  { title: 'Selected note', items: [{ keys: 'E', label: 'Archive or unarchive' }, { keys: 'F', label: 'Pin or unpin' }, { keys: '#', label: 'Delete (move to Trash)' }] },
  { title: 'While editing', items: [{ keys: 'Esc', label: 'Close the note' }, { keys: 'Enter', label: 'New list item (splits at the caret)' }, { keys: 'Backspace', label: 'Join an empty item with the one above' }, { keys: 'Alt+↑ / Alt+↓', label: 'Move a list item' }, { keys: 'Ctrl+V', label: 'Paste an image into the note' }, { keys: 'Ctrl+/', label: 'This list' }] },
];

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
const refOf = (key: string | null): OwnedRef | null => { if (!key) return null; const cut = key.indexOf('/'); return cut < 0 ? { owner: '', slug: key } : { owner: key.slice(0, cut), slug: key.slice(cut + 1) }; };
const nowIso = (): string => new Date().toISOString();
/** A copy of the notebook that shares the (immutable) strings but not the arrays or objects, so edits never touch the old state. */
const copyNoteObj = (n: Note): Note => ({ ...n, items: n.items.map((i) => ({ ...i })), images: n.images.map((m) => ({ ...m })), labels: [...n.labels], reminder: n.reminder ? { ...n.reminder } : null });
const copyBook = (b: Notebook): Notebook => ({ ...b, labels: [...b.labels], notes: b.notes.map(copyNoteObj) });
const sameView = (a: View, b: View): boolean => a.kind === b.kind && (a.kind !== 'label' || (b.kind === 'label' && a.label === b.label));
const viewTitle = (v: View): string => (v.kind === 'notes' ? 'Notes' : v.kind === 'reminders' ? 'Reminders' : v.kind === 'archive' ? 'Archive' : v.kind === 'trash' ? 'Trash' : v.label);

type Dialog = { kind: 'labels' } | { kind: 'newbook' } | { kind: 'help' } | null;
interface Snack { text: string; undo?: Notebook }

export function NotesScreen() {
  const { repository, notify } = useRepository();
  const [refs, setRefs] = useState<OwnedRef[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [book, setBook] = useState<Notebook | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirtyTick, setDirtyTick] = useState(0);
  const [view, setView] = useState<View>({ kind: 'notes' });
  const [filter, setFilter] = useState<Filter>({ query: '', label: '', color: '', type: 'any' });
  const [layout, setLayout] = useState<'grid' | 'list'>(() => { try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } });
  const [navOpen, setNavOpen] = useState(true);
  const [composer, setComposer] = useState<Note | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [snack, setSnack] = useState<Snack | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [now, setNow] = useState(0);
  const [cols, setCols] = useState(4);
  const [aiOpen, setAiOpen] = useState(() => window.innerWidth >= 1700);
  const [aiWidth, setAiWidth] = useState(360);

  const bookRef = useRef<Notebook | null>(null);
  const currentRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const imageTarget = useRef<'composer' | string | null>(null);

  // A clock for reminder chips ("Today, 8:00 PM", overdue): ticks every 30 s.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 30_000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, []);

  /* ---------- state changes and saving ---------- */

  const markDirty = (): void => { dirtyRef.current = true; setDirty(true); setDirtyTick((t) => t + 1); };
  /** Applies fn to a copy of the notebook; returns false (and changes nothing) when fn returns false or throws. */
  const exec = (fn: (b: Notebook) => void | false, undoText?: string): boolean => {
    const base = bookRef.current;
    if (!base) return false;
    const next = copyBook(base);
    try { if (fn(next) === false) return false; }
    catch (e) { notify(e instanceof Error ? e.message : String(e), 'error'); return false; }
    bookRef.current = next;
    setBook(next);
    markDirty();
    if (undoText) setSnack({ text: undoText, undo: base });
    return true;
  };
  const execNote = (id: string, fn: (n: Note, b: Notebook) => void, undoText?: string): boolean => exec((b) => {
    const n = b.notes.find((x) => x.id === id);
    if (!n) return false;
    fn(n, b);
    n.updated = nowIso(); n.by = USER_OWNER;
  }, undoText);
  const patchNote = (id: string, patch: Partial<Note>): void => { execNote(id, (n) => { Object.assign(n, patch); }); };

  const saveNow = useCallback(async () => {
    const ref = refOf(currentRef.current), b = bookRef.current;
    if (!ref || !b || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaving(true);
    try { await saveBook(ref, b, 'editor'); setDirty(dirtyRef.current); }
    catch (error) { dirtyRef.current = true; notify(`Could not save the notes: ${String(error)}`, 'error'); }
    finally { setSaving(false); }
  }, [notify]);
  useEffect(() => {
    if (!dirtyTick) return;
    const t = window.setTimeout(() => { void saveNow(); }, SAVE_DELAY);
    return () => window.clearTimeout(t);
  }, [dirtyTick, saveNow]);
  useEffect(() => registerNotesFlush(saveNow), [saveNow]);
  useEffect(() => () => {
    const ref = refOf(currentRef.current), b = bookRef.current;
    if (dirtyRef.current && ref && b) void saveBook(ref, b, 'editor');
  }, []);
  useEffect(() => {
    if (!snack) return;
    const t = window.setTimeout(() => setSnack(null), 6000);
    return () => window.clearTimeout(t);
  }, [snack]);

  /* ---------- opening notebooks ---------- */

  const openBook = useCallback(async (key: string, note?: string, list?: OwnedRef[]) => {
    await saveNow();
    const ref = refOf(key);
    if (!ref) return;
    const known = list ?? (await listBookRefs().catch(() => [] as OwnedRef[]));
    const exists = known.some((r) => refKey(r) === refKey(ref));
    try {
      let b: Notebook;
      if (exists) {
        const loaded = await loadBook(ref);
        b = loaded.book;
        if (loaded.warnings.length) notify(`Notebook opened with ${loaded.warnings.length} repaired issue(s).`);
      } else b = emptyBook(ref.slug === DEFAULT_NOTEBOOK ? 'Notes' : ref.slug);
      const nextKey = refKey(ref);
      dirtyRef.current = false; setDirty(false);
      bookRef.current = b; currentRef.current = nextKey;
      setBook(b); setCurrent(nextKey); setOpenBook(nextKey, note ?? null);
      setComposer(null); setFocused(null); setSnack(null);
      setEditing(note && b.notes.some((n) => n.id === note) ? note : null);
      if (note) { const n = b.notes.find((x) => x.id === note); if (n) setView(n.trashed ? { kind: 'trash' } : n.archived ? { kind: 'archive' } : { kind: 'notes' }); }
      try { localStorage.setItem(LAST_KEY, nextKey); } catch { /* storage unavailable */ }
    } catch (error) { notify(`Could not open "${key}": ${String(error)}`, 'error'); }
  }, [notify, saveNow]);
  const refreshList = useCallback(async () => { try { setRefs(await listBookRefs()); } catch { setRefs([]); } }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let list: OwnedRef[] = [];
      try { list = await listBookRefs(); } catch { /* no workspace */ }
      if (cancelled) return;
      setRefs(list);
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* storage unavailable */ }
      const request: NotesOpenRequest | null = takePendingOpenBook();
      const keys = list.map(refKey);
      const wanted = request?.key ?? (last && keys.includes(last) ? last : keys.includes(DEFAULT_KEY) ? DEFAULT_KEY : keys.find((k) => k.startsWith(`${USER_OWNER}/`)) ?? DEFAULT_KEY);
      await openBook(wanted, request?.note, list);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onChanged = (event: Event) => {
      const change = (event as CustomEvent<NotesChange>).detail;
      void refreshList();
      if (change.key !== currentRef.current) return;
      if (change.deleted) { void openBook(DEFAULT_KEY); return; }
      if (change.source === 'agent') { dirtyRef.current = false; void openBook(change.key, editing ?? undefined); }
    };
    const onOpen = (event: Event) => { const r = (event as CustomEvent<NotesOpenRequest>).detail; takePendingOpenBook(); void openBook(r.key, r.note); };
    window.addEventListener(NOTES_CHANGED, onChanged);
    window.addEventListener(NOTES_OPEN, onOpen);
    return () => { window.removeEventListener(NOTES_CHANGED, onChanged); window.removeEventListener(NOTES_OPEN, onOpen); };
  }, [openBook, refreshList, editing]);
  useEffect(() => { if (current) setOpenBook(current, editing); }, [current, editing]);
  useEffect(() => () => setOpenBook(null), []);

  const newNotebook = async (raw: string): Promise<void> => {
    setDialog(null);
    const slug = nameSlug(raw, ['.notes.json']);
    const ref: OwnedRef = { owner: USER_OWNER, slug };
    if (refs.some((r) => refKey(r) === refKey(ref))) { await openBook(refKey(ref)); return; }
    await saveNow();
    const b = emptyBook(raw.trim() || slug);
    try { await saveBook(ref, b, 'editor'); await refreshList(); await openBook(refKey(ref)); }
    catch (error) { notify(`Could not create the notebook: ${String(error)}`, 'error'); }
  };
  const deleteBookFile = async (key: string): Promise<void> => {
    setConfirmDelete(null); setFilesOpen(false);
    const ref = refOf(key);
    if (!ref) return;
    try { if (key === currentRef.current) { dirtyRef.current = false; } await removeBook(ref); await refreshList(); }
    catch (error) { notify(`Could not delete: ${String(error)}`, 'error'); }
  };

  /* ---------- composer and editing ---------- */

  const startComposer = (kind: 'text' | 'checklist' = 'text', withImage = false): void => {
    setEditing(null);
    const draft = newNote({ kind, items: kind === 'checklist' ? [] : undefined, labels: view.kind === 'label' ? [view.label] : [], reminder: null });
    setComposer(draft);
    if (withImage) { imageTarget.current = 'composer'; window.setTimeout(() => imageInput.current?.click(), 0); }
  };
  const closeComposer = (): void => {
    const draft = composer;
    setComposer(null);
    if (!draft || isEmptyNote(draft)) return;
    const stamp = nowIso();
    exec((b) => {
      const n = { ...draft, items: draft.items.filter((i) => i.text.trim()), created: stamp, updated: stamp, by: USER_OWNER };
      for (const l of n.labels) ensureLabel(b, l);
      b.notes.unshift(n);
    });
  };
  const patchComposer = (patch: Partial<Note>): void => setComposer((c) => (c ? { ...c, ...patch } : c));
  const composerLabel = (label: string, on: boolean): void => {
    if (on && bookRef.current && !bookRef.current.labels.some((l) => l.toLowerCase() === label.toLowerCase())) exec((b) => { ensureLabel(b, label); });
    setComposer((c) => (c ? { ...c, labels: on ? [...c.labels.filter((l) => l.toLowerCase() !== label.toLowerCase()), label] : c.labels.filter((l) => l.toLowerCase() !== label.toLowerCase()) } : c));
  };

  const addImages = async (target: 'composer' | string, files: File[]): Promise<void> => {
    const images: Note['images'] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try { images.push({ id: newId('m'), src: await readFileAsDataUrl(f), alt: f.name.replace(/\.[^.]+$/, '') }); }
      catch { notify(`Could not read ${f.name}`, 'error'); }
    }
    if (!images.length) return;
    if (target === 'composer') setComposer((c) => (c ? { ...c, images: [...c.images, ...images] } : c));
    else execNote(target, (n) => { n.images.push(...images); });
  };
  const pickImage = (target: 'composer' | string): void => { imageTarget.current = target; imageInput.current?.click(); };

  /* ---------- note actions ---------- */

  const archive = (id: string): void => {
    const n = bookRef.current?.notes.find((x) => x.id === id);
    if (!n) return;
    const on = !n.archived;
    execNote(id, (x) => archiveNote(x, on), on ? 'Note archived' : 'Note unarchived');
    if (on && editing === id) setEditing(null);
  };
  const trash = (id: string): void => { execNote(id, (x) => trashNote(x, nowIso()), 'Note moved to Trash'); if (editing === id) setEditing(null); };
  const restore = (id: string): void => { execNote(id, (x) => restoreNote(x), 'Note restored'); if (editing === id) setEditing(null); };
  const destroy = (id: string): void => { exec((b) => deleteForever(b, id), 'Note deleted forever'); if (editing === id) setEditing(null); };
  const pin = (id: string): void => { const n = bookRef.current?.notes.find((x) => x.id === id); if (n) execNote(id, (x) => pinNote(x, !n.pinned)); };
  const copy = (id: string): void => { let made: Note | undefined; exec((b) => { made = copyNote(b, id, nowIso()); }, 'Note copied'); if (made && editing === id) setEditing(made.id); };
  const toggleKind = (id: string): void => { const n = bookRef.current?.notes.find((x) => x.id === id); if (n) execNote(id, (x) => convertNote(x, n.kind === 'checklist' ? 'text' : 'checklist')); };
  const labelNote = (id: string, label: string, on: boolean): void => { execNote(id, (x, b) => setNoteLabel(b, x, label, on)); };
  const setItems = (id: string, items: ChecklistItem[]): void => { execNote(id, (x) => { x.items = items; }); };
  const moreFor = (n: Note): MoreItem[] => [
    { label: 'Delete note', run: () => trash(n.id) },
    { label: 'Make a copy', run: () => copy(n.id) },
    { label: n.kind === 'checklist' ? 'Hide checkboxes' : 'Show checkboxes', run: () => toggleKind(n.id) },
    ...(n.kind === 'checklist' && n.items.some((i) => i.checked) ? [{ label: 'Uncheck all items', run: () => execNote(n.id, (x) => { for (const i of x.items) i.checked = false; }) }, { label: 'Delete checked items', run: () => execNote(n.id, (x) => { x.items = x.items.filter((i) => !i.checked); }) }] : []),
  ];
  /** A repeating reminder that has passed moves on to its next time. */
  useEffect(() => {
    const b = bookRef.current;
    if (!now || !b) return;
    const due = new Set(b.notes.filter((n) => n.reminder && n.reminder.repeat !== 'none' && (parseStamp(n.reminder.at)?.getTime() ?? now) < now - 60_000).map((n) => n.id));
    if (!due.size) return;
    const t = window.setTimeout(() => {
      exec((x) => { for (const n of x.notes) if (due.has(n.id) && n.reminder) n.reminder = { ...n.reminder, at: nextOccurrence(n.reminder, now) ?? n.reminder.at }; });
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, book]);

  /* ---------- drag and drop ---------- */

  const dragPropsFor = (n: Note) => ({
    draggable: view.kind !== 'trash',
    onDragStart: (e: ReactDragEvent) => { if ((e.target as HTMLElement).closest('input, textarea, button, .nt-pop')) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-pigry-note', n.id); setDrag(n.id); },
    onDragEnd: () => { setDrag(null); setDrop(null); },
    onDragOver: (e: ReactDragEvent) => {
      if (!drag || drag === n.id) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      if (drop?.id !== n.id || drop.after !== after) setDrop({ id: n.id, after });
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      const from = drag, to = drop;
      setDrag(null); setDrop(null);
      if (from && to && from !== to.id) exec((b) => moveNote(b, from, to.id, to.after));
    },
  });

  /* ---------- keyboard ---------- */

  const shown = useMemo(() => (book ? visibleNotes(book, view, filter) : { pinned: [], others: [] }), [book, view, filter]);
  const order = useMemo(() => [...shown.pinned, ...shown.others].map((n) => n.id), [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !root.contains(t)) return;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.ai-panel'))) return;
      if (document.querySelector('.dc-modal__scrim, .nt-scrim')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); toggleLayout(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); e.stopPropagation(); setDialog({ kind: 'help' }); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'c' && view.kind !== 'trash') { e.preventDefault(); startComposer('text'); }
      else if (e.key === 'l' && view.kind !== 'trash') { e.preventDefault(); startComposer('checklist'); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const at = focused ? order.indexOf(focused) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, at + (e.key === 'j' ? 1 : -1)))] ?? order[0];
        if (next) { setFocused(next); root.querySelector<HTMLElement>(`[data-testid="note-card"][data-id="${next}"]`)?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  const onCardKey = (n: Note, key: string): void => {
    if (key === 'e') archive(n.id);
    else if (key === 'f') pin(n.id);
    else if (key === '#' || key === 'Delete') { if (n.trashed) destroy(n.id); else trash(n.id); }
  };
  const toggleLayout = (): void => setLayout((l) => { const next = l === 'grid' ? 'list' : 'grid'; try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* storage unavailable */ } return next; });

  /* ---------- layout ---------- */

  const gridRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () => setCols(Math.max(1, Math.floor((node.clientWidth + GAP) / (CARD_W + GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const c = book ? counts(book) : null;
  const editNote = editing && book ? book.notes.find((n) => n.id === editing) ?? null : null;
  const searching = hasFilter(filter);
  const listCols = layout === 'list' ? 1 : cols;
  const grouped = useMemo(() => {
    const map = new Map<string, OwnedRef[]>();
    const all = [...refs];
    const cur = refOf(current);
    if (cur && !all.some((r) => refKey(r) === refKey(cur))) all.push(cur);
    for (const r of all) map.set(r.owner || '(shared)', [...(map.get(r.owner || '(shared)') ?? []), r]);
    return [...map.entries()].sort(([a], [b]) => (a === USER_OWNER ? -1 : b === USER_OWNER ? 1 : a.localeCompare(b)));
  }, [refs, current]);
  const saveState = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  const labels = book?.labels ?? [];

  const card = (n: Note) => (
    <NoteCard key={n.id} note={n} now={now} labels={labels} selected={focused === n.id} dragging={drag === n.id} drop={drop?.id === n.id ? (drop.after ? 'after' : 'before') : null}
      more={moreFor(n)} onOpen={() => { setComposer(null); setEditing(n.id); setFocused(n.id); }}
      onPin={n.trashed ? undefined : () => pin(n.id)} onItems={(items) => setItems(n.id, items)} onLabelClick={(l) => { setView({ kind: 'label', label: l }); setFilter((f) => ({ ...f, query: '' })); }}
      onKeyAction={(k) => onCardKey(n, k)} dragProps={dragPropsFor(n)}
      onColor={(color) => patchNote(n.id, { color })} onBackground={(background) => patchNote(n.id, { background })} onReminder={(reminder) => patchNote(n.id, { reminder })}
      onLabel={(l, on) => labelNote(n.id, l, on)} onImage={() => pickImage(n.id)} onArchive={() => archive(n.id)}
      trash={n.trashed ? { onRestore: () => restore(n.id), onDelete: () => destroy(n.id) } : undefined} />
  );
  const section = (title: string | null, notes: Note[]) => notes.length > 0 && (
    <section className="nt-section" aria-label={title ?? viewTitle(view)}>
      {title && <h2 className="nt-section__title">{title}</h2>}
      <div className={`nt-grid nt-grid--${layout}`}>
        {masonry(notes, listCols).map((col, i) => <div key={i} className="nt-col">{col.map(card)}</div>)}
      </div>
    </section>
  );
  const emptyState = (() => {
    if (searching) return { icon: <Search size={96} strokeWidth={1} />, text: 'No matching results.' };
    if (view.kind === 'reminders') return { icon: <Bell size={96} strokeWidth={1} />, text: 'Notes with upcoming reminders appear here' };
    if (view.kind === 'archive') return { icon: <Archive size={96} strokeWidth={1} />, text: 'Your archived notes appear here' };
    if (view.kind === 'trash') return { icon: <Trash2 size={96} strokeWidth={1} />, text: 'No notes in Trash' };
    if (view.kind === 'label') return { icon: <Tag size={96} strokeWidth={1} />, text: 'No notes with this label yet' };
    return { icon: <Lightbulb size={96} strokeWidth={1} />, text: 'Notes that you add appear here' };
  })();
  const navItem = (v: View, icon: ReactNode, label: string, count?: number) => (
    <button key={label} type="button" className={`nt-nav__item${sameView(view, v) ? ' nt-nav__item--on' : ''}`} aria-current={sameView(view, v) ? 'page' : undefined} title={label}
      onClick={() => { setView(v); setEditing(null); setFocused(null); setFilter((f) => ({ ...f, query: '', label: '', color: '', type: 'any' })); }}>
      {icon}{navOpen && <span className="nt-nav__label">{label}</span>}{navOpen && count !== undefined && count > 0 && <span className="nt-nav__count">{count}</span>}
    </button>
  );

  return (
    <div className="screen nt" ref={rootRef}>
      <header className="screen-header">
        <h1 className="screen-header__title">Notes</h1>
        <span className="screen-header__meta">Google Keep-style notes and lists — agents can add to them too</span>
        {current && <span className={`dc__save dc__save--${saving ? 'saving' : dirty ? 'dirty' : 'saved'}`} role="status">{saveState}</span>}
        <div className="dc__menu">
          <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={filesOpen} onClick={() => { setFilesOpen((o) => !o); setConfirmDelete(null); }}>
            <Lightbulb size={12} strokeWidth={1.5} /> {current ? current.split('/').pop() : 'Notebooks'} <ChevronDown size={11} />
          </button>
          {filesOpen && (
            <div className="dc__popup dc__popup--list" role="menu" aria-label="Notebooks">
              {grouped.map(([owner, items]) => (
                <div key={owner}>
                  <div className="dc__owner">{owner}</div>
                  {items.map((ref) => {
                    const key = refKey(ref);
                    return (
                      <div key={key} className={`dc__file${key === current ? ' dc__file--on' : ''}`}>
                        <button type="button" role="menuitem" className="dc__file-main" title={notesPath(ref)} onClick={() => { setFilesOpen(false); if (key !== current) void openBook(key); }}>{ref.slug}</button>
                        {refs.some((r) => refKey(r) === key) && (confirmDelete === key ? (
                          <>
                            <button type="button" className="dc-icon dc-icon--danger" aria-label={`Confirm delete ${ref.slug}`} onClick={() => void deleteBookFile(key)}><Check size={12} /></button>
                            <button type="button" className="dc-icon" aria-label="Keep notebook" onClick={() => setConfirmDelete(null)}><X size={12} /></button>
                          </>
                        ) : <button type="button" className="dc-icon dc__file-del" aria-label={`Delete ${ref.slug}`} title="Delete notebook" onClick={() => setConfirmDelete(key)}><Trash2 size={12} /></button>)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="secondary-button" onClick={() => { setFilesOpen(false); setDialog({ kind: 'newbook' }); }}><Plus size={12} strokeWidth={1.5} /> New notebook</button>
      </header>

      <div className="screen-body nt__body">
        <div className="nt__main" onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (filesOpen && !t.closest('.dc__menu')) setFilesOpen(false);
          if (composer && !t.closest('[data-testid="note-composer"], .nt-composer, .nt-snack')) closeComposer();
        }}>
          <div className="nt-bar">
            <button type="button" className="nt-ib nt-bar__menu" aria-label="Main menu" aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}><Menu size={18} /></button>
            <Lightbulb size={24} className="nt__logo" strokeWidth={1.5} />
            <span className="nt-bar__title">{book?.title ?? 'Notes'}</span>
            <div className="nt-search" role="search">
              <Search size={16} />
              <input ref={searchRef} aria-label="Search notes" placeholder="Search" value={filter.query ?? ''} onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setFilter((f) => ({ ...f, query: '' })); e.currentTarget.blur(); } }} />
              {searching && <button type="button" className="nt-ib" aria-label="Clear search" onClick={() => setFilter({ query: '', label: '', color: '', type: 'any' })}><X size={15} /></button>}
            </div>
            <select className="dc-select nt-filter" aria-label="Filter by type" value={filter.type ?? 'any'} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value as TypeFilter }))}>
              <option value="any">All types</option><option value="text">Text notes</option><option value="checklist">Lists</option><option value="images">Images</option><option value="reminders">Reminders</option>
            </select>
            <select className="dc-select nt-filter" aria-label="Filter by label" value={filter.label ?? ''} onChange={(e) => setFilter((f) => ({ ...f, label: e.target.value }))}>
              <option value="">All labels</option>{labels.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select className="dc-select nt-filter" aria-label="Filter by colour" value={filter.color ?? ''} onChange={(e) => setFilter((f) => ({ ...f, color: e.target.value as NoteColor | '' }))}>
              <option value="">All colours</option>{COLORS.map((col) => <option key={col.id} value={col.id}>{col.label}</option>)}
            </select>
            <button type="button" className="nt-ib" aria-label={layout === 'grid' ? 'List view' : 'Grid view'} title={`${layout === 'grid' ? 'List view' : 'Grid view'} (Ctrl+G)`} onClick={toggleLayout}>{layout === 'grid' ? <Rows3 size={18} /> : <LayoutGrid size={18} />}</button>
            <button type="button" className="nt-ib" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (Ctrl+/)" onClick={() => setDialog({ kind: 'help' })}>?</button>
          </div>
          <div className="nt-work">
            <nav className={`nt-nav${navOpen ? '' : ' nt-nav--mini'}`} aria-label="Notes views">
              {navItem({ kind: 'notes' }, <Lightbulb size={18} />, 'Notes', c?.notes)}
              {navItem({ kind: 'reminders' }, <Bell size={18} />, 'Reminders', c?.reminders)}
              {labels.map((l) => navItem({ kind: 'label', label: l }, <Tag size={18} />, l, c?.labels[l]))}
              <button type="button" className="nt-nav__item" title="Edit labels" onClick={() => setDialog({ kind: 'labels' })}><Pencil size={18} />{navOpen && <span className="nt-nav__label">Edit labels</span>}</button>
              {navItem({ kind: 'archive' }, <Archive size={18} />, 'Archive', c?.archive)}
              {navItem({ kind: 'trash' }, <Trash2 size={18} />, 'Trash', c?.trash)}
            </nav>
            <div className="nt-content" data-testid="notes-content">
              {view.kind !== 'trash' && view.kind !== 'archive' && !searching && (
                <div className="nt-composer">
                  {composer ? (
                    <NoteEditor note={composer} now={now} mode="composer" labels={labels} more={[{ label: composer.kind === 'checklist' ? 'Hide checkboxes' : 'Show checkboxes', run: () => { const d = { ...composer, items: [...composer.items] }; convertNote(d, composer.kind === 'checklist' ? 'text' : 'checklist'); setComposer(d); } }]}
                      onChange={patchComposer} onPin={() => patchComposer({ pinned: !composer.pinned, archived: false })} onClose={closeComposer}
                      onColor={(color) => patchComposer({ color })} onBackground={(background) => patchComposer({ background })} onReminder={(reminder) => patchComposer({ reminder })}
                      onLabel={composerLabel} onImage={() => pickImage('composer')} onArchive={() => { const d = composer; setComposer(null); if (!isEmptyNote(d)) exec((b) => { for (const l of d.labels) ensureLabel(b, l); b.notes.unshift({ ...d, items: d.items.filter((i) => i.text.trim()), archived: true, pinned: false, created: nowIso(), updated: nowIso(), by: USER_OWNER }); }, 'Note archived'); }}
                      onDropImages={(files) => void addImages('composer', files)} />
                  ) : (
                    <div className="nt-take" role="group" aria-label="Take a note">
                      <button type="button" className="nt-take__input" onClick={() => startComposer('text')}>Take a note…</button>
                      <button type="button" className="nt-ib" aria-label="New list" title="New list (L)" onClick={() => startComposer('checklist')}><CheckSquare size={18} /></button>
                      <button type="button" className="nt-ib" aria-label="New note with image" title="New note with image" onClick={() => startComposer('text', true)}><ImagePlus size={18} /></button>
                    </div>
                  )}
                </div>
              )}
              {view.kind === 'trash' && (
                <div className="nt-banner">
                  <span>Notes in Trash stay here until you delete them forever or empty the Trash.</span>
                  <button type="button" className="dc-link" disabled={!c?.trash} onClick={() => exec((b) => { emptyTrash(b); }, 'Trash emptied')}>Empty Trash</button>
                </div>
              )}
              <div ref={gridRef} className="nt-sections">
                {shown.pinned.length + shown.others.length === 0 ? (
                  <div className="nt-empty">{emptyState.icon}<p>{emptyState.text}</p></div>
                ) : (
                  <>
                    {section(shown.pinned.length ? 'Pinned' : null, shown.pinned)}
                    {section(shown.pinned.length && shown.others.length ? 'Others' : null, shown.others)}
                  </>
                )}
              </div>
            </div>
          </div>
          {snack && (
            <div className="nt-snack" role="status">
              <span>{snack.text}</span>
              {snack.undo && <button type="button" className="nt-snack__undo" onClick={() => { const prev = snack.undo!; bookRef.current = prev; setBook(prev); markDirty(); setSnack(null); }}>Undo</button>}
              <button type="button" className="nt-ib" aria-label="Dismiss" onClick={() => setSnack(null)}><X size={14} /></button>
            </div>
          )}
          <input ref={imageInput} type="file" hidden aria-label="Add an image file" accept="image/*" multiple onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; const t = imageTarget.current; imageTarget.current = null; if (t && files.length) void addImages(t, files); }} />
        </div>

        {aiOpen && <ResizeHandle orientation="v" label="Resize AI panel" onDelta={(dx) => setAiWidth((w) => Math.min(window.innerWidth * 0.5, Math.max(280, w - dx)))} />}
        {aiOpen ? (
          <AiAgentPanel width={aiWidth} fileName={repository?.name ?? 'pigry'} defaultTeam={teamForScreen('notes')} onCollapse={() => setAiOpen(false)} />
        ) : (
          <button type="button" className="ai-rail-strip" title="Show AI Agent panel" onClick={() => setAiOpen(true)}>
            <ChevronLeft size={14} strokeWidth={1.5} />
            <span>AI Agent</span>
          </button>
        )}
      </div>

      {editNote && (
        <div className="nt-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="nt-dialog" role="dialog" aria-modal="true" aria-label="Edit note" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}>
            <NoteEditor note={editNote} now={now} mode="dialog" readOnly={!!editNote.trashed} labels={labels} more={moreFor(editNote)}
              onChange={(patch) => patchNote(editNote.id, patch)} onPin={() => pin(editNote.id)} onClose={() => setEditing(null)}
              onColor={(color) => patchNote(editNote.id, { color })} onBackground={(background) => patchNote(editNote.id, { background })} onReminder={(reminder) => patchNote(editNote.id, { reminder })}
              onLabel={(l, on) => labelNote(editNote.id, l, on)} onImage={() => pickImage(editNote.id)} onArchive={() => archive(editNote.id)}
              trash={editNote.trashed ? { onRestore: () => restore(editNote.id), onDelete: () => destroy(editNote.id) } : undefined}
              onDropImages={(files) => void addImages(editNote.id, files)} />
          </div>
        </div>
      )}
      {dialog?.kind === 'labels' && book && (
        <EditLabelsDialog labels={book.labels} onCreate={(l) => exec((b) => { ensureLabel(b, l); })} onRename={(from, to) => exec((b) => { renameLabel(b, from, to); })}
          onDelete={(l) => { exec((b) => deleteLabel(b, l)); if (view.kind === 'label' && view.label === l) setView({ kind: 'notes' }); }} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'newbook' && <PromptDialog title="New notebook" label="Notebook name" okLabel="Create" onOk={(v) => { if (v.trim()) void newNotebook(v); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'help' && <ShortcutHelp title="Notes shortcuts" groups={SHORTCUTS} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EditLabelsDialog({ labels, onCreate, onRename, onDelete, onClose }: { labels: string[]; onCreate: (l: string) => void; onRename: (from: string, to: string) => void; onDelete: (l: string) => void; onClose: () => void }) {
  const [fresh, setFresh] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const create = () => { const v = fresh.trim(); if (v) { onCreate(v); setFresh(''); } };
  return (
    <Modal title="Edit labels" onClose={onClose} extra={<span />}>
      <div className="nt-labels-edit">
        <div className="nt-labels-edit__row">
          <button type="button" className="nt-ib" aria-label="Cancel" onClick={() => setFresh('')}><X size={15} /></button>
          <input className="dc-input" aria-label="Create new label" placeholder="Create new label" value={fresh} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); create(); } }} />
          <button type="button" className="nt-ib" aria-label="Create label" disabled={!fresh.trim()} onClick={create}><Check size={15} /></button>
        </div>
        {labels.map((l) => (
          <div key={l} className="nt-labels-edit__row">
            <button type="button" className="nt-ib" aria-label={`Delete label ${l}`} onClick={() => onDelete(l)}><Trash2 size={15} /></button>
            <input className="dc-input" aria-label={`Rename label ${l}`} value={drafts[l] ?? l} onChange={(e) => setDrafts((d) => ({ ...d, [l]: e.target.value }))}
              onBlur={() => { const v = (drafts[l] ?? l).trim(); if (v && v !== l) onRename(l, v); setDrafts((d) => { const n = { ...d }; delete n[l]; return n; }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); (e.target as HTMLInputElement).blur(); } }} />
            <Pencil size={14} className="nt-muted" />
          </div>
        ))}
      </div>
      <p className="dc-note">Deleting a label takes it off every note; the notes stay.</p>
    </Modal>
  );
}
