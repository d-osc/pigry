/**
 * VS Code-style code search helpers for the Explorer FILES search view:
 * literal / whole-word / regex matching, include/exclude globs, worktree
 * scanning and the replace-all engine shared with the search results.
 */
import type { CodeSearchHit } from '../types/repository';

export interface CodeSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated glob patterns; empty = search everywhere. */
  include: string;
  exclude: string;
  /** Skip generated/vendored directories (the gear toggle). */
  useDefaultIgnores: boolean;
}

/** Directories skipped while the "gear" toggle is on (VS Code default excludes). */
const DEFAULT_IGNORE_PARTS = [
  'node_modules',
  '.git',
  'dist',
  'dist-ssr',
  'target',
  '.serena',
  '.zcode-notes',
  '.zcode',
];

export function isDefaultIgnored(path: string): boolean {
  return DEFAULT_IGNORE_PARTS.some(
    (part) => path === part || path.startsWith(`${part}/`) || path.includes(`/${part}/`),
  );
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds the search matcher; null for an empty or (in regex mode) invalid pattern. */
export function buildSearchRegex(
  query: string,
  options: Pick<CodeSearchOptions, 'caseSensitive' | 'wholeWord' | 'regex'>,
): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const flags = `g${options.caseSensitive ? '' : 'i'}`;
  let source: string;
  if (options.regex) {
    source = q;
  } else {
    source = escapeRegExp(q);
    if (options.wholeWord) source = `\\b(?:${source})\\b`;
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function splitGlobs(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** VS Code-style glob: `*` within a segment, `**` across, `?` one char. */
export function globToRegExp(pattern: string): RegExp | null {
  const normalized = pattern.replace(/^\.\//, '');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          source += '(?:.*/)?'; // `**/` also matches zero segments
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    return null;
  }
}

function pathMatchesGlob(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  if (!re) return false;
  if (pattern.includes('/')) return re.test(path);
  // No slash — VS Code matches the pattern against basenames anywhere.
  const parts = path.split('/');
  return parts.some((part) => re.test(part)) || re.test(path);
}

export function pathMatchesGlobs(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pathMatchesGlob(path, pattern));
}

/** Include/exclude/ignore filtering over a path. */
export function passesPathFilters(path: string, options: CodeSearchOptions): boolean {
  if (options.useDefaultIgnores && isDefaultIgnored(path)) return false;
  const include = splitGlobs(options.include);
  if (include.length > 0 && !pathMatchesGlobs(path, include)) return false;
  const exclude = splitGlobs(options.exclude);
  if (exclude.length > 0 && pathMatchesGlobs(path, exclude)) return false;
  return true;
}

/** Scans worktree files with the built matcher (path taken when options are active). */
export async function scanWorktreeCode(
  files: string[],
  readFile: (path: string) => Promise<string>,
  query: string,
  options: CodeSearchOptions,
  maxHits = 200,
): Promise<CodeSearchHit[]> {
  const re = buildSearchRegex(query, options);
  if (!re) return [];
  const hits: CodeSearchHit[] = [];
  const maxPerFile = 10;
  const maxLineLen = 300;
  for (const path of files) {
    if (hits.length >= maxHits) break;
    if (!passesPathFilters(path, options)) continue;
    let content: string;
    try {
      content = await readFile(path);
    } catch {
      continue; // unreadable file — skip
    }
    if (!content) continue;
    const lines = content.split('\n');
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < maxPerFile; i += 1) {
      re.lastIndex = 0;
      const match = re.exec(lines[i]);
      if (match) {
        const text = lines[i].trim();
        hits.push({
          path,
          line: i + 1,
          column: match.index + 1,
          text: text.length > maxLineLen ? `${text.slice(0, maxLineLen)}…` : text,
        });
        perFile += 1;
      }
    }
  }
  return hits;
}

/** VS Code "Preserve Case": adapt the replacement to each match's casing. */
function preserveCaseReplace(match: string, replacement: string): string {
  const hasUpper = /[A-Z]/.test(match);
  const hasLower = /[a-z]/.test(match);
  if (hasUpper && !hasLower) return replacement.toUpperCase();
  const first = match[0];
  if (
    hasUpper &&
    first === first.toUpperCase() &&
    match.slice(1) === match.slice(1).toLowerCase()
  ) {
    return (replacement[0]?.toUpperCase() ?? '') + replacement.slice(1);
  }
  return replacement;
}

/** Replace every match in a file; literal mode keeps `$` as literal text. */
export function replaceAllInContent(
  content: string,
  re: RegExp,
  replacement: string,
  options: { preserveCase: boolean; isRegex: boolean },
): { content: string; count: number } {
  const count = (content.match(re) ?? []).length;
  if (count === 0) return { content, count: 0 };
  const pattern = re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
  const to = options.isRegex
    ? replacement
    : replacement.replace(/\$/g, () => '$$'); // literal `$` in replacement strings
  const next = options.preserveCase
    ? content.replace(pattern, (match) => preserveCaseReplace(match, to))
    : content.replace(pattern, to);
  return { content: next, count };
}
