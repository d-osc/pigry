/** Code shown on a board: a file (or just some of its lines), a compare of two
 * refs, or a commit. This module is pure — it normalises references and turns
 * texts into drawable lines. Loading the texts lives in boardCode.ts. */

export type CodeKind = 'file' | 'compare' | 'commit';

export interface CodeRef {
  kind: CodeKind;
  /** Repository-relative file path (always for `file`, optional narrowing for `compare`/`commit`). */
  path?: string;
  /** file: first and last line to show (1-based, inclusive). */
  start?: number;
  end?: number;
  /** file: show the file as it was at this commit/branch instead of the working tree. */
  rev?: string;
  /** compare: the two refs. */
  base?: string;
  head?: string;
  /** commit: the commit (full or short oid, or a ref). */
  oid?: string;
}

export type SnapKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta' | 'file';

export interface SnapLine {
  k: SnapKind;
  /** Gutter label (line number); empty for meta lines. */
  n?: string;
  t: string;
  /** `file` rows: the changed file's path (opens its diff). */
  p?: string;
}

export interface CommitInfo {
  oid: string;
  shortOid: string;
  summary: string;
  /** Message body without the summary line. */
  body: string;
  authorName: string;
  authorInitials: string;
  /** Pre-formatted, e.g. "3 days ago". */
  when: string;
  isMerge: boolean;
  signed?: 'good' | 'bad';
  parents: string[];
}

export interface CodeSnapshot {
  title: string;
  subtitle?: string;
  lines: SnapLine[];
  /** commit/compare without a file: the changed files, in the order of the `file` rows. */
  files?: FileChange[];
  /** commit without a file: the details the commit card shows (like the Commit graph's Overview). */
  commit?: CommitInfo;
  /** A diff opened from a commit/compare: position among the changed files (for the ‹ 2/4 › stepper). */
  nav?: { index: number; total: number; prev?: string; next?: string };
  /** The loader could not read the source. */
  error?: string;
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const posInt = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
};
const cleanPath = (v: unknown): string | undefined => str(v, 260)?.replace(/\\/g, '/').replace(/^\.\//, '');

/** Reads a code reference from loose agent/user input. `hint` is the kind implied by the item type used (file / compare / commit). */
export function normalizeCodeRef(raw: Record<string, unknown>, hint?: CodeKind, previous?: CodeRef): CodeRef | null {
  const nested = (key: string) => (raw[key] && typeof raw[key] === 'object' ? raw[key] as Record<string, unknown> : null);
  const cmp = nested('compare') ?? nested('diff');
  const src = nested('code') ?? cmp ?? raw;
  const oid = str(src.oid ?? src.commit ?? src.sha ?? raw.oid ?? raw.commit ?? raw.sha, 80);
  const base = str(src.base ?? raw.base, 120), head = str(src.head ?? src.compare ?? raw.head, 120);
  const path = cleanPath(src.path ?? src.file ?? raw.path ?? raw.file);
  let kind: CodeKind | undefined = src.kind === 'file' || src.kind === 'compare' || src.kind === 'commit' ? src.kind : hint;
  if (!kind) kind = base && head ? 'compare' : oid ? 'commit' : path ? 'file' : previous?.kind;
  if (!kind) return null;

  if (kind === 'file') {
    const prev = previous?.kind === 'file' ? previous : undefined;
    const filePath = path ?? prev?.path;
    if (!filePath) return null;
    const out: CodeRef = { kind, path: filePath };
    const mentionsRange = [src, raw].some((o) => o.start !== undefined || o.end !== undefined || o.line !== undefined || o.lines !== undefined);
    let start = posInt(src.start ?? raw.start ?? src.line ?? raw.line), end = posInt(src.end ?? raw.end);
    if (!mentionsRange && prev) { start = prev.start; end = prev.end; }
    const range = str(src.lines ?? raw.lines, 30)?.match(/^(\d+)\s*(?:[-–:]\s*(\d+))?$/);
    if (range) { start = Number(range[1]); end = range[2] ? Number(range[2]) : start; }
    if (start) out.start = start;
    if (end) out.end = Math.max(end, start ?? 1);
    if (start && !end) out.end = start + 19; // a lone start shows 20 lines
    const rev = str(src.rev ?? raw.rev ?? src.at ?? raw.at, 80) ?? (path ? undefined : prev?.rev);
    if (rev) out.rev = rev;
    return out;
  }
  if (kind === 'compare') {
    if (!base || !head) return previous?.kind === 'compare' ? { ...previous, ...(path ? { path } : {}) } : null;
    return { kind, base, head, ...(path ? { path } : {}) };
  }
  if (!oid) return previous?.kind === 'commit' ? { ...previous, ...(path ? { path } : {}) } : null;
  return { kind: 'commit', oid, ...(path ? { path } : {}) };
}

export const codeKey = (c: CodeRef): string =>
  [c.kind, c.path ?? '', c.start ?? '', c.end ?? '', c.rev ?? '', c.base ?? '', c.head ?? '', c.oid ?? ''].join('|');

/** Short label such as "src/App.tsx:1-10" or "main…feature" or "commit 1a2b3c4". */
export function describeCode(c: CodeRef): string {
  if (c.kind === 'file') return `${c.path}${c.start ? `:${c.start}${c.end && c.end !== c.start ? `-${c.end}` : ''}` : ''}${c.rev ? ` @ ${c.rev.slice(0, 8)}` : ''}`;
  if (c.kind === 'compare') return `${c.base}…${c.head}${c.path ? ` · ${c.path}` : ''}`;
  return `commit ${(c.oid ?? '').slice(0, 8)}${c.path ? ` · ${c.path}` : ''}`;
}

const splitLines = (text: string): string[] => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return text === '' ? [] : lines;
};

const MAX_LINES = 400;

/** Lines `start`..`end` of a file text, numbered with their real line numbers. */
export function fileSnapshot(title: string, text: string, start?: number, end?: number, subtitle?: string): CodeSnapshot {
  const all = splitLines(text);
  const first = Math.min(Math.max(1, start ?? 1), Math.max(1, all.length));
  const last = Math.min(all.length, end ?? Math.min(all.length, first + MAX_LINES - 1), first + MAX_LINES - 1);
  const lines: SnapLine[] = [];
  for (let n = first; n <= last; n += 1) lines.push({ k: 'ctx', n: String(n), t: all[n - 1] });
  const note = all.length === 0 ? 'empty file' : start && start > all.length ? `file has only ${all.length} lines` : `${all.length} lines`;
  return { title, subtitle: subtitle ?? `${start || end ? `lines ${first}-${last} of ` : ''}${note}`.replace(/^(\d+ lines)$/, '$1'), lines };
}

interface Op { k: 'ctx' | 'add' | 'del'; a?: number; b?: number; t: string }

/** Line diff (LCS after trimming the common head and tail). Returns an edit script. */
export function diffOps(before: string, after: string): Op[] | null {
  const a = splitLines(before), b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail);
  if (am.length * bm.length > 9_000_000) return null;
  const ops: Op[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ k: 'ctx', a: i + 1, b: i + 1, t: a[i] });
  const w = bm.length + 1;
  const table = new Uint32Array((am.length + 1) * w);
  for (let i = am.length - 1; i >= 0; i -= 1) for (let j = bm.length - 1; j >= 0; j -= 1) {
    table[i * w + j] = am[i] === bm[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
  }
  let i = 0, j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) { ops.push({ k: 'ctx', a: head + i + 1, b: head + j + 1, t: am[i] }); i += 1; j += 1; }
    else if (j < bm.length && (i === am.length || table[i * w + j + 1] >= table[(i + 1) * w + j])) { ops.push({ k: 'add', b: head + j + 1, t: bm[j] }); j += 1; }
    else { ops.push({ k: 'del', a: head + i + 1, t: am[i] }); i += 1; }
  }
  for (let t = 0; t < tail; t += 1) ops.push({ k: 'ctx', a: a.length - tail + t + 1, b: b.length - tail + t + 1, t: a[a.length - tail + t] });
  return ops;
}

/** A unified diff with `context` unchanged lines around each change. */
export function diffSnapshot(title: string, before: string, after: string, subtitle?: string, context = 3): CodeSnapshot {
  const ops = diffOps(before, after);
  if (!ops) return { title, subtitle, lines: [{ k: 'meta', t: 'The change is too large to show line by line.' }] };
  const adds = ops.filter((o) => o.k === 'add').length, dels = ops.filter((o) => o.k === 'del').length;
  const stat = `+${adds} −${dels}`;
  if (adds + dels === 0) return { title, subtitle: subtitle ? `${subtitle} · no changes` : 'no changes', lines: [{ k: 'meta', t: 'No differences.' }] };
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => { if (o.k !== 'ctx') for (let d = -context; d <= context; d += 1) if (idx + d >= 0 && idx + d < ops.length) keep[idx + d] = true; });
  const lines: SnapLine[] = [];
  let idx = 0;
  while (idx < ops.length && lines.length < MAX_LINES) {
    if (!keep[idx]) { idx += 1; continue; }
    let end = idx;
    while (end < ops.length && keep[end]) end += 1;
    const slice = ops.slice(idx, end);
    const firstA = slice.find((o) => o.a !== undefined)?.a ?? 0, firstB = slice.find((o) => o.b !== undefined)?.b ?? 0;
    lines.push({ k: 'hunk', t: `@@ −${firstA} +${firstB} @@` });
    for (const o of slice) lines.push({ k: o.k, n: String(o.k === 'add' ? o.b : o.a), t: o.t });
    idx = end;
  }
  if (idx < ops.length) lines.push({ k: 'meta', t: '… more changes not shown' });
  return { title, subtitle: subtitle ? `${subtitle} · ${stat}` : stat, lines: lines.slice(0, MAX_LINES + 1) };
}

export interface FileChange { path: string; status: string; additions: number; deletions: number }

/** The list of files a commit or compare touches. */
export function changesSnapshot(title: string, subtitle: string, head: string[], files: FileChange[]): CodeSnapshot {
  const lines: SnapLine[] = head.map((t) => ({ k: 'meta' as const, t }));
  if (head.length) lines.push({ k: 'meta', t: '' });
  for (const f of files.slice(0, MAX_LINES)) lines.push({ k: 'file', n: f.status, p: f.path, t: `${f.path}  +${f.additions} −${f.deletions}` });
  if (files.length > MAX_LINES) lines.push({ k: 'meta', t: `… and ${files.length - MAX_LINES} more files` });
  if (files.length === 0) lines.push({ k: 'meta', t: 'No file changes.' });
  return { title, subtitle, lines, files };
}

/** Size of a card that shows the snapshot without scrolling (within sensible limits). */
export function fitCodeSize(snap: CodeSnapshot | null | undefined): { w: number; h: number } {
  if (snap?.commit) return { w: 600, h: Math.min(680, commitLayout(snap, 600).height + 42) };
  const rows = Math.min(Math.max(snap?.lines.length ?? 8, 4), 30);
  const longest = Math.max(30, ...(snap?.lines ?? []).slice(0, 60).map((l) => l.t.length + 6));
  return { w: Math.round(Math.min(780, Math.max(420, longest * CODE_CHAR + 40))), h: rows * CODE_ROW + 62 };
}

/* ---------- drawing: palettes, header tabs and the commit card ---------- */

export type CodeTheme = 'light' | 'dark';

/** Row height and character width of the monospace code lines. */
export const CODE_ROW = 18;
export const CODE_CHAR = 7.2;

export interface CodePalette {
  card: string; cardStroke: string; headInk: string; headMuted: string; accent: string;
  codeBg: string; codeInk: Record<SnapKind, string>; codeAdd: string; codeDel: string; codeHunk: string; gutter: string;
  panel: string; panelStroke: string; title: string; text: string; muted: string; sep: string; rowA: string; rowB: string;
  sha: string; chipBg: string; add: string; del: string; mod: string; icon: string;
  badges: Record<CodeKind, [string, string]>;
  tones: Array<[string, string]>;
}

const LIGHT: CodePalette = {
  card: '#ffffff', cardStroke: '#c9ceda', headInk: '#1f2430', headMuted: '#6b7385', accent: '#4338ca',
  codeBg: '#0f172a', codeInk: { ctx: '#e2e8f0', add: '#bbf7d0', del: '#fecaca', hunk: '#a5b4fc', meta: '#94a3b8', file: '#fde68a' }, codeAdd: '#14532d', codeDel: '#7f1d1d', codeHunk: '#1e1b4b', gutter: '#64748b',
  panel: '#ffffff', panelStroke: '#e5e7eb', title: '#111827', text: '#4b5563', muted: '#9ca3af', sep: '#e5e7eb', rowA: '#f8fafc', rowB: '#ffffff',
  sha: '#4338ca', chipBg: '#eef2ff', add: '#15803d', del: '#b91c1c', mod: '#b45309', icon: '#64748b',
  badges: { file: ['#e0e7ff', '#4338ca'], compare: ['#fef3c7', '#b45309'], commit: ['#dcfce7', '#15803d'] },
  tones: [['#dbeafe', '#1d4ed8'], ['#fce7f3', '#be185d'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#ede9fe', '#6d28d9'], ['#ccfbf1', '#0f766e']],
};

const DARK: CodePalette = {
  card: '#1c2230', cardStroke: '#2e3647', headInk: '#e6e9f0', headMuted: '#8b94a7', accent: '#a5b4fc',
  codeBg: '#0b0f1a', codeInk: { ctx: '#e2e8f0', add: '#bbf7d0', del: '#fecaca', hunk: '#a5b4fc', meta: '#94a3b8', file: '#fde68a' }, codeAdd: '#14532d', codeDel: '#7f1d1d', codeHunk: '#1e1b4b', gutter: '#64748b',
  panel: '#161b27', panelStroke: '#2a3243', title: '#f3f4f6', text: '#b4bccb', muted: '#7b8498', sep: '#2a3243', rowA: '#1a2030', rowB: '#161b27',
  sha: '#a5b4fc', chipBg: '#272f4d', add: '#4ade80', del: '#f87171', mod: '#fbbf24', icon: '#94a3b8',
  badges: { file: ['#312e81', '#c7d2fe'], compare: ['#78350f', '#fde68a'], commit: ['#14532d', '#bbf7d0'] },
  tones: [['#1e3a8a', '#bfdbfe'], ['#831843', '#fbcfe8'], ['#14532d', '#bbf7d0'], ['#78350f', '#fde68a'], ['#4c1d95', '#ddd6fe'], ['#134e4a', '#99f6e4']],
};

export const codePalette = (theme: CodeTheme | undefined): CodePalette => (theme === 'dark' ? DARK : LIGHT);

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { if (out.length) out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && (line + ' ' + word).length > maxChars) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
      while (line.length > maxChars) { out.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
    }
    if (line) out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.{0,2}$/, '…'); }
  return out;
}

/* Header tabs of commit and compare cards: Overview | Changes N, and "‹ 2/4 ›" to step through the files in the diff view. */

export type CodeHeaderAction = { type: 'tab'; id: 'overview' | 'changes' } | { type: 'step'; dir: -1 | 1 };

interface Rect { x: number; y: number; w: number; h: number }

export interface CodeHeader {
  tabs: Array<Rect & { id: 'overview' | 'changes'; label: string; active: boolean }>;
  steps?: { prev: Rect; next: Rect; label: string; labelX: number; canPrev: boolean; canNext: boolean };
}

export const badgeWidth = (kind: CodeKind): number => (kind === 'compare' ? 'COMPARE' : kind === 'commit' ? 'COMMIT' : 'FILE').length * 6.4 + 12;

/** Header geometry (card-local coordinates), or null for cards without tabs. */
export function codeHeader(code: CodeRef, snap: CodeSnapshot | undefined, w: number): CodeHeader | null {
  if (code.kind === 'file' || !snap || snap.error) return null;
  const total = snap.files?.length ?? snap.nav?.total ?? 0;
  if (!snap.files && !snap.nav) return null;
  const changesActive = !!code.path;
  const x0 = 8 + badgeWidth(code.kind) + 14;
  const overview = 'Overview', changes = `Changes ${total}`;
  const ow = overview.length * 7 + 18, cw = changes.length * 7 + 18;
  const tabs: CodeHeader['tabs'] = [
    { id: 'overview', label: overview, x: x0, y: 3, w: ow, h: 28, active: !changesActive },
    { id: 'changes', label: changes, x: x0 + ow + 4, y: 3, w: cw, h: 28, active: changesActive },
  ];
  const header: CodeHeader = { tabs };
  if (changesActive && snap.nav) {
    const label = `${snap.nav.index + 1}/${snap.nav.total}`;
    const lw = label.length * 7 + 8;
    const right = w - 12;
    header.steps = {
      next: { x: right - 22, y: 6, w: 22, h: 22 }, prev: { x: right - 22 - lw - 22, y: 6, w: 22, h: 22 },
      label, labelX: right - 22 - lw / 2, canPrev: !!snap.nav.prev, canNext: !!snap.nav.next,
    };
  }
  return header;
}

/** What a click at card-local (x, y) does, if it lands on a header tab or step arrow. */
export function codeHeaderHit(code: CodeRef, snap: CodeSnapshot | undefined, w: number, x: number, y: number): CodeHeaderAction | null {
  const h = codeHeader(code, snap, w);
  if (!h) return null;
  const inside = (r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  for (const t of h.tabs) if (inside(t)) return { type: 'tab', id: t.id };
  if (h.steps) {
    if (inside(h.steps.prev) && h.steps.canPrev) return { type: 'step', dir: -1 };
    if (inside(h.steps.next) && h.steps.canNext) return { type: 'step', dir: 1 };
  }
  return null;
}

/** SVG of the header tabs (drawn in the card's header row). */
export function codeHeaderSvg(code: CodeRef, snap: CodeSnapshot | undefined, w: number, font: string, theme: CodeTheme | undefined): string {
  const h = codeHeader(code, snap, w);
  if (!h) return '';
  const p = codePalette(theme);
  let out = '';
  for (const t of h.tabs) {
    out += `<text x="${t.x + t.w / 2}" y="21" text-anchor="middle" font-family="${esc(font)}" font-size="12.5" font-weight="${t.active ? 700 : 500}" style="fill:${t.active ? p.headInk : p.headMuted};stroke:none">${esc(t.label)}</text>`;
    if (t.active) out += `<rect x="${t.x + 6}" y="29" width="${t.w - 12}" height="2.5" rx="1.25" style="fill:${p.accent};stroke:none"/>`;
  }
  if (h.steps) {
    const s = h.steps;
    const arrow = (r: Rect, glyph: string, on: boolean) => `<text x="${r.x + r.w / 2}" y="22" text-anchor="middle" font-family="${esc(font)}" font-size="16" font-weight="700" style="fill:${on ? p.headInk : p.muted};stroke:none;opacity:${on ? 1 : 0.4}">${glyph}</text>`;
    out += arrow(s.prev, '‹', s.canPrev) + arrow(s.next, '›', s.canNext);
    out += `<text x="${s.labelX}" y="21" text-anchor="middle" font-family="${esc(font)}" font-size="11.5" style="fill:${p.headMuted};stroke:none">${esc(s.label)}</text>`;
  }
  return out;
}

/* The commit card: same content as the Commit graph's Overview. */

export interface CommitLayout {
  titleLines: string[];
  messageLines: string[];
  identityY: number;
  titleY: number;
  messageY: number;
  authorY: number;
  sepY: number;
  filesHeadY: number;
  rowsTop: number;
  rowH: number;
  height: number;
}

const ROW_H = 24;

/** Vertical layout of the commit card's body (y is relative to the body's top edge). */
export function commitLayout(snap: CodeSnapshot, w: number): CommitLayout {
  const c = snap.commit!;
  const titleLines = wrap(c.summary, Math.max(12, Math.floor((w - 28) / 8.6)), 3);
  const messageLines = c.body.trim() ? wrap(c.body, Math.floor((w - 28) / 7), 5) : [];
  const identityY = 8;
  const titleY = identityY + 32;
  const messageY = titleY + titleLines.length * 22 + 4;
  const authorY = messageY + (messageLines.length ? messageLines.length * 18 + 10 : 2);
  const sepY = authorY + 38;
  const filesHeadY = sepY + 8;
  const rowsTop = filesHeadY + 30;
  const files = snap.files?.length ?? 0;
  return { titleLines, messageLines, identityY, titleY, messageY, authorY, sepY, filesHeadY, rowsTop, rowH: ROW_H, height: rowsTop + Math.max(1, files) * ROW_H + 10 };
}

/** The changed file under a point of the commit card body (y relative to the body top), if any. */
export function commitFileAt(snap: CodeSnapshot, w: number, y: number): string | undefined {
  if (!snap.commit || !snap.files) return undefined;
  const l = commitLayout(snap, w);
  const index = Math.floor((y - l.rowsTop) / l.rowH);
  return index >= 0 ? snap.files[index]?.path : undefined;
}

const STATUS: Record<string, 'add' | 'del' | 'mod'> = { A: 'add', D: 'del', M: 'mod', R: 'mod' };

/** SVG of the commit card body: identity, title, message, author, and the changed files. */
export function commitBodySvg(snap: CodeSnapshot, w: number, h: number, font: string, mono: string, theme?: CodeTheme): string {
  const p = codePalette(theme);
  const c = snap.commit!;
  const l = commitLayout(snap, w);
  const files = snap.files ?? [];
  const adds = files.reduce((n, f) => n + f.additions, 0), dels = files.reduce((n, f) => n + f.deletions, 0);
  const t = (x: number, y: number, size: number, fill: string, text: string, extra = '') => `<text x="${x}" y="${y}" font-family="${esc(font)}" font-size="${size}" ${extra} style="fill:${fill};stroke:none">${esc(text)}</text>`;
  const m = (x: number, y: number, size: number, fill: string, text: string, extra = '') => `<text x="${x}" y="${y}" font-family="${esc(mono)}" font-size="${size}" ${extra} xml:space="preserve" style="fill:${fill};stroke:none">${esc(text)}</text>`;
  let out = '';
  const iy = l.identityY + 14;
  out += `<circle cx="22" cy="${iy}" r="6.5" style="fill:none;stroke:${p.icon};stroke-width:1.7"/><line x1="22" y1="${iy - 13}" x2="22" y2="${iy - 6.5}" style="stroke:${p.icon};stroke-width:1.7"/><line x1="22" y1="${iy + 6.5}" x2="22" y2="${iy + 13}" style="stroke:${p.icon};stroke-width:1.7"/>`;
  out += m(38, iy + 4.5, 13, p.sha, c.shortOid, 'font-weight="700"');
  const shaW = c.shortOid.length * 7.8;
  const kind = c.isMerge ? 'Merge commit' : 'Commit';
  out += `<rect x="${38 + shaW + 10}" y="${iy - 10}" width="${kind.length * 6.9 + 16}" height="20" rx="10" style="fill:${p.chipBg};stroke:none"/>`;
  out += t(38 + shaW + 18, iy + 4, 11.5, p.sha, kind, 'font-weight="600"');
  if (c.signed) {
    const x = 38 + shaW + 10 + kind.length * 6.9 + 28;
    out += t(x, iy + 4, 11.5, c.signed === 'good' ? p.add : p.del, c.signed === 'good' ? '✓ Signed' : 'Invalid signature', 'font-weight="600"');
  }
  l.titleLines.forEach((line, i) => { out += t(14, l.titleY + 15 + i * 22, 16.5, p.title, line, 'font-weight="700"'); });
  l.messageLines.forEach((line, i) => { out += t(14, l.messageY + 13 + i * 18, 13, p.text, line, 'xml:space="preserve"'); });
  const tone = p.tones[[...c.authorInitials].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 0) % p.tones.length];
  const ay = l.authorY + 18;
  out += `<circle cx="26" cy="${ay}" r="12" style="fill:${tone[0]};stroke:none"/>` + t(26, ay + 4, 10.5, tone[1], c.authorInitials.slice(0, 2), 'text-anchor="middle" font-weight="700"');
  out += t(46, ay + 4.5, 13.5, p.title, c.authorName, 'font-weight="700"');
  out += t(46 + c.authorName.length * 7.8 + 10, ay + 4.5, 12.5, p.muted, c.when);
  out += `<line x1="0" y1="${l.sepY}" x2="${w - 16}" y2="${l.sepY}" style="stroke:${p.sep};stroke-width:1"/>`;
  const hy = l.filesHeadY + 19;
  const head = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
  out += t(14, hy, 13, p.title, head, 'font-weight="700"');
  let hx = 14 + head.length * 7.4 + 10;
  out += t(hx, hy, 13, p.add, `+${adds}`, 'font-weight="600"');
  hx += String(adds).length * 7.4 + 18;
  out += t(hx, hy, 13, p.del, `−${dels}`, 'font-weight="600"');
  out += t(w - 30, hy, 11.5, p.muted, 'Compared to first parent', 'text-anchor="end"');
  const maxRows = Math.max(1, Math.floor((h - 42 - l.rowsTop - 6) / l.rowH));
  const maxPath = Math.max(8, Math.floor((w - 28 - 100) / 7.2));
  files.slice(0, maxRows).forEach((f, i) => {
    const y = l.rowsTop + i * l.rowH;
    const col = p[STATUS[f.status] ?? 'mod'];
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '', name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    const shownDir = dir.length + name.length > maxPath ? '…' + dir.slice(Math.max(0, dir.length - Math.max(0, maxPath - name.length - 1))) : dir;
    out += `<rect x="6" y="${y}" width="${w - 28}" height="${l.rowH - 2}" rx="5" style="fill:${i % 2 ? p.rowB : p.rowA};stroke:none"/>`;
    out += m(14, y + 15, 12, col, f.status, 'font-weight="700"');
    out += m(32, y + 15, 12, p.muted, shownDir) + m(32 + shownDir.length * CODE_CHAR, y + 15, 12, p.title, name, 'font-weight="600"');
    out += m(w - 30, y + 15, 11.5, p.del, `−${f.deletions}`, 'text-anchor="end"') + m(w - 30 - (String(f.deletions).length + 2) * 6.9 - 6, y + 15, 11.5, p.add, `+${f.additions}`, 'text-anchor="end"');
  });
  if (files.length > maxRows) out += t(w - 30, l.rowsTop + maxRows * l.rowH + 13, 11, p.muted, `+${files.length - maxRows} more files`, 'text-anchor="end"');
  return out;
}
