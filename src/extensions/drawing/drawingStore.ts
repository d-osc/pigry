/** Drawing files in the workspace (.pigry/drawings/<owner>/<name>.drawing.json) plus the small bits of state shared by
 * the Drawing editor and the agent's drawing tools: change events, "flush unsaved strokes" and "open this drawing". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { DRAWINGS_DIR, DRAWING_EXT, parseDrawingJson, serializeDrawing, type Drawing, type NormalizeResult } from './drawing';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const DRAWING_CHANGED = 'pigry:drawing-changed';
export const DRAWING_OPEN = 'pigry:open-drawing';

export interface DrawingChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const drawingPath = (ref: OwnedRef): string => pathOf(DRAWINGS_DIR, DRAWING_EXT, ref);

export async function listDrawingRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(DRAWINGS_DIR, DRAWING_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveDrawing(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listDrawingRefs(), name, caller, [DRAWING_EXT]);
}

export async function loadDrawing(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(drawingPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${drawingPath(ref)} is not a readable drawing file`);
  return { ...parseDrawingJson(file.content, ref.slug), ref };
}

export function notifyDrawingChanged(change: DrawingChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DrawingChange>(DRAWING_CHANGED, { detail: change }));
}

export async function saveDrawing(ref: OwnedRef, drawing: Drawing, source: DrawingChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(drawingPath(ref), serializeDrawing(drawing));
  notifyDrawingChanged({ key: refKey(ref), source });
  return drawingPath(ref);
}

export async function removeDrawing(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(drawingPath(ref));
  notifyDrawingChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerDrawingFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushDrawingEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this drawing in the editor" (works before the screen has mounted) ---- */

export interface DrawingOpenRequest { key: string }
let pendingOpen: DrawingOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenDrawing(key: string): void {
  pendingOpen = { key };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DrawingOpenRequest>(DRAWING_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenDrawing(): DrawingOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The drawing currently open in the editor — the agent panel mentions it as context. */
export const setOpenDrawing = (key: string | null): void => { openKey = key; };
export const getOpenDrawing = (): string | null => openKey;
