/** Loads the code a board's `code` items show: lines of a file, a compare of two
 * refs or a commit. The board file only stores the reference; the text is read
 * from the repository so the card always shows the current state. */
import { relativeTime } from './relativeTime';
import { verifyCommitSig } from './tauriClient';
import { changesSnapshot, codeKey, diffSnapshot, fileSnapshot, fitCodeSize, type CodeRef, type CodeSnapshot } from './codeSnap';
import { compareBranches, getCommitDetail, getCommitFileDiff, readFileAtCommit, readWorktreeFile } from './tauriClient';
import type { Board, BoardItem } from './board';

const cache = new Map<string, CodeSnapshot>();

const fail = (title: string, error: string): CodeSnapshot => ({ title, lines: [], error });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readAt(path: string, rev: string): Promise<string> {
  try {
    const file = await readFileAtCommit(path, rev);
    return file.binary || file.tooLarge ? '' : file.content;
  } catch { return ''; } // the file does not exist on that side
}

/** Marks a diff as one of the changed files of its commit/compare, and names the file on its first line. */
function withNav(snap: CodeSnapshot, path: string, all: string[]): CodeSnapshot {
  const index = all.indexOf(path);
  return {
    ...snap,
    lines: [{ k: 'meta', t: `${path}${snap.subtitle ? `   ${snap.subtitle.split(' · ').pop()}` : ''}` }, ...snap.lines],
    nav: { index: Math.max(0, index), total: Math.max(1, all.length), prev: index > 0 ? all[index - 1] : undefined, next: index >= 0 && index < all.length - 1 ? all[index + 1] : undefined },
  };
}

/** Reads one reference. Never throws: failures come back as a snapshot with `error`. */
export async function loadCode(code: CodeRef): Promise<CodeSnapshot> {
  const label = code.path ?? code.oid ?? `${code.base}…${code.head}`;
  try {
    if (code.kind === 'file') {
      if (!code.path) return fail('file', 'no path');
      const file = code.rev ? await readFileAtCommit(code.path, code.rev) : await readWorktreeFile(code.path);
      if (file.binary) return fail(code.path, 'binary file');
      if (file.tooLarge) return fail(code.path, 'file is too large');
      return fileSnapshot(code.path, file.content, code.start, code.end, code.rev ? `at ${code.rev.slice(0, 8)}` : undefined);
    }
    if (code.kind === 'compare') {
      if (!code.base || !code.head) return fail('compare', 'needs a base and a head');
      const cmp = await compareBranches(code.base, code.head);
      const title = `${code.base} … ${code.head}`;
      if (code.path) {
        const [before, after] = await Promise.all([readAt(code.path, cmp.baseOid), readAt(code.path, cmp.compareOid)]);
        return withNav(diffSnapshot(`${code.path}`, before, after, title), code.path, cmp.files.map((f) => f.path));
      }
      const adds = cmp.files.reduce((n, f) => n + f.additions, 0), dels = cmp.files.reduce((n, f) => n + f.deletions, 0);
      return changesSnapshot(title, `${cmp.compareOnly} ahead · ${cmp.baseOnly} behind · ${cmp.files.length} files · +${adds} −${dels}`, [`${code.head} is ${cmp.compareOnly} commit${cmp.compareOnly === 1 ? '' : 's'} ahead of and ${cmp.baseOnly} behind ${code.base}`, 'Double-click a file to see its diff'], cmp.files);
    }
    if (!code.oid) return fail('commit', 'no commit');
    const detail = await getCommitDetail(code.oid);
    const title = `${detail.shortOid} ${detail.summary}`;
    if (code.path) {
      const entry = detail.files.find((f) => f.path === code.path);
      const diff = await getCommitFileDiff(detail.oid, code.path, entry?.previousPath);
      if (diff.binary) return fail(title, 'binary file');
      return withNav(diffSnapshot(code.path, diff.original ?? '', diff.modified ?? '', `${detail.shortOid} · ${detail.authorName}`), code.path, detail.files.map((f) => f.path));
    }
    const lines = detail.message.trim().split('\n').map((l) => l.trimEnd());
    if (lines[0]?.trim() === detail.summary.trim()) lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    let signed: 'good' | 'bad' | undefined;
    try { const sig = await verifyCommitSig(detail.oid); if (sig === 'good' || sig === 'bad') signed = sig; } catch { /* unsigned or unavailable */ }
    const adds = detail.files.reduce((n, f) => n + f.additions, 0), dels = detail.files.reduce((n, f) => n + f.deletions, 0);
    const snap = changesSnapshot(title, `${detail.files.length} files · +${adds} −${dels}`, [detail.summary], detail.files);
    snap.commit = {
      oid: detail.oid, shortOid: detail.shortOid, summary: detail.summary, body: lines.join('\n'), authorName: detail.authorName,
      authorInitials: detail.authorInitials, when: relativeTime(detail.timeSeconds), isMerge: detail.isMerge, signed, parents: detail.parents,
    };
    return snap;
  } catch (error) {
    return fail(label, message(error));
  }
}

/** Snapshots for every code item of the board, keyed by codeKey(). */
export async function collectCodes(board: Board, opts?: { refresh?: boolean }): Promise<Record<string, CodeSnapshot>> {
  const out: Record<string, CodeSnapshot> = {};
  await Promise.all(board.items.filter((i) => i.type === 'code' && i.code).map(async (item) => {
    const key = codeKey(item.code!);
    if (!opts?.refresh && cache.has(key)) { out[key] = cache.get(key)!; return; }
    const snap = await loadCode(item.code!);
    if (!snap.error) cache.set(key, snap);
    out[key] = snap;
  }));
  return out;
}

export function invalidateCodes(): void { cache.clear(); }

/** Reports sources that could not be read and sizes brand-new code cards to their content. Mutates `board`. */
export async function checkCodes(board: Board, fit: (item: BoardItem) => boolean): Promise<string[]> {
  const problems: string[] = [];
  const snaps = await collectCodes(board, { refresh: true });
  for (const item of board.items) {
    if (item.type !== 'code' || !item.code) continue;
    const snap = snaps[codeKey(item.code)];
    if (!snap || snap.error) { problems.push(`${item.id}: ${snap?.error ?? 'could not be read'}`); continue; }
    if (fit(item)) { const size = fitCodeSize(snap); item.w = size.w; item.h = size.h; }
  }
  return problems;
}
