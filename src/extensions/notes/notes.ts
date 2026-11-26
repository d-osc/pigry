/** Notes model (Google Keep-style): a notebook file holds labels and notes; a note is text or a checklist with a colour,
 * a background, labels, images, a reminder, and pinned / archived / trashed state. Pure — node tests import it. */

export const NOTES_DIR = '.pigry/notes/';
export const NOTES_EXT = '.notes.json';
export const DEFAULT_NOTEBOOK = 'notes';

export const COLORS = [
  { id: 'default', label: 'Default', light: '#ffffff', dark: '#202124' },
  { id: 'coral', label: 'Coral', light: '#faafa8', dark: '#77172e' },
  { id: 'peach', label: 'Peach', light: '#f39f76', dark: '#692b17' },
  { id: 'sand', label: 'Sand', light: '#fff8b8', dark: '#7c4a03' },
  { id: 'mint', label: 'Mint', light: '#e2f6d3', dark: '#264d3b' },
  { id: 'sage', label: 'Sage', light: '#b4ddd3', dark: '#0c625d' },
  { id: 'fog', label: 'Fog', light: '#d4e4ed', dark: '#256377' },
  { id: 'storm', label: 'Storm', light: '#aeccdc', dark: '#284255' },
  { id: 'dusk', label: 'Dusk', light: '#d3bfdb', dark: '#472e5b' },
  { id: 'blossom', label: 'Blossom', light: '#f6e2dd', dark: '#6c394f' },
  { id: 'clay', label: 'Clay', light: '#e9e3d4', dark: '#4b443a' },
  { id: 'chalk', label: 'Chalk', light: '#efeff1', dark: '#232427' },
] as const;
export type NoteColor = (typeof COLORS)[number]['id'];

/** Background presets: a light pattern and a glyph drawn in the corner of the card (no image files). */
export const BACKGROUNDS = [
  { id: 'none', label: 'No background', glyph: '', css: '' },
  { id: 'groceries', label: 'Groceries', glyph: '🛒', css: 'radial-gradient(circle at 100% 100%, rgba(76,175,80,0.22) 0 30%, transparent 31%)' },
  { id: 'food', label: 'Food', glyph: '🍜', css: 'radial-gradient(circle at 0% 100%, rgba(255,152,0,0.22) 0 34%, transparent 35%)' },
  { id: 'music', label: 'Music', glyph: '🎵', css: 'repeating-linear-gradient(0deg, transparent 0 18px, rgba(103,58,183,0.12) 18px 19px)' },
  { id: 'recipes', label: 'Recipes', glyph: '🧁', css: 'radial-gradient(rgba(233,30,99,0.16) 2px, transparent 2.5px) 0 0 / 14px 14px' },
  { id: 'notes', label: 'Notes', glyph: '📒', css: 'repeating-linear-gradient(0deg, transparent 0 22px, rgba(33,150,243,0.16) 22px 23px)' },
  { id: 'places', label: 'Places', glyph: '📍', css: 'linear-gradient(160deg, transparent 55%, rgba(0,150,136,0.2) 55% 70%, transparent 70%)' },
  { id: 'travel', label: 'Travel', glyph: '✈️', css: 'linear-gradient(200deg, rgba(3,169,244,0.18) 0 35%, transparent 35%)' },
  { id: 'video', label: 'Video', glyph: '🎬', css: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.08) 0 10px, transparent 10px 22px) 0 0 / 100% 8px no-repeat' },
  { id: 'celebration', label: 'Celebration', glyph: '🎉', css: 'radial-gradient(rgba(255,193,7,0.35) 1.5px, transparent 2px) 0 0 / 18px 18px, radial-gradient(rgba(244,67,54,0.25) 1.5px, transparent 2px) 9px 9px / 18px 18px' },
] as const;
export type NoteBackground = (typeof BACKGROUNDS)[number]['id'];

export const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;
export type Repeat = (typeof REPEATS)[number];

export interface ChecklistItem { id: string; text: string; checked: boolean }
export interface NoteImage { id: string; src: string; alt: string }
/** `at` is a local date-time, "YYYY-MM-DDTHH:mm" (what <input type="datetime-local"> uses). */
export interface Reminder { at: string; repeat: Repeat }
export interface Note {
  id: string;
  kind: 'text' | 'checklist';
  title: string;
  body: string;
  items: ChecklistItem[];
  color: NoteColor;
  background: NoteBackground;
  labels: string[];
  images: NoteImage[];
  pinned: boolean;
  archived: boolean;
  /** When it was moved to the trash (ISO), or null. */
  trashed: string | null;
  reminder: Reminder | null;
  created: string;
  updated: string;
  /** Who wrote it last: "user" or an agent's username. */
  by?: string;
}
export interface Notebook { version: 1; title: string; labels: string[]; notes: Note[] }
export interface NormalizeResult { book: Notebook; warnings: string[] }

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let idCounter = 0;
export const newId = (prefix = 'n'): string => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const isColor = (v: unknown): v is NoteColor => COLORS.some((c) => c.id === v);
export const isBackground = (v: unknown): v is NoteBackground => BACKGROUNDS.some((b) => b.id === v);
export const colorOf = (id: NoteColor) => COLORS.find((c) => c.id === id) ?? COLORS[0];
export const backgroundOf = (id: NoteBackground) => BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
/** A colour or background by id or label, case-insensitive. */
export const findColor = (v: unknown): NoteColor | undefined => COLORS.find((c) => c.id === String(v ?? '').trim().toLowerCase() || c.label.toLowerCase() === String(v ?? '').trim().toLowerCase())?.id;
export const findBackground = (v: unknown): NoteBackground | undefined => { const s = String(v ?? '').trim().toLowerCase(); return BACKGROUNDS.find((b) => b.id === s || b.label.toLowerCase() === s)?.id; };

export function emptyBook(title = 'Notes'): Notebook { return { version: 1, title, labels: [], notes: [] }; }

export function newNote(init: Partial<Note> = {}, now = ''): Note {
  return {
    id: init.id ?? newId(),
    kind: init.kind ?? (init.items && init.items.length ? 'checklist' : 'text'),
    title: init.title ?? '',
    body: init.body ?? '',
    items: init.items ?? [],
    color: init.color ?? 'default',
    background: init.background ?? 'none',
    labels: init.labels ?? [],
    images: init.images ?? [],
    pinned: init.pinned ?? false,
    archived: init.archived ?? false,
    trashed: init.trashed ?? null,
    reminder: init.reminder ?? null,
    created: init.created ?? now,
    updated: init.updated ?? now,
    ...(init.by ? { by: init.by } : {}),
  };
}
export const newItem = (text = '', checked = false): ChecklistItem => ({ id: newId('i'), text, checked });

/* ---------------- labels ---------------- */

export const cleanLabel = (name: unknown): string => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 50);
const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const findLabel = (book: Notebook, name: string): string | undefined => book.labels.find((l) => sameLabel(l, cleanLabel(name)));

/** Adds a label to the notebook (or returns the existing one with its spelling). */
export function ensureLabel(book: Notebook, name: string): string {
  const clean = cleanLabel(name);
  if (!clean) throw new Error('a label needs a name');
  const existing = findLabel(book, clean);
  if (existing) return existing;
  book.labels.push(clean);
  book.labels.sort((a, b) => a.localeCompare(b));
  return clean;
}
export function renameLabel(book: Notebook, from: string, to: string): string {
  const old = findLabel(book, from);
  if (!old) throw new Error(`no label "${from}"`);
  const clean = cleanLabel(to);
  if (!clean) throw new Error('a label needs a name');
  const clash = findLabel(book, clean);
  book.labels = book.labels.filter((l) => l !== old && l !== clash);
  const name = ensureLabel(book, clean);
  for (const n of book.notes) if (n.labels.some((l) => l === old || (clash && l === clash))) n.labels = uniqueLabels([...n.labels.filter((l) => l !== old && l !== clash), name]);
  return name;
}
export function deleteLabel(book: Notebook, name: string): void {
  const old = findLabel(book, name);
  if (!old) throw new Error(`no label "${name}"`);
  book.labels = book.labels.filter((l) => l !== old);
  for (const n of book.notes) n.labels = n.labels.filter((l) => l !== old);
}
const uniqueLabels = (list: string[]): string[] => { const out: string[] = []; for (const l of list) if (!out.some((x) => sameLabel(x, l))) out.push(l); return out; };
/** Puts a label on or takes it off a note (creating the label in the notebook when needed). */
export function setNoteLabel(book: Notebook, note: Note, name: string, on: boolean): void {
  if (on) { const label = ensureLabel(book, name); note.labels = uniqueLabels([...note.labels, label]); }
  else note.labels = note.labels.filter((l) => !sameLabel(l, name));
}

/* ---------------- checklists ---------------- */

/** Text lines → checklist items ("[x] ", "- [ ] ", "☑ " mark checked ones). */
export function textToItems(text: string): ChecklistItem[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim()).map((line) => {
    const m = /^\s*(?:[-*•]\s+)?(?:\[( |x|X)\]|(☐|☑|✓|✔))\s*(.*)$/.exec(line);
    if (m) return newItem(m[3], m[1] ? m[1].toLowerCase() === 'x' : m[2] !== '☐');
    return newItem(line.replace(/^\s*[-*•]\s+/, ''));
  });
}
export const itemsToText = (items: ChecklistItem[]): string => items.map((i) => i.text).join('\n');
export const itemsToMarkdown = (items: ChecklistItem[]): string => items.map((i) => `- [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n');

/** Turns a text note into a checklist (one item per line) or back ("Hide checkboxes" keeps the text). */
export function convertNote(note: Note, to: 'text' | 'checklist'): void {
  if (note.kind === to) return;
  if (to === 'checklist') { note.items = textToItems(note.body); note.body = ''; }
  else { note.body = itemsToText([...note.items.filter((i) => !i.checked), ...note.items.filter((i) => i.checked)]); note.items = []; }
  note.kind = to;
}
export const uncheckedItems = (note: Note): ChecklistItem[] => note.items.filter((i) => !i.checked);
export const checkedItems = (note: Note): ChecklistItem[] => note.items.filter((i) => i.checked);

/** Moves an item to `to` (0-based index into the whole list). */
export function moveItem(note: Note, id: string, to: number): void {
  const from = note.items.findIndex((i) => i.id === id);
  if (from < 0) throw new Error(`no item "${id}"`);
  const [item] = note.items.splice(from, 1);
  note.items.splice(Math.max(0, Math.min(note.items.length, to)), 0, item);
}
/** Moves item `id` just before (or after) item `target` — the drag-and-drop case. */
export function moveItemNear(note: Note, id: string, target: string, after = false): void {
  if (id === target) return;
  const item = note.items.find((i) => i.id === id);
  if (!item || !note.items.some((i) => i.id === target)) return;
  note.items = note.items.filter((i) => i.id !== id);
  const at = note.items.findIndex((i) => i.id === target);
  note.items.splice(after ? at + 1 : at, 0, item);
}
export function findItem(note: Note, ref: unknown): ChecklistItem | undefined {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) return note.items[Number(ref) - 1];
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  return note.items.find((i) => i.id === s) ?? note.items.find((i) => i.text.toLowerCase() === lower) ?? note.items.find((i) => i.text.toLowerCase().includes(lower));
}

/* ---------------- notes in a notebook ---------------- */

export function findNote(book: Notebook, ref: unknown): Note | undefined {
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  return book.notes.find((n) => n.id === s)
    ?? book.notes.find((n) => n.title.trim().toLowerCase() === lower)
    ?? book.notes.find((n) => !!n.title && n.title.toLowerCase().includes(lower))
    ?? book.notes.find((n) => noteText(n).toLowerCase().includes(lower));
}
export const noteText = (n: Note): string => [n.title, n.kind === 'checklist' ? itemsToText(n.items) : n.body].filter(Boolean).join('\n');
export const isEmptyNote = (n: Note): boolean => !n.title.trim() && !n.body.trim() && !n.items.some((i) => i.text.trim()) && n.images.length === 0;

/** Adds a note at the top (Keep puts new notes first). */
export function addNote(book: Notebook, note: Note): Note {
  for (const l of note.labels) ensureLabel(book, l);
  note.labels = uniqueLabels(note.labels.map((l) => findLabel(book, l) ?? l));
  book.notes.unshift(note);
  return note;
}
/** "Make a copy": a new note with the same content, placed first. */
export function copyNote(book: Notebook, id: string, now: string): Note {
  const src = book.notes.find((n) => n.id === id);
  if (!src) throw new Error(`no note "${id}"`);
  const copy = clone(src);
  copy.id = newId();
  copy.items = copy.items.map((i) => ({ ...i, id: newId('i') }));
  copy.images = copy.images.map((i) => ({ ...i, id: newId('m') }));
  copy.created = now; copy.updated = now;
  copy.trashed = null;
  const at = book.notes.indexOf(src);
  book.notes.splice(at, 0, copy);
  return copy;
}
/** Moves note `id` just before (or after) note `target`; it takes the target's pinned state (dropping into Pinned pins it). */
export function moveNote(book: Notebook, id: string, target: string, after = false): void {
  if (id === target) return;
  const note = book.notes.find((n) => n.id === id);
  const t = book.notes.find((n) => n.id === target);
  if (!note || !t) return;
  note.pinned = t.pinned;
  book.notes = book.notes.filter((n) => n.id !== id);
  const at = book.notes.indexOf(t);
  book.notes.splice(after ? at + 1 : at, 0, note);
}
/** Moves a note to a position (1-based) among the notes shown in its section (pinned or others). */
export function moveNoteTo(book: Notebook, id: string, position: number): void {
  const note = book.notes.find((n) => n.id === id);
  if (!note) throw new Error(`no note "${id}"`);
  const peers = book.notes.filter((n) => n.id !== id && n.pinned === note.pinned && !n.archived && !n.trashed);
  const p = Math.max(1, Math.min(peers.length + 1, Math.round(position)));
  book.notes = book.notes.filter((n) => n.id !== id);
  if (p > peers.length) { const last = peers[peers.length - 1]; book.notes.splice(last ? book.notes.indexOf(last) + 1 : book.notes.length, 0, note); }
  else book.notes.splice(book.notes.indexOf(peers[p - 1]), 0, note);
}
export function trashNote(note: Note, now: string): void { note.trashed = now; note.pinned = false; }
export function restoreNote(note: Note): void { note.trashed = null; }
export function archiveNote(note: Note, on = true): void { note.archived = on; if (on) note.pinned = false; }
/** Pinning brings an archived note back to Notes (as in Keep). */
export function pinNote(note: Note, on = true): void { note.pinned = on; if (on) note.archived = false; }
export function deleteForever(book: Notebook, id: string): void { book.notes = book.notes.filter((n) => n.id !== id); }
export function emptyTrash(book: Notebook): number { const before = book.notes.length; book.notes = book.notes.filter((n) => !n.trashed); return before - book.notes.length; }

/* ---------------- views, search and filters ---------------- */

export type View = { kind: 'notes' } | { kind: 'reminders' } | { kind: 'archive' } | { kind: 'trash' } | { kind: 'label'; label: string };
export type TypeFilter = 'any' | 'text' | 'checklist' | 'images' | 'reminders';
export interface Filter { query?: string; label?: string; color?: NoteColor | ''; type?: TypeFilter }

export function inView(n: Note, view: View): boolean {
  if (view.kind === 'trash') return !!n.trashed;
  if (n.trashed) return false;
  if (view.kind === 'archive') return n.archived;
  if (view.kind === 'reminders') return !!n.reminder;
  if (view.kind === 'label') return n.labels.some((l) => sameLabel(l, view.label));
  return !n.archived;
}
export function matchesFilter(n: Note, f: Filter): boolean {
  const q = (f.query ?? '').trim().toLowerCase();
  if (q && !`${noteText(n)}\n${n.labels.join(' ')}\n${n.images.map((i) => i.alt).join(' ')}`.toLowerCase().includes(q)) return false;
  if (f.label && !n.labels.some((l) => sameLabel(l, f.label!))) return false;
  if (f.color && n.color !== f.color) return false;
  const type = f.type ?? 'any';
  if (type === 'text' && n.kind !== 'text') return false;
  if (type === 'checklist' && n.kind !== 'checklist') return false;
  if (type === 'images' && n.images.length === 0) return false;
  if (type === 'reminders' && !n.reminder) return false;
  return true;
}
export const hasFilter = (f: Filter): boolean => !!((f.query ?? '').trim() || f.label || f.color || (f.type && f.type !== 'any'));

/** The notes a view shows, in order: pinned ones first (in Notes and label views), others after. Searching looks in Notes and Archive. */
export function visibleNotes(book: Notebook, view: View, filter: Filter = {}): { pinned: Note[]; others: Note[] } {
  const searching = hasFilter(filter) && view.kind === 'notes';
  let list = book.notes.filter((n) => (searching ? !n.trashed : inView(n, view)) && matchesFilter(n, filter));
  if (view.kind === 'reminders') list = [...list].sort((a, b) => (a.reminder!.at < b.reminder!.at ? -1 : a.reminder!.at > b.reminder!.at ? 1 : 0));
  if (view.kind === 'archive' || view.kind === 'trash' || searching) return { pinned: [], others: list };
  return { pinned: list.filter((n) => n.pinned), others: list.filter((n) => !n.pinned) };
}
export function counts(book: Notebook): { notes: number; pinned: number; reminders: number; archive: number; trash: number; labels: Record<string, number> } {
  const live = book.notes.filter((n) => !n.trashed);
  const labels: Record<string, number> = {};
  for (const l of book.labels) labels[l] = live.filter((n) => n.labels.includes(l)).length;
  return { notes: live.filter((n) => !n.archived).length, pinned: live.filter((n) => n.pinned && !n.archived).length, reminders: live.filter((n) => n.reminder).length, archive: live.filter((n) => n.archived).length, trash: book.notes.length - live.length, labels };
}

/* ---------------- masonry ---------------- */

/** A rough card height in px for the masonry layout (no measuring needed). */
export function estimateHeight(n: Note, width = 240): number {
  const perLine = Math.max(16, Math.floor(width / 7.6));
  const lines = (text: string, max: number) => Math.min(max, text.split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / perLine)), 0));
  let h = 24;
  if (n.images.length) h += Math.min(2, n.images.length) * 130;
  if (n.title.trim()) h += 22 * lines(n.title, 3);
  if (n.kind === 'checklist') { const open = uncheckedItems(n); h += 24 * Math.min(10, open.reduce((s, i) => s + lines(i.text || ' ', 3), 0)); if (checkedItems(n).length) h += 26; }
  else if (n.body.trim()) h += 19 * lines(n.body, 18);
  if (n.labels.length || n.reminder) h += 30;
  return h + 34;
}
/** Shortest-column masonry: notes keep their order left to right, each one going to the column that is currently shortest. */
export function masonry<T extends Note>(notes: T[], columns: number, height: (n: T) => number = estimateHeight): T[][] {
  const cols: T[][] = Array.from({ length: Math.max(1, columns) }, () => []);
  const heights = cols.map(() => 0);
  for (const n of notes) {
    let best = 0;
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[best] - 1) best = i;
    cols[best].push(n);
    heights[best] += height(n) + 16;
  }
  return cols;
}

/* ---------------- reminders ---------------- */

const pad = (v: number): string => String(v).padStart(2, '0');
export const localStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function parseStamp(at: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(at.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 8), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}
/** "2026-11-27 09:30", "2026-11-27", "tomorrow 9:00", "today 18:00", "next week" → "YYYY-MM-DDTHH:mm". */
export function parseReminderAt(value: unknown, now: Date): string | null {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  const direct = parseStamp(s);
  if (direct) return localStamp(direct);
  const m = /^(today|tonight|tomorrow|later today|next week)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/.exec(s);
  if (!m) return null;
  const preset = m[1] === 'tonight' ? 'later' : m[1] === 'later today' ? 'later' : m[1] === 'next week' ? 'week' : m[1] === 'tomorrow' ? 'tomorrow' : 'today';
  const d = preset === 'today' ? new Date(now) : presetDate(preset, now);
  if (m[2]) {
    let h = Number(m[2]) % 24;
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    d.setHours(h, Number(m[3] ?? 0), 0, 0);
  } else if (preset === 'today') d.setHours(Math.max(now.getHours() + 1, 8), 0, 0, 0);
  return localStamp(d);
}
/** Keep's presets: later today (20:00, or 18:00 before noon… Keep uses 8 PM), tomorrow 8:00, next week Monday 8:00. */
export function presetDate(preset: 'later' | 'tomorrow' | 'week', now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0, 0);
  if (preset === 'later') { d.setHours(20); if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); return d; }
  if (preset === 'tomorrow') { d.setDate(d.getDate() + 1); return d; }
  const days = ((8 - d.getDay()) % 7) || 7; // next Monday
  d.setDate(d.getDate() + days);
  return d;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const time = (d: Date): string => `${((d.getHours() + 11) % 12) + 1}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
/** "Today, 8:00 PM", "Tomorrow, 8:00 AM", "Nov 30, 8:00 AM", "Jan 3, 2027, 9:00 AM" (now = 0 → always the date). */
export function formatReminder(r: Reminder, now: number): string {
  const d = parseStamp(r.at);
  if (!d) return r.at;
  let day: string;
  const n = now ? new Date(now) : null;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (n && sameDay(d, n)) day = 'Today';
  else if (n && sameDay(d, new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) day = 'Tomorrow';
  else if (n && sameDay(d, new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) day = 'Yesterday';
  else day = `${MONTHS[d.getMonth()]} ${d.getDate()}${!n || d.getFullYear() !== n.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
  return `${day}, ${time(d)}${r.repeat !== 'none' ? ` · ${r.repeat[0].toUpperCase()}${r.repeat.slice(1)}` : ''}`;
}
export const isOverdue = (r: Reminder, now: number): boolean => { const d = parseStamp(r.at); return !!d && !!now && d.getTime() < now; };
/** The next time a repeating reminder fires after `now` (or null for a one-off). */
export function nextOccurrence(r: Reminder, now: number): string | null {
  if (r.repeat === 'none') return null;
  const d = parseStamp(r.at);
  if (!d) return null;
  for (let guard = 0; d.getTime() <= now && guard < 4000; guard++) {
    if (r.repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (r.repeat === 'weekly') d.setDate(d.getDate() + 7);
    else if (r.repeat === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  }
  return localStamp(d);
}

/** "Edited Nov 26" / "Edited 3:04 PM" from an ISO time. */
export function editedLabel(iso: string, now: number): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const n = now ? new Date(now) : null;
  if (n && d.toDateString() === n.toDateString()) return `Edited ${time(d)}`;
  return `Edited ${MONTHS[d.getMonth()]} ${d.getDate()}${!n || d.getFullYear() !== n.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}

/* ---------------- files ---------------- */

const str = (v: unknown, max = 100_000): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max);
function normItem(raw: unknown): ChecklistItem | null {
  if (typeof raw === 'string' || typeof raw === 'number') return newItem(String(raw));
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return { id: typeof r.id === 'string' && r.id ? r.id : newId('i'), text: str(r.text, 5000), checked: r.checked === true };
}
function normReminder(raw: unknown): Reminder | null {
  if (!raw) return null;
  if (typeof raw === 'string') { const d = parseStamp(raw); return d ? { at: localStamp(d), repeat: 'none' } : null; }
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = parseStamp(str(r.at));
  if (!d) return null;
  return { at: localStamp(d), repeat: REPEATS.includes(r.repeat as Repeat) ? (r.repeat as Repeat) : 'none' };
}
function normNote(raw: unknown, warnings: string[], i: number): Note | null {
  if (!raw || typeof raw !== 'object') { warnings.push(`note ${i + 1} was not an object and was dropped`); return null; }
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items.map(normItem).filter((x): x is ChecklistItem => x !== null) : [];
  const kind = r.kind === 'checklist' || (r.kind === undefined && items.length > 0) ? 'checklist' : 'text';
  if (r.color !== undefined && !isColor(r.color)) warnings.push(`note ${i + 1}: unknown colour "${String(r.color)}"`);
  const images = Array.isArray(r.images) ? r.images.flatMap((m) => {
    if (!m || typeof m !== 'object') return [];
    const x = m as Record<string, unknown>;
    return typeof x.src === 'string' && x.src ? [{ id: typeof x.id === 'string' && x.id ? x.id : newId('m'), src: x.src, alt: str(x.alt, 500) }] : [];
  }) : [];
  return newNote({
    id: typeof r.id === 'string' && r.id ? r.id : undefined,
    kind,
    title: str(r.title, 1000),
    body: str(r.body),
    items: kind === 'checklist' ? items : [],
    color: isColor(r.color) ? r.color : 'default',
    background: isBackground(r.background) ? r.background : 'none',
    labels: Array.isArray(r.labels) ? uniqueLabels(r.labels.map(cleanLabel).filter(Boolean)) : [],
    images,
    pinned: r.pinned === true,
    archived: r.archived === true,
    trashed: typeof r.trashed === 'string' && r.trashed ? r.trashed : r.trashed === true ? new Date(0).toISOString() : null,
    reminder: normReminder(r.reminder),
    created: str(r.created, 40),
    updated: str(r.updated, 40),
    by: typeof r.by === 'string' && r.by ? r.by : undefined,
  });
}
export function normalizeBook(raw: unknown, fallbackTitle = 'Notes'): NormalizeResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (Array.isArray(raw)) { const book = emptyBook(fallbackTitle); raw.forEach((n, i) => { const x = normNote(n, warnings, i); if (x) book.notes.push(x); }); fixLabels(book); return { book, warnings: ['the file was a bare list of notes', ...warnings] }; }
    return { book: emptyBook(fallbackTitle), warnings: ['the file was not a notebook; started an empty one'] };
  }
  const r = raw as Record<string, unknown>;
  const book = emptyBook(str(r.title, 300).trim() || fallbackTitle);
  book.labels = Array.isArray(r.labels) ? uniqueLabels(r.labels.map(cleanLabel).filter(Boolean)) : [];
  const seen = new Set<string>();
  (Array.isArray(r.notes) ? r.notes : []).forEach((n, i) => {
    const note = normNote(n, warnings, i);
    if (!note) return;
    if (seen.has(note.id)) { warnings.push(`note ${i + 1} had a duplicate id`); note.id = newId(); }
    seen.add(note.id);
    book.notes.push(note);
  });
  fixLabels(book);
  return { book, warnings };
}
/** Every label used on a note is in the notebook's list. */
function fixLabels(book: Notebook): void {
  for (const n of book.notes) n.labels = n.labels.map((l) => findLabel(book, l) ?? ensureLabel(book, l));
  book.labels.sort((a, b) => a.localeCompare(b));
}
export function parseBookJson(text: string, fallbackTitle?: string): NormalizeResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { book: emptyBook(fallbackTitle), warnings: ['the file was not valid JSON; started an empty notebook'] }; }
  return normalizeBook(raw, fallbackTitle);
}
export const serializeBook = (book: Notebook): string => JSON.stringify(book);

/* ---------------- text out ---------------- */

export function noteToMarkdown(n: Note): string {
  const out: string[] = [];
  if (n.title.trim()) out.push(`## ${n.title.trim()}`);
  if (n.kind === 'checklist') out.push(itemsToMarkdown(n.items)); else if (n.body.trim()) out.push(n.body.trim());
  for (const m of n.images) out.push(`![${m.alt || 'image'}](image)`);
  const meta = [n.labels.length ? `Labels: ${n.labels.join(', ')}` : '', n.reminder ? `Reminder: ${n.reminder.at.replace('T', ' ')}${n.reminder.repeat !== 'none' ? ` (${n.reminder.repeat})` : ''}` : ''].filter(Boolean);
  if (meta.length) out.push(`_${meta.join(' · ')}_`);
  return out.join('\n\n');
}
export const bookToMarkdown = (book: Notebook): string => [`# ${book.title}`, ...book.notes.filter((n) => !n.trashed).map(noteToMarkdown)].join('\n\n') + '\n';
