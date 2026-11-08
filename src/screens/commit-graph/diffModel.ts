/**
 * Minimal unified-diff model — computes hunks from two strings so the
 * Changes tab can render the design's custom diff view (hunk header bars,
 * dual line numbers, colored +/- rows) instead of a stock diff editor.
 */

export type DiffRowType = 'context' | 'add' | 'del';

export interface DiffRow {
  type: DiffRowType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  /** "@@ -12,13 +12,18 @@" */
  header: string;
  /** Nearest enclosing declaration, shown next to the header (e.g. "Keyboard shortcuts"). */
  section: string;
  rows: DiffRow[];
}

const CONTEXT = 3;
const MAX_LINES = 2500;

/** Longest-common-subsequence edit script; falls back to whole-file replace. */
function lcsRows(a: string[], b: string[]): DiffRow[] {
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text, i) => ({ type: 'del' as const, oldLine: i + 1, text })),
      ...b.map((text, i) => ({ type: 'add' as const, newLine: i + 1, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', oldLine: i + 1, text: a[i] });
      i += 1;
    } else {
      rows.push({ type: 'add', newLine: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', oldLine: i + 1, text: a[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ type: 'add', newLine: j + 1, text: b[j] });
    j += 1;
  }
  return rows;
}

function hunkHeader(rows: DiffRow[]): string {
  const oldLines = rows.filter((row) => row.type !== 'add');
  const newLines = rows.filter((row) => row.type !== 'del');
  const oldStart = oldLines[0]?.oldLine ?? 0;
  const newStart = newLines[0]?.newLine ?? 0;
  const oldText = oldStart === 0 ? `-0,0` : `-${oldStart},${oldLines.length}`;
  const newText = newStart === 0 ? `+0,0` : `+${newStart},${newLines.length}`;
  return `@@ ${oldText} ${newText} @@`;
}

function sectionTitle(rows: DiffRow[], original: string[]): string {
  const firstOld = rows.find((row) => row.oldLine !== undefined)?.oldLine;
  if (firstOld === undefined) return '';
  for (let line = Math.min(firstOld, original.length) - 1; line >= 0; line -= 1) {
    const match = original[line].match(
      /(?:function|class|interface|struct|impl|def|fn)\s+([A-Za-z0-9_$]+)/,
    );
    if (match) {
      return match[1]
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^./, (char) => char.toUpperCase())
        .toLowerCase();
    }
    if (line < firstOld - 40) break;
  }
  return '';
}

export function buildHunks(originalText: string, modifiedText: string): DiffHunk[] {
  const original = originalText.split('\n');
  const modified = modifiedText.split('\n');
  if (original.length > MAX_LINES || modified.length > MAX_LINES) return [];
  const rows = lcsRows(original, modified);

  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type === 'context') {
      index += 1;
      continue;
    }
    // A change block starts here — include trailing context.
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    while (end < rows.length) {
      if (rows[end].type !== 'context') {
        end += 1;
        continue;
      }
      // Stop after `CONTEXT` unchanged lines unless another change follows soon.
      let run = end;
      while (run < rows.length && rows[run].type === 'context') run += 1;
      if (run - end >= CONTEXT && (run >= rows.length || run - end > CONTEXT * 2)) break;
      end = run > end + CONTEXT ? end + CONTEXT : run;
    }
    const hunkRows = rows.slice(start, end);
    hunks.push({
      header: hunkHeader(hunkRows),
      section: sectionTitle(hunkRows, original),
      rows: hunkRows,
    });
    index = end;
  }
  return hunks;
}

export function diffTotals(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.type === 'add') added += 1;
      if (row.type === 'del') removed += 1;
    }
  }
  return { added, removed };
}
