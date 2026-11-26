/** Workbooks in the workspace (.pigry/sheets/<owner>/<name>.sheet.json) plus the small bits of state shared by the
 * Sheet editor and the agent's sheet tools: change events, "flush unsaved edits" and "open this workbook". */
import { getFileTree } from '../../lib/tauriClient';
import { deleteDoc, readDocText, writeDocText } from '../../lib/docFile';
import { SHEET_DIR, SHEET_EXT, parseWorkbookJson, serializeWorkbook, type NormalizeResult, type Workbook } from './sheet';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../../lib/ownedFiles';

export const SHEET_CHANGED = 'pigry:sheet-changed';
export const SHEET_OPEN = 'pigry:open-sheet';

export interface SheetChange {
  key: string;
  /** Who wrote the file: the editor itself, or an agent tool. */
  source: 'editor' | 'agent';
  deleted?: boolean;
}

export const sheetPath = (ref: OwnedRef): string => pathOf(SHEET_DIR, SHEET_EXT, ref);

export async function listSheetRefs(): Promise<OwnedRef[]> {
  const tree = await getFileTree();
  return sortRefs(tree.entries.map((path) => refFromPath(SHEET_DIR, SHEET_EXT, path)).filter((ref): ref is OwnedRef => ref !== null));
}

export async function resolveSheet(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listSheetRefs(), name, caller, [SHEET_EXT]);
}

export async function loadSheet(ref: OwnedRef): Promise<NormalizeResult & { ref: OwnedRef }> {
  const file = await readDocText(sheetPath(ref));
  if (file.binary || file.tooLarge) throw new Error(`${sheetPath(ref)} is not a readable workbook`);
  return { ...parseWorkbookJson(file.content, ref.slug), ref };
}

export function notifySheetChanged(change: SheetChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<SheetChange>(SHEET_CHANGED, { detail: change }));
}

export async function saveSheet(ref: OwnedRef, wb: Workbook, source: SheetChange['source'] = 'editor'): Promise<string> {
  await writeDocText(sheetPath(ref), serializeWorkbook(wb));
  notifySheetChanged({ key: refKey(ref), source });
  return sheetPath(ref);
}

export async function removeSheet(ref: OwnedRef): Promise<void> {
  await deleteDoc(sheetPath(ref));
  notifySheetChanged({ key: refKey(ref), source: 'editor', deleted: true });
}

/* ---- unsaved editor state: tools flush it before they read a file ---- */

const flushers = new Set<() => Promise<void>>();

export function registerSheetFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushSheetEditors(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
}

/* ---- "open this workbook in the editor" (works before the screen has mounted) ---- */

export interface SheetOpenRequest { key: string; sheet?: string; cell?: string }
let pendingOpen: SheetOpenRequest | null = null;
let openKey: string | null = null;
let openSelection: string | null = null;

export function requestOpenSheet(key: string, sheet?: string, cell?: string): void {
  pendingOpen = { key, sheet, cell };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<SheetOpenRequest>(SHEET_OPEN, { detail: pendingOpen }));
}

export function takePendingOpenSheet(): SheetOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

/** The workbook currently open in the editor (and the selection) — the agent panel mentions it as context. */
export const setOpenSheet = (key: string | null, selection: string | null = null): void => { openKey = key; openSelection = selection; };
export const getOpenSheet = (): string | null => openKey;
export const getOpenSheetSelection = (): string | null => openSelection;
