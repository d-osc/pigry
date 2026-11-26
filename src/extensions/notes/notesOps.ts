/** Agent operations on a notebook (all-or-nothing, with a log) and the compact reader. Pure — node tests import it. */
import {
  BACKGROUNDS, COLORS, REPEATS, addNote, archiveNote, checkedItems, clone, convertNote, copyNote, counts, deleteForever, deleteLabel, emptyTrash, ensureLabel, findBackground,
  findColor, findItem, findLabel, findNote, formatReminder, matchesFilter, moveItem, moveNoteTo, newId, newItem, newNote, parseReminderAt, pinNote, renameLabel, restoreNote,
  setNoteLabel, textToItems, trashNote, uncheckedItems,
  type ChecklistItem, type Filter, type Note, type Notebook, type Repeat, type TypeFilter,
} from './notes.ts';

export type Op = { op: string } & Record<string, unknown>;
export interface OpCtx { author: string; now: string }
export interface OpResult { book: Notebook; log: string[]; error?: string; created: string[] }

export const OP_HELP = [
  'Notes are addressed by id (best — notes_read shows them), exact title, part of the title, or part of the text. Checklist items by id, 1-based number, or their text.',
  `Colours: ${COLORS.map((c) => c.id).join(', ')}. Backgrounds: ${BACKGROUNDS.map((b) => b.id).join(', ')}. Reminders: at "YYYY-MM-DD HH:mm" (local time), "tomorrow 9:00", "today 18:00" or "next week"; repeat ${REPEATS.join('|')}.`,
  '- add {title?, body? | items? (list of strings; "[x] " marks done), color?, background?, labels?, pinned?, archived?, reminder? {at, repeat?} or "at"} — a new note, placed first',
  '- set {note, title?, body?, color?, background?, pinned?, archived?, reminder? (null removes)} — body on a checklist replaces its items (one per line)',
  '- append {note, text} — add lines to a text note (or items to a checklist)',
  '- convert {note, to: checklist|text} — one item per line, or back to text ("Hide checkboxes")',
  '- add_item {note, text | items, checked?, at? (1-based)} · check {note, item, checked? (default true)} · uncheck {note, item} · edit_item {note, item, text} · remove_item {note, item} · move_item {note, item, to (1-based)} · uncheck_all {note} · remove_checked {note}',
  '- label {note, add? (name or list), remove?} — labels are created as needed · create_label {name} · rename_label {from, to} · delete_label {name} (removes it from every note)',
  '- pin {note} · unpin {note} · archive {note} · unarchive {note} · trash {note} · restore {note} · delete {note} (forever; only from the trash unless force: true) · empty_trash',
  '- copy {note, title?} — "Make a copy", returns the new id · move {note, to (1-based position among the pinned or the other notes)}',
  '- remind {note, at, repeat?} · unremind {note}',
  '- add_image {note, src (data URL) | path (workspace image), alt?} · remove_image {note, image (id or 1-based number)}',
  '- title {title} — rename the notebook',
].join('\n');

const OPS = new Set(['add', 'set', 'append', 'convert', 'add_item', 'check', 'uncheck', 'edit_item', 'remove_item', 'move_item', 'uncheck_all', 'remove_checked', 'label', 'create_label', 'rename_label', 'delete_label', 'pin', 'unpin', 'archive', 'unarchive', 'trash', 'restore', 'delete', 'empty_trash', 'copy', 'move', 'remind', 'unremind', 'add_image', 'remove_image', 'title']);

export function parseOps(raw: unknown): { ops: Op[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const errors: string[] = [];
  const ops: Op[] = [];
  if (!Array.isArray(raw) && !(raw && typeof raw === 'object')) errors.push('ops must be an array of {op: …} objects');
  list.forEach((o, i) => {
    if (!o || typeof o !== 'object' || typeof (o as Op).op !== 'string') { errors.push(`op ${i + 1}: needs an "op" name`); return; }
    if (!OPS.has((o as Op).op)) { errors.push(`op ${i + 1}: unknown op "${(o as Op).op}" — use ${[...OPS].join(', ')}`); return; }
    ops.push(o as Op);
  });
  return { ops, errors };
}

class OpError extends Error {}
function fail(m: string): never { throw new OpError(m); }
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()) : []).filter((x) => x.trim());
const itemList = (v: unknown): ChecklistItem[] => (Array.isArray(v)
  ? v.flatMap((x) => (x && typeof x === 'object' ? [newItem(String((x as Record<string, unknown>).text ?? ''), (x as Record<string, unknown>).checked === true)] : textToItems(String(x ?? ''))))
  : typeof v === 'string' ? textToItems(v) : []);
const short = (n: Note): string => `${n.id}${n.title ? ` "${n.title.slice(0, 40)}"` : ''}`;

function needNote(book: Notebook, ref: unknown): Note {
  if (ref === undefined || ref === null || String(ref).trim() === '') fail('needs a note (id, title or text)');
  return findNote(book, ref) ?? fail(`no note "${String(ref)}" (notes_read lists them with their ids)`);
}
function needItem(note: Note, ref: unknown): ChecklistItem {
  if (note.kind !== 'checklist') fail(`note ${short(note)} is not a checklist (convert it first)`);
  if (ref === undefined) fail('needs an item (id, number or text)');
  return findItem(note, ref) ?? fail(`note ${short(note)} has no item "${String(ref)}" (it has ${note.items.map((i, k) => `${k + 1}. ${i.text}`).join('; ') || 'none'})`);
}
function colorArg(v: unknown): Note['color'] { return findColor(v) ?? fail(`unknown colour "${String(v)}" — use ${COLORS.map((c) => c.id).join(', ')}`); }
function backgroundArg(v: unknown): Note['background'] { return findBackground(v) ?? fail(`unknown background "${String(v)}" — use ${BACKGROUNDS.map((b) => b.id).join(', ')}`); }
function reminderArg(v: unknown, repeat: unknown, now: Date): Note['reminder'] {
  if (v === null || v === false || v === '') return null;
  const at = typeof v === 'object' && v ? (v as Record<string, unknown>).at : v;
  const rep = typeof v === 'object' && v && (v as Record<string, unknown>).repeat !== undefined ? (v as Record<string, unknown>).repeat : repeat;
  const stamp = parseReminderAt(at, now) ?? fail(`cannot read the reminder time "${String(at)}" — use "YYYY-MM-DD HH:mm", "tomorrow 9:00" or "next week"`);
  const r = rep === undefined ? 'none' : String(rep).toLowerCase();
  if (!REPEATS.includes(r as Repeat)) fail(`repeat must be ${REPEATS.join(', ')}`);
  return { at: stamp, repeat: r as Repeat };
}

export function applyOps(input: Notebook, ops: Op[], ctx: OpCtx): OpResult {
  const book = clone(input);
  const log: string[] = [];
  const created: string[] = [];
  const now = new Date(ctx.now);
  const touch = (n: Note) => { n.updated = ctx.now; n.by = ctx.author; };
  try {
    ops.forEach((op, i) => {
      const at = `op ${i + 1} (${op.op})`;
      try {
        switch (op.op) {
          case 'add': {
            const items = itemList(op.items);
            const note = newNote({
              kind: items.length || op.kind === 'checklist' ? 'checklist' : 'text',
              title: String(op.title ?? '').slice(0, 1000),
              body: items.length ? '' : String(op.body ?? op.text ?? ''),
              items,
              color: op.color === undefined ? 'default' : colorArg(op.color),
              background: op.background === undefined ? 'none' : backgroundArg(op.background),
              labels: strList(op.labels),
              pinned: op.pinned === true,
              archived: op.archived === true,
              reminder: op.reminder === undefined ? null : reminderArg(op.reminder, op.repeat, now),
              by: ctx.author,
            }, ctx.now);
            if (note.kind === 'checklist' && !items.length && op.body) note.items = textToItems(String(op.body));
            if (note.pinned) note.archived = false;
            addNote(book, note);
            created.push(note.id);
            log.push(`${at}: added ${note.kind === 'checklist' ? `checklist (${note.items.length} items)` : 'note'} ${short(note)}`);
            break;
          }
          case 'set': {
            const n = needNote(book, op.note);
            const changed: string[] = [];
            if (op.title !== undefined) { n.title = String(op.title).slice(0, 1000); changed.push('title'); }
            if (op.body !== undefined) { if (n.kind === 'checklist') n.items = textToItems(String(op.body)); else n.body = String(op.body); changed.push(n.kind === 'checklist' ? 'items' : 'text'); }
            if (op.items !== undefined) { if (n.kind !== 'checklist') convertNote(n, 'checklist'); n.items = itemList(op.items); changed.push('items'); }
            if (op.color !== undefined) { n.color = colorArg(op.color); changed.push(`colour ${n.color}`); }
            if (op.background !== undefined) { n.background = backgroundArg(op.background); changed.push(`background ${n.background}`); }
            if (op.pinned !== undefined) { pinNote(n, op.pinned === true); changed.push(n.pinned ? 'pinned' : 'unpinned'); }
            if (op.archived !== undefined) { archiveNote(n, op.archived === true); changed.push(n.archived ? 'archived' : 'unarchived'); }
            if (op.reminder !== undefined) { n.reminder = reminderArg(op.reminder, op.repeat, now); changed.push(n.reminder ? `reminder ${n.reminder.at}` : 'no reminder'); }
            if (op.labels !== undefined) { n.labels = []; for (const l of strList(op.labels)) setNoteLabel(book, n, l, true); changed.push(`labels ${n.labels.join(', ') || '(none)'}`); }
            if (!changed.length) fail('nothing to change (title, body, items, color, background, pinned, archived, reminder, labels)');
            touch(n);
            log.push(`${at}: ${short(n)} — ${changed.join(', ')}`);
            break;
          }
          case 'append': {
            const n = needNote(book, op.note);
            const text = String(op.text ?? op.body ?? '');
            if (!text.trim()) fail('needs text');
            if (n.kind === 'checklist') n.items.push(...textToItems(text)); else n.body = n.body.trim() ? `${n.body.replace(/\s+$/, '')}\n${text}` : text;
            touch(n); log.push(`${at}: appended to ${short(n)}`);
            break;
          }
          case 'convert': {
            const n = needNote(book, op.note);
            const to = op.to === 'text' ? 'text' : op.to === 'checklist' || op.to === 'list' ? 'checklist' : fail('to must be checklist or text');
            convertNote(n, to); touch(n); log.push(`${at}: ${short(n)} is now ${to === 'checklist' ? `a checklist (${n.items.length} items)` : 'a text note'}`);
            break;
          }
          case 'add_item': {
            const n = needNote(book, op.note);
            if (n.kind !== 'checklist') convertNote(n, 'checklist');
            const items = op.items !== undefined ? itemList(op.items) : [newItem(String(op.text ?? ''), op.checked === true)];
            if (!items.length || items.some((x) => !x.text.trim())) fail('needs text (or items)');
            const pos = typeof op.at === 'number' ? Math.max(0, Math.min(n.items.length, op.at - 1)) : n.items.length;
            n.items.splice(pos, 0, ...items);
            touch(n); log.push(`${at}: ${short(n)} + ${items.map((x) => `${x.id} "${x.text}"`).join(', ')}`);
            break;
          }
          case 'check': case 'uncheck': {
            const n = needNote(book, op.note); const it = needItem(n, op.item);
            it.checked = op.op === 'uncheck' ? false : op.checked !== false;
            touch(n); log.push(`${at}: ${short(n)} item "${it.text}" ${it.checked ? 'checked' : 'unchecked'}`);
            break;
          }
          case 'edit_item': {
            const n = needNote(book, op.note); const it = needItem(n, op.item);
            it.text = String(op.text ?? '');
            touch(n); log.push(`${at}: ${short(n)} item ${it.id} → "${it.text}"`);
            break;
          }
          case 'remove_item': {
            const n = needNote(book, op.note); const it = needItem(n, op.item);
            n.items = n.items.filter((x) => x !== it);
            touch(n); log.push(`${at}: ${short(n)} removed item "${it.text}"`);
            break;
          }
          case 'move_item': {
            const n = needNote(book, op.note); const it = needItem(n, op.item);
            const to = Number(op.to);
            if (!Number.isFinite(to)) fail('needs to (1-based position)');
            moveItem(n, it.id, to - 1);
            touch(n); log.push(`${at}: ${short(n)} item "${it.text}" moved to ${n.items.indexOf(it) + 1}`);
            break;
          }
          case 'uncheck_all': {
            const n = needNote(book, op.note); if (n.kind !== 'checklist') fail(`note ${short(n)} is not a checklist`);
            const k = checkedItems(n).length; for (const it of n.items) it.checked = false;
            touch(n); log.push(`${at}: ${short(n)} unchecked ${k} item(s)`);
            break;
          }
          case 'remove_checked': {
            const n = needNote(book, op.note); if (n.kind !== 'checklist') fail(`note ${short(n)} is not a checklist`);
            const k = checkedItems(n).length; n.items = uncheckedItems(n);
            touch(n); log.push(`${at}: ${short(n)} removed ${k} checked item(s)`);
            break;
          }
          case 'label': {
            const n = needNote(book, op.note);
            const add = strList(op.add ?? op.labels), remove = strList(op.remove);
            if (!add.length && !remove.length) fail('needs add or remove');
            for (const l of add) setNoteLabel(book, n, l, true);
            for (const l of remove) setNoteLabel(book, n, l, false);
            touch(n); log.push(`${at}: ${short(n)} labels: ${n.labels.join(', ') || '(none)'}`);
            break;
          }
          case 'create_label': { const name = ensureLabel(book, String(op.name ?? op.label ?? '')); log.push(`${at}: label "${name}"`); break; }
          case 'rename_label': { const name = renameLabel(book, String(op.from ?? ''), String(op.to ?? '')); log.push(`${at}: label "${String(op.from)}" → "${name}"`); break; }
          case 'delete_label': { const name = findLabel(book, String(op.name ?? op.label ?? '')) ?? fail(`no label "${String(op.name ?? op.label ?? '')}" (labels: ${book.labels.join(', ') || 'none'})`); deleteLabel(book, name); log.push(`${at}: deleted label "${name}"`); break; }
          case 'pin': case 'unpin': { const n = needNote(book, op.note); pinNote(n, op.op === 'pin'); touch(n); log.push(`${at}: ${short(n)} ${op.op}ned`); break; }
          case 'archive': case 'unarchive': { const n = needNote(book, op.note); archiveNote(n, op.op === 'archive'); touch(n); log.push(`${at}: ${short(n)} ${op.op}d`); break; }
          case 'trash': { const n = needNote(book, op.note); trashNote(n, ctx.now); log.push(`${at}: ${short(n)} moved to the trash`); break; }
          case 'restore': { const n = needNote(book, op.note); if (!n.trashed) fail(`note ${short(n)} is not in the trash`); restoreNote(n); touch(n); log.push(`${at}: ${short(n)} restored`); break; }
          case 'delete': {
            const n = needNote(book, op.note);
            if (!n.trashed && op.force !== true) fail(`note ${short(n)} is not in the trash — trash it first (or pass force: true)`);
            deleteForever(book, n.id); log.push(`${at}: ${short(n)} deleted forever`);
            break;
          }
          case 'empty_trash': { log.push(`${at}: deleted ${emptyTrash(book)} note(s) from the trash`); break; }
          case 'copy': {
            const n = needNote(book, op.note);
            const c = copyNote(book, n.id, ctx.now);
            if (op.title !== undefined) c.title = String(op.title);
            c.by = ctx.author; created.push(c.id);
            log.push(`${at}: copied ${short(n)} → ${short(c)}`);
            break;
          }
          case 'move': {
            const n = needNote(book, op.note);
            const to = Number(op.to);
            if (!Number.isFinite(to)) fail('needs to (1-based position)');
            moveNoteTo(book, n.id, to); log.push(`${at}: ${short(n)} moved to position ${Math.round(to)}${n.pinned ? ' in Pinned' : ''}`);
            break;
          }
          case 'remind': { const n = needNote(book, op.note); n.reminder = reminderArg(op.at ?? op.reminder, op.repeat, now); touch(n); log.push(`${at}: ${short(n)} reminder ${n.reminder ? formatReminder(n.reminder, now.getTime()) : 'removed'}`); break; }
          case 'unremind': { const n = needNote(book, op.note); n.reminder = null; touch(n); log.push(`${at}: ${short(n)} reminder removed`); break; }
          case 'add_image': {
            const n = needNote(book, op.note);
            const src = typeof op.src === 'string' ? op.src : '';
            if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) fail('needs src (a data:image/…;base64 URL) or path (a workspace image)');
            const img = { id: newId('m'), src, alt: String(op.alt ?? '').slice(0, 500) };
            n.images.push(img); touch(n); log.push(`${at}: ${short(n)} + image ${img.id}`);
            break;
          }
          case 'remove_image': {
            const n = needNote(book, op.note);
            const ref = op.image;
            const img = typeof ref === 'number' || /^\d+$/.test(String(ref ?? '')) ? n.images[Number(ref) - 1] : n.images.find((m) => m.id === String(ref));
            if (!img) fail(`note ${short(n)} has no image "${String(ref)}" (it has ${n.images.length})`);
            n.images = n.images.filter((m) => m !== img); touch(n); log.push(`${at}: ${short(n)} removed image ${img.id}`);
            break;
          }
          case 'title': { const t = String(op.title ?? '').trim(); if (!t) fail('needs a title'); book.title = t.slice(0, 300); log.push(`${at}: notebook title "${book.title}"`); break; }
          default: fail(`unknown op "${op.op}"`);
        }
      } catch (error) {
        if (error instanceof OpError) throw new OpError(`${at}: ${error.message}`);
        throw new OpError(`${at}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  } catch (error) {
    return { book: input, log, created: [], error: error instanceof Error ? error.message : String(error) };
  }
  return { book, log, created };
}

/* ---------------- reading ---------------- */

export function summarizeBook(book: Notebook): string {
  const c = counts(book);
  return `"${book.title}": ${c.notes} note(s) (${c.pinned} pinned), ${c.archive} archived, ${c.trash} in the trash, ${c.reminders} with reminders; labels: ${book.labels.length ? book.labels.map((l) => `${l} (${c.labels[l]})`).join(', ') : 'none'}`;
}

function noteLines(n: Note, now: number): string {
  const flags = [n.kind === 'checklist' ? 'checklist' : 'text', n.pinned ? 'pinned' : '', n.archived ? 'archived' : '', n.trashed ? `trashed ${n.trashed.slice(0, 10)}` : '', n.color !== 'default' ? n.color : '', n.background !== 'none' ? `bg ${n.background}` : '', n.images.length ? `${n.images.length} image(s)` : ''].filter(Boolean).join(', ');
  const out = [`- ${n.id} [${flags}]${n.title ? ` ${n.title}` : ''}`];
  if (n.labels.length) out.push(`    labels: ${n.labels.join(', ')}`);
  if (n.reminder) out.push(`    reminder: ${n.reminder.at.replace('T', ' ')}${n.reminder.repeat !== 'none' ? ` repeats ${n.reminder.repeat}` : ''} (${formatReminder(n.reminder, now)})`);
  if (n.kind === 'checklist') n.items.forEach((it, k) => out.push(`    ${k + 1}. [${it.checked ? 'x' : ' '}] ${it.text} (${it.id})`));
  else if (n.body.trim()) out.push(...n.body.split('\n').slice(0, 60).map((l) => `    ${l}`), ...(n.body.split('\n').length > 60 ? ['    …'] : []));
  n.images.forEach((m, k) => out.push(`    image ${k + 1}: ${m.id}${m.alt ? ` "${m.alt}"` : ''}`));
  if (n.updated) out.push(`    edited ${n.updated.slice(0, 16).replace('T', ' ')}${n.by ? ` by ${n.by}` : ''}`);
  return out.join('\n');
}

export interface ReadOptions extends Filter { include?: 'notes' | 'archive' | 'trash' | 'all'; limit?: number; now?: number }
/** The notes a reader asked for, in the order the editor shows them (pinned first). */
export function readBook(book: Notebook, opts: ReadOptions = {}): string {
  const include = opts.include ?? 'all';
  const type = (['any', 'text', 'checklist', 'images', 'reminders'] as TypeFilter[]).includes(opts.type as TypeFilter) ? opts.type : 'any';
  const filter: Filter = { query: opts.query, label: opts.label, color: opts.color, type };
  const pick = book.notes.filter((n) => (include === 'all' ? true : include === 'trash' ? !!n.trashed : include === 'archive' ? n.archived && !n.trashed : !n.archived && !n.trashed) && matchesFilter(n, filter));
  const ordered = [...pick.filter((n) => n.pinned), ...pick.filter((n) => !n.pinned)];
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const shown = ordered.slice(0, limit);
  const now = opts.now ?? 0;
  const head = summarizeBook(book);
  if (!shown.length) return `${head}\n(no notes match)`;
  return `${head}\n${shown.map((n) => noteLines(n, now)).join('\n')}${ordered.length > limit ? `\n[${ordered.length - limit} more not shown]` : ''}`;
}
