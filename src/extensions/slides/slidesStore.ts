/** Presentations in the workspace (.pigry/slides/<owner>/<name>.slides.json) plus the small bits of state shared by the
 * Slides editor and the agent's slides tools: change events, "flush unsaved edits" and "open this presentation". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { SLIDES_DIR, SLIDES_EXT, parseDeckJson, serializeDeck, type Deck, type NormalizeResult } from './slides';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const SLIDES_CHANGED = 'pigry:slides-changed';
export const SLIDES_OPEN = 'pigry:open-slides';

export interface SlidesChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const slidesPath = (ref: OwnedRef): string => pathOf(SLIDES_DIR, SLIDES_EXT, ref);

export async function listDeckRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(SLIDES_DIR, SLIDES_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveDeckRef(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listDeckRefs(), name, caller, [SLIDES_EXT]);
}

export async function loadDeck(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(slidesPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${slidesPath(ref)} is not a readable presentation`);
  return { ...parseDeckJson(file.content, ref.slug), ref };
}

export function notifySlidesChanged(change: SlidesChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<SlidesChange>(SLIDES_CHANGED, { detail: change }));
}

export async function saveDeck(ref: OwnedRef, deck: Deck, source: SlidesChange['source'] = 'editor'): Promise<string> {
  await writeDocText(slidesPath(ref), serializeDeck(deck));
  notifySlidesChanged({ key: refKey(ref), source });
  return slidesPath(ref);
}

export async function removeDeck(ref: OwnedRef): Promise<void> {
  await deleteDoc(slidesPath(ref));
  notifySlidesChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerSlidesFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushSlidesEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this presentation in the editor" (works before the screen has mounted) ---- */

export interface SlidesOpenRequest { key: string; slide?: string }
let pendingOpen: SlidesOpenRequest | null = null;
let openKey: string | null = null;
let openSelection: string | null = null;

export function requestOpenDeck(key: string, slide?: string): void {
  pendingOpen = { key, slide };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<SlidesOpenRequest>(SLIDES_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenDeck(): SlidesOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The presentation open in the editor (and the slide and selection) — the agent panel mentions it as context. */
export const setOpenDeck = (key: string | null, selection: string | null = null): void => { openKey = key; openSelection = selection; };
export const getOpenDeck = (): string | null => openKey;
export const getOpenDeckSelection = (): string | null => openSelection;
