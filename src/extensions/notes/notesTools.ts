/** Agent tools for the Notes menu. Notebooks are plain files (.pigry/notes/<owner>/<name>.notes.json, one folder per agent).
 * The tools list and read notebooks, search notes across all of them, create a notebook, apply editing operations
 * (all-or-nothing, with a log) and open a notebook or a note in the Notes menu. */
import type { ToolSpec } from '../../lib/agentTools';
import { readBinaryFile } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { COLORS, DEFAULT_NOTEBOOK, emptyBook, findNote, matchesFilter, noteText, type Filter, type Notebook, type NoteColor, type TypeFilter } from './notes';
import { OP_HELP, applyOps, parseOps, readBook, summarizeBook, type Op } from './notesOps';
import { flushNotesEditors, listBookRefs, loadBook, requestOpenBook, resolveBookRef, saveBook } from './notesStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.notebook ?? '').trim();
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const callerOf = (input: Record<string, unknown>): string => ownerSlug(agentOf(input) ?? 'agent');
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };
const nowIso = (): string => new Date().toISOString();
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const safePath = (p: string): string | null => { const x = p.replace(/\\/g, '/').trim(); return !x || x.split('/').includes('..') || /^[A-Za-z]:/.test(x) || x.startsWith('/') ? null : x; };

async function imageDataUrl(path: string): Promise<string> {
  const p = safePath(path);
  if (!p) throw new Error('image path must be inside the workspace');
  const mime = MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()];
  if (!mime) throw new Error('images must be .png, .jpg, .gif, .webp or .svg');
  const file = await readBinaryFile(p);
  return `data:${mime};base64,${file.data}`;
}
/** Resolves `path:` on add_image into a data URL. */
async function resolveImages(ops: Op[]): Promise<Op[] | string> {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === 'add_image' && typeof op.path === 'string' && !op.src) {
      try { out.push({ ...op, src: await imageDataUrl(op.path) }); continue; } catch (error) { return fail(`could not read image: ${error instanceof Error ? error.message : String(error)}`); }
    }
    out.push(op);
  }
  return out;
}

async function open(input: Record<string, unknown>, fallback?: string): Promise<{ ref: OwnedRef; book: Notebook; warnings: string[] } | string> {
  const name = nameOf(input) || fallback || '';
  if (!name) return fail('needs a notebook name (see notes_list)');
  await flushNotesEditors();
  const resolved = await resolveBookRef(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see notes_list)`);
  try {
    const { book, warnings } = await loadBook(resolved.ref);
    return { ref: resolved.ref, book, warnings };
  } catch (error) {
    return fail(`could not read notebook "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const filterOf = (input: Record<string, unknown>): Filter => ({
  query: typeof input.query === 'string' ? input.query : undefined,
  label: typeof input.label === 'string' ? input.label : undefined,
  color: typeof input.color === 'string' && COLORS.some((c) => c.id === input.color) ? (input.color as NoteColor) : undefined,
  type: typeof input.type === 'string' ? (input.type as TypeFilter) : undefined,
});
const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };
const filterProps = {
  query: { type: 'string', description: 'Text to look for in titles, text, items, labels and image descriptions' },
  label: { type: 'string' },
  color: { type: 'string', enum: COLORS.map((c) => c.id) },
  type: { type: 'string', enum: ['any', 'text', 'checklist', 'images', 'reminders'] },
};

export const NOTES_TOOLS: ToolSpec[] = [
  {
    id: 'notes_list',
    name: 'notes_list',
    description: 'List the notebooks saved in the workspace (.pigry/notes/<owner>/) with their note counts, labels and the first note titles. The user\'s own notes are in user/notes.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushNotesEditors();
      const refs = await listBookRefs();
      if (refs.length === 0) return 'No notebooks yet. Create one with notes_write (or add notes to your own with notes_edit, which creates it).';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { book } = await loadBook(ref);
          const live = book.notes.filter((n) => !n.trashed && !n.archived);
          rows.push(`- ${refKey(ref)}: ${summarizeBook(book)}${live.length ? `\n    ${live.slice(0, 10).map((n) => n.title || noteText(n).split('\n')[0].slice(0, 40) || '(empty)').join(' · ')}` : ''}`);
        } catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'notes_read',
    name: 'notes_read',
    description: 'Read a notebook: every note with its id, kind (text or checklist), pinned / archived / trashed state, colour, background, labels, reminder, its text or numbered checklist items (with item ids), images (with descriptions) and when it was last edited. Filter with query, label, color and type; include: notes (not archived), archive, trash or all (default).',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Notebook name, or owner/name (e.g. user/notes)' }, ...filterProps, include: { type: 'string', enum: ['notes', 'archive', 'trash', 'all'] }, limit: { type: 'number' } },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const include = ['notes', 'archive', 'trash', 'all'].includes(String(input.include)) ? (input.include as 'notes') : 'all';
      return `${refKey(opened.ref)}\n${readBook(opened.book, { ...filterOf(input), include, limit: typeof input.limit === 'number' ? input.limit : undefined, now: Date.now() })}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'notes_search',
    name: 'notes_search',
    description: 'Search notes across every notebook in the workspace (trash left out) by text, label, colour and type; returns owner/notebook, note id, title and the matching lines.',
    input_schema: { type: 'object', properties: { ...filterProps, limit: { type: 'number' } } },
    run: async (input) => {
      const filter = filterOf(input);
      if (!filter.query && !filter.label && !filter.color && (!filter.type || filter.type === 'any')) return fail('give a query, label, color or type');
      await flushNotesEditors();
      const refs = await listBookRefs();
      const hits: string[] = [];
      const limit = Math.max(1, Math.min(200, typeof input.limit === 'number' ? input.limit : 50));
      const q = (filter.query ?? '').trim().toLowerCase();
      for (const ref of refs) {
        let book: Notebook;
        try { book = (await loadBook(ref)).book; } catch { continue; }
        for (const n of book.notes) {
          if (n.trashed || !matchesFilter(n, filter)) continue;
          const lines = q ? noteText(n).split('\n').filter((l) => l.toLowerCase().includes(q)).slice(0, 3) : [];
          hits.push(`- ${refKey(ref)} ${n.id}${n.archived ? ' (archived)' : ''}${n.pinned ? ' (pinned)' : ''}: ${n.title || '(untitled)'}${n.labels.length ? ` [${n.labels.join(', ')}]` : ''}${lines.length ? `\n    ${lines.join('\n    ')}` : ''}`);
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      return hits.length ? `${hits.length} note(s):\n${hits.join('\n')}` : 'No notes match.';
    },
  },
  {
    id: 'notes_write',
    name: 'notes_write',
    description: `Create a notebook in your own folder (or replace your own with overwrite: true), optionally with notes straight away through ops. It is shown in the Notes menu. To add notes to an existing notebook use notes_edit.\n${OP_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Notebook name; becomes .pigry/notes/<you>/<name>.notes.json' },
        title: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing notebook of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('notes_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.notes.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create notebooks in your own folder (${caller}/) — change another owner's notebook with notes_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushNotesEditors();
      if ((await listBookRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`notebook "${refKey(ref)}" already exists. Read it with notes_read and change it with notes_edit, or pass overwrite: true to replace it.`);
      }
      const { ops, errors } = input.ops === undefined ? { ops: [] as Op[], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const book = emptyBook(String(input.title ?? name).trim().slice(0, 300) || name);
      const labelOps: Op[] = (Array.isArray(input.labels) ? input.labels : []).map((l) => ({ op: 'create_label', name: String(l) }));
      const resolved = await resolveImages([...labelOps, ...ops]);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(book, resolved, { author: caller, now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveBook(ref, result.book, 'agent');
      return `saved ${path}\n${summarizeBook(result.book)}${result.log.length ? '\n' + result.log.slice(0, 60).join('\n') : ''}\nShow it to the user with notes_open.`;
    },
  },
  {
    id: 'notes_edit',
    name: 'notes_edit',
    description: `Change a notebook with a list of operations, applied in order and saved only if all of them work; returns a log with the ids of new notes. name defaults to your own "${DEFAULT_NOTEBOOK}" notebook, which is created if it does not exist yet; use user/notes for the user's own notes. ${OP_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: `Notebook name, or owner/name (default: your own "${DEFAULT_NOTEBOOK}")` }, ops: opsSchema }, required: ['ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('notes_edit needs at least one operation');
      const caller = callerOf(input);
      let ref: OwnedRef;
      let book: Notebook;
      if (!nameOf(input)) {
        await flushNotesEditors();
        ref = { owner: caller, slug: DEFAULT_NOTEBOOK };
        const exists = (await listBookRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug);
        try { book = exists ? (await loadBook(ref)).book : emptyBook('Notes'); }
        catch (error) { return fail(`could not read ${refKey(ref)} — ${error instanceof Error ? error.message : String(error)}`); }
      } else {
        const opened = await open(input);
        if (typeof opened === 'string') return opened;
        ref = opened.ref; book = opened.book;
      }
      const resolved = await resolveImages(ops);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(book, resolved, { author: caller, now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ` (the ops before it worked: ${result.log.join('; ')})` : ''}`);
      const path = await saveBook(ref, result.book, 'agent');
      return `saved ${path}\n${result.log.slice(0, 80).join('\n')}${result.log.length > 80 ? `\n…${result.log.length - 80} more` : ''}\n${summarizeBook(result.book)}`;
    },
  },
  {
    id: 'notes_open',
    name: 'notes_open',
    description: 'Open a notebook in the Notes menu so the user can see it; optionally open one note (id or title) in the editor.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Notebook name, or owner/name' }, note: { type: 'string', description: 'Note id or title to open' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('notes_open needs a name');
      const resolved = await resolveBookRef(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see notes_list)`);
      let note: string | undefined;
      if (input.note !== undefined) {
        try { const { book } = await loadBook(resolved.ref); note = findNote(book, input.note)?.id; } catch { /* opens the notebook only */ }
        if (!note) return fail(`no note "${String(input.note)}" in ${refKey(resolved.ref)}`);
      }
      requestOpenBook(refKey(resolved.ref), note);
      return `opened "${refKey(resolved.ref)}" in the Notes menu${note ? ` with note ${note}` : ''}`;
    },
  },
];
