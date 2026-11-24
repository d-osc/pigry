/** Games in the workspace (.pigry/games/<owner>/<name>.game.json) plus the small bits of state shared by the Game
 * Engine editor and the agent's game tools: change events, "flush unsaved edits" and "open this game". */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { GAMES_DIR, GAME_EXT, parseGameJson, serializeGame, type Game, type NormalizeResult } from './game';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const GAME_CHANGED = 'pigry:game-changed';
export const GAME_OPEN = 'pigry:open-game';

export interface GameChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const gamePath = (ref: OwnedRef): string => pathOf(GAMES_DIR, GAME_EXT, ref);

export async function listGameRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(GAMES_DIR, GAME_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveGame(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listGameRefs(), name, caller, [GAME_EXT]);
}

export async function loadGame(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readWorktreeFile(gamePath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${gamePath(ref)} is not a readable game file`);
  return { ...parseGameJson(file.content, ref.slug), ref };
}

export function notifyGameChanged(change: GameChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<GameChange>(GAME_CHANGED, { detail: change }));
}

export async function saveGame(ref: OwnedRef, game: Game, source: GameChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(gamePath(ref), serializeGame(game));
  notifyGameChanged({ key: refKey(ref), source });
  return gamePath(ref);
}

export async function removeGame(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(gamePath(ref));
  notifyGameChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerGameFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushGameEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this game in the editor" (works before the screen has mounted) ---- */

export interface GameOpenRequest { key: string }
let pendingOpen: GameOpenRequest | null = null;
let openKey: string | null = null;

export function requestOpenGame(key: string): void {
  pendingOpen = { key };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<GameOpenRequest>(GAME_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenGame(): GameOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The game currently open in the editor — the agent panel mentions it as context. */
export const setOpenGame = (key: string | null): void => { openKey = key; };
export const getOpenGame = (): string | null => openKey;
