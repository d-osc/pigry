/** Pigry's Cypress-style E2E runner.
 *
 * A spec is plain JavaScript written against the Cypress API (describe / it /
 * hooks, `cy.*`, `Cypress.*`, `expect`). `runSpec` evaluates it, builds the
 * command queue of every test, and executes the commands one by one against
 * the external test browser through a {@link Driver} (the DevTools/CDP session
 * of src-tauri/src/devtools.rs). DOM work happens inside the page via the
 * helper library in cyPage.js, so commands retry, auto-wait for actionability
 * and read live data exactly like Cypress does.
 *
 * Every command is logged (with before/after DOM snapshots for time travel),
 * every test gets a result, failures carry a code frame, a screenshot and the
 * browser console, and the whole spec can be videoed. */
import CY_PAGE from './cyPage.js?raw';
import { loadModuleGraph, makeRequire, type ModuleHost } from './modules';
import { cypressBrowserOf, isBrowser, type CypressBrowser } from './browsers';
import {
  AssertionError, JQ, VIEWPORT_PRESETS, assertDom, assertFn, deepEqual, expectFn, fmt, isDomSnap, makeStub, runAssertion,
  type DomSnap,
} from './assert';

/* ------------------------------------------------------------------ types */

export interface E2eConfig {
  baseUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  defaultCommandTimeout: number;
  pageLoadTimeout: number;
  responseTimeout: number;
  retries: number;
  video: boolean;
  screenshotOnRunFailure: boolean;
  testIsolation: boolean;
  snapshots: boolean;
  networkEvidence: boolean;
  env: Record<string, unknown>;
  /** Trusted mouse/keyboard input through the browser (CDP) instead of dispatched DOM events. */
  realInput: boolean;
  /** false disables web security in the test browser (cross-origin requests and iframes), like Cypress chromeWebSecurity. */
  chromeWebSecurity: boolean;
  includeShadowDom: boolean;
  waitForAnimations: boolean;
  animationDistanceThreshold: number;
  scrollBehavior: 'center' | 'top' | 'bottom' | 'nearest';
  /** Workspace file run before every spec (custom commands, global hooks); empty = none. */
  supportFile: string;
  /** Workspace file with `module.exports = (on, config) => { on('task', {...}) }` — Cypress's setupNodeEvents. */
  pluginsFile: string;
  /** Extra spec locations (globs such as tests/&#42;&#42;/&#42;.spec.js) besides *.cy.js / *.cy.ts. */
  specPattern: string[];
  excludeSpecPattern: string[];
  /** Component testing: the dev server page used by cy.mount({ module }) (default baseUrl). */
  componentUrl: string;
  /** react | vue | custom (default for cy.mount({ module })). */
  componentFramework: 'react' | 'vue' | 'custom';
}

export const DEFAULT_CONFIG: E2eConfig = {
  baseUrl: '', viewportWidth: 1000, viewportHeight: 660, defaultCommandTimeout: 4000, pageLoadTimeout: 60000, responseTimeout: 30000,
  retries: 0, video: false, screenshotOnRunFailure: true, testIsolation: true, snapshots: true, networkEvidence: true, env: {},
  realInput: true, chromeWebSecurity: true, includeShadowDom: false, waitForAnimations: true, animationDistanceThreshold: 5, scrollBehavior: 'center',
  supportFile: '.pigry/e2e/support/e2e.js', pluginsFile: '.pigry/e2e/support/plugins.js',
  specPattern: [], excludeSpecPattern: [], componentUrl: '', componentFramework: 'custom',
};

/** The test browser. Implemented over the Tauri DevTools session (driver.ts) and, in tests, over Playwright. */
export interface Driver {
  open(url: string, waitMs?: number): Promise<void>;
  /** Evaluates an expression in the page; resolves to the raw result text (JSON-quoted for strings). */
  eval(js: string): Promise<string>;
  initScript(js: string): Promise<void>;
  screenshot(saveAs: string, opts?: { fullPage?: boolean; clip?: { x: number; y: number; w: number; h: number } }): Promise<void>;
  /** Trusted mouse / wheel / keyboard / text events (CDP Input domain). Optional: without it commands fall back to dispatched DOM events. */
  input?(events: InputEvent[]): Promise<void>;
  /** Cookies of the browser, httpOnly ones included. */
  cookies?(): Promise<Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; expires?: number }>>;
  setCookie?(cookie: { name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean }): Promise<void>;
  clearCookies?(name?: string): Promise<void>;
  setHeaders?(headers: Record<string, string>): Promise<void>;
  setWebSecurity?(enabled: boolean): Promise<void>;
  /** Picks which installed browser the test window launches with ("" = Auto); a change restarts the window. */
  setBrowser?(id: string): Promise<void>;
  viewport(width: number, height: number, mobile?: boolean): Promise<void>;
  recordStart(saveAs: string): Promise<void>;
  recordStop(): Promise<void>;
  networkExport(saveAs: string): Promise<void>;
  console(): Promise<string>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, timeoutSecs?: number): Promise<{ code: number; output: string }>;
  close(): Promise<void>;
}

export interface InputEvent {
  t: 'move' | 'down' | 'up' | 'wheel' | 'keydown' | 'keyup' | 'text';
  x?: number; y?: number; button?: 'left' | 'right' | 'middle' | 'none'; clicks?: number; mods?: number;
  key?: string; code?: string; text?: string; vk?: number; dx?: number; dy?: number; delay?: number;
}

export interface Snapshot {
  html: string; url: string; w: number; h: number; sx: number; sy: number; title: string;
  /** What was highlighted ("before click", "after click", …). */
  label: string;
}

export type LogState = 'pending' | 'passed' | 'failed';
export interface LogEntry {
  id: number;
  testKey: string;
  /** cy command name, "assert", "log", "request", "route", "hook". */
  name: string;
  message: string;
  kind: 'command' | 'assertion' | 'log' | 'request' | 'route' | 'hook';
  level: number;
  state: LogState;
  ms: number;
  error?: string;
  line?: number;
  before?: number;
  after?: number;
  /** Extra console props shown when a command is selected. */
  props?: Record<string, unknown>;
  alias?: string;
}

export interface CodeFrame { line: number; lines: Array<{ n: number; text: string; hit: boolean }> }
export interface TestError { message: string; name: string; line?: number; frame?: CodeFrame; command?: string }

export type TestStatus = 'passed' | 'failed' | 'pending' | 'skipped';
export interface TestResult {
  key: string;
  title: string[];
  status: TestStatus;
  ms: number;
  attempts: number;
  error?: TestError;
  log: LogEntry[];
  screenshots: string[];
  /** Passed, but only after a retry. */
  flaky?: boolean;
  /** The browser console captured when the test failed. */
  console?: string;
  networkFile?: string;
}
export interface SpecResult {
  spec: string;
  status: 'passed' | 'failed' | 'error';
  startedAt: number;
  ms: number;
  tests: TestResult[];
  passed: number;
  failed: number;
  pending: number;
  video?: string;
  error?: string;
  config: E2eConfig;
  /** The browser the spec ran in, e.g. "Chrome 120". */
  browser?: string;
  /** Things the run could not do in this browser (e.g. no video in Firefox). */
  notes?: string[];
}

export type RunEvent =
  | { type: 'spec:start'; spec: string; tests: Array<{ key: string; title: string[]; status: TestStatus }> }
  | { type: 'test:start'; key: string; attempt: number }
  | { type: 'log'; entry: LogEntry }
  | { type: 'log:update'; entry: LogEntry }
  | { type: 'snapshot'; index: number; snapshot: Snapshot }
  | { type: 'test:end'; result: TestResult }
  | { type: 'spec:end'; result: SpecResult };

export interface RunOptions {
  driver: Driver;
  config: E2eConfig;
  spec: string;
  source: string;
  /** Workspace-relative folder for screenshots / videos / network files (no trailing slash). */
  evidenceDir: string;
  onEvent?: (event: RunEvent) => void;
  shouldStop?: () => boolean;
  /** Only run tests whose full title contains this text. */
  grep?: string;
  /** Snapshots are returned here (index = Snapshot id referenced by log entries). */
  snapshotSink?: Snapshot[];
  /** Source of the support file (custom commands, global hooks), evaluated before the spec. */
  support?: string;
  /** Turns a TypeScript spec into JavaScript (the spec name ends in .ts). */
  transpile?: (source: string) => Promise<string>;
  /** cy.pause() and step mode: resolves when the user resumes. 'step' stops again at the next command. */
  /** Workspace paths of the spec / support / plugins files (relative imports resolve from them). */
  specPath?: string;
  supportPath?: string;
  /** Source of a plugins file: `module.exports = (on, config) => { on('task', {...}) }` (also `cypress.config.js` setupNodeEvents). */
  plugins?: string;
  pluginsPath?: string;
  /** `setupNodeEvents` of a cypress.config.js. */
  setupNodeEvents?: (on: (event: string, handler: unknown) => void, config: Record<string, unknown>) => unknown;
  /** Real Node `require` (headless CLI): lets specs and plugins use built-ins and packages. */
  nodeRequire?: (name: string) => unknown;
  /** Start in step mode: pause before every command until the user continues. */
  step?: boolean;
  /** The spec is TypeScript: `transpile` turns it into JavaScript first. */
  typescript?: boolean;
  onPause?: (info: { spec: string; test: string; command: string; line?: number }) => Promise<'resume' | 'step' | 'stop'>;
  /** What `Cypress.browser` reports (the browser picked in E2E Testing). */
  browser?: CypressBrowser;
  /** How that browser is driven: "cdp", "bidi" (no video) or "playwright". */
  engine?: string;
}

/* -------------------------------------------------------------- subjects */

type Step = { t: string; s?: string; n?: number; text?: string; re?: string; flags?: string; matchCase?: boolean; deep?: boolean };
type Layer = Step[];
type Subject =
  | { kind: 'none' }
  | { kind: 'dom'; steps: Step[]; scope: Layer[]; timeout?: number }
  | { kind: 'value'; value: unknown; reeval?: () => Promise<unknown> }
  | { kind: 'win'; path: string }
  | { kind: 'route'; id: string };

class Chain {
  subject: Subject = { kind: 'none' };
}

const CHAIN = Symbol('pigry.chain');
/** The Chain behind a chainable (what cy.get() returns), or null for anything else. */
function chainableOf(v: unknown): Chain | null {
  if (v instanceof Chain) return v;
  return v && typeof v === 'object' ? ((v as Record<symbol, unknown>)[CHAIN] as Chain | undefined) ?? null : null;
}

interface Cmd {
  id: number;
  name: string;
  args: unknown[];
  chain: Chain;
  run: (c: Ctx) => Promise<Subject | void>;
  line?: number;
  quiet?: boolean;
}

interface Ctx {
  cmd: Cmd;
  args: unknown[];
  subject: Subject;
  log: LogEntry | null;
  peek: () => Cmd | undefined;
}

class SkipTest extends Error { }
class StopRun extends Error { }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unwrap(raw: string): string {
  try { const first = JSON.parse(raw) as unknown; return typeof first === 'string' ? first : raw; } catch { return raw; }
}

const STRING_QUERY = new Set(['find', 'filter', 'not', 'closest']);
const QUERIES = ['find', 'filter', 'not', 'first', 'last', 'eq', 'children', 'parent', 'parents', 'closest', 'siblings', 'next', 'prev', 'nextAll', 'prevAll', 'parentsUntil', 'nextUntil', 'prevUntil', 'shadow'];

/** Commands that act on an element with the mouse/keyboard: they use trusted input when the driver has it. */
const REAL_VERBS = new Set(['click', 'dblclick', 'rightclick', 'hover', 'type', 'clear', 'check', 'uncheck']);

export const KEYBOARD_KEYS = { ENTER: 'Enter', TAB: 'Tab', ESCAPE: 'Escape', BACKSPACE: 'Backspace', DELETE: 'Delete', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight', ARROW_UP: 'ArrowUp', ARROW_DOWN: 'ArrowDown', HOME: 'Home', END: 'End', PAGE_UP: 'PageUp', PAGE_DOWN: 'PageDown', SPACE: ' ' } as const;

const NAMED_KEYS: Record<string, { key: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', vk: 13, text: '\r' }, esc: { key: 'Escape', vk: 27 }, escape: { key: 'Escape', vk: 27 }, backspace: { key: 'Backspace', vk: 8 }, del: { key: 'Delete', vk: 46 }, delete: { key: 'Delete', vk: 46 },
  leftarrow: { key: 'ArrowLeft', vk: 37 }, rightarrow: { key: 'ArrowRight', vk: 39 }, uparrow: { key: 'ArrowUp', vk: 38 }, downarrow: { key: 'ArrowDown', vk: 40 },
  home: { key: 'Home', vk: 36 }, end: { key: 'End', vk: 35 }, pageup: { key: 'PageUp', vk: 33 }, pagedown: { key: 'PageDown', vk: 34 }, tab: { key: 'Tab', vk: 9 }, insert: { key: 'Insert', vk: 45 },
};

const KEY_BY_NAME: Record<string, { key: string; vk: number; text?: string }> = {
  Enter: NAMED_KEYS.enter, Tab: NAMED_KEYS.tab, Escape: NAMED_KEYS.esc, Backspace: NAMED_KEYS.backspace, Delete: NAMED_KEYS.del, ArrowLeft: NAMED_KEYS.leftarrow, ArrowRight: NAMED_KEYS.rightarrow,
  ArrowUp: NAMED_KEYS.uparrow, ArrowDown: NAMED_KEYS.downarrow, Home: NAMED_KEYS.home, End: NAMED_KEYS.end, PageUp: NAMED_KEYS.pageup, PageDown: NAMED_KEYS.pagedown, ' ': { key: ' ', vk: 32, text: ' ' },
};

const modBits = (o: Record<string, unknown>): number => (o.altKey ? 1 : 0) | (o.ctrlKey ? 2 : 0) | (o.metaKey ? 4 : 0) | (o.shiftKey ? 8 : 0);

/** "ab{enter}{{}" → tokens. `special` is the lower-cased name inside {braces}; {{} is a literal "{". */
export function tokenizeType(text: string, parse = true): Array<{ raw: string; char: string; special?: string }> {
  const out: Array<{ raw: string; char: string; special?: string }> = [];
  for (const raw of (parse ? text.match(/\{[^}]*\}|[\s\S]/gu) : [...text]) ?? []) {
    if (raw === '{{}') out.push({ raw, char: '{' });
    else if (parse && raw.length > 1 && raw.startsWith('{') && raw.endsWith('}')) out.push({ raw, char: '', special: raw.slice(1, -1).toLowerCase() });
    else out.push({ raw, char: raw });
  }
  return out;
}

export function relUrl(base: string, url: string): string {
  if (/^https?:\/\//i.test(url) || url === 'about:blank') return url;
  if (!base) throw new Error(`cy.visit("${url}") needs a full URL, or a baseUrl in the E2E settings`);
  return base.replace(/\/+$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

export const globToRegex = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '@@DIRS@@').replace(/\*\*/g, '@@ANY@@').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/@@DIRS@@/g, '(?:.*/)?').replace(/@@ANY@@/g, '.*') + '$');

/** 5 lines of the spec around `line`. */
export function codeFrame(source: string, line: number): CodeFrame {
  const all = source.split('\n');
  const from = Math.max(1, line - 2), to = Math.min(all.length, line + 2);
  const lines: CodeFrame['lines'] = [];
  for (let n = from; n <= to; n += 1) lines.push({ n, text: all[n - 1] ?? '', hit: n === line });
  return { line, lines };
}

/* ------------------------------------------------------------ the engine */

interface TestNode { key: string; title: string[]; fn: (() => unknown) | null; skip: boolean; only: boolean; retries?: number; suite: SuiteNode }
interface SuiteNode {
  title: string; parent: SuiteNode | null; tests: TestNode[]; suites: SuiteNode[]; skip: boolean; only: boolean;
  before: Array<() => unknown>; beforeEach: Array<() => unknown>; after: Array<() => unknown>; afterEach: Array<() => unknown>;
  order: Array<TestNode | SuiteNode>;
}

type Routes = Array<{ id: string; method?: string; url?: unknown; pathname?: unknown; hostname?: string; query?: Record<string, unknown>; headers?: Record<string, unknown>; alias?: string | null; response?: unknown; handler?: string | null; times?: number | null }>;

export class Engine {
  readonly cfg: E2eConfig;
  private readonly driver: Driver;
  private readonly opts: RunOptions;
  private nextId = 1;
  queues: Cmd[][] = [[]];
  private level = 0;
  private current: LogEntry | null = null;
  private logs: LogEntry[] = [];
  private testKey = '';
  private aliases = new Map<string, Subject>();
  private within: Layer[] = [];
  private routes: Routes = [];
  private routeSeq = 0;
  private consumed = new Map<string, number>();
  private sessionOpen = false;
  private handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  private persistentHandlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  private confirmDecision = true;
  private dialogDirty = false;
  private stepping = false;
  /** Set by runSpec: enqueues commands from inside other commands (clock().tick()). */
  cyApi: { tick: (ms: number) => void; defsRun: (name: string) => void } | null = null;
  private tasks = new Map<string, (arg: unknown) => unknown>();
  private beforeLoad: string[] = [];
  screenshotDefaults: Record<string, unknown> = { capture: 'viewport', disableTimersAndAnimations: true, padding: 0 };
  private uncaught: Array<{ message: string; stack?: string }> = [];
  private sessions = new Map<string, unknown>();
  private envs: Record<string, unknown>;
  private conf: Record<string, unknown>;
  private snapBytes = 0;
  currentTestTitle = '';
  screenshots: string[] = [];
  testScreenshotCount = 0;
  specLineOffset = 3;

  constructor(opts: RunOptions) {
    this.opts = opts; this.driver = opts.driver; this.cfg = opts.config; this.stepping = !!opts.step;
    this.envs = { ...opts.config.env };
    this.conf = { ...opts.config } as unknown as Record<string, unknown>;
  }

  /* ---- logging ---- */

  private emit(e: RunEvent) { this.opts.onEvent?.(e); }

  private startLog(name: string, message: string, kind: LogEntry['kind'], line?: number): LogEntry {
    const entry: LogEntry = { id: this.logs.length + 1, testKey: this.testKey, name, message, kind, level: this.level, state: 'pending', ms: 0, line };
    this.logs.push(entry); this.emit({ type: 'log', entry });
    return entry;
  }
  private endLog(entry: LogEntry, state: LogState, started: number, error?: string) {
    entry.state = state; entry.ms = Date.now() - started; if (error) entry.error = error;
    this.emit({ type: 'log:update', entry });
  }
  takeLogs(): LogEntry[] { const out = this.logs; this.logs = []; return out; }

  /* ---- page access ---- */

  async injectLib() { await this.driver.eval(`(function(){${CY_PAGE}\nreturn 1;})()`); }

  private async rawPage(name: string, args: unknown[]): Promise<{ r?: unknown; x?: string; e?: Array<{ message: string; stack?: string }>; n?: string }> {
    const js = `(function(){ if(!window.__cy) return JSON.stringify({x:"__cy_missing"}); return window.__cy.call(${JSON.stringify(name)}, ${JSON.stringify(args)}); })()`;
    const parsed = JSON.parse(unwrap(await this.driver.eval(js))) as { r?: unknown; x?: string; e?: Array<{ message: string; stack?: string }>; n?: string };
    return parsed;
  }
  /** Calls a page-lib function; (re)injects the library when the document has none. */
  async page<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    let out = await this.rawPage(name, args);
    if (out.x === '__cy_missing') { await this.injectLib(); await this.pushRoutes(false); out = await this.rawPage(name, args); }
    if (out.e?.length) for (const err of out.e) this.uncaught.push(err);
    if (out.x) throw new Error(out.x);
    return out.r as T;
  }
  private async evalAsync(js: string): Promise<unknown> {
    const raw = unwrap(await this.driver.eval(js));
    try { return JSON.parse(raw); } catch { return raw; }
  }

  private initSource(): string {
    const before = this.beforeLoad.map((f) => `try { (${f})(window); } catch (e) { console.error('onBeforeLoad failed', e); }`).join('\n');
    return `${CY_PAGE}\n;(function(){ __cy.call("setRoutes",[${JSON.stringify(this.routes)}]); __cy.call("setOpts",[${JSON.stringify({ confirm: this.confirmDecision })}]); })();\n${before}`;
  }
  private async pushRoutes(register = true) {
    if (register && this.sessionOpen) await this.driver.initScript(this.initSource());
    await this.page('setRoutes', this.routes).catch(() => undefined);
  }
  async ensureSession() {
    if (this.sessionOpen) return;
    await this.driver.open('about:blank', 0);
    this.sessionOpen = true;
    await this.driver.initScript(this.initSource());
    await this.driver.viewport(Number(this.conf.viewportWidth) || 1000, Number(this.conf.viewportHeight) || 660, false);
  }

  /** Calls the handlers registered with Cypress.on(event). Their failures never break the run. */
  fire(event: string, ...args: unknown[]) {
    for (const h of [...(this.persistentHandlers.get(event) ?? []), ...(this.handlers.get(event) ?? [])]) { try { h(...args); } catch { /* ignore */ } }
  }
  registerTasks(map: Record<string, (arg: unknown) => unknown>) { for (const [k, fn] of Object.entries(map)) this.tasks.set(k, fn); }
  /** Throws when the application raised an uncaught exception that no `uncaught:exception` handler ignored. */
  private checkUncaught() {
    while (this.uncaught.length) {
      const err = this.uncaught.shift()!;
      const hs = [...(this.persistentHandlers.get('uncaught:exception') ?? []), ...(this.handlers.get('uncaught:exception') ?? [])];
      let ignore = false;
      for (const h of hs) { try { if (h({ message: err.message, stack: err.stack }, {}) === false) ignore = true; } catch { /* handler failed */ } }
      if (!ignore) throw new Error(`The following error originated from your application code, not from Cypress.\n\n  > ${err.message}\n\nWhen Cypress detects uncaught errors originating from your application it will automatically fail the current test. This behavior is configurable with Cypress.on('uncaught:exception', () => false).`);
    }
  }
  private async drainDialogs() {
    const dialogs = await this.page<Array<{ type: string; message: string }>>('dialogs').catch(() => []);
    for (const d of dialogs) {
      const hs = [...(this.persistentHandlers.get(`window:${d.type}`) ?? []), ...(this.handlers.get(`window:${d.type}`) ?? [])];
      for (const h of hs) { try { const r = h(d.message); if (d.type === 'confirm' && r === false) this.confirmDecision = false; } catch (e) { throw new Error(`window:${d.type} handler failed: ${(e as Error).message}`); } }
    }
  }

  /* ---- snapshots ---- */

  private async snapshot(label: string, mark?: { steps: Step[]; scope: Layer[] }): Promise<number | undefined> {
    if (!this.cfg.snapshots || this.snapBytes > 40_000_000 || !this.opts.snapshotSink) return undefined;
    try {
      if (mark) await this.page('mark', mark.steps, mark.scope);
      const dom = await this.page<{ html: string; url: string; w: number; h: number; sx: number; sy: number; title: string } | null>('dom', 700_000);
      if (mark) await this.page('unmark');
      if (!dom) return undefined;
      this.snapBytes += dom.html.length;
      const snap: Snapshot = { ...dom, label };
      this.opts.snapshotSink.push(snap);
      const index = this.opts.snapshotSink.length - 1;
      this.emit({ type: 'snapshot', index, snapshot: snap });
      return index;
    } catch { return undefined; }
  }

  /* ---- queue ---- */

  enqueue(name: string, args: unknown[], chain: Chain, run: Cmd['run'], quiet = false): Cmd {
    const cmd: Cmd = { id: this.nextId++, name, args, chain, run, quiet, line: this.callLine() };
    this.queues[this.queues.length - 1].push(cmd);
    return cmd;
  }
  private callLine(): number | undefined {
    const stack = new Error().stack ?? '';
    const m = /pigry-spec[^\n]*?:(\d+):\d+/.exec(stack);
    return m ? Math.max(1, Number(m[1]) - this.specLineOffset) : undefined;
  }

  /** Runs the commands enqueued by `body` (a test, hook or callback) to completion. */
  async runBlock(body: () => unknown): Promise<void> {
    const queue: Cmd[] = [];
    this.queues.push(queue);
    let ret: unknown;
    try { ret = body(); } catch (e) { this.queues.pop(); throw e; }
    try {
      if (ret && typeof (ret as { then?: unknown }).then === 'function') await ret;
      await this.runQueue(queue);
    } finally { this.queues.pop(); }
  }

  async runQueue(queue: Cmd[]): Promise<Subject> {
    let last: Subject = { kind: 'none' };
    for (let i = 0; i < queue.length; i += 1) {
      if (this.opts.shouldStop?.()) throw new StopRun('stopped');
      const cmd = queue[i];
      const peek = () => queue[i + 1] && queue[i + 1].chain === cmd.chain ? queue[i + 1] : undefined;
      last = await this.exec(cmd, peek);
    }
    return last;
  }

  private async exec(cmd: Cmd, peek: () => Cmd | undefined): Promise<Subject> {
    const started = Date.now();
    if (this.stepping && this.opts.onPause && !cmd.quiet && cmd.name !== 'pause') {
      const choice = await this.opts.onPause({ spec: this.opts.spec, test: this.currentTestTitle, command: `${cmd.name} ${this.describeArgs(cmd)}`.trim(), line: cmd.line });
      if (choice === 'resume') this.stepping = false; else if (choice === 'stop') throw new StopRun('stopped');
    }
    if (this.dialogDirty) await this.applyDialogOpts();
    const log = cmd.quiet ? null : this.startLog(cmd.name, '', cmd.name === 'should' || cmd.name === 'and' ? 'assertion' : 'command', cmd.line);
    if (log) { log.message = this.describeArgs(cmd); }
    const prev = this.current;
    this.current = log;
    this.level += cmd.quiet ? 0 : 1;
    try {
      const out = await cmd.run({ cmd, args: cmd.args, subject: cmd.chain.subject, log, peek });
      if (out) cmd.chain.subject = out;
      await this.afterCommand();
      if (log) this.endLog(log, 'passed', started);
      return cmd.chain.subject;
    } catch (e) {
      const err = e as Error;
      if (err instanceof StopRun || err instanceof SkipTest) throw err;
      if (log) this.endLog(log, 'failed', started, err.message);
      (err as Error & { cmd?: Cmd }).cmd = (err as Error & { cmd?: Cmd }).cmd ?? cmd;
      throw err;
    } finally {
      this.level -= cmd.quiet ? 0 : 1;
      this.current = prev;
    }
  }
  /** `cy.on('window:confirm', fn)` decides before the dialog opens: ask the handler (with an empty message) and tell the page. */
  private async applyDialogOpts() {
    this.dialogDirty = false;
    const hs = [...(this.persistentHandlers.get('window:confirm') ?? []), ...(this.handlers.get('window:confirm') ?? [])];
    let decision = true;
    for (const h of hs) { try { if (h('') === false) decision = false; } catch { /* the real call reports it */ } }
    this.confirmDecision = decision;
    await this.page('setOpts', { confirm: decision }).catch(() => undefined);
  }
  private async afterCommand() {
    await this.drainDialogs();
    this.checkUncaught();
  }
  private describeArgs(cmd: Cmd): string {
    const show = (v: unknown): string => (typeof v === 'function' ? '[fn]' : isObj(v) && ('fixture' in v || 'statusCode' in v) ? fmt(v, 50) : fmt(v, 60).replace(/^'(.*)'$/, '$1'));
    if (cmd.name === 'should' || cmd.name === 'and') return cmd.args.map(show).join(', ');
    return cmd.args.filter((a) => a !== undefined).map(show).join(', ');
  }

  /* ---- subject helpers ---- */

  private chainFor(): Chain { return new Chain(); }

  domOf(s: Subject, verb: string): Extract<Subject, { kind: 'dom' }> {
    if (s.kind !== 'dom') throw new Error(`cy.${verb}() failed because it requires a DOM element. The subject received was: ${s.kind === 'value' ? fmt(s.value, 50) : s.kind}`);
    return s;
  }
  timeoutOf(o?: Record<string, unknown> | null, s?: Subject): number {
    const t = o && typeof o.timeout === 'number' ? o.timeout : s && s.kind === 'dom' && s.timeout ? s.timeout : Number(this.conf.defaultCommandTimeout) || 4000;
    return t;
  }
  async snapDom(s: Extract<Subject, { kind: 'dom' }>, css?: string[]): Promise<DomSnap> {
    return this.page<DomSnap>('snap', s.steps, s.scope, { css });
  }
  private describeSteps(steps: Step[]): string {
    return steps.map((s) => (s.t === 'get' ? s.s : s.t === 'contains' ? `contains(${s.s ? `${s.s}, ` : ''}${s.text ?? `/${s.re}/`})` : `${s.t}${s.s ? `(${s.s})` : s.n !== undefined ? `(${s.n})` : ''}`)).join(' → ');
  }

  /** Re-queries a DOM subject until it exists (or until the timeout). */
  async requireDom(s: Extract<Subject, { kind: 'dom' }>, timeout: number, allowEmpty = false): Promise<DomSnap> {
    const end = Date.now() + timeout;
    for (;;) {
      const snap = await this.snapDom(s);
      if (snap.count > 0 || allowEmpty) return snap;
      if (Date.now() >= end) throw new Error(`Timed out retrying after ${timeout}ms: Expected to find element: \`${this.describeSteps(s.steps)}\`, but never found it.`);
      await sleep(100);
    }
  }

  /** Resolves an assertion subject to the thing the chainer is evaluated on. */
  private async evalSubject(s: Subject, css?: string[]): Promise<{ value: unknown; dom?: DomSnap }> {
    if (s.kind === 'dom') { const d = await this.snapDom(s, css); return { value: d, dom: d }; }
    if (s.kind === 'value') return { value: s.reeval ? await s.reeval() : s.value };
    if (s.kind === 'win') return { value: await this.page('evalPath', s.path, [], false) };
    return { value: undefined };
  }

  /* ---- retried assertion (should / and) ---- */

  private async assertRetry(c: Ctx, chainer: unknown, args: unknown[]) {
    const s = c.subject;
    const timeout = this.timeoutOf(null, s);
    const end = Date.now() + timeout;
    const started = Date.now();
    for (;;) {
      let result: { pass: boolean; message: string } = { pass: false, message: '' };
      let thrown: Error | null = null;
      try {
        if (typeof chainer === 'function') {
          const { value, dom } = await this.evalSubject(s);
          const arg = dom ? new JQ(dom) : value;
          try { await (chainer as (v: unknown) => unknown)(arg); result = { pass: true, message: 'the callback assertions passed' }; }
          catch (e) { thrown = e as Error; result = { pass: false, message: (e as Error).message }; }
        } else {
          const text = String(chainer);
          const css = /(^|\.)css$/.test(text) && typeof args[0] === 'string' ? [String(args[0])] : undefined;
          const { value, dom } = await this.evalSubject(s, css);
          result = dom ? assertDom(dom, text, args) : runAssertion(value, text, args);
          if (dom && s.kind === 'dom' && !result.pass && /^(not\.)?(be\.)?(equal|eq|eql|a|an|match|true|false|null|undefined)/.test(text)) result = runAssertion(value, text, args);
        }
      } catch (e) { thrown = e as Error; result = { pass: false, message: (e as Error).message }; }
      if (result.pass) {
        if (c.log) { c.log.message = result.message; c.log.kind = 'assertion'; }
        return;
      }
      if (Date.now() >= end) {
        const err = new AssertionError(`Timed out retrying after ${timeout}ms: ${thrown?.message ?? result.message}`);
        throw err;
      }
      void started;
      await sleep(100);
    }
  }

  /* ---- action with auto-wait ---- */

  /** Waits until the element stops moving (CSS animations, transitions), like Cypress waitForAnimations. */
  private async settle(s: Extract<Subject, { kind: 'dom' }>, opts: Record<string, unknown>, end: number) {
    const thr = Number(opts.animationDistanceThreshold ?? this.conf.animationDistanceThreshold ?? 5);
    let prev = await this.page<{ x: number; y: number; w: number; h: number } | null>('rect', s.steps, s.scope);
    while (prev && Date.now() < end) {
      await sleep(40);
      const cur = await this.page<{ x: number; y: number; w: number; h: number } | null>('rect', s.steps, s.scope);
      if (!cur || (Math.hypot(cur.x - prev.x, cur.y - prev.y) <= thr && Math.abs(cur.w - prev.w) <= thr && Math.abs(cur.h - prev.h) <= thr)) return;
      prev = cur;
    }
  }

  /** Trusted input: moves the mouse, clicks, hovers and types through the browser instead of dispatching DOM events. */
  private async performReal(verb: string, res: { point?: { x: number; y: number }; focused?: boolean; checked?: boolean; tag?: string; editable?: boolean; wholeValue?: boolean; value?: string }, opts: Record<string, unknown>, args: Record<string, unknown>): Promise<boolean> {
    const input = this.driver.input!;
    const p = res.point ?? { x: 0, y: 0 };
    const mods = modBits(opts);
    const btn = (b: InputEvent['button'], clicks: number): InputEvent[] => [{ t: 'down', x: p.x, y: p.y, button: b, clicks, mods }, { t: 'up', x: p.x, y: p.y, button: b, clicks, mods }];
    const click = (): InputEvent[] => [{ t: 'move', x: p.x, y: p.y, button: 'none', mods }, ...btn('left', 1)];
    if (verb === 'click') { await input(click()); return true; }
    if (verb === 'dblclick') { await input([{ t: 'move', x: p.x, y: p.y, button: 'none', mods }, ...btn('left', 1), ...btn('left', 2)]); return true; }
    if (verb === 'rightclick') { await input([{ t: 'move', x: p.x, y: p.y, button: 'none', mods }, ...btn('right', 1)]); return true; }
    if (verb === 'hover') { await input([{ t: 'move', x: p.x - 1, y: p.y - 1, button: 'none', mods }, { t: 'move', x: p.x, y: p.y, button: 'none', mods }]); return true; }
    if (verb === 'check' || verb === 'uncheck') {
      const values = (args.values as string[] | undefined) ?? [];
      if (values.length && !values.includes(String(res.value ?? ''))) return true;
      if (!!res.checked !== (verb === 'check')) await input(click());
      return true;
    }
    if (verb === 'type' || verb === 'clear') {
      if (res.wholeValue || (!res.editable && res.tag !== 'input' && res.tag !== 'textarea')) return false;
      if (!res.focused) await input(click());
      const text = verb === 'clear' ? '{selectall}{backspace}' : String(args.text ?? '');
      const delay = typeof opts.delay === 'number' ? opts.delay : 0;
      let batch: InputEvent[] = [];
      const flush = async () => { if (batch.length) { const b = batch; batch = []; await input(b); } };
      const state = { ctrl: false, shift: false, alt: false, meta: false };
      for (const tk of tokenizeType(text, opts.parseSpecialCharSequences !== false)) {
        const name = tk.special;
        if (name === 'ctrl' || name === 'control') { state.ctrl = true; continue; }
        if (name === 'shift') { state.shift = true; continue; }
        if (name === 'alt' || name === 'option') { state.alt = true; continue; }
        if (name === 'meta' || name === 'command' || name === 'cmd') { state.meta = true; continue; }
        const m = (state.alt ? 1 : 0) | (state.ctrl ? 2 : 0) | (state.meta ? 4 : 0) | (state.shift ? 8 : 0);
        if (name === 'selectall') { await flush(); await this.page('selectAll'); continue; }
        if (name === 'movetostart') { await flush(); await this.page('caret', 'start'); continue; }
        if (name === 'movetoend') { await flush(); await this.page('caret', 'end'); continue; }
        if (name && NAMED_KEYS[name]) {
          const k = NAMED_KEYS[name];
          batch.push({ t: 'keydown', key: k.key, code: k.key, vk: k.vk, text: k.text, mods: m, delay }, { t: 'keyup', key: k.key, code: k.key, vk: k.vk, mods: m });
          continue;
        }
        const ch = tk.char;
        const code = /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : ch;
        if (ch.length === 1 && ch.charCodeAt(0) < 128) batch.push({ t: 'keydown', key: ch, code, text: ch, vk: /^[a-z]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0), mods: m, delay }, { t: 'keyup', key: ch, code, mods: m });
        else batch.push({ t: 'text', text: ch, delay });
      }
      await flush();
      return true;
    }
    return false;
  }

  private async action(c: Ctx, verb: string, options: Record<string, unknown> | undefined, args: Record<string, unknown> = {}): Promise<Subject | void> {
    const s = this.domOf(c.subject, verb);
    const opts: Record<string, unknown> = { scrollBehavior: this.conf.scrollBehavior, ...(options ?? {}) };
    const timeout = this.timeoutOf(opts, s);
    const end = Date.now() + timeout;
    const before = await this.snapshot(`before ${verb}`, { steps: s.steps, scope: s.scope });
    const real = !!this.driver.input && this.conf.realInput !== false && opts.realInput !== false && REAL_VERBS.has(verb);
    const animates = REAL_VERBS.has(verb) && opts.force !== true && (opts.waitForAnimations ?? this.conf.waitForAnimations) !== false;
    // type with a delay but without trusted input: send the text in pieces
    if (verb === 'type' && !real && typeof opts.delay === 'number' && opts.delay > 0) {
      const tokens = tokenizeType(String(args.text ?? ''), opts.parseSpecialCharSequences !== false).map((t) => t.raw);
      for (const part of tokens) { await this.action({ ...c, log: null }, 'type', { ...opts, delay: 0 }, { text: part }); await sleep(opts.delay); }
      if (c.log) { c.log.before = before; c.log.after = await this.snapshot('after type'); }
      return;
    }
    let last = '';
    for (;;) {
      if (animates) await this.settle(s, opts, end);
      const res = await this.page<{ ok: boolean; retry?: boolean; fatal?: boolean; reason?: string; target?: { desc: string; rect: unknown }; count?: number; point?: { x: number; y: number }; focused?: boolean; checked?: boolean; tag?: string; editable?: boolean; wholeValue?: boolean; value?: string }>('act', s.steps, s.scope, verb, real ? { ...opts, dry: true } : opts, args);
      if (res.ok) {
        let done = !real;
        if (real) done = await this.performReal(verb, res, opts, args);
        if (!done) {
          // controls that cannot be driven with the keyboard (date inputs…) are set through the page
          const simulated = await this.page<{ ok: boolean; reason?: string }>('act', s.steps, s.scope, verb, opts, args);
          if (!simulated.ok) throw new Error(simulated.reason ?? 'action failed');
        }
        if (c.log) {
          c.log.before = before;
          c.log.props = { Command: verb, Yielded: res.target?.desc, Elements: res.count, Input: real && done ? 'trusted (browser input)' : 'dispatched DOM events', Point: real && res.point ? `${Math.round(res.point.x)}, ${Math.round(res.point.y)}` : undefined, Options: Object.keys(options ?? {}).length ? options : undefined };
          c.log.after = await this.snapshot(`after ${verb}`);
        }
        return;
      }
      last = res.reason ?? 'action failed';
      if (res.fatal) throw new Error(last);
      if (Date.now() >= end) throw new Error(`Timed out retrying after ${timeout}ms: ${last}`);
      await sleep(100);
    }
  }

  /* ---- routes ---- */

  private async buildRoute(args: unknown[]): Promise<Routes[number]> {
    const route: Routes[number] = { id: `r${++this.routeSeq}`, alias: null, times: null };
    const [a, b, c] = args;
    let matcher: unknown; let handler: unknown;
    if (typeof a === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(a) && (typeof b === 'string' || b instanceof RegExp)) { route.method = a.toUpperCase(); matcher = b; handler = c; }
    else if (isObj(a) && !(a instanceof RegExp)) { matcher = a; handler = b; }
    else { matcher = a; handler = b; }
    const asUrl = (v: unknown): unknown => (v instanceof RegExp ? { regex: v.source, flags: v.flags } : v);
    if (isObj(matcher)) {
      if (matcher.method) route.method = String(matcher.method).toUpperCase();
      if (matcher.url !== undefined) route.url = asUrl(matcher.url);
      if (matcher.pathname !== undefined) route.pathname = asUrl(matcher.pathname);
      if (matcher.hostname) route.hostname = String(matcher.hostname);
      if (isObj(matcher.query)) route.query = matcher.query;
      if (isObj(matcher.headers)) route.headers = matcher.headers;
      if (typeof matcher.times === 'number') route.times = matcher.times;
    } else route.url = asUrl(matcher);
    if (typeof handler === 'function') route.handler = (handler as (...a: unknown[]) => unknown).toString();
    else if (handler !== undefined) {
      const resp: Record<string, unknown> = isObj(handler) ? { ...handler } : { body: handler };
      if (typeof resp.fixture === 'string') { const fx = await this.readFixture(resp.fixture as string); resp.body = fx; delete resp.fixture; if (typeof fx === 'object' && fx !== null) resp.headers = { 'content-type': 'application/json', ...(isObj(resp.headers) ? resp.headers : {}) }; }
      route.response = resp;
    }
    return route;
  }
  private async readFixture(name: string): Promise<unknown> {
    const candidates = /\.\w+$/.test(name) ? [name] : [name, `${name}.json`];
    for (const n of candidates) for (const dir of ['.pigry/e2e/fixtures/', 'cypress/fixtures/']) {
      const text = await this.driver.readFile(`${dir}${n}`);
      if (text !== null) { if (/\.json$/i.test(n)) { try { return JSON.parse(text); } catch (e) { throw new Error(`cy.fixture("${n}") is not valid JSON: ${(e as Error).message}`); } } return text; }
    }
    throw new Error(`cy.fixture("${name}") failed: no file .pigry/e2e/fixtures/${candidates.join(' or ')}`);
  }
  private interceptionOf(call: Record<string, unknown>): Record<string, unknown> {
    const parse = (t: unknown, h: Record<string, unknown>): unknown => {
      if (typeof t !== 'string') return t;
      if (/json/i.test(String(h['content-type'] ?? '')) || /^\s*[{[]/.test(t)) { try { return JSON.parse(t); } catch { return t; } }
      return t;
    };
    const url = String(call.url);
    const query: Record<string, string> = {}; try { new URL(url).searchParams.forEach((v, k) => { query[k] = v; }); } catch { /* relative */ }
    const reqH = (call.reqHeaders as Record<string, unknown>) ?? {}, resH = (call.respHeaders as Record<string, unknown>) ?? {};
    return {
      id: call.i, state: call.state, alias: call.alias, type: call.type,
      request: { method: call.method, url, headers: reqH, body: parse(call.reqBody, reqH), query },
      response: call.state === 'pending' ? undefined : { statusCode: call.status, statusMessage: '', headers: resH, body: parse(call.respBody, resH), duration: call.dur },
      error: call.state === 'error' ? { message: 'network error' } : undefined,
      stubbed: !!call.stubbed,
    };
  }

  private async allCookies(): Promise<Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; expiry?: number }>> {
    if (!this.driver.cookies) return this.page('cookies');
    const host = (await this.page<{ hostname: string }>('info').catch(() => ({ hostname: '' }))).hostname;
    const all = await this.driver.cookies();
    return all.filter((k) => !host || host === k.domain.replace(/^\./, '') || host.endsWith(`.${k.domain.replace(/^\./, '')}`)).map((k) => ({ name: k.name, value: k.value, domain: k.domain, path: k.path, httpOnly: k.httpOnly, secure: k.secure, expiry: k.expires && k.expires > 0 ? Math.round(k.expires) : undefined }));
  }
  private async clearAllCookies() {
    if (this.driver.clearCookies) await this.driver.clearCookies();
    await this.page('clearCookies').catch(() => undefined);
  }

  private async pressKey(c: Ctx, key: unknown): Promise<void> {
    const name = String(key);
    const k = KEY_BY_NAME[name] ?? { key: name, vk: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0, text: name.length === 1 ? name : undefined };
    if (this.driver.input && this.conf.realInput !== false) {
      await this.driver.input([{ t: 'keydown', key: k.key, code: name.length === 1 ? (/^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name) : k.key, vk: k.vk, text: k.text }, { t: 'keyup', key: k.key, code: k.key, vk: k.vk }]);
    } else await this.page('pressKey', name);
    if (c.log) c.log.props = { Key: name, Input: this.driver.input && this.conf.realInput !== false ? 'trusted (browser input)' : 'dispatched DOM events' };
  }

  /** The Cypress object commands share (`cy.xxx` and chained `.xxx`) — see COMMANDS below. */
  commandContext() { return this; }

  /* ---- environment (Cypress.env / Cypress.config) ---- */
  env(key?: string, value?: unknown): unknown { if (key === undefined) return this.envs; if (arguments.length > 1) { this.envs[key] = value; return undefined; } return this.envs[key]; }
  config(key?: string | Record<string, unknown>, value?: unknown): unknown {
    if (key === undefined) return this.conf;
    if (typeof key === 'object') { Object.assign(this.conf, key); return undefined; }
    if (arguments.length > 1) { this.conf[key] = value; return undefined; }
    return this.conf[key];
  }
  on(event: string, fn: (...a: unknown[]) => unknown, persistent = false) {
    const map = persistent ? this.persistentHandlers : this.handlers;
    (map.get(event) ?? map.set(event, []).get(event)!).push(fn);
    if (event === 'window:confirm') this.dialogDirty = true;
  }
  resetTest() {
    this.aliases = new Map(); this.within = []; this.routes = []; this.consumed = new Map(); this.handlers = new Map(); this.uncaught = []; this.confirmDecision = true; this.testScreenshotCount = 0;
    this.screenshots = [];
  }
  setTest(key: string, title: string) { this.testKey = key; this.currentTestTitle = title; }
  get isOpen() { return this.sessionOpen; }

  /** Clears cookies/storage/routes and blanks the page (test isolation). */
  async isolate() {
    if (!this.sessionOpen) return;
    try { await this.page('clockRestore'); await this.page('clearStorage', 'all'); await this.page('clearCookies'); } catch { /* about:blank has no storage */ }
    if (this.driver.clearCookies) await this.driver.clearCookies().catch(() => undefined);
    if (this.driver.setHeaders) await this.driver.setHeaders({}).catch(() => undefined);
    await this.driver.initScript(this.initSource());
    await this.driver.open('about:blank', 0);
  }
  async shutdown() { /* the window stays open for the next run */ }

  /* ------------------------------------------------------------------ commands */

  readonly defs: Record<string, (c: Ctx, ...a: unknown[]) => Promise<Subject | void>> = {
    visit: async (c, url, options) => {
      const o = (isObj(options) ? options : isObj(url) ? url : {}) as Record<string, unknown>;
      const target = relUrl(String(this.conf.baseUrl ?? ''), String(isObj(url) ? url.url : url));
      let full = target;
      if (isObj(o.qs)) { const u = new URL(target); Object.entries(o.qs).forEach(([k, v]) => u.searchParams.set(k, String(v))); full = u.href; }
      await this.ensureSession();
      const headers: Record<string, string> = isObj(o.headers) ? Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k, String(v)])) : {};
      if (isObj(o.auth)) headers.Authorization = `Basic ${btoa(`${String(o.auth.username ?? '')}:${String(o.auth.password ?? '')}`)}`;
      this.beforeLoad = typeof o.onBeforeLoad === 'function' ? [(o.onBeforeLoad as () => void).toString()] : [];
      await this.driver.initScript(this.initSource());
      if (Object.keys(headers).length) {
        if (!this.driver.setHeaders) throw new Error('cy.visit({ headers, auth }) needs a test browser that can set request headers');
        await this.driver.setHeaders(headers);
      }
      this.uncaught = [];
      const method = String(o.method ?? 'GET').toUpperCase();
      try {
        if (method === 'GET') await this.driver.open(full, 0);
        else {
          // a form post: the browser navigates to the response like a user submitting a form
          await this.driver.open('about:blank', 0);
          const fields = isObj(o.body) ? o.body : {};
          await this.driver.eval(`(function(){ var f = document.createElement('form'); f.method = ${JSON.stringify(method === 'GET' ? 'GET' : 'POST')}; f.action = ${JSON.stringify(full)}; var d = ${JSON.stringify(fields)}; Object.keys(d).forEach(function(k){ var i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = String(d[k]); f.appendChild(i); }); document.body.appendChild(f); f.submit(); return 1; })()`);
        }
      } finally { this.beforeLoad = []; }
      const limit = typeof o.timeout === 'number' ? o.timeout : Number(this.conf.pageLoadTimeout) || 60000;
      const end = Date.now() + limit;
      for (;;) {
        const state = await this.driver.eval('document.readyState').then(unwrap).catch(() => '');
        if (state === 'complete' && (method === 'GET' || unwrap(await this.driver.eval('location.href').catch(() => '""')) !== 'about:blank')) break;
        if (Date.now() >= end) throw new Error(`Timed out after ${limit}ms waiting for the page ${full} to load`);
        await sleep(50);
      }
      if (Object.keys(headers).length && this.driver.setHeaders) await this.driver.setHeaders({}).catch(() => undefined);
      const nav = await this.page<{ status: number }>('navStatus').catch(() => ({ status: 0 }));
      if (nav.status >= 400 && o.failOnStatusCode !== false) {
        throw new Error(`cy.visit() failed trying to load:\n\n${full}\n\nThe response we received from your web server was:\n\n  > ${nav.status}\n\nThis was considered a failure because the status code was not 2xx or 3xx.\n\nIf you do not want status codes to cause failures pass the option: failOnStatusCode: false`);
      }
      if (typeof o.onLoad === 'function') await this.page('evalScript', `(${(o.onLoad as () => void).toString()})(window)`);
      if (c.log) { c.log.props = { URL: full, Status: nav.status || undefined, Headers: Object.keys(headers).length ? Object.keys(headers) : undefined }; c.log.after = await this.snapshot('visit'); }
      await this.page('info');
    },
    go: async (c, dir) => {
      const js = dir === 'back' ? 'history.back()' : dir === 'forward' ? 'history.forward()' : `history.go(${Number(dir)})`;
      await this.driver.eval(js); await sleep(150); await this.page('info').catch(() => undefined);
      if (c.log) c.log.after = await this.snapshot('go');
    },
    reload: async (c) => { await this.driver.eval('location.reload()'); await sleep(200); for (let i = 0; i < 100; i += 1) { if (unwrap(await this.driver.eval('document.readyState')) === 'complete') break; await sleep(50); } await this.page('info').catch(() => undefined); if (c.log) c.log.after = await this.snapshot('reload'); },
    url: async () => ({ kind: 'value', value: (await this.page<{ href: string }>('info')).href, reeval: async () => (await this.page<{ href: string }>('info')).href }),
    hash: async () => ({ kind: 'value', value: (await this.page<{ hash: string }>('info')).hash, reeval: async () => (await this.page<{ hash: string }>('info')).hash }),
    title: async () => ({ kind: 'value', value: (await this.page<{ title: string }>('info')).title, reeval: async () => (await this.page<{ title: string }>('info')).title }),
    location: async (_c, key) => {
      const get = async () => { const i = await this.page<Record<string, unknown>>('info'); return key ? i[String(key)] : i; };
      return { kind: 'value', value: await get(), reeval: get };
    },
    viewport: async (_c, a, b, d) => {
      let w = Number(a), h = Number(b);
      if (typeof a === 'string') {
        const preset = VIEWPORT_PRESETS[a];
        if (!preset) throw new Error(`cy.viewport() could not find a preset for: ${a}. Available presets: ${Object.keys(VIEWPORT_PRESETS).join(', ')}`);
        [w, h] = preset; if (b === 'landscape') [w, h] = [h, w];
      }
      if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000)) throw new Error('cy.viewport() width and height must be between 200 and 4000');
      this.conf.viewportWidth = w; this.conf.viewportHeight = h;
      await this.ensureSession();
      await this.driver.viewport(w, h, isObj(d) ? d.mobile === true : false);
      await sleep(100);
    },
    get: async (c, selector, options) => {
      const o = isObj(options) ? options : {};
      const sel = String(selector);
      if (sel.startsWith('@')) {
        const [name, mod] = sel.slice(1).split('.');
        const al = this.aliases.get(name);
        if (!al) throw new Error(`cy.get() could not find a registered alias for: @${name}. Available aliases are: ${[...this.aliases.keys()].join(', ') || '(none)'}.`);
        if (al.kind === 'route') {
          const read = async () => { const calls = await this.page<Array<Record<string, unknown>>>('calls', 0, name); const list = calls.map((x) => this.interceptionOf(x)); return mod === 'all' ? list : list[list.length - 1] ?? null; };
          return { kind: 'value', value: await read(), reeval: read };
        }
        return al;
      }
      const deep = (o.includeShadowDom ?? this.conf.includeShadowDom) === true;
      const subject: Subject = { kind: 'dom', steps: [{ t: 'get', s: sel, ...(deep ? { deep: true } : {}) }], scope: this.within.map((l) => l), timeout: typeof o.timeout === 'number' ? o.timeout : undefined };
      if (c.peek()?.name === 'should' || c.peek()?.name === 'and') { await this.snapDom(subject); }
      else if (o.log !== false) await this.requireDom(subject, this.timeoutOf(o));
      if (c.log) c.log.before = await this.snapshot(`get ${sel}`, { steps: subject.steps, scope: subject.scope });
      return subject;
    },
    contains: async (c, a, b, d) => {
      let sel: string | undefined; let text: unknown; let opts: Record<string, unknown> = {};
      if (typeof b === 'string' || typeof b === 'number' || b instanceof RegExp) { sel = String(a); text = b; opts = isObj(d) ? d : {}; }
      else { text = a; opts = isObj(b) ? b : {}; }
      const deepContains = (opts.includeShadowDom ?? this.conf.includeShadowDom) === true;
      const step: Step = text instanceof RegExp ? { t: 'contains', s: sel, re: text.source, flags: text.flags, ...(deepContains ? { deep: true } : {}) } : { t: 'contains', s: sel, text: String(text), matchCase: opts.matchCase !== false, ...(deepContains ? { deep: true } : {}) };
      const prev = c.subject;
      const steps = prev.kind === 'dom' ? [...prev.steps, step] : [step];
      const subject: Subject = { kind: 'dom', steps, scope: prev.kind === 'dom' ? prev.scope : this.within.map((l) => l), timeout: typeof opts.timeout === 'number' ? opts.timeout : (prev.kind === 'dom' ? prev.timeout : undefined) };
      if (c.peek()?.name === 'should' || c.peek()?.name === 'and') await this.snapDom(subject);
      else await this.requireDom(subject, this.timeoutOf(opts, subject));
      if (c.log) c.log.before = await this.snapshot('contains', { steps, scope: subject.scope });
      return subject;
    },
    root: async () => ({ kind: 'dom', steps: [{ t: 'root' }], scope: [] }),
    document: async () => ({ kind: 'dom', steps: [{ t: 'root' }], scope: [] }),
    focused: async (c) => { const s: Subject = { kind: 'dom', steps: [{ t: 'focused' }], scope: [] }; if (!c.peek()) await this.requireDom(s, this.timeoutOf()); return s; },
    window: async () => ({ kind: 'win', path: '' }),
    wrap: async (_c, v) => {
      const ch = chainableOf(v);
      if (ch) return ch.subject;
      if (v instanceof JQ && v.subject) return v.subject as Subject;
      if (v && typeof (v as { then?: unknown }).then === 'function') return { kind: 'value', value: await (v as Promise<unknown>) };
      return { kind: 'value', value: v };
    },
    then: async (c, a, b) => {
      const fn = (typeof a === 'function' ? a : b) as (v: unknown) => unknown;
      const s = c.subject;
      let arg: unknown;
      if (s.kind === 'dom') { const jq = new JQ(await this.requireDom(s, this.timeoutOf(null, s))); jq.subject = s; arg = jq; }
      else if (s.kind === 'value') arg = s.value;
      else if (s.kind === 'win') arg = this.winProxy(s.path);
      else arg = undefined;
      let ret: unknown; let nested: Subject = { kind: 'none' };
      const queue: Cmd[] = []; this.queues.push(queue);
      try { ret = fn(arg); if (ret && typeof (ret as { then?: unknown }).then === 'function' && !chainableOf(ret)) ret = await (ret as Promise<unknown>); } finally { this.queues.pop(); }
      if (queue.length) { this.level += 1; try { nested = await this.runQueue(queue); } finally { this.level -= 1; } }
      const retChain = chainableOf(ret);
      if (retChain) return retChain.subject.kind === 'none' ? nested : retChain.subject;
      if (ret !== undefined) return { kind: 'value', value: ret };
      if (queue.length && nested.kind !== 'none') return nested;
    },
    spread: async (c, fn) => { const v = c.subject.kind === 'value' ? c.subject.value : []; (fn as (...a: unknown[]) => unknown)(...(Array.isArray(v) ? v : [v])); },
    each: async (c, fn) => {
      const s = c.subject;
      if (s.kind === 'dom') {
        const d = await this.requireDom(s, this.timeoutOf(null, s));
        for (let i = 0; i < d.count; i += 1) {
          const item = { kind: 'dom', steps: [...s.steps, { t: 'eq', n: i }], scope: s.scope } as Subject;
          const one = new JQ({ count: 1, els: [d.els[i]] }); one.subject = item;
          await this.runCallback(() => (fn as (...a: unknown[]) => unknown)(one, i, new JQ(d)));
        }
      } else if (s.kind === 'value' && Array.isArray(s.value)) {
        const list = s.value as unknown[];
        for (let i = 0; i < list.length; i += 1) await this.runCallback(() => (fn as (...a: unknown[]) => unknown)(list[i], i, list));
      } else throw new Error('cy.each() can only be called on an array or DOM elements');
    },
    its: async (c, path) => this.dig(c.subject, String(path), false, []),
    invoke: async (c, name, ...rest) => this.dig(c.subject, String(name), true, rest),
    should: async (c, chainer, ...args) => { await this.assertRetry(c, chainer, args); },
    and: async (c, chainer, ...args) => { await this.assertRetry(c, chainer, args); },
    as: async (c, name) => {
      const s = c.subject; const n = String(name);
      if (s.kind === 'route') { const r = this.routes.find((x) => x.id === s.id); if (r) r.alias = n; this.aliases.set(n, s); await this.pushRoutes(); return; }
      if (s.kind === 'none') throw new Error('cy.as() needs a subject');
      this.aliases.set(n, s);
      if (c.log) c.log.alias = n;
    },
    within: async (c, a, b) => {
      const s = this.domOf(c.subject, 'within');
      const fn = (typeof a === 'function' ? a : b) as (el: unknown) => unknown;
      const layer = s.steps;
      await this.requireDom(s, this.timeoutOf(null, s));
      this.within = [...this.within, layer];
      try { await this.runCallback(() => fn(new JQ({ count: 1, els: [] }))); } finally { this.within = this.within.slice(0, -1); }
    },
    hover: (c, o) => this.action(c, 'hover', isObj(o) ? o : {}),
    realClick: (c, a, b, d) => this.action(c, 'click', actionOpts(a, b, d)),
    realHover: (c, o) => this.action(c, 'hover', isObj(o) ? o : {}),
    realType: (c, text, o) => this.action(c, 'type', isObj(o) ? o : {}, { text: String(text) }),
    realPress: (c, key) => this.pressKey(c, key),
    press: (c, key) => this.pressKey(c, key),
    iframe: async (c, selector) => {
      const base = typeof selector === 'string' ? ({ kind: 'dom', steps: [{ t: 'get', s: selector }], scope: this.within.map((l) => l) } as Subject) : c.subject;
      const s = this.domOf(base, 'iframe');
      const next: Subject = { kind: 'dom', steps: [...s.steps, { t: 'iframe' }], scope: s.scope, timeout: s.timeout };
      await this.requireDom(next, this.timeoutOf(null, next));
      return next;
    },
    mount: async (c, content, o) => {
      const opts = isObj(o) ? o : {};
      await this.ensureSession();
      if (isObj(content) && typeof content.module === 'string') {
        // Component testing: import a component module from the dev server (Vite & co.) and mount it with React, Vue or its own mount()
        const base = String(this.conf.componentUrl || this.conf.baseUrl || '').replace(/\/+$/, '');
        if (!base) throw new Error('cy.mount({ module }) needs a dev server: set baseUrl (or componentUrl) to the running Vite/dev-server URL — the headless CLI can start one with --component');
        const framework = String(content.framework ?? opts.framework ?? this.conf.componentFramework ?? 'custom');
        const props = isObj(content.props) ? content.props : isObj(opts.props) ? opts.props : {};
        await this.driver.initScript(this.initSource());
        await this.driver.open(`${base}/__pigry/mount.html`, 0);
        const code = `(async function(){ try {`
          + ` var root = document.getElementById('root'); if (!root) { document.body.innerHTML = '<div id="root"></div>'; root = document.getElementById('root'); }`
          + ` var mod = await import(${JSON.stringify(String(content.module))}); var comp = ${content.export ? `mod[${JSON.stringify(String(content.export))}]` : 'mod.default'};`
          + ` if (!comp) throw new Error('the module has no ${content.export ? `export ${String(content.export)}` : 'default export'}');`
          + ` var props = ${JSON.stringify(props)};`
          + (framework === 'react' ? ` var a = await import('/__pigry/react.js'); a.mountReact(root, comp, props);`
            : framework === 'vue' ? ` var a = await import('/__pigry/vue.js'); a.mountVue(root, comp, props);`
            : ` var fn = typeof mod.mount === 'function' ? mod.mount : (typeof comp === 'function' ? comp : null); if (!fn) throw new Error('with framework "custom" the module must export mount(element, props) (or a function component that renders into it)'); var out = await fn(root, props); if (typeof out === 'string') root.innerHTML = out;`)
          + ` return JSON.stringify({ ok: true }); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); } })()`;
        const res = await this.evalAsync(code) as { ok: boolean; error?: string };
        if (!res.ok) throw new Error(`cy.mount() failed: ${res.error}`);
        await this.page('info');
        await sleep(30);
        if (c.log) c.log.props = { Module: content.module, Export: content.export ?? 'default', Framework: framework, Props: props };
        return { kind: 'dom', steps: [{ t: 'get', s: '#root' }], scope: [] };
      }
      await this.driver.open('about:blank', 0);
      const html = typeof content === 'function' ? String((content as () => unknown)()) : String(content ?? '');
      const styles = (Array.isArray(opts.styles) ? opts.styles : opts.styles ? [opts.styles] : []).map(String);
      const scripts = (Array.isArray(opts.scripts) ? opts.scripts : opts.scripts ? [opts.scripts] : []).map(String);
      const code = `(async function(){ document.body.innerHTML = '<div id="root"></div>'; var root = document.getElementById('root'); root.innerHTML = ${JSON.stringify(html)};`
        + `${JSON.stringify(styles)}.forEach(function(s){ if (/^(https?:)?\\/\\//.test(s) || /\\.css$/.test(s)) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = s; document.head.appendChild(l); } else { var st = document.createElement('style'); st.textContent = s; document.head.appendChild(st); } });`
        + `for (var u of ${JSON.stringify(scripts)}) { await new Promise(function(res, rej){ var sc = document.createElement('script'); if (/^(https?:)?\\/\\//.test(u) || /\\.js$/.test(u)) sc.src = u; else sc.textContent = u; sc.onload = res; sc.onerror = function(){ rej(new Error('script failed: ' + u)); }; document.head.appendChild(sc); if (!sc.src) res(); }); }`
        + ` return JSON.stringify('mounted'); })()`;
      await this.evalAsync(code);
      await this.page('info');
      if (c.log) c.log.props = { HTML: html.slice(0, 200), Styles: styles.length, Scripts: scripts.length };
      return { kind: 'dom', steps: [{ t: 'get', s: '#root' }], scope: [] };
    },
    click: (c, a, b, d) => this.action(c, 'click', actionOpts(a, b, d)),
    dblclick: (c, a) => this.action(c, 'dblclick', actionOpts(a)),
    rightclick: (c, a) => this.action(c, 'rightclick', actionOpts(a)),
    type: (c, text, o) => { if (typeof text !== 'string' && typeof text !== 'number') throw new Error('cy.type() can only accept a string or number'); return this.action(c, 'type', isObj(o) ? o : {}, { text: String(text) }); },
    clear: (c, o) => this.action(c, 'clear', isObj(o) ? o : {}),
    check: (c, a, b) => this.action(c, 'check', actionOpts(typeof a === 'string' || Array.isArray(a) ? b : a), { values: typeof a === 'string' ? [a] : Array.isArray(a) ? a : [] }),
    uncheck: (c, a, b) => this.action(c, 'uncheck', actionOpts(typeof a === 'string' || Array.isArray(a) ? b : a), { values: typeof a === 'string' ? [a] : Array.isArray(a) ? a : [] }),
    select: (c, v, o) => this.action(c, 'select', isObj(o) ? o : {}, { values: Array.isArray(v) ? v : [v] }),
    focus: (c, o) => this.action(c, 'focus', isObj(o) ? o : {}),
    blur: (c, o) => this.action(c, 'blur', isObj(o) ? o : {}),
    submit: (c, o) => this.action(c, 'submit', isObj(o) ? o : {}),
    trigger: (c, event, a, b) => this.action(c, 'trigger', isObj(a) ? a : isObj(b) ? b : {}, { event: String(event), init: isObj(a) ? a : isObj(b) ? b : {} }),
    scrollIntoView: (c, o) => this.action(c, 'scrollIntoView', isObj(o) ? o : {}),
    scrollTo: async (c, a, b, d) => {
      const pos = typeof a === 'string' ? a : undefined;
      const o = isObj(b) ? b : isObj(d) ? d : {};
      if (c.subject.kind === 'dom') return this.action(c, 'scrollTo', o, { pos, x: typeof a === 'number' ? a : undefined, y: typeof b === 'number' ? b : undefined });
      const x = typeof a === 'number' ? a : 0, y = typeof b === 'number' ? b : 0;
      const code = pos ? `var m={top:[0,0],center:[.5,.5],bottom:[0,1],left:[0,0],right:[1,0],topLeft:[0,0],topRight:[1,0],bottomLeft:[0,1],bottomRight:[1,1]}[${JSON.stringify(pos)}]||[0,0];window.scrollTo((document.documentElement.scrollWidth-innerWidth)*m[0],(document.documentElement.scrollHeight-innerHeight)*m[1]);` : `window.scrollTo(${x},${y});`;
      await this.driver.eval(`(function(){${code}return 1;})()`);
    },
    selectFile: (c, file, o) => {
      const list = (Array.isArray(file) ? file : [file]).map((f) => isObj(f) ? f : { contents: String(f), fileName: String(f).split('/').pop() });
      return this.action(c, 'selectFile', isObj(o) ? o : {}, { files: list, drag: isObj(o) && o.action === 'drag-drop' });
    },
    wait: async (_c, a, o) => {
      const targets = Array.isArray(a) ? a : [a];
      if (typeof a === 'number') { await sleep(a); return; }
      const out: Array<Record<string, unknown>> = [];
      for (const t of targets) {
        const name = String(t).replace(/^@/, '').split('.')[0];
        const al = this.aliases.get(name);
        if (!al || al.kind !== 'route') throw new Error(`cy.wait() could not find a registered alias for: @${name}. Available aliases are: ${[...this.aliases.entries()].filter(([, v]) => v.kind === 'route').map(([k]) => k).join(', ') || '(none)'}.`);
        const timeout = isObj(o) && typeof o.timeout === 'number' ? o.timeout : Number(this.conf.responseTimeout) || 30000;
        const end = Date.now() + timeout;
        for (;;) {
          const calls = await this.page<Array<Record<string, unknown>>>('calls', this.consumed.get(name) ?? 0, name);
          const done = calls.find((x) => x.state !== 'pending');
          if (done) { this.consumed.set(name, Number(done.i)); out.push(this.interceptionOf(done)); break; }
          if (Date.now() >= end) throw new Error(`cy.wait() timed out waiting ${timeout}ms for the ${(this.consumed.get(name) ?? 0) ? 'next' : '1st'} request to the route: \`${name}\`. No request ever occurred.`);
          await sleep(100);
        }
      }
      return { kind: 'value', value: Array.isArray(a) ? out : out[0] };
    },
    intercept: async (c, ...args) => {
      const route = await this.buildRoute(args);
      this.routes.push(route);
      await this.pushRoutes();
      if (c.log) c.log.props = { Route: route };
      return { kind: 'route', id: route.id };
    },
    request: async (c, a, b, d) => {
      let o: Record<string, unknown>;
      if (isObj(a)) o = { ...a };
      else if (typeof a === 'string' && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(a) && typeof b === 'string') o = { method: a, url: b, body: d };
      else o = { method: 'GET', url: a, ...(b !== undefined ? { body: b } : {}) };
      const url = relUrl(String(this.conf.baseUrl ?? ''), String(o.url));
      const method = String(o.method ?? 'GET').toUpperCase();
      const headers = isObj(o.headers) ? o.headers : {};
      const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      const hdrs = { ...(typeof o.body === 'object' && o.body !== null && !('content-type' in Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), 1]))) ? { 'content-type': 'application/json' } : {}), ...headers };
      const qs = isObj(o.qs) ? o.qs : null;
      await this.ensureSession();
      const target = qs ? (() => { const u = new URL(url); Object.entries(qs).forEach(([k, v]) => u.searchParams.set(k, String(v))); return u.href; })() : url;
      const started = Date.now();
      const code = `(async function(){ try { var r = await fetch(${JSON.stringify(target)}, ${JSON.stringify({ method, headers: hdrs, body, redirect: o.followRedirect === false ? 'manual' : 'follow' })}); var t = await r.text(); var h = {}; r.headers.forEach(function(v,k){h[k]=v;}); return JSON.stringify({ ok:true, status:r.status, statusText:r.statusText, headers:h, body:t }); } catch (e) { return JSON.stringify({ ok:false, error:String(e && e.message || e) }); } })()`;
      const res = await this.evalAsync(code) as { ok: boolean; status?: number; statusText?: string; headers?: Record<string, string>; body?: string; error?: string };
      if (!res.ok) throw new Error(`cy.request() failed trying to load: ${target}\n\n${res.error}\n\n(cy.request runs inside the test browser, so it follows CORS: use the application's own origin, or an API that allows it.)`);
      let parsed: unknown = res.body;
      if (typeof res.body === 'string' && (/json/i.test(res.headers?.['content-type'] ?? '') || /^\s*[{[]/.test(res.body))) { try { parsed = JSON.parse(res.body); } catch { /* text */ } }
      const response = { status: res.status, statusText: res.statusText, headers: res.headers, body: parsed, duration: Date.now() - started, isOkStatusCode: (res.status ?? 0) >= 200 && (res.status ?? 0) < 300, requestHeaders: hdrs, allRequestResponses: [] };
      if (c.log) { c.log.message = `${method} ${res.status} ${target}`; c.log.kind = 'request'; c.log.props = { Request: { method, url: target, headers: hdrs, body: o.body }, Response: { status: res.status, body: parsed, headers: res.headers } }; }
      if (o.failOnStatusCode !== false && !response.isOkStatusCode) throw new Error(`cy.request() failed on:\n\n${target}\n\nThe response we received from your web server was:\n\n  > ${res.status}: ${res.statusText}\n\nThis was considered a failure because the status code was not 2xx or 3xx.\n\nIf you do not want status codes to cause failures pass the option: failOnStatusCode: false`);
      return { kind: 'value', value: response };
    },
    fixture: async (_c, name) => ({ kind: 'value', value: await this.readFixture(String(name)) }),
    readFile: async (_c, path) => {
      const text = await this.driver.readFile(String(path));
      if (text === null) throw new Error(`cy.readFile("${path}") failed because the file does not exist`);
      let v: unknown = text; if (/\.json$/i.test(String(path))) { try { v = JSON.parse(text); } catch { /* text */ } }
      return { kind: 'value', value: v };
    },
    writeFile: async (_c, path, contents) => {
      const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p === '.git' || p.startsWith('.git/')) throw new Error('cy.writeFile() can only write inside the workspace (not .git/ and not outside it)');
      await this.driver.writeFile(p, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
    },
    exec: async (_c, command, o) => {
      const opts = isObj(o) ? o : {};
      const res = await this.driver.exec(String(command), typeof opts.timeout === 'number' ? Math.ceil(opts.timeout / 1000) : undefined);
      if (res.code !== 0 && opts.failOnNonZeroExit !== false) throw new Error(`cy.exec("${command}") failed with the exit code: ${res.code}\n\n${res.output.slice(-600)}`);
      return { kind: 'value', value: { code: res.code, stdout: res.output, stderr: '' } };
    },
    task: async (_c, name, arg, o) => {
      const fn = this.tasks.get(String(name));
      if (!fn) throw new Error(`The task '${String(name)}' was not handled. Register it with Cypress.tasks({ ${String(name)}(arg) { return … } }) in the spec or the support file (tasks run in the runner, not in Node — use cy.exec() for shell commands).`);
      const timeout = isObj(o) && typeof o.timeout === 'number' ? o.timeout : 60000;
      const value = await Promise.race([Promise.resolve().then(() => fn(arg)), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`cy.task('${String(name)}') timed out after ${timeout}ms`)), timeout))]);
      if (value === undefined) throw new Error(`cy.task('${String(name)}') failed because the task handler returned undefined. Return a value or null.`);
      return { kind: 'value', value };
    },
    screenshot: async (c, a, b) => {
      const name = typeof a === 'string' ? a : '';
      const o = { ...this.screenshotDefaults, ...(isObj(a) ? a : isObj(b) ? b : {}) } as Record<string, unknown>;
      await this.ensureSession();
      const rel = this.shotPath(name || `${++this.testScreenshotCount}`);
      let shot: { fullPage?: boolean; clip?: { x: number; y: number; w: number; h: number } } | undefined;
      const pad = Number(o.padding ?? 0) || 0;
      if (c.subject.kind === 'dom') {
        const sub = c.subject;
        const r = await this.requireDom(sub, this.timeoutOf(o, sub)).then(() => this.page<{ x: number; y: number; w: number; h: number; sx: number; sy: number } | null>('rect', sub.steps, sub.scope));
        if (r) shot = { clip: { x: Math.max(0, r.x + r.sx - pad), y: Math.max(0, r.y + r.sy - pad), w: r.w + pad * 2, h: r.h + pad * 2 } };
      } else if (isObj(o.clip)) {
        const m = await this.page<{ sx: number; sy: number }>('metrics');
        shot = { clip: { x: Number(o.clip.x ?? 0) + m.sx, y: Number(o.clip.y ?? 0) + m.sy, w: Number(o.clip.width ?? 0), h: Number(o.clip.height ?? 0) } };
      } else if (o.capture === 'fullPage') shot = { fullPage: true };
      const blackout = Array.isArray(o.blackout) ? (o.blackout as string[]) : [];
      if (blackout.length) await this.page('blackout', blackout);
      if (o.disableTimersAndAnimations !== false) await this.page('freeze', true).catch(() => undefined);
      try { await this.driver.screenshot(rel, shot); } finally {
        if (blackout.length) await this.page('unblackout').catch(() => undefined);
        await this.page('freeze', false).catch(() => undefined);
      }
      this.screenshots.push(rel);
      if (c.log) c.log.props = { Path: rel, Capture: shot?.clip ? 'element/clip' : shot?.fullPage ? 'full page' : 'viewport', Blackout: blackout.length ? blackout : undefined };
      if (c.subject.kind === 'dom') return c.subject;
    },
    log: async (c, message) => { if (c.log) { c.log.kind = 'log'; c.log.message = String(message); } },
    pause: async (c) => {
      if (!this.opts.onPause) { if (c.log) c.log.message = 'skipped in run mode'; return; }
      if (c.log) c.log.message = 'paused — resume to continue';
      const choice = await this.opts.onPause({ spec: this.opts.spec, test: this.currentTestTitle, command: 'pause', line: c.cmd.line });
      if (choice === 'step') this.stepping = true;
      else if (choice === 'stop') throw new StopRun('stopped');
      if (c.log) c.log.message = choice === 'step' ? 'resumed (stepping)' : 'resumed';
    },
    debug: async (c) => { if (c.log) c.log.props = { Subject: c.subject.kind === 'dom' ? this.describeSteps(c.subject.steps) : c.subject }; },
    end: async () => ({ kind: 'none' }),
    clock: async (_c, a, b) => {
      const now = typeof a === 'number' ? a : a instanceof Date ? a.getTime() : Date.now();
      const only = Array.isArray(a) ? a : Array.isArray(b) ? b : undefined;
      await this.ensureSession();
      await this.page('clockInstall', now, only);
      const chain = this.chainFor();
      const api = { tick: (ms: number) => { this.cyApi!.tick(ms); return api; }, restore: () => { this.cyApi!.defsRun('clockRestore'); return api; }, now };
      void chain;
      return { kind: 'value', value: api };
    },
    tick: async (_c, ms) => { await this.page('clockTick', Number(ms)); },
    clockRestore: async () => { await this.page('clockRestore'); },
    spy: async (_c, target, method) => this.spyOrStub(target, method, null),
    stub: async (_c, target, method, impl) => {
      if (target === undefined) { const s = makeStub(); return { kind: 'value', value: s }; }
      return this.spyOrStub(target, method, impl);
    },
    getAllLocalStorage: async () => { const d = await this.page<{ origin: string; local: Record<string, string> }>('storeDump'); return { kind: 'value', value: { [d.origin]: d.local } }; },
    getAllSessionStorage: async () => { const d = await this.page<{ origin: string; session: Record<string, string> }>('storeDump'); return { kind: 'value', value: { [d.origin]: d.session } }; },
    getCookie: async (_c, name) => { const all = await this.allCookies(); return { kind: 'value', value: all.find((x) => x.name === name) ?? null }; },
    getCookies: async () => ({ kind: 'value', value: await this.allCookies() }),
    setCookie: async (_c, name, value, o) => {
      const opts = isObj(o) ? o : {};
      if (this.driver.setCookie) await this.driver.setCookie({ name: String(name), value: String(value), path: typeof opts.path === 'string' ? opts.path : '/', domain: typeof opts.domain === 'string' ? opts.domain : undefined, httpOnly: opts.httpOnly === true, secure: opts.secure === true });
      else await this.page('setCookie', String(name), String(value), opts);
    },
    clearCookie: async (_c, name) => { if (this.driver.clearCookies) await this.driver.clearCookies(String(name)); else await this.page('clearCookies', String(name)); },
    clearCookies: async () => { await this.clearAllCookies(); },
    clearAllCookies: async () => { await this.clearAllCookies(); },
    clearLocalStorage: async (_c, key) => { await this.page('clearStorage', 'local', typeof key === 'string' ? key : undefined); },
    clearAllLocalStorage: async () => { await this.page('clearStorage', 'local'); },
    clearAllSessionStorage: async () => { await this.page('clearStorage', 'session'); },
    session: async (c, id, setup, o) => {
      const opts = isObj(o) ? o : {};
      const key = typeof id === 'string' ? id : JSON.stringify(id);
      let saved = this.sessions.get(key) as { origin: string; local: Record<string, string>; session: Record<string, string>; cookies: unknown[] } | undefined;
      await this.ensureSession();
      if (saved && !opts.__force) {
        if (saved.origin && saved.origin !== 'null') await this.driver.open(saved.origin, 0);
        await this.page('storeRestore', saved);
        if (typeof opts.validate === 'function') { await this.runCallback(opts.validate as () => unknown); }
        if (c.log) c.log.message = `${key} (restored)`;
        return;
      }
      await this.page('clearCookies'); await this.page('clearStorage', 'all');
      await this.runCallback(setup as () => unknown);
      saved = await this.page('storeDump');
      this.sessions.set(key, saved);
      if (typeof opts.validate === 'function') await this.runCallback(opts.validate as () => unknown);
      if (c.log) c.log.message = `${key} (created)`;
    },
    origin: async (_c, _url, a, b) => {
      // One browser tab, no origin isolation: the callback just runs (with its arguments, like Cypress).
      const fn = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown;
      const args = Array.isArray(a) ? a : isObj(a) && 'args' in a ? [a.args] : [];
      if (typeof fn !== 'function') throw new Error('cy.origin(url, callback) needs a callback');
      await this.runCallback(() => fn(...args));
    },
  };

  private shotPath(name: string): string {
    const safe = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return `${this.opts.evidenceDir}/${safe(this.currentTestTitle) || 'test'}--${safe(name) || 'shot'}.png`;
  }

  /** Runs the cy commands a callback enqueues (one level deeper) before returning. */
  private async runCallback(body: () => unknown): Promise<void> {
    const queue: Cmd[] = []; this.queues.push(queue);
    let ret: unknown;
    try { ret = body(); if (ret && typeof (ret as { then?: unknown }).then === 'function' && !chainableOf(ret)) await (ret as Promise<unknown>); } finally { this.queues.pop(); }
    if (queue.length) { this.level += 1; try { await this.runQueue(queue); } finally { this.level -= 1; } }
  }

  private winProxy(path: string): unknown {
    const handler: ProxyHandler<object> = {
      get: (_t, prop) => (prop === '__path' ? path : typeof prop === 'string' ? this.winProxy(path ? `${path}.${prop}` : prop) : undefined),
    };
    return new Proxy(function () { /* handle */ }, handler);
  }

  private async spyOrStub(target: unknown, method: unknown, impl: unknown): Promise<Subject> {
    const path = target && typeof target === 'function' ? (target as unknown as { __path?: string }).__path : undefined;
    if (path !== undefined && typeof method === 'string') {
      const id = await this.page<number>('spy', path, method, impl === undefined ? null : typeof impl === 'function' ? (impl as () => void).toString() : impl === null ? null : `function(){return ${JSON.stringify(impl)};}`);
      const get = async () => ({ calls: await this.page<Array<{ args: unknown[] }>>('spyCalls', id) });
      const v = await get();
      return { kind: 'value', value: { ...v, callCount: v.calls.length }, reeval: async () => { const r = await get(); return { ...r, callCount: r.calls.length }; } };
    }
    const obj = target as Record<string, unknown>;
    if (obj && typeof method === 'string' && typeof obj[method] === 'function') {
      const orig = obj[method] as (...a: unknown[]) => unknown;
      const s = makeStub(impl === undefined ? orig : typeof impl === 'function' ? (impl as (...a: unknown[]) => unknown) : () => impl);
      obj[method] = s; s.restore = () => { obj[method] = orig; };
      return { kind: 'value', value: s };
    }
    throw new Error('cy.spy()/cy.stub() needs an object and a method name (or a window handle such as win.console)');
  }

  private async dig(s: Subject, path: string, call: boolean, args: unknown[]): Promise<Subject> {
    const read = async (): Promise<unknown> => {
      if (s.kind === 'win') return this.page('evalPath', path, args, call);
      if (s.kind === 'dom') {
        const d = await this.snapDom(s);
        const jq = new JQ(d);
        if (call) { const fn = (jq as unknown as Record<string, unknown>)[path]; if (typeof fn !== 'function') throw new Error(`cy.invoke() could not find the jQuery method "${path}"`); return (fn as (...a: unknown[]) => unknown).apply(jq, args); }
        if (path === 'length') return d.count;
        return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), jq);
      }
      if (s.kind === 'value') {
        const base = s.reeval ? await s.reeval() : s.value;
        if (call) {
          const parts = path.split('.'); const last = parts.pop()!; const parent = parts.reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), base);
          const fn = parent == null ? undefined : (parent as Record<string, unknown>)[last];
          if (typeof fn !== 'function') throw new Error(`cy.invoke() errored because the property: \`${path}\` is not a function. You tried to invoke it on ${fmt(base, 50)}`);
          return (fn as (...a: unknown[]) => unknown).apply(parent, args);
        }
        return path.split('.').filter(Boolean).reduce<unknown>((o, k) => { if (o == null) return undefined; return (o as Record<string, unknown>)[k]; }, base);
      }
      throw new Error(`cy.${call ? 'invoke' : 'its'}() requires a subject`);
    };
    const value = await read();
    if (!call && value === undefined && s.kind !== 'win') throw new Error(`Timed out retrying: cy.its() errored because the property: \`${path}\` does not exist on your subject.`);
    return { kind: 'value', value, reeval: read };
  }
}

function actionOpts(...candidates: unknown[]): Record<string, unknown> {
  for (const c of candidates) if (isObj(c)) return c;
  const pos = candidates.find((c) => typeof c === 'string');
  const nums = candidates.filter((c) => typeof c === 'number') as number[];
  return pos ? { position: pos } : nums.length >= 2 ? { x: nums[0], y: nums[1] } : {};
}

/* ------------------------------------------------------------- DSL build */

function buildCy(engine: Engine, customs: Map<string, { fn: (...a: unknown[]) => unknown; type: string; orig?: string }>) {
  const defs = engine.defs;
  const make = (chain: Chain) => {
    const api: Record<string, unknown> = {};
    Object.defineProperty(api, CHAIN, { value: chain, enumerable: false });
    const add = (name: string, run: (c: Ctx, ...a: unknown[]) => Promise<Subject | void>) => {
      api[name] = (...args: unknown[]) => { engine.enqueue(name, args, chain, (c) => run(c, ...args)); return api; };
    };
    for (const name of Object.keys(defs)) add(name, defs[name]);
    for (const q of QUERIES) {
      add(q, async (c, ...a) => {
        const s = engine.domOf(c.subject, q);
        const step: Step = { t: q };
        if (typeof a[0] === 'string') step.s = a[0]; else if (typeof a[0] === 'number') step.n = a[0];
        if (STRING_QUERY.has(q) && step.s === undefined) throw new Error(`cy.${q}() needs a selector`);
        const o = isObj(a[1]) ? a[1] : {};
        if ((o.includeShadowDom ?? engine.cfg.includeShadowDom) === true && q === 'find') step.deep = true;
        const next: Subject = { kind: 'dom', steps: [...s.steps, step], scope: s.scope, timeout: typeof o.timeout === 'number' ? o.timeout : s.timeout };
        if (c.peek()?.name === 'should' || c.peek()?.name === 'and') await engine.snapDom(next);
        else await engine.requireDom(next, engine.timeoutOf(null, next));
        return next;
      });
    }
    for (const [name, def] of customs) {
      api[name] = (...args: unknown[]) => {
        engine.enqueue(name, args, chain, async (c) => {
          const prevSubject = c.subject;
          const queue: Cmd[] = []; engine.queues.push(queue);
          let ret: unknown;
          try {
            ret = def.type === 'parent' ? def.fn(...args) : def.fn(prevSubject.kind === 'value' ? prevSubject.value : prevSubject, ...args);
            if (ret && typeof (ret as { then?: unknown }).then === 'function' && !chainableOf(ret)) ret = await (ret as Promise<unknown>);
          } finally { engine.queues.pop(); }
          let nested: Subject = { kind: 'none' };
          if (queue.length) nested = await engine.runQueue(queue);
          const retChain = chainableOf(ret);
          if (retChain) return retChain.subject.kind === 'none' ? nested : retChain.subject;
          return nested.kind !== 'none' ? nested : prevSubject;
        });
        return api;
      };
    }
    return api;
  };
  const root = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === 'then') return undefined;
      if (prop === 'on') return (event: string, fn: (...a: unknown[]) => unknown) => engine.on(event, typeof fn === 'function' ? fn : () => fn);
      if (prop === 'state' || prop === 'queue') return undefined;
      const chain = new Chain();
      const api = make(chain);
      if (prop in api) return api[prop];
      throw new Error(`cy.${prop} is not a function — it is not part of the Cypress API supported by Pigry's runner`);
    },
  });
  return { root, make };
}

/* ---------------------------------------------------------------- runSpec */

const LODASH_LITE = {
  times: (n: number, fn?: (i: number) => unknown) => Array.from({ length: n }, (_, i) => (fn ? fn(i) : i)),
  range: (a: number, b?: number) => (b === undefined ? Array.from({ length: a }, (_, i) => i) : Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)),
  sum: (l: number[]) => l.reduce((x, y) => x + y, 0), uniq: <T,>(l: T[]) => [...new Set(l)], first: <T,>(l: T[]) => l[0], last: <T,>(l: T[]) => l[l.length - 1],
  get: (o: unknown, p: string, d?: unknown) => { const r = String(p).split('.').reduce<unknown>((x, k) => (x == null ? undefined : (x as Record<string, unknown>)[k]), o); return r === undefined ? d : r; },
  pick: (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])),
  omit: (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))),
  isEqual: deepEqual, capitalize: (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(), random: (a: number, b?: number) => (b === undefined ? Math.floor(Math.random() * (a + 1)) : a + Math.floor(Math.random() * (b - a + 1))),
  sample: <T,>(l: T[]) => l[Math.floor(Math.random() * l.length)], shuffle: <T,>(l: T[]) => [...l].sort(() => Math.random() - 0.5), flatten: (l: unknown[]) => l.flat(), compact: (l: unknown[]) => l.filter(Boolean),
  sortBy: <T,>(l: T[], k: string | ((x: T) => unknown)) => [...l].sort((a, b) => { const f = typeof k === 'function' ? k : (x: T) => (x as Record<string, unknown>)[k]; const x = f(a) as number, y = f(b) as number; return x < y ? -1 : x > y ? 1 : 0; }),
  groupBy: <T,>(l: T[], k: string | ((x: T) => string)) => l.reduce<Record<string, T[]>>((m, x) => { const key = String(typeof k === 'function' ? k(x) : (x as Record<string, unknown>)[k]); (m[key] ??= []).push(x); return m; }, {}),
  map: <T, R>(l: T[], f: (x: T, i: number) => R) => l.map(f), filter: <T,>(l: T[], f: (x: T) => boolean) => l.filter(f), each: <T,>(l: T[], f: (x: T, i: number) => void) => { l.forEach(f); return l; }, includes: (l: unknown, v: unknown) => (Array.isArray(l) || typeof l === 'string' ? (l as unknown[] | string).includes(v as never) : false),
};

export async function runSpec(opts: RunOptions): Promise<SpecResult> {
  const startedAt = Date.now();
  const engine = new Engine(opts);
  const cfg = opts.config;
  const browserName = opts.browser ? [opts.browser.displayName, opts.browser.majorVersion].filter((v) => v !== '').join(' ') : undefined;
  const cypressBrowser = opts.browser ?? cypressBrowserOf(undefined);
  const notes: string[] = [];
  const results: TestResult[] = [];
  const rootSuite: SuiteNode = { title: '', parent: null, tests: [], suites: [], skip: false, only: false, before: [], beforeEach: [], after: [], afterEach: [], order: [] };
  let currentSuite = rootSuite;
  let anyOnly = false;
  let counter = 0;
  const customs = new Map<string, { fn: (...a: unknown[]) => unknown; type: string; orig?: string }>();

  const addTest = (title: string, a: unknown, b: unknown, flags: { skip?: boolean; only?: boolean }) => {
    const fn = (typeof a === 'function' ? a : typeof b === 'function' ? b : null) as (() => unknown) | null;
    const conf = (isObj(a) ? a : isObj(b) ? b : {}) as Record<string, unknown>;
    const node: TestNode = { key: `t${++counter}`, title: [], fn, skip: !!flags.skip || !fn, only: !!flags.only, retries: typeof conf.retries === 'number' ? conf.retries : isObj(conf.retries) && typeof conf.retries.runMode === 'number' ? conf.retries.runMode : undefined, suite: currentSuite };
    const titles: string[] = []; for (let s: SuiteNode | null = currentSuite; s; s = s.parent) if (s.title) titles.unshift(s.title);
    node.title = [...titles, title];
    if (flags.only) anyOnly = true;
    currentSuite.tests.push(node); currentSuite.order.push(node);
  };
  const addSuite = (title: string, a: unknown, b: unknown, flags: { skip?: boolean; only?: boolean }) => {
    const fn = (typeof a === 'function' ? a : b) as () => void;
    const suite: SuiteNode = { title, parent: currentSuite, tests: [], suites: [], skip: !!flags.skip || currentSuite.skip, only: !!flags.only, before: [], beforeEach: [], after: [], afterEach: [], order: [] };
    if (flags.only) anyOnly = true;
    currentSuite.suites.push(suite); currentSuite.order.push(suite);
    const prev = currentSuite; currentSuite = suite;
    try { fn(); } finally { currentSuite = prev; }
  };
  const itFn = Object.assign((t: string, a?: unknown, b?: unknown) => addTest(t, a, b, {}), {
    only: (t: string, a?: unknown, b?: unknown) => addTest(t, a, b, { only: true }),
    skip: (t: string, a?: unknown, b?: unknown) => addTest(t, a, b, { skip: true }),
  });
  const descFn = Object.assign((t: string, a?: unknown, b?: unknown) => addSuite(t, a, b, {}), {
    only: (t: string, a?: unknown, b?: unknown) => addSuite(t, a, b, { only: true }),
    skip: (t: string, a?: unknown, b?: unknown) => addSuite(t, a, b, { skip: true }),
  });
  const hook = (kind: 'before' | 'beforeEach' | 'after' | 'afterEach') => (a: unknown, b?: unknown) => { const fn = (typeof a === 'function' ? a : b) as () => unknown; currentSuite[kind].push(fn); };

  const { root: cy, make } = buildCy(engine, customs);
  const Cypress = {
    env: (...a: unknown[]) => (engine.env as (...x: unknown[]) => unknown)(...a),
    config: (...a: unknown[]) => (engine.config as (...x: unknown[]) => unknown)(...a),
    on: (event: string, fn: unknown) => { if (event === 'task' && isObj(fn)) engine.registerTasks(fn as Record<string, (arg: unknown) => unknown>); else engine.on(event, fn as (...a: unknown[]) => unknown, true); },
    tasks: (map: Record<string, (arg: unknown) => unknown>) => engine.registerTasks(map),
    Keyboard: { Keys: KEYBOARD_KEYS, defaults: () => undefined },
    Screenshot: { defaults: (o: Record<string, unknown>) => { Object.assign(engine.screenshotDefaults, o); } },
    Cookies: { defaults: () => undefined, preserveOnce: () => undefined },
    Commands: {
      addQuery: (name: string, fn: (...x: unknown[]) => unknown) => customs.set(name, { fn, type: 'child' }),
      overwriteQuery: (name: string, fn: (orig: (...a: unknown[]) => unknown, ...a: unknown[]) => unknown) => {
        const orig = (...a: unknown[]) => (make(new Chain()) as Record<string, (...x: unknown[]) => unknown>)[name](...a);
        customs.set(name, { fn: (...a: unknown[]) => fn(orig, ...a), type: 'child' });
      },
      add: (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (...x: unknown[]) => unknown;
        const o = isObj(a) ? a : {};
        customs.set(name, { fn, type: o.prevSubject ? 'child' : 'parent' });
      },
      addAll: (defs: Record<string, (...a: unknown[]) => unknown>) => Object.entries(defs).forEach(([k, fn]) => customs.set(k, { fn, type: 'parent' })),
      overwrite: (name: string, fn: (orig: (...a: unknown[]) => unknown, ...a: unknown[]) => unknown) => {
        const orig = (...a: unknown[]) => (make(new Chain()) as Record<string, (...x: unknown[]) => unknown>)[name](...a);
        customs.set(name, { fn: (...a: unknown[]) => fn(orig, ...a), type: 'parent' });
      },
    },
    _: LODASH_LITE, browser: cypressBrowser, isBrowser: (matcher: Parameters<typeof isBrowser>[1]) => isBrowser(cypressBrowser, matcher), platform: 'win32', version: 'pigry',
    spec: { name: opts.spec, relative: opts.spec }, isCy: (v: unknown) => !!chainableOf(v),
    get currentTest() { return { title: engine.currentTestTitle.split(' -- ').pop(), titlePath: engine.currentTestTitle.split(' -- ') }; },
    sinon: { stub: (o?: Record<string, unknown>, m?: string) => (o && m ? engine.defs.stub as never : makeStub()), spy: makeStub },
    dom: {}, log: () => undefined, $: undefined,
  };
  const wrappedCy = new Proxy(cy, { get: (t, p: string) => (p === 'on' ? (e: string, fn: (...a: unknown[]) => unknown) => engine.on(e, typeof fn === 'function' ? fn : () => fn) : t[p]) });
  engine.cyApi = {
    tick: (ms: number) => { (make(new Chain()) as Record<string, (...a: unknown[]) => unknown>).tick(ms); },
    defsRun: (name: string) => { (make(new Chain()) as Record<string, (...a: unknown[]) => unknown>)[name](); },
  };

  /* ---- evaluate the spec to build the suite tree ---- */
  const evalError = (e: unknown): SpecResult => ({
    spec: opts.spec, status: 'error', startedAt, ms: Date.now() - startedAt, tests: [], passed: 0, failed: 0, pending: 0, config: cfg, browser: browserName,
    error: `The spec could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
  });
  const globals: Record<string, unknown> = {
    cy: wrappedCy, Cypress, describe: descFn, context: descFn, xdescribe: descFn.skip, xcontext: descFn.skip, it: itFn, specify: itFn, xit: itFn.skip, xspecify: itFn.skip,
    before: hook('before'), beforeEach: hook('beforeEach'), after: hook('after'), afterEach: hook('afterEach'),
    expect: expectFn, assert: assertFn, _: LODASH_LITE, Chainable: Chain,
  };
  const names = Object.keys(globals);
  const host: ModuleHost = {
    readFile: (p) => opts.driver.readFile(p),
    transpile: opts.transpile,
    nodeRequire: opts.nodeRequire,
    shims: { lodash: LODASH_LITE, 'lodash/fp': LODASH_LITE },
  };
  const scopeValues = names.map((n) => globals[n]);
  const specPath = opts.specPath ?? `${opts.spec}${opts.typescript ? '.cy.ts' : '.cy.js'}`;
  /** Evaluates one entry file (spec, support or plugins) with the Cypress globals and a `require` for its relative imports. */
  const evaluate = async (path: string, source: string, label: string): Promise<{ exports: unknown } | { error: SpecResult }> => {
    try {
      const graph = await loadModuleGraph(host, path, source);
      const module = { exports: {} as unknown };
      const req = makeRequire(graph, host, { names, values: scopeValues }, path);
      const fn = new Function('module', 'exports', 'require', ...names, '"use strict";\n' + `${graph.entryCode}\n//# sourceURL=pigry-${label}.js`);
      fn(module, module.exports, req, ...scopeValues);
      return module;
    } catch (e) {
      const err = evalError(e);
      return { error: label === 'spec' ? err : { ...err, error: `The ${label} file could not be loaded: ${e instanceof Error ? e.message : String(e)}` } };
    }
  };
  if (opts.support && opts.support.trim()) {
    // the support file runs first, in the same scope: its custom commands and hooks apply to every test of the spec
    const sup = await evaluate(opts.supportPath ?? 'support.js', opts.support, 'support');
    if ('error' in sup) return sup.error;
  }
  const pluginOn = (event: string, handler: unknown) => {
    if (event === 'task' && isObj(handler)) engine.registerTasks(handler as Record<string, (arg: unknown) => unknown>);
    else if (typeof handler === 'function') engine.on(event, handler as (...a: unknown[]) => unknown, true);
  };
  if (opts.setupNodeEvents) {
    try { const out = await opts.setupNodeEvents(pluginOn, engine.config() as Record<string, unknown>); if (isObj(out)) engine.config(out); }
    catch (e) { return { ...evalError(e), error: `setupNodeEvents failed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  if (opts.plugins && opts.plugins.trim()) {
    // setupNodeEvents(on, config): tasks and run events — in the runner (the CLI gives them a real Node `require`)
    const plug = await evaluate(opts.pluginsPath ?? 'plugins.js', opts.plugins, 'plugins');
    if ('error' in plug) return plug.error;
    try {
      const exp = plug.exports as unknown;
      const setup = (typeof exp === 'function' ? exp : isObj(exp) && typeof exp.default === 'function' ? exp.default : isObj(exp) && typeof exp.setupNodeEvents === 'function' ? exp.setupNodeEvents : null) as ((on: (e: string, h: unknown) => void, config: Record<string, unknown>) => unknown) | null;
      if (setup) {
        const out = await setup((event, handler) => {
          if (event === 'task' && isObj(handler)) engine.registerTasks(handler as Record<string, (arg: unknown) => unknown>);
          else if (typeof handler === 'function') engine.on(event, handler as (...a: unknown[]) => unknown, true);
        }, engine.config() as Record<string, unknown>);
        if (isObj(out)) engine.config(out);
      }
    } catch (e) { return { ...evalError(e), error: `setupNodeEvents failed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const loaded = await evaluate(specPath, opts.source, 'spec');
  if ('error' in loaded) return loaded.error;

  /* ---- flatten and execute ---- */
  const allTests: TestNode[] = [];
  const collect = (s: SuiteNode) => { for (const item of s.order) { if ('fn' in item) allTests.push(item); else collect(item); } };
  collect(rootSuite);
  const insideOnly = (t: TestNode): boolean => t.only || (() => { for (let s: SuiteNode | null = t.suite; s; s = s.parent) if (s.only) return true; return false; })();
  const grep = opts.grep?.toLowerCase();
  const planned = allTests.map((t) => {
    const skipped = t.skip || (anyOnly && !insideOnly(t)) || (grep ? !t.title.join(' ').toLowerCase().includes(grep) : false) || (() => { for (let s: SuiteNode | null = t.suite; s; s = s.parent) if (s.skip) return true; return false; })();
    return { t, skipped };
  });
  opts.onEvent?.({ type: 'spec:start', spec: opts.spec, tests: planned.map(({ t, skipped }) => ({ key: t.key, title: t.title, status: (skipped ? 'pending' : 'skipped') as TestStatus })).map((x) => ({ ...x, status: 'pending' as TestStatus })) });

  let videoPath: string | undefined;
  if (cfg.video && opts.engine === 'bidi') {
    notes.push(`No video: recording needs a Chromium or Playwright browser — ${cypressBrowser.displayName} (WebDriver BiDi) has no screencast.`);
  } else if (cfg.video) {
    try { await engineEnsure(engine); videoPath = `${opts.evidenceDir}/${opts.spec.replace(/[^\w.-]+/g, '-')}.webm`; await opts.driver.recordStart(videoPath); } catch { videoPath = undefined; }
  }

  const doneSuites = new Set<SuiteNode>();
  const startedSuites = new Set<SuiteNode>();
  const runHooks = async (hooks: Array<() => unknown>, label: string, key: string) => {
    for (const h of hooks) {
      engine.setTest(key, engine.currentTestTitle);
      await engine.runBlock(h);
      void label;
    }
  };
  const chainOf = (s: SuiteNode): SuiteNode[] => { const out: SuiteNode[] = []; for (let x: SuiteNode | null = s; x; x = x.parent) out.unshift(x); return out; };

  let stopped = false;
  const runnable = planned.filter((p) => !p.skipped);
  const lastIndexOfSuite = new Map<SuiteNode, number>();
  runnable.forEach((p, i) => chainOf(p.t.suite).forEach((s) => lastIndexOfSuite.set(s, i)));

  for (const { t, skipped } of planned) {
    if (stopped) break;
    const title = t.title.join(' -- ');
    if (skipped) {
      const r: TestResult = { key: t.key, title: t.title, status: 'pending', ms: 0, attempts: 0, log: [], screenshots: [] };
      results.push(r); opts.onEvent?.({ type: 'test:end', result: r });
      continue;
    }
    const maxRetries = t.retries ?? cfg.retries;
    let attempt = 0; let result: TestResult | null = null;
    while (attempt <= maxRetries) {
      attempt += 1;
      opts.onEvent?.({ type: 'test:start', key: t.key, attempt });
      const started = Date.now();
      engine.setTest(t.key, title); engine.resetTest(); engine.takeLogs();
      engine.fire('test:before:run', { title: t.title[t.title.length - 1], titlePath: t.title, attempt });
      let error: TestError | undefined; let status: TestStatus = 'passed';
      const suiteChain = chainOf(t.suite);
      try {
        if (cfg.testIsolation) await engine.isolate();
        for (const s of suiteChain) if (!startedSuites.has(s)) { startedSuites.add(s); await runHooks(s.before, 'before all', t.key); }
        for (const s of suiteChain) await runHooks(s.beforeEach, 'before each', t.key);
        await engine.runBlock(t.fn!);
      } catch (e) {
        if (e instanceof StopRun) { stopped = true; status = 'skipped'; }
        else {
          status = 'failed';
          const err = e as Error & { cmd?: { name: string; line?: number } };
          const line = err.cmd?.line;
          error = { message: err.message, name: err.name || 'Error', line, frame: line ? codeFrame(opts.source, line) : undefined, command: err.cmd?.name };
          engine.fire('fail', { message: err.message, name: err.name }, { title: t.title[t.title.length - 1] });
        }
      }
      try { for (const s of [...suiteChain].reverse()) await runHooks(s.afterEach, 'after each', t.key); } catch (e) {
        if (!(e instanceof StopRun) && status === 'passed') { status = 'failed'; error = { message: `An afterEach hook failed: ${(e as Error).message}`, name: 'Error' }; }
      }
      let consoleText: string | undefined; let networkFile: string | undefined;
      if (status === 'failed') {
        if (cfg.screenshotOnRunFailure) {
          try { const rel = `${opts.evidenceDir}/${title.replace(/[^\w.-]+/g, '-').slice(0, 80)}--failed${attempt > 1 ? `-attempt-${attempt}` : ''}.png`; await opts.driver.screenshot(rel); engine.screenshots.push(rel); } catch { /* no page */ }
        }
        try { consoleText = (await opts.driver.console()).slice(-1500); } catch { /* ignore */ }
      }
      if (cfg.networkEvidence && engine.isOpen) {
        try { networkFile = `${opts.evidenceDir}/${title.replace(/[^\w.-]+/g, '-').slice(0, 80)}--api.json`; await opts.driver.networkExport(networkFile); } catch { networkFile = undefined; }
      }
      result = { key: t.key, title: t.title, status, ms: Date.now() - started, attempts: attempt, error, log: engine.takeLogs(), screenshots: [...engine.screenshots], console: consoleText, networkFile, ...(status === 'passed' && attempt > 1 ? { flaky: true } : {}) };
      engine.fire('test:after:run', { title: t.title[t.title.length - 1], titlePath: t.title, status, attempt });
      if (status !== 'failed') break;
      if (attempt <= maxRetries && !stopped) opts.onEvent?.({ type: 'test:end', result: { ...result, status: 'failed' } });
    }
    if (result) {
      results.push(result); opts.onEvent?.({ type: 'test:end', result });
      // after-all hooks of suites that just ran their last test
      const idx = runnable.findIndex((p) => p.t === t);
      for (const s of [...chainOf(t.suite)].reverse()) if (lastIndexOfSuite.get(s) === idx && !doneSuites.has(s) && startedSuites.has(s)) { doneSuites.add(s); try { await runHooks(s.after, 'after all', t.key); } catch { /* reported by the next run */ } }
    }
  }

  if (videoPath) { try { await opts.driver.recordStop(); } catch { videoPath = undefined; } }
  const passed = results.filter((r) => r.status === 'passed').length, failed = results.filter((r) => r.status === 'failed').length, pending = results.filter((r) => r.status === 'pending' || r.status === 'skipped').length;
  const spec: SpecResult = { spec: opts.spec, status: failed > 0 ? 'failed' : 'passed', startedAt, ms: Date.now() - startedAt, tests: results, passed, failed, pending, video: videoPath, config: cfg, browser: browserName, ...(notes.length ? { notes } : {}) };
  opts.onEvent?.({ type: 'spec:end', result: spec });
  return spec;
}

async function engineEnsure(engine: Engine) {
  await (engine as unknown as { ensureSession(): Promise<void> }).ensureSession();
}

export { isDomSnap };
