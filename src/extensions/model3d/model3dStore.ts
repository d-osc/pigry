/** 3D models in the workspace (.pigry/models/<owner>/<name>.model.json) plus the small bits of state shared by the
 * 3D Model editor and the agent's model tools: change events, "flush unsaved edits" and "open this model". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { MODELS_DIR, MODEL_EXT, parseModelJson, serializeModel, type Model3D, type NormalizeResult } from './model3d';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const MODEL_CHANGED = 'pigry:model3d-changed';
export const MODEL_OPEN = 'pigry:open-model3d';

export interface ModelChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const modelPath = (ref: OwnedRef): string => pathOf(MODELS_DIR, MODEL_EXT, ref);

export async function listModelRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(MODELS_DIR, MODEL_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveModel(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listModelRefs(), name, caller, [MODEL_EXT]);
}

export async function loadModel(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(modelPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${modelPath(ref)} is not a readable model file`);
  return { ...parseModelJson(file.content, ref.slug), ref };
}

export function notifyModelChanged(change: ModelChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ModelChange>(MODEL_CHANGED, { detail: change }));
}

export async function saveModel(ref: OwnedRef, model: Model3D, source: ModelChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(modelPath(ref), serializeModel(model));
  notifyModelChanged({ key: refKey(ref), source });
  return modelPath(ref);
}

export async function removeModel(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(modelPath(ref));
  notifyModelChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerModelFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushModelEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this model in the editor" (works before the screen has mounted) ---- */

export interface ModelOpenRequest { key: string }
let pendingOpen: ModelOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenModel(key: string): void {
  pendingOpen = { key };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ModelOpenRequest>(MODEL_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenModel(): ModelOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The model currently open in the editor — the agent panel mentions it as context. */
export const setOpenModel = (key: string | null): void => { openKey = key; };
export const getOpenModel = (): string | null => openKey;
