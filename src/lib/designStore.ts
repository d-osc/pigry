/** Design files in the workspace (.pigry/designs/<owner>/<name>.design.json)
 * plus the small bits of shared state between the Design editor screen and the
 * agent's design tools: change events, "flush unsaved edits" and "open this design". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from './tauriClient';
import { DESIGNS_DIR, DESIGN_EXT, parseDesignJson, serializeDesign, type Design, type NormalizeResult } from './design';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from './ownedFiles';

export const DESIGN_CHANGED = 'pigry:design-changed';
export const DESIGN_OPEN = 'pigry:open-design';

export interface DesignChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const designPath = (ref: OwnedRef): string => pathOf(DESIGNS_DIR, DESIGN_EXT, ref);

export async function listDesignRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(DESIGNS_DIR, DESIGN_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveDesign(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listDesignRefs(), name, caller, [DESIGN_EXT]);
}

export async function loadDesign(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(designPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${designPath(ref)} is not a readable design file`);
  return { ...parseDesignJson(file.content, ref.slug), ref };
}

export function notifyDesignChanged(change: DesignChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DesignChange>(DESIGN_CHANGED, { detail: change }));
}

export async function saveDesign(ref: OwnedRef, design: Design, source: DesignChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(designPath(ref), serializeDesign(design));
  notifyDesignChanged({ key: refKey(ref), source });
  return designPath(ref);
}

export async function removeDesign(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(designPath(ref));
  notifyDesignChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerDesignFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushDesignEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this design in the editor" (works before the screen has mounted) ---- */

export interface OpenRequest { key: string; node?: string }
let pendingOpen: OpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenDesign(key: string, node?: string): void {
  pendingOpen = { key, node };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<OpenRequest>(DESIGN_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenDesign(): OpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The design currently open in the editor — the agent panel mentions it as context. */
export const setOpenDesign = (key: string | null): void => { openKey = key; };
export const getOpenDesign = (): string | null => openKey;
