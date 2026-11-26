/** Pure helpers for the JSON documents kept under .pigry/ (drawings, designs, sheets, …).
 *
 * These files live in git, so they are written to diff well:
 *  - `toFileJson` pretty-prints with stable two-space indentation, keeps short
 *    objects and arrays of plain values on one line, and wraps long number lists
 *    into lines of ~100 characters, so a one-field edit is a one-line diff.
 *  - `externalizeMedia` lifts large base64 images (data: URLs) out of the document
 *    into content-addressed side files (<doc>.assets/<hash>.png), so the JSON stays
 *    small and an unchanged picture is never rewritten or re-committed.
 *  - `internalizeMedia` reverses that when a document is read back.
 *
 * No I/O here: docFile.ts wires these to the worktree. */

const WIDTH = 100;
/** Short objects of plain values fit one line up to this width (points, colours, keyframes). */
const INLINE_OBJECT = 80;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isPlain = (v: unknown): boolean => v === null || typeof v !== 'object';
const scalar = (v: unknown): string => JSON.stringify(v) ?? 'null';

function fmt(value: unknown, indent: string): string {
  if (isPlain(value)) return scalar(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPlain)) {
      const parts = value.map(scalar);
      const one = `[${parts.join(', ')}]`;
      if (indent.length + one.length <= WIDTH) return one;
      const lines: string[] = [];
      let line = '';
      for (const part of parts) {
        if (line && inner.length + line.length + part.length + 2 > WIDTH) { lines.push(line); line = ''; }
        line += `${line ? ' ' : ''}${part},`;
      }
      lines.push(line.slice(0, -1));
      return `[\n${lines.map((l) => inner + l).join('\n')}\n${indent}]`;
    }
    return `[\n${value.map((item) => inner + fmt(item ?? null, inner)).join(',\n')}\n${indent}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined && typeof record[k] !== 'function');
  if (keys.length === 0) return '{}';
  if (keys.every((k) => isPlain(record[k]))) {
    const one = `{ ${keys.map((k) => `${JSON.stringify(k)}: ${scalar(record[k])}`).join(', ')} }`;
    if (one.length <= INLINE_OBJECT && indent.length + one.length <= WIDTH) return one;
  }
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(record[k], inner)}`).join(',\n')}\n${indent}}`;
}

/** Diff-friendly JSON text with a trailing newline. Parses back to exactly what JSON.stringify would give. */
export const toFileJson = (value: unknown): string => `${fmt(value, '')}\n`;

/* ---- media side files ---- */

/** Prefix of a reference to a side file in the document's assets folder. */
export const ASSET_REF = 'pigry-asset:';
/** Images smaller than this stay inline (icons, tiny swatches). */
export const MIN_EXTERNAL_CHARS = 4096;

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,/;

/** `.pigry/drawings/user/cat.drawing.json` → `.pigry/drawings/user/cat.drawing.assets/` */
export const assetsDirOf = (docPath: string): string => `${docPath.replace(/\.json$/i, '')}.assets/`;

export const mimeOfAsset = (name: string): string => MIME_BY_EXT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** Asset file names are `<hex>.<ext>`: anything else in a reference is ignored (no paths, no traversal). */
const ASSET_NAME = /^[0-9a-f]{8,64}\.(png|jpg|jpeg|webp|gif)$/;
export const assetNameOf = (ref: string): string | null => {
  if (!ref.startsWith(ASSET_REF)) return null;
  const name = ref.slice(ASSET_REF.length);
  return ASSET_NAME.test(name) ? name : null;
};

async function hashOf(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MediaAsset { name: string; mime: string; base64: string }

function mapStrings(value: Json, visit: (s: string) => string): Json {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, visit));
  if (value && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, visit);
    return out;
  }
  return value;
}

function collectStrings(value: Json, into: Set<string>): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

/** Replaces every large base64 image with `pigry-asset:<hash>.<ext>`; returns the new value and the files to write. */
export async function externalizeMedia(value: Json, minChars = MIN_EXTERNAL_CHARS): Promise<{ value: Json; assets: MediaAsset[] }> {
  const found = new Map<string, MediaAsset>();
  for (const s of collectStrings(value, new Set())) {
    const match = s.length >= minChars ? DATA_URL.exec(s) : null;
    if (!match) continue;
    const base64 = s.slice(match[0].length);
    found.set(s, { name: `${await hashOf(base64)}.${EXT_BY_MIME[match[1]]}`, mime: match[1], base64 });
  }
  if (found.size === 0) return { value, assets: [] };
  const out = mapStrings(value, (s) => { const asset = found.get(s); return asset ? `${ASSET_REF}${asset.name}` : s; });
  const unique = new Map<string, MediaAsset>();
  for (const asset of found.values()) unique.set(asset.name, asset);
  return { value: out, assets: [...unique.values()] };
}

/** Asset file names a document refers to. */
export const assetRefsIn = (value: Json): string[] =>
  [...collectStrings(value, new Set())].map(assetNameOf).filter((name): name is string => name !== null);

/** Puts the images back as data: URLs. `load` returns base64 for a file name, or null when it is missing (the reference is kept). */
export async function internalizeMedia(value: Json, load: (name: string) => Promise<string | null>): Promise<Json> {
  const names = assetRefsIn(value);
  if (names.length === 0) return value;
  const urls = new Map<string, string>();
  await Promise.all(names.map(async (name) => {
    const base64 = await load(name);
    if (base64 !== null) urls.set(name, `data:${mimeOfAsset(name)};base64,${base64}`);
  }));
  return mapStrings(value, (s) => { const name = assetNameOf(s); return (name && urls.get(name)) ?? s; });
}

export type { Json };
