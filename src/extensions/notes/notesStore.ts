/** Notebooks in the workspace (.pigry/notes/<owner>/<name>.notes.json) plus the small bits of state shared by the
 * Notes screen and the agent's notes tools: change events, "flush unsaved edits" and "open this notebook / note". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { NOTES_DIR, NOTES_EXT, parseBookJson, serializeBook, type NormalizeResult, type Notebook } from './notes';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const NOTES_CHANGED = 'pigry:notes-changed';
export const NOTES_OPEN = 'pigry:open-notes';

export interface NotesChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const notesPath = (ref: OwnedRef): string => pathOf(NOTES_DIR, NOTES_EXT, ref);

export async function listBookRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(NOTES_DIR, NOTES_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveBookRef(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listBookRefs(), name, caller, [NOTES_EXT]);
}

export async function loadBook(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(notesPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${notesPath(ref)} is not a readable notebook`);
  return { ...parseBookJson(file.content, ref.slug), ref };
}

export function notifyNotesChanged(change: NotesChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<NotesChange>(NOTES_CHANGED, { detail: change }));
}

export async function saveBook(ref: OwnedRef, book: Notebook, source: NotesChange['source'] = 'editor'): Promise<string> {
  await writeDocText(notesPath(ref), serializeBook(book));
  notifyNotesChanged({ key: refKey(ref), source });
  return notesPath(ref);
}

export async function removeBook(ref: OwnedRef): Promise<void> {
  await deleteDoc(notesPath(ref));
  notifyNotesChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerNotesFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushNotesEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this notebook (and note) in the Notes menu" (works before the screen has mounted) ---- */

export interface NotesOpenRequest { key: string; note?: string }
let pendingOpen: NotesOpenRequest | null = null;
let openKey: string | null = null;
let openNote: string | null = null;

export function requestOpenBook(key: string, note?: string): void {
  pendingOpen = { key, note };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<NotesOpenRequest>(NOTES_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenBook(): NotesOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The notebook open in the Notes menu (and the note being edited) — the agent panel mentions it as context. */
export const setOpenBook = (key: string | null, note: string | null = null): void => { openKey = key; openNote = note; };
export const getOpenBook = (): string | null => openKey;
export const getOpenNote = (): string | null => openNote;
