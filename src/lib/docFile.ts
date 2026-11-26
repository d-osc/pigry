/** Reads and writes the JSON documents under .pigry/ (drawings, designs, boards, sheets, …).
 *
 * Every editor store goes through here so the files on disk are:
 *  - diff-friendly JSON (see toFileJson), and
 *  - free of large base64 images, which are kept as side files in
 *    `<doc>.assets/<hash>.<ext>` and referenced as `pigry-asset:<hash>.<ext>`.
 *
 * Editors and agent tools still see ordinary data: URLs — the swap happens only at
 * the file boundary. Side files are content-addressed, so an image that did not
 * change is never written again, and ones a save stops referring to are deleted. */
import { deleteWorktreeFile, getFileTree, readBinaryFile, readWorktreeFile, writeWorktreeBinary, writeWorktreeFile } from './tauriClient';
import { assetRefsIn, assetsDirOf, externalizeMedia, internalizeMedia, toFileJson, type Json } from './fileJson';
import type { WorktreeFileContent } from '../types/repository';

/** Side files known to exist on disk (written or read this session). */
const known = new Set<string>();
/** Side files each document referred to at its last save or load, for clean-up. */
const lastRefs = new Map<string, Set<string>>();

/** base64 of side files read this session — they are content-addressed, so a cached copy never goes stale. */
const cache = new Map<string, string>();
let cacheChars = 0;
const CACHE_LIMIT = 64_000_000;
function remember(path: string, base64: string): void {
  if (base64.length > CACHE_LIMIT / 4) return;
  if (cacheChars + base64.length > CACHE_LIMIT) { cache.clear(); cacheChars = 0; }
  cache.set(path, base64);
  cacheChars += base64.length;
}

const parse = (text: string): Json | undefined => { try { return JSON.parse(text) as Json; } catch { return undefined; } };

/** Document text as written on disk → text with every side-file image put back inline. */
export async function inlineDocAssets(docPath: string, text: string): Promise<string> {
  if (!text.includes('pigry-asset:')) return text;
  const value = parse(text);
  if (value === undefined) return text;
  const dir = assetsDirOf(docPath);
  lastRefs.set(docPath, new Set(assetRefsIn(value)));
  const inlined = await internalizeMedia(value, async (name) => {
    const path = `${dir}${name}`;
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    try {
      const file = await readBinaryFile(path);
      known.add(path);
      remember(path, file.data);
      return file.data;
    } catch { return null; }
  });
  return JSON.stringify(inlined);
}

/** Reads a document; returns the text with images inline, or throws like readWorktreeFile. */
export async function readDocText(docPath: string): Promise<WorktreeFileContent> {
  const file = await readWorktreeFile(docPath);
  if (file.binary || file.tooLarge) return file;
  return { ...file, content: await inlineDocAssets(docPath, file.content) };
}

/** Turns a serialized document into what goes on disk, writing any new side files and deleting dropped ones. */
export async function packDoc(docPath: string, text: string): Promise<string> {
  const value = parse(text);
  if (value === undefined) return text;
  const { value: packed, assets } = await externalizeMedia(value);
  const dir = assetsDirOf(docPath);
  for (const asset of assets) {
    const path = `${dir}${asset.name}`;
    if (known.has(path)) continue;
    await writeWorktreeBinary(path, asset.base64);
    known.add(path);
    remember(path, asset.base64);
  }
  const now = new Set(assetRefsIn(packed));
  const before = lastRefs.get(docPath);
  if (before) {
    for (const name of before) {
      if (now.has(name)) continue;
      const path = `${dir}${name}`;
      await deleteWorktreeFile(path).catch(() => undefined);
      known.delete(path);
    }
  }
  lastRefs.set(docPath, now);
  return toFileJson(packed);
}

/** Writes a serialized document (diff-friendly, images as side files). */
export async function writeDocText(docPath: string, text: string): Promise<void> {
  await writeWorktreeFile(docPath, await packDoc(docPath, text));
}

/** Deletes a document together with its side files. */
export async function deleteDoc(docPath: string): Promise<void> {
  await deleteWorktreeFile(docPath);
  const dir = assetsDirOf(docPath);
  lastRefs.delete(docPath);
  const tree = await getFileTree().catch(() => null);
  for (const path of tree?.entries ?? []) {
    if (!path.startsWith(dir)) continue;
    await deleteWorktreeFile(path).catch(() => undefined);
    known.delete(path);
  }
}
