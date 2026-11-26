/** Video files in the workspace (.pigry/videos/<owner>/<name>.video.json) plus the small bits of state shared by
 * the Video editor and the agent's video tools: change events, "flush unsaved edits" and "open this video". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { VIDEOS_DIR, VIDEO_EXT, parseProjectJson, serializeProject, type Project, type NormalizeResult } from './video';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const VIDEO_CHANGED = 'pigry:video-changed';
export const VIDEO_OPEN = 'pigry:open-video';

export interface VideoChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const videoPath = (ref: OwnedRef): string => pathOf(VIDEOS_DIR, VIDEO_EXT, ref);

export async function listVideoRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(VIDEOS_DIR, VIDEO_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveVideo(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listVideoRefs(), name, caller, [VIDEO_EXT]);
}

export async function loadVideo(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(videoPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${videoPath(ref)} is not a readable video file`);
  return { ...parseProjectJson(file.content, ref.slug), ref };
}

export function notifyVideoChanged(change: VideoChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<VideoChange>(VIDEO_CHANGED, { detail: change }));
}

export async function saveVideo(ref: OwnedRef, project: Project, source: VideoChange['source'] = 'editor'): Promise<string> {
  await writeDocText(videoPath(ref), serializeProject(project));
  notifyVideoChanged({ key: refKey(ref), source });
  return videoPath(ref);
}

export async function removeVideo(ref: OwnedRef): Promise<void> {
  await deleteDoc(videoPath(ref));
  notifyVideoChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerVideoFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushVideoEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this video in the editor" (works before the screen has mounted) ---- */

export interface VideoOpenRequest { key: string }
let pendingOpen: VideoOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenVideo(key: string): void {
  pendingOpen = { key };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<VideoOpenRequest>(VIDEO_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenVideo(): VideoOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The video currently open in the editor — the agent panel mentions it as context. */
export const setOpenVideo = (key: string | null): void => { openKey = key; };
export const getOpenVideo = (): string | null => openKey;
