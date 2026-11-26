/** Documents in the workspace (.pigry/docs/<owner>/<name>.doc.json) plus the small bits of state shared by the
 * Docs editor and the agent's docs tools: change events, "flush unsaved edits" and "open this document". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { DOCS_DIR, DOCS_EXT, parseDocJson, serializeDoc, type Doc, type NormalizeResult } from './docs';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const DOCS_CHANGED = 'pigry:docs-changed';
export const DOCS_OPEN = 'pigry:open-docs';

export interface DocsChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const docsPath = (ref: OwnedRef): string => pathOf(DOCS_DIR, DOCS_EXT, ref);

export async function listDocRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(DOCS_DIR, DOCS_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveDocRef(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listDocRefs(), name, caller, [DOCS_EXT]);
}

export async function loadDoc(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(docsPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${docsPath(ref)} is not a readable document`);
  return { ...parseDocJson(file.content, ref.slug), ref };
}

export function notifyDocsChanged(change: DocsChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DocsChange>(DOCS_CHANGED, { detail: change }));
}

export async function saveDoc(ref: OwnedRef, doc: Doc, source: DocsChange['source'] = 'editor'): Promise<string> {
  await writeDocText(docsPath(ref), serializeDoc(doc));
  notifyDocsChanged({ key: refKey(ref), source });
  return docsPath(ref);
}

export async function removeDoc(ref: OwnedRef): Promise<void> {
  await deleteDoc(docsPath(ref));
  notifyDocsChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerDocsFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushDocsEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this document in the editor" (works before the screen has mounted) ---- */

export interface DocsOpenRequest { key: string; block?: string }
let pendingOpen: DocsOpenRequest | null = null;
let openKey: string | null = null;
let openSelection: string | null = null;

export function requestOpenDoc(key: string, block?: string): void {
  pendingOpen = { key, block };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DocsOpenRequest>(DOCS_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenDoc(): DocsOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The document open in the editor (and what is selected) — the agent panel mentions it as context. */
export const setOpenDoc = (key: string | null, selection: string | null = null): void => { openKey = key; openSelection = selection; };
export const getOpenDoc = (): string | null => openKey;
export const getOpenDocSelection = (): string | null => openSelection;
