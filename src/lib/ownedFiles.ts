/** Files that agents and the user create in the workspace under .pigry/ are
 * kept per owner: .pigry/<kind>/<owner>/<name><ext>, where the owner is the
 * agent's username ("sa", "uxui", …) or "user" for what the person made in an
 * editor. A reference is addressed as "owner/name" (or just "name" when unique). */

export interface OwnedRef {
  /** Folder name; '' only for legacy files stored directly in the kind folder. */
  owner: string;
  slug: string;
}

export const USER_OWNER = 'user';

const clean = (value: string, max: number): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);

export const ownerSlug = (owner: string | null | undefined): string => clean(String(owner ?? ''), 40) || USER_OWNER;

/** File-safe name: strips known extensions, lowercases, keeps [a-z0-9_-]. */
export function nameSlug(name: string, extensions: string[] = []): string {
  let text = name.trim();
  for (const ext of [...extensions, '.svg', '.png', '.html', '.json']) {
    if (text.toLowerCase().endsWith(ext)) { text = text.slice(0, -ext.length); break; }
  }
  return clean(text, 60) || 'untitled';
}

export const refKey = (ref: OwnedRef): string => (ref.owner ? `${ref.owner}/${ref.slug}` : ref.slug);

/** "owner/name" or "name" → parts; owner is null when it was not given. */
export function parseRefName(name: string, extensions: string[] = []): { owner: string | null; slug: string } {
  const text = name.trim().replace(/\\/g, '/');
  const cut = text.lastIndexOf('/');
  if (cut < 0) return { owner: null, slug: nameSlug(text, extensions) };
  return { owner: ownerSlug(text.slice(0, cut).split('/').pop()), slug: nameSlug(text.slice(cut + 1), extensions) };
}

export function pathOf(dir: string, ext: string, ref: OwnedRef): string {
  return ref.owner ? `${dir}${ref.owner}/${ref.slug}${ext}` : `${dir}${ref.slug}${ext}`;
}

/** Inverse of pathOf for paths directly in `dir` or one owner folder below it. */
export function refFromPath(dir: string, ext: string, path: string): OwnedRef | null {
  if (!path.startsWith(dir) || !path.endsWith(ext)) return null;
  const rest = path.slice(dir.length, -ext.length);
  const parts = rest.split('/');
  if (parts.some((part) => !part) || parts.length > 2) return null;
  return parts.length === 1 ? { owner: '', slug: parts[0] } : { owner: parts[0], slug: parts[1] };
}

export type Resolved = { ref: OwnedRef } | { error: string };

/** Finds the file a name refers to. A bare name that exists under several owners
 * prefers the caller's own folder, then reports the ambiguity. */
export function resolveRef(refs: OwnedRef[], name: string, caller?: string, extensions: string[] = []): Resolved {
  const { owner, slug } = parseRefName(name, extensions);
  const matches = refs.filter((ref) => ref.slug === slug && (owner === null || ref.owner === owner));
  if (matches.length === 1) return { ref: matches[0] };
  if (matches.length === 0) return { error: `no "${owner ? `${owner}/` : ''}${slug}" found` };
  const mine = caller ? matches.find((ref) => ref.owner === ownerSlug(caller)) : undefined;
  if (mine) return { ref: mine };
  return { error: `"${slug}" exists under several owners (${matches.map(refKey).join(', ')}) — use owner/name` };
}

/** Agent tools that keep files per owner (.pigry/<kind>/<agent>/…) or attach images for the caller. */
const OWNED_TOOL_PREFIXES = ['diagram_', 'design_', 'board_', 'e2e_', 'drawing_', 'game_', 'model_', 'sheet_', 'docs_', 'video_', 'audio_'];
export const isOwnedFileTool = (name: string): boolean => name === 'read_image' || OWNED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));

/** Tells an owned-file tool which agent is calling, so it writes to that agent's own folder
 * (without it the tools fall back to a generic "agent" folder). */
export function withCaller(name: string, input: Record<string, unknown>, agent: string | undefined): Record<string, unknown> {
  return agent && isOwnedFileTool(name) ? { ...input, agent } : input;
}

export const sortRefs =(refs: OwnedRef[]): OwnedRef[] =>
  [...refs].sort((a, b) => a.owner.localeCompare(b.owner) || a.slug.localeCompare(b.slug));
