/** Pure rules behind the Explorer editor's AI help (Copilot-style ghost text and Ctrl+I inline edit):
 * which files may be sent, the context window around the cursor, the prompts, cleaning the model's
 * answer, and the debounce / cancel / cache rules. No Monaco or browser imports, so node tests run it. */

/** Files over this size get no completions (the prompt only carries a window, but huge files are usually generated). */
export const MAX_COMPLETION_FILE_CHARS = 400_000;
/** Characters of code before / after the cursor sent with a completion request. */
export const PREFIX_CHARS = 6_000;
export const SUFFIX_CHARS = 2_000;
/** Pause after the last keystroke before a completion is requested. */
export const COMPLETION_DEBOUNCE_MS = 350;
/** Upper bound on the ghost text, in lines. */
export const MAX_COMPLETION_LINES = 16;
/** Characters of code around the edited region sent with an inline-edit request. */
export const EDIT_CONTEXT_CHARS = 4_000;

const SECRET_NAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.htpasswd', '.pgpass', '.git-credentials', '.dockercfg',
  'credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts', 'authorized_keys',
]);
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg|ppk|crt|cer|der|tfvars|tfstate)$/i;
const SECRET_WORDS = /(^|[._-])(secrets?|credentials?|passwords?|private[._-]?key|service[._-]?account|token)s?([._-]|$)/i;
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|bmp|ico|webp|avif|tiff?|psd|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|lib|class|wasm|pyc|mp[34]|m4a|wav|flac|ogg|mov|avi|mkv|webm|woff2?|ttf|otf|eot|sqlite|db|lock)$/i;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** `.env`, `.env.local`, keys, certificates, credential stores and files named like secrets. */
export function isSecretPath(path: string): boolean {
  const name = baseName(path).toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true;
  if (SECRET_NAMES.has(name) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return true;
  if (SECRET_EXTENSIONS.test(name)) return true;
  return SECRET_WORDS.test(name.replace(/\.[^.]+$/, ''));
}

/** True when `path` is listed as git-ignored, or sits in an ignored folder (listed with a trailing slash). */
export function isIgnoredPath(path: string, ignored: readonly string[]): boolean {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return ignored.some((entry) => {
    const item = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return item.endsWith('/') ? clean.startsWith(item) : clean === item;
  });
}

export interface FileFacts {
  path: string;
  /** Length of the buffer in characters. */
  size: number;
  binary?: boolean;
  tooLarge?: boolean;
  /** Git-ignored entries of the workspace tree (folders end with `/`). */
  ignored?: readonly string[];
}

/** Why this file must not be sent to the model, or null when it may be. */
export function aiSkipReason(file: FileFacts, maxChars = MAX_COMPLETION_FILE_CHARS): string | null {
  if (file.binary || BINARY_EXTENSIONS.test(file.path)) return 'binary file';
  if (isSecretPath(file.path)) return 'looks like a secrets file';
  if (file.ignored && isIgnoredPath(file.path, file.ignored)) return 'ignored by git';
  if (file.tooLarge || file.size > maxChars) return 'file is too large';
  return null;
}

export interface ContextWindow {
  prefix: string;
  suffix: string;
  /** True when code before / after the window was left out. */
  prefixCut: boolean;
  suffixCut: boolean;
}

/** The code before and after `offset`, cut to the budget on whole lines (the cursor's own line is always kept). */
export function contextWindow(text: string, offset: number, prefixChars = PREFIX_CHARS, suffixChars = SUFFIX_CHARS): ContextWindow {
  const at = Math.max(0, Math.min(offset, text.length));
  let prefix = text.slice(0, at);
  let suffix = text.slice(at);
  const prefixCut = prefix.length > prefixChars;
  if (prefixCut) {
    const lineStart = prefix.lastIndexOf('\n') + 1;
    let start = prefix.length - prefixChars;
    const nl = prefix.indexOf('\n', start);
    start = nl === -1 || nl + 1 > lineStart ? lineStart : nl + 1;
    prefix = prefix.slice(start);
  }
  const suffixCut = suffix.length > suffixChars;
  if (suffixCut) {
    const lineEnd = suffix.indexOf('\n');
    const nl = suffix.lastIndexOf('\n', suffixChars);
    const end = nl === -1 || (lineEnd !== -1 && nl < lineEnd) ? (lineEnd === -1 ? suffix.length : lineEnd) : nl;
    suffix = suffix.slice(0, end);
  }
  return { prefix, suffix, prefixCut, suffixCut };
}

export const CURSOR = '<CURSOR>';

export interface CompletionRequest {
  path: string;
  language: string;
  prefix: string;
  suffix: string;
}

/** Fill-in-the-middle prompt for chat models: the file with a cursor marker, and strict output rules. */
export function buildCompletionPrompt({ path, language, prefix, suffix }: CompletionRequest): string {
  return [
    'You are a code completion engine inside a code editor, like GitHub Copilot.',
    `File: ${path} (${language || 'plaintext'})`,
    `Continue the code at ${CURSOR}. Reply with ONLY the text to insert at ${CURSOR}:`,
    '- no explanations, no markdown fences, do not repeat code that is already before or after the cursor;',
    '- complete the current statement or block, at most a few lines, matching the file\'s style and indentation;',
    '- reply with nothing if no completion makes sense.',
    '',
    '<file>',
    `${prefix}${CURSOR}${suffix}`,
    '</file>',
  ].join('\n');
}

/** Strips a markdown fence the model wrapped its answer in (keeps the inside, indentation included). */
export function stripFence(raw: string): string {
  const fence = raw.match(/^\s*```[\w+#.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return fence ? fence[1] : raw;
}

/** The longest end of `text` that is also the start of `next` (how much of `next` the model repeated). */
export function overlapLength(text: string, next: string): number {
  for (let k = Math.min(text.length, next.length); k > 0; k--) {
    if (text.endsWith(next.slice(0, k))) return k;
  }
  return 0;
}

/** Turns a model answer into ghost text: no fences or cursor markers, no echo of the line before the cursor,
 * nothing that repeats the code after the cursor, at most `maxLines` lines. Empty string = show nothing. */
export function cleanCompletion(raw: string, prefix: string, suffix: string, maxLines = MAX_COMPLETION_LINES): string {
  let text = stripFence(raw.replace(/\r\n/g, '\n')).split(CURSOR).join('');
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  // The model restated the current line: keep only what comes after the part already typed.
  const typed = linePrefix.trimStart();
  if (typed.trim() && text.trimStart().startsWith(typed)) {
    text = text.trimStart().slice(typed.length);
  } else if (!linePrefix.trim() && linePrefix && text.startsWith(linePrefix)) {
    // The cursor is in indentation and the answer repeats that indentation.
    text = text.slice(linePrefix.length);
  }
  // Ghost text never reaches past the code that follows: drop a repeat of the suffix's start.
  const restOfLine = suffix.split('\n')[0];
  const overlap = overlapLength(text, suffix);
  if (overlap > 0) {
    text = text.slice(0, text.length - overlap);
  } else if (restOfLine.trim() && text.trimEnd().endsWith(restOfLine.trim())) {
    text = text.trimEnd().slice(0, text.trimEnd().length - restOfLine.trim().length);
  }
  const lines = text.split('\n');
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join('\n');
  text = text.replace(/[ \t]+$/g, '').replace(/\n+$/, '');
  return text.trim() ? text : '';
}

/** Copilot shows ghost text at the end of a line, or before closing brackets / quotes / punctuation only. */
export function shouldOfferCompletion(linePrefix: string, lineSuffix: string): boolean {
  if (!/^[\s)\]}>"'`;,.]*$/.test(lineSuffix)) return false;
  // Nothing typed on an empty line after an empty line: wait for the user.
  return linePrefix.trim().length > 0 || lineSuffix.trim().length === 0;
}

export interface CachedCompletion {
  path: string;
  prefix: string;
  suffix: string;
  text: string;
}

/** Reuses the last answer while the user types it out: same file and suffix, and what was typed since is
 * the start of the cached ghost text. Returns the rest to show, '' when it was all typed, null on a miss. */
export function reuseCompletion(cache: CachedCompletion | null, path: string, prefix: string, suffix: string): string | null {
  if (!cache || cache.path !== path || cache.suffix !== suffix) return null;
  if (prefix === cache.prefix) return cache.text;
  if (!prefix.startsWith(cache.prefix)) return null;
  const typed = prefix.slice(cache.prefix.length);
  return cache.text.startsWith(typed) ? cache.text.slice(typed.length) : null;
}

/** Hands out request numbers; only the newest one may show its answer (older ones are stale). */
export function createRequestGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (id: number) => id === latest,
    /** Makes every request handed out so far stale (the user typed, switched files or turned AI off). */
    cancelAll: () => {
      latest += 1;
    },
  };
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits `delay` ms after the last call. A newer call (or `cancel`) settles the waiting one with false;
 * the one left standing settles with true when the pause is over. */
export function createDebouncer(delay: number, timers: Timers = realTimers) {
  let timer: unknown = null;
  let settle: ((go: boolean) => void) | null = null;
  const drop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    const pending = settle;
    settle = null;
    pending?.(false);
  };
  return {
    wait(ms = delay): Promise<boolean> {
      drop();
      return new Promise<boolean>((resolve) => {
        settle = resolve;
        if (ms <= 0) {
          settle = null;
          resolve(true);
          return;
        }
        timer = timers.setTimeout(() => {
          timer = null;
          settle = null;
          resolve(true);
        }, ms);
      });
    },
    cancel: drop,
  };
}

/** Explicit requests (Alt+\ / a retrigger) go at once; typing waits for a pause. */
export function debounceFor(explicit: boolean): number {
  return explicit ? 0 : COMPLETION_DEBOUNCE_MS;
}

export interface InlineEditRequest {
  path: string;
  language: string;
  instruction: string;
  /** Code before the region (already cut to a window). */
  before: string;
  /** The region to rewrite: the selection, or the cursor's line. */
  region: string;
  after: string;
  /** True when the user selected code; false = the cursor's line. */
  selected: boolean;
}

/** Prompt for Ctrl+I: rewrite only the marked region and answer with its full replacement. */
export function buildInlineEditPrompt({ path, language, instruction, before, region, after, selected }: InlineEditRequest): string {
  return [
    'You are editing code inside a code editor, like VS Code inline chat.',
    `File: ${path} (${language || 'plaintext'})`,
    `Instruction: ${instruction.trim()}`,
    '',
    selected
      ? 'Rewrite the code between <region> and </region> to follow the instruction.'
      : 'The cursor is on the line between <region> and </region> (it may be empty). Replace that line with code that follows the instruction.',
    'Reply with ONLY the full replacement for the region, in one ```' + (language || '') + ' fence, keeping the indentation of the surrounding code.',
    'Do not include code from outside the region and do not explain.',
    '',
    '<before>',
    before,
    '</before>',
    '<region>',
    region,
    '</region>',
    '<after>',
    after,
    '</after>',
  ].join('\n');
}

/** The replacement code from an inline-edit answer: the first fence's body, or the whole answer without
 * region tags. A missing trailing newline is matched to the original region's. */
export function parseInlineEditReply(raw: string, region: string): string {
  const text = raw.replace(/\r\n/g, '\n');
  const fence = text.match(/```[\w+#.-]*[ \t]*\n([\s\S]*?)\n?```/);
  // Without a fence only blank lines around the answer go: its indentation is kept.
  let code = fence ? fence[1] : text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  code = code.replace(/^<region>\n?/, '').replace(/\n?<\/region>$/, '');
  const endsWithNewline = region.endsWith('\n');
  code = code.replace(/\n+$/, '');
  return endsWithNewline ? `${code}\n` : code;
}

export type CodeAction = 'explain' | 'fix' | 'document' | 'tests';

/** Ctrl+I instruction behind each editor context-menu action that edits code in place. */
export const CODE_ACTION_INSTRUCTIONS: Record<Exclude<CodeAction, 'explain' | 'tests'>, string> = {
  fix: 'Fix any bugs or problems in this code. Keep its behaviour otherwise the same.',
  document: 'Add clear doc comments and short inline comments to this code in the file\'s comment style. Do not change the code itself.',
};

/** Chat message for actions that go to the AI Agent panel (the selection rides along as an attachment). */
export function agentPromptFor(action: 'explain' | 'tests', path: string, startLine: number, endLine: number): string {
  const where = `\`${path}\` lines ${startLine}–${endLine}`;
  return action === 'explain'
    ? `Explain the selected code in ${where}: what it does, how, and anything surprising.`
    : `Write unit tests for the selected code in ${where}, using the test framework this project already uses. Put them where this project keeps its tests.`;
}
