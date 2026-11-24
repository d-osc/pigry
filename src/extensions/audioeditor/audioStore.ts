/** Audio projects in the workspace (.pigry/audio/<owner>/<name>.audio.json) plus the small bits of state shared by
 * the Audio editor and the agent's audio tools: change events, "flush unsaved edits" and "open this project". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { AUDIO_DIR, AUDIO_EXT, parseProjectJson, serializeProject, type Project, type NormalizeResult } from './audio';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const AUDIO_CHANGED = 'pigry:audio-changed';
export const AUDIO_OPEN = 'pigry:open-audio';

export interface AudioChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const audioPath = (ref: OwnedRef): string => pathOf(AUDIO_DIR, AUDIO_EXT, ref);

export async function listAudioRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(AUDIO_DIR, AUDIO_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveAudio(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listAudioRefs(), name, caller, [AUDIO_EXT]);
}

export async function loadAudio(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(audioPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${audioPath(ref)} is not a readable audio project`);
  return { ...parseProjectJson(file.content, ref.slug), ref };
}

export function notifyAudioChanged(change: AudioChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<AudioChange>(AUDIO_CHANGED, { detail: change }));
}

export async function saveAudio(ref: OwnedRef, project: Project, source: AudioChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(audioPath(ref), serializeProject(project));
  notifyAudioChanged({ key: refKey(ref), source });
  return audioPath(ref);
}

export async function removeAudio(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(audioPath(ref));
  notifyAudioChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerAudioFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushAudioEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this project in the editor" (works before the screen has mounted) ---- */

export interface AudioOpenRequest { key: string }
let pendingOpen: AudioOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenAudio(key: string): void {
  pendingOpen = { key };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<AudioOpenRequest>(AUDIO_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenAudio(): AudioOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The project currently open in the editor — the agent panel mentions it as context. */
export const setOpenAudio = (key: string | null): void => { openKey = key; };
export const getOpenAudio = (): string | null => openKey;
