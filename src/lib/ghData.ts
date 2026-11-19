/**
 * Helpers for mapping gh CLI data into the screens' display models,
 * shared by the Pull requests / Issues / Releases screens.
 */

/** "46 min ago" (long) or "46m" (short) from an RFC3339 timestamp. */
export function relativeTime(iso: string, short = false): string {
  if (!iso) return short ? '—' : 'just now';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return short ? '—' : 'just now';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return short ? 'now' : 'just now';
  if (minutes < 60) return short ? `${minutes}m` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return short ? `${hours}h` : `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return short ? `${days}d` : `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return short ? `${months}mo` : `${months} month${months === 1 ? '' : 's'} ago`;
}

/** "Nov 7, 2026" from an RFC3339 timestamp (empty input → empty string). */
export function formatDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase() || '??';
}

const AVATAR_COLORS = ['#223d43', '#3b3049', '#453a2c', '#38405b', '#4a2c38'];

/** Deterministic avatar color per author (same palette as the demo fixtures). */
export function colorOf(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Map a gh review decision to the PR screen's tone wording. */
export function reviewDisplay(
  state: string,
  review: string,
  draft: boolean,
): { review: string; tone: 'orange' | 'green' | 'red' } {
  if (state === 'MERGED') return { review: 'Merged', tone: 'green' };
  if (draft) return { review: 'Draft', tone: 'orange' };
  if (review === 'APPROVED') return { review: 'Approved', tone: 'green' };
  if (review === 'CHANGES_REQUESTED') return { review: 'Changes requested', tone: 'red' };
  return { review: 'Review required', tone: 'orange' };
}

/** Map issue label text to the Issues screen's badge tone. */
export function labelTone(label: string): 'red' | 'purple' | 'orange' | 'accent' {
  const l = label.toLowerCase();
  if (l.includes('bug') || l.includes('fix')) return 'red';
  if (l.includes('performance')) return 'orange';
  if (l.includes('doc')) return 'accent';
  return 'purple';
}

export interface PrDiffFile {
  path: string;
  original: string;
  modified: string;
  language: string;
  additions: number;
  deletions: number;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  rs: 'rust',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  xml: 'xml',
};

export function languageForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return EXT_LANGUAGE[ext] ?? 'plaintext';
}

interface ParsedFile {
  path: string;
  originalLines: string[];
  modifiedLines: string[];
  additions: number;
  deletions: number;
}

/**
 * Splits a unified diff into per-file original/modified contents — feeding the
 * same Monaco DiffEditor the Working changes screen uses.
 */
export function parseUnifiedByFile(diff: string): PrDiffFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      const match = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        path: match ? match[2] : '',
        originalLines: [],
        modifiedLines: [],
        additions: 0,
        deletions: 0,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) {
      current.additions += 1;
      current.modifiedLines.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith('-')) {
      current.deletions += 1;
      current.originalLines.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith(' ')) {
      current.originalLines.push(raw.slice(1));
      current.modifiedLines.push(raw.slice(1));
    }
  }
  return files
    .filter((file) => file.path)
    .map((file) => ({
      path: file.path,
      original: file.originalLines.join('\n'),
      modified: file.modifiedLines.join('\n'),
      language: languageForPath(file.path),
      additions: file.additions,
      deletions: file.deletions,
    }));
}
