/** Git conflict markers as data: parse a conflicted file into plain text and conflict blocks, describe each block in
 * plain words, and rebuild the file from the choices made for each block. Pure — the Merge conflicts menu, the agent
 * tools and the node tests share it.
 *
 *   <<<<<<< HEAD            ← start, followed by the CURRENT side (what your branch has)
 *   ||||||| base            ← optional (diff3 / zdiff3 style), followed by the COMMON ANCESTOR
 *   =======                 ← separator, followed by the INCOMING side
 *   >>>>>>> feature         ← end */

export interface ConflictBlock {
  /** 0-based position among the file's conflicts. */
  index: number;
  /** 1-based line numbers of the <<<<<<< and >>>>>>> markers in the conflicted file. */
  startLine: number;
  endLine: number;
  /** Text after the markers, e.g. "HEAD" and "feature/login". */
  currentLabel: string;
  incomingLabel: string;
  baseLabel: string | null;
  current: string[];
  /** Only when the file was written with merge.conflictStyle = diff3 or zdiff3. */
  base: string[] | null;
  incoming: string[];
}

export type Segment = { kind: 'text'; lines: string[] } | { kind: 'conflict'; block: ConflictBlock };

export interface ParsedConflicts {
  segments: Segment[];
  blocks: ConflictBlock[];
  eol: '\n' | '\r\n';
  /** A block that never closed — its lines are kept as text and cannot be resolved block by block. */
  malformed: string | null;
}

export type Choice =
  | { kind: 'current' }
  | { kind: 'incoming' }
  | { kind: 'both'; order: 'current-first' | 'incoming-first' }
  | { kind: 'base' }
  | { kind: 'custom'; text: string };

const START = /^<{7}(?:[ \t](.*))?$/;
const BASE = /^\|{7}(?:[ \t](.*))?$/;
const SEP = /^={7}[ \t]*$/;
const END = /^>{7}(?:[ \t](.*))?$/;

export const hasConflictMarkers = (text: string): boolean => text.split(/\r?\n/).some((l) => START.test(l)) && text.split(/\r?\n/).some((l) => END.test(l));

export function parseConflicts(text: string): ParsedConflicts {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  const blocks: ConflictBlock[] = [];
  let plain: string[] = [];
  let malformed: string | null = null;
  const flush = (): void => { if (plain.length) { segments.push({ kind: 'text', lines: plain }); plain = []; } };

  let i = 0;
  while (i < lines.length) {
    const start = START.exec(lines[i]);
    if (!start) {
      plain.push(lines[i]);
      i++;
      continue;
    }
    // collect one block
    const block: ConflictBlock = { index: blocks.length, startLine: i + 1, endLine: 0, currentLabel: (start[1] ?? '').trim(), incomingLabel: '', baseLabel: null, current: [], base: null, incoming: [] };
    let part: 'current' | 'base' | 'incoming' = 'current';
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (START.test(line)) break; // a new block before this one closed: malformed
      const baseMatch = part === 'current' ? BASE.exec(line) : null;
      if (baseMatch) { part = 'base'; block.base = []; block.baseLabel = (baseMatch[1] ?? '').trim(); continue; }
      if (part !== 'incoming' && SEP.test(line)) { part = 'incoming'; continue; }
      const end = part === 'incoming' ? END.exec(line) : null;
      if (end) { block.incomingLabel = (end[1] ?? '').trim(); block.endLine = j + 1; closed = true; break; }
      if (part === 'current') block.current.push(line);
      else if (part === 'base') block.base!.push(line);
      else block.incoming.push(line);
    }
    if (!closed) {
      malformed = `the conflict that starts on line ${i + 1} has no ${part === 'incoming' ? '>>>>>>> end marker' : '======= separator'}`;
      plain.push(...lines.slice(i, j));
      i = j;
      continue;
    }
    flush();
    blocks.push(block);
    segments.push({ kind: 'conflict', block });
    i = j + 1;
  }
  flush();
  return { segments, blocks, eol, malformed };
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

/** The lines a choice puts in place of a block. */
export function choiceLines(block: ConflictBlock, choice: Choice): string[] {
  switch (choice.kind) {
    case 'current': return block.current;
    case 'incoming': return block.incoming;
    case 'base': return block.base ?? [];
    case 'both': return choice.order === 'current-first' ? [...block.current, ...block.incoming] : [...block.incoming, ...block.current];
    case 'custom': return choice.text.split(/\r?\n/);
  }
}

/** The original marker lines of a block (kept for blocks that have no choice yet). */
export function markerLines(block: ConflictBlock): string[] {
  const out = [`<<<<<<<${block.currentLabel ? ' ' + block.currentLabel : ''}`, ...block.current];
  if (block.base) out.push(`|||||||${block.baseLabel ? ' ' + block.baseLabel : ''}`, ...block.base);
  out.push('=======', ...block.incoming, `>>>>>>>${block.incomingLabel ? ' ' + block.incomingLabel : ''}`);
  return out;
}

/** Rebuilds the file: chosen blocks become their result, the others keep their markers. Line endings are kept. */
export function resolveText(parsed: ParsedConflicts, choices: Record<number, Choice | undefined>): string {
  const out: string[] = [];
  for (const seg of parsed.segments) {
    if (seg.kind === 'text') out.push(...seg.lines);
    else {
      const choice = choices[seg.block.index];
      out.push(...(choice ? choiceLines(seg.block, choice) : markerLines(seg.block)));
    }
  }
  return out.join(parsed.eol);
}

/** A safe automatic choice: both sides made the same change, or only one side changed (needs the ancestor). */
export function autoChoice(block: ConflictBlock): { choice: Choice; reason: string } | null {
  if (same(block.current, block.incoming)) return { choice: { kind: 'current' }, reason: 'Both sides made the same change.' };
  const trimmed = (a: string[]): string[] => a.map((l) => l.trim()).filter(Boolean);
  if (same(trimmed(block.current), trimmed(block.incoming))) return { choice: { kind: 'incoming' }, reason: 'The sides differ only in whitespace or blank lines.' };
  if (block.base) {
    if (same(block.base, block.current)) return { choice: { kind: 'incoming' }, reason: 'Only the incoming side changed these lines.' };
    if (same(block.base, block.incoming)) return { choice: { kind: 'current' }, reason: 'Only your side changed these lines.' };
  }
  return null;
}

/** A plain-words summary of what each side did, for the card header and the agent. */
export function describeBlock(block: ConflictBlock): string {
  const n = (a: string[]): string => `${a.length} line${a.length === 1 ? '' : 's'}`;
  if (block.current.length === 0) return `Your side removed these lines; the incoming side has ${n(block.incoming)}.`;
  if (block.incoming.length === 0) return `The incoming side removed these lines; your side has ${n(block.current)}.`;
  if (block.base && block.base.length === 0) return `Both sides added different lines here (${n(block.current)} vs ${n(block.incoming)}).`;
  return `Both sides changed the same place: ${n(block.current)} on your side, ${n(block.incoming)} incoming.`;
}

/** Lines of plain text just before and after a block, for context in the card. */
export function blockContext(parsed: ParsedConflicts, index: number, count = 3): { before: string[]; after: string[] } {
  const at = parsed.segments.findIndex((s) => s.kind === 'conflict' && s.block.index === index);
  const prev = parsed.segments[at - 1], next = parsed.segments[at + 1];
  return {
    before: prev && prev.kind === 'text' ? prev.lines.slice(-count) : [],
    after: next && next.kind === 'text' ? next.lines.slice(0, count) : [],
  };
}

export const CHOICE_LABELS: Record<string, string> = {
  current: 'Current', incoming: 'Incoming', 'both:current-first': 'Both (current first)', 'both:incoming-first': 'Both (incoming first)', base: 'Ancestor', custom: 'Edited',
};
export const choiceLabel = (c: Choice): string => CHOICE_LABELS[c.kind === 'both' ? `both:${c.order}` : c.kind];

/** Parses an agent's or a UI's choice name: current | incoming | both | both-incoming-first | base | custom. */
export function choiceFromName(name: string, text?: string): Choice | null {
  switch (name) {
    case 'current': case 'ours': return { kind: 'current' };
    case 'incoming': case 'theirs': return { kind: 'incoming' };
    case 'both': case 'both-current-first': return { kind: 'both', order: 'current-first' };
    case 'both-incoming-first': return { kind: 'both', order: 'incoming-first' };
    case 'base': case 'ancestor': return { kind: 'base' };
    case 'custom': return typeof text === 'string' ? { kind: 'custom', text } : null;
    default: return null;
  }
}
