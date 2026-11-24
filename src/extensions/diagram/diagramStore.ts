/** Diagram files in the workspace (.pigry/diagrams/<owner>/<name>.diagram.json,
 * one folder per agent — "user" for the editor) plus the small bits of shared
 * state between the Diagram editor screen and the agent's diagram tools:
 * change events, "flush unsaved edits" and "open this diagram". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { DIAGRAMS_DIR, DIAGRAM_EXT, parseDiagramJson, serializeDiagram, type Diagram, type NormalizeResult } from './diagram';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const DIAGRAM_CHANGED = 'pigry:diagram-changed';
export const DIAGRAM_OPEN = 'pigry:open-diagram';

export interface DiagramChange {
  /** "owner/name" of the file. */
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const diagramPath = (ref: OwnedRef): string => pathOf(DIAGRAMS_DIR, DIAGRAM_EXT, ref);

export async function listDiagramRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(DIAGRAMS_DIR, DIAGRAM_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveDiagram(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listDiagramRefs(), name, caller, [DIAGRAM_EXT]);
}

export async function loadDiagram(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(diagramPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${diagramPath(ref)} is not a readable diagram file`);
  return { ...parseDiagramJson(file.content, ref.slug), ref };
}

export function notifyDiagramChanged(change: DiagramChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<DiagramChange>(DIAGRAM_CHANGED, { detail: change }));
}

export async function saveDiagram(ref: OwnedRef, diagram: Diagram, source: DiagramChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(diagramPath(ref), serializeDiagram(diagram));
  notifyDiagramChanged({ key: refKey(ref), source });
  return diagramPath(ref);
}

export async function removeDiagram(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(diagramPath(ref));
  notifyDiagramChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

/** The editor registers a function that writes its pending (debounced) edits. */
export function registerDiagramFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushDiagramEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this diagram in the editor" (works before the screen has mounted) ---- */

let pendingOpen: string | null = null;
let openKey: string | null = null;

export function requestOpenDiagram(key: string): void {
  pendingOpen = key;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(DIAGRAM_OPEN, { detail: key }));
}

export function takePendingOpenDiagram(): string | null {
  const key = pendingOpen;
  pendingOpen = null;
  return key;
}

/** The diagram currently open in the editor — the agent panel mentions it as context. */
export const setOpenDiagram = (key: string | null): void => { openKey = key; };
export const getOpenDiagram = (): string | null => openKey;

export { DIAGRAMS_DIR };
