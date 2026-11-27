/** Pure helpers for the AI-written pull request description: trims a branch's
 * diff to a size a model can take, picks the language of the commit messages,
 * builds the prompt, reads the reply and puts the result into the description.
 * No imports with runtime effects, so the node tests load it directly. */

export interface PrDraftCommit {
  shortOid: string;
  /** Full commit message: summary, blank line, body. */
  message: string;
}

export interface PrDraftFile {
  path: string;
  previousPath?: string | null;
  /** A, M, D, R or T. */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
}

export interface PrDraftTemplate {
  path: string;
  content: string;
}

export interface PrDraftContext {
  mergeBaseOid: string | null;
  commits: PrDraftCommit[];
  files: PrDraftFile[];
  template: PrDraftTemplate | null;
}

/** Characters of diff the prompt carries by default (~6k tokens). */
export const DEFAULT_DIFF_BUDGET = 24_000;
const MAX_LISTED_FILES = 300;
const MAX_LISTED_COMMITS = 80;
const MAX_COMMIT_CHARS = 600;
/** A file whose share would be smaller than this is listed without a patch. */
const MIN_FILE_SHARE = 160;

const NOISE = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/i,
  /\.min\.(js|css)$/i,
  /\.(map|snap)$/i,
  /(^|\/)(__snapshots__|dist|build|out|coverage|vendor|node_modules)\//i,
  /(^|\/)[^/]+-snapshots\//i,
];

/** Lockfiles, build output, minified bundles and snapshots: listed, but their patch is left out. */
export function isNoiseFile(path: string): boolean {
  return NOISE.some((pattern) => pattern.test(path));
}

const TESTS = [
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\//i,
  /\.(test|spec|e2e)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rs|rb|exs?)$/i,
  /(Test|Tests|Spec)\.(java|kt|cs|swift|scala)$/,
];

export function isTestFile(path: string): boolean {
  return TESTS.some((pattern) => pattern.test(path));
}

const HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode|Binary files )/;

/** The hunks of a unified patch without git's per-file header lines. */
export function patchBody(patch: string): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@'));
  const body = first < 0 ? lines.filter((line) => !HEADER.test(line)) : lines.slice(first);
  return body.join('\n').replace(/\n+$/, '');
}

/** Cuts text to `max` characters on a line boundary and says how many lines were left out. */
export function trimPatch(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max) break;
    kept.push(line);
    used += line.length + 1;
  }
  const rest = lines.length - kept.length;
  return `${kept.join('\n')}${kept.length ? '\n' : ''}… (${rest} more line${rest === 1 ? '' : 's'} not shown)`;
}

function fileLabel(file: PrDraftFile): string {
  const name = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path;
  return `${name} (${file.status}, +${file.additions} −${file.deletions})`;
}

export interface TrimmedDiff {
  text: string;
  /** Files whose patch is shown, in full or in part. */
  shown: number;
  /** Files listed without a patch: binary, noise, or past the budget. */
  omitted: number;
  /** True when anything was cut or left out to fit the budget. */
  cut: boolean;
}

/**
 * Fits the patches into `budget` characters. Each file gets a fair share: small
 * files keep their whole patch and what they leave over goes to the larger ones,
 * which are cut on a line boundary. Lockfiles, build output and binary files are
 * named but never shown.
 */
export function trimDiff(files: PrDraftFile[], budget = DEFAULT_DIFF_BUDGET): TrimmedDiff {
  const bodies = files.map((file) => (file.binary || isNoiseFile(file.path) ? '' : patchBody(file.patch)));
  const eligible = bodies.map((body, index) => ({ index, size: body.length })).filter(({ size }) => size > 0);
  const headers = eligible.reduce((sum, { index }) => sum + fileLabel(files[index]).length + 6, 0);
  let remaining = Math.max(0, budget - headers);
  const allowance = new Map<number, number>();
  const bySize = [...eligible].sort((a, b) => a.size - b.size);
  bySize.forEach(({ index, size }, position) => {
    const share = Math.floor(remaining / (bySize.length - position));
    const take = size <= share ? size : share >= MIN_FILE_SHARE ? share : 0;
    allowance.set(index, take);
    remaining -= take;
  });

  const parts: string[] = [];
  let shown = 0;
  let cut = false;
  files.forEach((file, index) => {
    const body = bodies[index];
    const take = allowance.get(index) ?? 0;
    const reason = file.binary ? 'binary file' : isNoiseFile(file.path) ? 'generated or lock file' : !body ? 'no text changes' : '';
    if (reason) {
      parts.push(`--- ${fileLabel(file)} — ${reason}, not shown`);
      return;
    }
    if (take === 0) {
      cut = true;
      parts.push(`--- ${fileLabel(file)} — left out to keep the diff short`);
      return;
    }
    shown++;
    const text = trimPatch(body, take);
    if (text !== body || file.truncated) cut = true;
    parts.push(`--- ${fileLabel(file)}\n${text}${file.truncated && text === body ? '\n… (rest of this file not shown)' : ''}`);
  });
  return { text: parts.join('\n\n'), shown, omitted: files.length - shown, cut };
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['Thai', /[฀-๿]/g],
  ['Japanese', /[぀-ヿ]/g],
  ['Korean', /[가-힯ᄀ-ᇿ]/g],
  ['Chinese', /[一-鿿]/g],
  ['Russian', /[Ѐ-ӿ]/g],
  ['Arabic', /[؀-ۿ]/g],
  ['Hebrew', /[֐-׿]/g],
  ['Greek', /[Ͱ-Ͽ]/g],
  ['Hindi', /[ऀ-ॿ]/g],
  ['Vietnamese', /[ăâđêôơưĂÂĐÊÔƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g],
];

/** The language most commit messages are written in, judged by script; English when unsure. */
export function detectLanguage(messages: string[]): string {
  // Conventional prefixes, code spans and paths are English whatever the language of the prose.
  const prose = messages
    .join('\n')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*\w+(\([^)]*\))?!?:\s*/gm, ' ')
    .replace(/\S*[/\\.]\S*/g, ' ');
  const letters = (prose.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return 'English';
  let best = 'English';
  let bestCount = 0;
  for (const [language, pattern] of SCRIPTS) {
    const count = (prose.match(pattern) ?? []).length;
    // Japanese text is mostly kanji: kana anywhere makes Han count as Japanese.
    if (language === 'Chinese' && best === 'Japanese') continue;
    const weight = language === 'Vietnamese' ? count * 6 : count;
    if (weight > bestCount) { best = language; bestCount = weight; }
  }
  return bestCount / letters >= 0.2 ? best : 'English';
}

export interface PrPromptInput {
  base: string;
  compare: string;
  /** The title the user has now, for context. */
  title: string;
  context: PrDraftContext;
  language?: string;
  budget?: number;
}

function commitLines(commits: PrDraftCommit[]): string {
  const list = commits.slice(-MAX_LISTED_COMMITS).map((commit) => {
    const message = commit.message.trim();
    const short = message.length > MAX_COMMIT_CHARS ? `${message.slice(0, MAX_COMMIT_CHARS)}…` : message;
    return `- ${commit.shortOid} ${short.replace(/\n/g, '\n  ')}`;
  });
  const skipped = commits.length - list.length;
  return [...(skipped > 0 ? [`(${skipped} older commits not listed)`] : []), ...list].join('\n') || '(no commits)';
}

/** The whole request sent to the model. */
export function buildPrDescriptionPrompt({ base, compare, title, context, language, budget = DEFAULT_DIFF_BUDGET }: PrPromptInput): string {
  const lang = language || detectLanguage(context.commits.map((commit) => commit.message));
  const testsChanged = context.files.some((file) => isTestFile(file.path));
  const diff = trimDiff(context.files, budget);
  const listed = context.files.slice(0, MAX_LISTED_FILES).map((file) => `- ${fileLabel(file)}`);
  if (context.files.length > listed.length) listed.push(`- … and ${context.files.length - listed.length} more files`);

  const shape = context.template
    ? [
      `The repository has a pull request template (${context.template.path}). Fill it in instead of using your own layout:`,
      '- Keep its headings, their order and its checklists.',
      '- Replace placeholder text and HTML comments with real content; leave a section short (e.g. "N/A") when nothing applies.',
      '- Tick a checkbox only when the commits or the diff clearly show it is done.',
      '',
      'Template:',
      '<<<TEMPLATE',
      context.template.content.trim(),
      'TEMPLATE>>>',
    ]
    : [
      'Use this layout:',
      '## Summary',
      '2–4 bullets: what changed and why, for a reviewer who has not seen the branch.',
      '## Changes',
      'Bullets grouped by area (a **bold** area name, e.g. **UI**, **API**, **Build**, followed by its bullets). Name files or components only where it helps.',
      ...(testsChanged
        ? ['## Testing', 'What the changed or added tests cover, and how to run or check them.']
        : ['Leave out a Testing section: no test files changed.']),
    ];

  return [
    `You are writing the description of a GitHub pull request that merges "${compare}" into "${base}".`,
    `Write it in ${lang}. Keep code identifiers, file paths and commit prefixes as they are.`,
    'Describe only what the commits and the diff below show; do not invent motivation, tickets or test results.',
    'Be concise: no filler, no restating every commit.',
    '',
    ...shape,
    '',
    'Reply in exactly this form, with nothing before or after it:',
    'TITLE: <a better pull request title, at most 72 characters, in the same language>',
    '---',
    '<the description in GitHub markdown>',
    '',
    `Current title: ${title.trim() || '(none)'}`,
    '',
    `Commits (${context.commits.length}, oldest first):`,
    commitLines(context.commits),
    '',
    `Files changed (${context.files.length}):`,
    listed.join('\n') || '(none)',
    '',
    `Diff against the merge base${diff.cut ? ' (trimmed to fit; "…" marks cut parts)' : ''}:`,
    diff.text || '(no text changes)',
  ].join('\n');
}

export interface PrDescriptionReply {
  title: string | null;
  body: string;
}

/** Reads the model's reply: an optional `TITLE:` line, a `---` separator and the markdown body. */
export function parsePrDescriptionReply(raw: string): PrDescriptionReply {
  let text = raw.replace(/\r\n/g, '\n').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  let title: string | null = null;
  const head = text.match(/^\**TITLE\**\s*[:：]\s*(.+)\n?/i);
  if (head) {
    title = head[1].replace(/^[*\s"'`“]+|[*\s"'`”]+$/g, '') || null;
    text = text.slice(head[0].length).replace(/^\s*---+\s*\n/, '').trim();
  }
  const innerFence = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  if (innerFence) text = innerFence[1].trim();
  return { title, body: text };
}

export type InsertMode = 'replace' | 'cursor' | 'append';

/** Puts the generated description into the existing one: instead of it, at the cursor, or below it. */
export function insertDescription(existing: string, generated: string, mode: InsertMode, cursor = existing.length): string {
  const text = generated.trim();
  if (mode === 'replace' || !existing.trim()) return text;
  if (mode === 'append') return `${existing.replace(/\s+$/, '')}\n\n${text}`;
  const at = Math.max(0, Math.min(cursor, existing.length));
  const before = existing.slice(0, at).replace(/[ \t]+$/, '');
  const after = existing.slice(at).replace(/^[ \t]+/, '');
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after ? '' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return `${before}${lead}${text}${tail}${after}`;
}
