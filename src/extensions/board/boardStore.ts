/** Board files in the workspace (.pigry/boards/<owner>/<name>.board.json, one
 * folder per agent — "user" for the editor) plus the small bits of shared state
 * between the Board editor screen and the agent's board tools: change events,
 * "flush unsaved edits" and "open this board". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { BOARDS_DIR, BOARD_EXT, parseBoardJson, serializeBoard, type Board, type NormalizeResult } from './board';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const BOARD_CHANGED = 'pigry:board-changed';
export const BOARD_OPEN = 'pigry:open-board';

export interface BoardChange {
  /** "owner/name" of the file. */
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const boardPath = (ref: OwnedRef): string => pathOf(BOARDS_DIR, BOARD_EXT, ref);

export async function listBoardRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(BOARDS_DIR, BOARD_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveBoard(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listBoardRefs(), name, caller, [BOARD_EXT]);
}

export async function loadBoard(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(boardPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${boardPath(ref)} is not a readable board file`);
  return { ...parseBoardJson(file.content, ref.slug), ref };
}

export function notifyBoardChanged(change: BoardChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<BoardChange>(BOARD_CHANGED, { detail: change }));
}

export async function saveBoard(ref: OwnedRef, board: Board, source: BoardChange['source'] = 'editor'): Promise<string> {
  await writeDocText(boardPath(ref), serializeBoard(board));
  notifyBoardChanged({ key: refKey(ref), source });
  return boardPath(ref);
}

export async function removeBoard(ref: OwnedRef): Promise<void> {
  await deleteDoc(boardPath(ref));
  notifyBoardChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerBoardFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushBoardEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this board in the editor" (works before the screen has mounted) ---- */

export interface BoardOpenRequest { key: string; item?: string }
let pendingOpen: BoardOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenBoard(key: string, item?: string): void {
  pendingOpen = { key, item };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<BoardOpenRequest>(BOARD_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenBoard(): BoardOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The board currently open in the editor — the agent panel mentions it as context. */
export const setOpenBoard = (key: string | null): void => { openKey = key; };
export const getOpenBoard = (): string | null => openKey;
