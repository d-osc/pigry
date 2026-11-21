/** E2E files in the workspace and the shared state between the E2E screen and
 * the agent's e2e tools.
 *
 *   .pigry/e2e/specs/<owner>/<name>.cy.js      the specs (owner = agent username, or "user")
 *   .pigry/e2e/fixtures/<name>.json            data for cy.fixture() / cy.intercept({fixture})
 *   .pigry/e2e/e2e.config.json                 settings (baseUrl, viewport, timeouts, env, …)
 *   .pigry/e2e/results/<owner>/<name>.json     the latest result of each spec (commands, errors, evidence)
 *   .pigry/e2e/results/history.json            the last runs
 *   .pigry/e2e/evidence/<owner>/<name>/        screenshots, network JSON and videos of the latest run */
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from '../tauriClient';
import { pathOf, refFromPath, refKey, resolveRef, sortRefs, type OwnedRef, type Resolved } from '../ownedFiles';
import { globToRegex, runSpec, type E2eConfig, type RunEvent, type RunOptions, type Snapshot, type SpecResult, type Driver } from './runner';
import { tauriDriver } from './driver';
import { buildReplay, mergeConfig, resultToJUnit, type ReplayFile, type StatsFile, type TestStat } from './report';
export * from './report';
import { transpileTs } from './transpile';
import { CYPRESS_CONFIG_FILES, loadCypressConfig, type CypressConfigFile } from './configFile';

export const E2E_DIR = '.pigry/e2e/';
export const SPECS_DIR = `${E2E_DIR}specs/`;
export const SPEC_EXT = '.cy.js';
export const SPEC_EXT_TS = '.cy.ts';
export const ENV_FILE = `${E2E_DIR}e2e.env.json`;

/** A spec reference that remembers its file extension (JavaScript or TypeScript). */
export type SpecRef = OwnedRef & { ext?: typeof SPEC_EXT | typeof SPEC_EXT_TS; /** workspace path of a spec that lives outside .pigry/ (owner "repo") */ path?: string };
export const REPO_OWNER = 'repo';
export const FIXTURES_DIR = `${E2E_DIR}fixtures/`;
export const RESULTS_DIR = `${E2E_DIR}results/`;
export const EVIDENCE_DIR = `${E2E_DIR}evidence/`;
export const CONFIG_PATH = `${E2E_DIR}e2e.config.json`;
export const HISTORY_PATH = `${RESULTS_DIR}history.json`;
export const STATS_PATH = `${RESULTS_DIR}stats.json`;

export const E2E_CHANGED = 'pigry:e2e-changed';
export const E2E_OPEN = 'pigry:open-e2e';

export interface E2eChange { key: string; source: 'editor' | 'agent'; deleted?: boolean; kind?: 'spec' | 'result' | 'config' }

export const specPath = (ref: OwnedRef): string => (ref as SpecRef).path ?? pathOf(SPECS_DIR, (ref as SpecRef).ext ?? SPEC_EXT, ref);
export const resultPath = (ref: OwnedRef): string => pathOf(RESULTS_DIR, '.json', ref);
export const replayPath = (ref: OwnedRef): string => pathOf(RESULTS_DIR, '.replay.json', ref);
export const evidenceDir = (ref: OwnedRef): string => `${EVIDENCE_DIR}${ref.owner ? `${ref.owner}/` : ''}${ref.slug}`;

export function notifyE2eChanged(change: E2eChange): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<E2eChange>(E2E_CHANGED, { detail: change }));
}

export async function listSpecRefs(): Promise<SpecRef[]> {
  const tree = await getFileTree();
  const out: SpecRef[] = [];
  for (const ext of [SPEC_EXT, SPEC_EXT_TS] as const) {
    for (const p of tree.entries) {
      const ref = refFromPath(SPECS_DIR, ext, p);
      if (ref && !out.some((r) => r.owner === ref.owner && r.slug === ref.slug)) out.push({ ...ref, ext });
    }
  }
  // specs that already live in the repository (cypress/e2e/login.cy.js, e2e/*.cy.ts …) show up under the owner "repo"
  const taken = new Set(out.map((r) => `${r.owner}/${r.slug}`));
  const cfg = await loadConfig().catch(() => null);
  const include = (cfg?.specPattern ?? []).map(globToRegex);
  const exclude = (cfg?.excludeSpecPattern ?? []).map(globToRegex);
  for (const p of tree.entries) {
    const wanted = /\.cy\.(js|ts)$/.test(p) || include.some((re) => re.test(p));
    if (p.startsWith('.pigry/') || /(^|\/)node_modules\//.test(p) || !wanted || exclude.some((re) => re.test(p)) || out.length > 400) continue;
    const base = p.replace(/\.(cy\.)?(js|jsx|ts|tsx)$/, '').replace(/^(cypress\/e2e|cypress|e2e|tests?)\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'spec';
    let slug = base; let n = 2;
    while (taken.has(`${REPO_OWNER}/${slug}`)) { slug = `${base}-${n}`; n += 1; }
    taken.add(`${REPO_OWNER}/${slug}`);
    out.push({ owner: REPO_OWNER, slug, ext: /\.tsx?$/.test(p) ? SPEC_EXT_TS : SPEC_EXT, path: p });
  }
  return sortRefs(out) as SpecRef[];
}

export async function listFixtures(): Promise<string[]> {
  const tree = await getFileTree();
  const own = tree.entries.filter((p) => p.startsWith(FIXTURES_DIR)).map((p) => p.slice(FIXTURES_DIR.length));
  const theirs = tree.entries.filter((p) => p.startsWith('cypress/fixtures/')).map((p) => p.slice('cypress/fixtures/'.length));
  return [...new Set([...own, ...theirs])].sort();
}

export async function resolveSpec(name: string, caller?: string): Promise<Resolved> {
  return resolveRef(await listSpecRefs(), name, caller, [SPEC_EXT, SPEC_EXT_TS, '.cy', '.js', '.ts']);
}

export async function loadSpecSource(ref: OwnedRef): Promise<string> {
  const f = await readWorktreeFile(specPath(ref));
  if (f.binary || f.tooLarge) throw new Error(`${specPath(ref)} is not a readable spec`);
  return f.content;
}

export async function saveSpecSource(ref: OwnedRef, source: string, who: E2eChange['source'] = 'editor'): Promise<string> {
  await writeWorktreeFile(specPath(ref), source);
  notifyE2eChanged({ key: refKey(ref), source: who, kind: 'spec' });
  return specPath(ref);
}

export async function removeSpec(ref: OwnedRef): Promise<void> {
  await deleteWorktreeFile(specPath(ref));
  notifyE2eChanged({ key: refKey(ref), source: 'editor', deleted: true, kind: 'spec' });
}

/* ---- settings ---- */

/** The project's own cypress.config.js/.ts, evaluated (null when there is none or it cannot be read). */
export async function loadCypressFile(): Promise<CypressConfigFile | null> {
  for (const path of CYPRESS_CONFIG_FILES) {
    let text: string;
    try { const f = await readWorktreeFile(path); if (f.binary) continue; text = f.content; } catch { continue; }
    try {
      return await loadCypressConfig({ readFile: async (p) => { try { const f = await readWorktreeFile(p); return f.binary ? null : f.content; } catch { return null; } }, transpile: transpileTs }, path, text);
    } catch { return null; }
  }
  return null;
}

export async function loadConfig(): Promise<E2eConfig> {
  let config: E2eConfig;
  const fromCypress = await loadCypressFile().catch(() => null);
  try {
    const f = await readWorktreeFile(CONFIG_PATH);
    config = mergeConfig({ ...(fromCypress?.settings ?? {}), specPattern: fromCypress?.specPattern, excludeSpecPattern: fromCypress?.excludeSpecPattern, ...JSON.parse(f.content) });
  } catch { config = mergeConfig({ ...(fromCypress?.settings ?? {}), specPattern: fromCypress?.specPattern, excludeSpecPattern: fromCypress?.excludeSpecPattern }); }
  // e2e.env.json (like cypress.env.json) holds secrets you keep out of version control; its values win
  for (const file of ['cypress.env.json', ENV_FILE]) {
    try {
      const env = JSON.parse((await readWorktreeFile(file)).content) as unknown;
      if (env && typeof env === 'object' && !Array.isArray(env)) config.env = { ...config.env, ...(env as Record<string, unknown>) };
    } catch { /* no env file */ }
  }
  return config;
}

export async function saveConfig(config: E2eConfig, who: E2eChange['source'] = 'editor'): Promise<void> {
  await writeWorktreeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  notifyE2eChanged({ key: 'config', source: who, kind: 'config' });
}

/* ---- results ---- */

export interface HistoryEntry { spec: string; status: 'passed' | 'failed' | 'error'; passed: number; failed: number; pending: number; ms: number; at: number; video?: string }

export async function loadResult(ref: OwnedRef): Promise<SpecResult | null> {
  try { return JSON.parse((await readWorktreeFile(resultPath(ref))).content) as SpecResult; } catch { return null; }
}
export async function loadHistory(): Promise<HistoryEntry[]> {
  try { const list = JSON.parse((await readWorktreeFile(HISTORY_PATH)).content) as HistoryEntry[]; return Array.isArray(list) ? list : []; } catch { return []; }
}
export async function loadReplay(ref: OwnedRef): Promise<ReplayFile | null> {
  try { return JSON.parse((await readWorktreeFile(replayPath(ref))).content) as ReplayFile; } catch { return null; }
}

async function saveResult(ref: OwnedRef, result: SpecResult, snapshots?: Snapshot[]): Promise<void> {
  const replay = snapshots ? buildReplay(result, snapshots) : null;
  if (replay) await writeWorktreeFile(replayPath(ref), JSON.stringify(replay)).catch(() => undefined);
  else await deleteWorktreeFile(replayPath(ref)).catch(() => undefined);
  // the stored log keeps no snapshot ids (they only mean something together with the replay file)
  const stored: SpecResult = { ...result, tests: result.tests.map((t) => ({ ...t, log: t.log.map((l) => { const { before: _b, after: _a, ...rest } = l; void _b; void _a; return rest; }) })) };
  await writeWorktreeFile(resultPath(ref), JSON.stringify(stored));
  const history = await loadHistory();
  history.unshift({ spec: refKey(ref), status: result.status, passed: result.passed, failed: result.failed, pending: result.pending, ms: result.ms, at: result.startedAt, video: result.video });
  await writeWorktreeFile(HISTORY_PATH, JSON.stringify(history.slice(0, 60)));
  await writeWorktreeFile(pathOf(RESULTS_DIR, '.junit.xml', ref), resultToJUnit(result)).catch(() => undefined);
  await updateStats(refKey(ref), result).catch(() => undefined);
  notifyE2eChanged({ key: refKey(ref), source: 'agent', kind: 'result' });
}

/* ---- running (one run at a time: there is one test browser) ---- */

let running: { ref: string; stop: boolean } | null = null;
export const currentRun = (): string | null => (running ? running.ref : null);
export const stopRun = (): void => { if (running) running.stop = true; };

export interface RunRefOptions {
  driver?: Driver;
  grep?: string;
  onEvent?: (e: RunEvent) => void;
  snapshotSink?: Snapshot[];
  configOverride?: Partial<E2eConfig>;
  onPause?: RunOptions['onPause'];
  step?: boolean;
}

let lastWebSecurity = true;

export async function runSpecRef(ref: OwnedRef, o: RunRefOptions = {}): Promise<SpecResult> {
  if (running) throw new Error(`a spec is already running (${running.ref}) — there is a single test browser; wait for it or stop it`);
  const state = { ref: refKey(ref), stop: false };
  running = state;
  notifyE2eChanged({ key: state.ref, source: 'editor', kind: 'result' });
  try {
    const [source, config] = await Promise.all([loadSpecSource(ref), loadConfig()]);
    const merged = { ...config, ...o.configOverride };
    let support = ''; let supportPath: string | undefined;
    for (const file of [merged.supportFile, 'cypress/support/e2e.js', 'cypress/support/e2e.ts'].filter(Boolean)) {
      try { const f = await readWorktreeFile(file); if (!f.binary) { support = f.content; supportPath = file; break; } } catch { /* try the next one */ }
    }
    let plugins = ''; let pluginsPath: string | undefined;
    for (const file of [merged.pluginsFile].filter(Boolean)) {
      try { const f = await readWorktreeFile(file); if (!f.binary) { plugins = f.content; pluginsPath = file; break; } } catch { /* no plugins file */ }
    }
    const cypressFile = await loadCypressFile().catch(() => null);
    const driver = o.driver ?? tauriDriver();
    if (driver.setWebSecurity) {
      // the switch is a launch flag: restart the test browser when it changes
      if (lastWebSecurity !== merged.chromeWebSecurity) await driver.close().catch(() => undefined);
      await driver.setWebSecurity(merged.chromeWebSecurity).catch(() => undefined);
      lastWebSecurity = merged.chromeWebSecurity;
    }
    const sink: Snapshot[] | undefined = o.snapshotSink ?? (merged.snapshots ? [] : undefined);
    const result = await runSpec({
      driver, config: merged, spec: refKey(ref), source, evidenceDir: evidenceDir(ref), support, supportPath, plugins, pluginsPath, specPath: specPath(ref), setupNodeEvents: cypressFile?.setupNodeEvents,
      typescript: (ref as SpecRef).ext === SPEC_EXT_TS, transpile: transpileTs,
      onEvent: o.onEvent, shouldStop: () => state.stop, grep: o.grep, snapshotSink: sink, onPause: o.onPause, step: o.step,
    });
    await saveResult(ref, result, sink);
    return result;
  } finally {
    running = null;
    notifyE2eChanged({ key: state.ref, source: 'editor', kind: 'result' });
  }
}

/* ---- reports ---- */

/* ---- starter specs ---- */

export interface SpecTemplate { id: string; label: string; hint: string; source: string }

export const SPEC_TEMPLATES: SpecTemplate[] = [
  { id: 'blank', label: 'Blank spec', hint: 'An empty describe / it', source: `describe('My feature', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('works', () => {
    cy.get('body').should('be.visible');
  });
});
` },
  { id: 'smoke', label: 'Smoke test', hint: 'Open the site, check title, heading and links', source: `describe('Smoke test', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('loads the home page', () => {
    cy.title().should('not.be.empty');
    cy.get('h1').should('be.visible');
    cy.url().should('include', Cypress.config('baseUrl'));
  });

  it('has no broken main navigation', () => {
    cy.get('nav a').each(($a) => {
      expect($a.attr('href')).to.be.a('string');
    });
  });

  it('looks right on a phone', () => {
    cy.viewport('iphone-x');
    cy.get('body').should('be.visible');
    cy.screenshot('mobile-home');
  });
});
` },
  { id: 'form', label: 'Form & login', hint: 'Type, check, select, submit and assert', source: `describe('Sign in form', () => {
  beforeEach(() => {
    cy.visit('/login');
  });

  it('shows validation errors for an empty form', () => {
    cy.contains('button', /sign in|log in/i).click();
    cy.get('[role=alert], .error').should('be.visible');
  });

  it('signs in with valid credentials', () => {
    cy.get('input[type=email]').type('user@example.com');
    cy.get('input[type=password]').type('{selectall}secret123{enter}', { log: false });
    cy.url().should('not.include', '/login');
    cy.contains(/welcome|dashboard/i).should('be.visible');
  });

  it('remembers me and picks a language', () => {
    cy.get('input[type=checkbox]').check().should('be.checked');
    cy.get('select').select('English').should('have.value', 'en');
  });
});
` },
  { id: 'api', label: 'Network & API', hint: 'cy.intercept stubs, cy.wait on aliases, cy.request', source: `describe('Network', () => {
  it('stubs the users API and shows the data', () => {
    cy.intercept('GET', '**/api/users*', {
      statusCode: 200,
      body: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }],
      delay: 100,
    }).as('users');
    cy.visit('/');
    cy.wait('@users').its('response.statusCode').should('eq', 200);
    cy.contains('Ada').should('be.visible');
  });

  it('shows an error state when the API fails', () => {
    cy.intercept('GET', '**/api/users*', { statusCode: 500, body: { message: 'boom' } }).as('users');
    cy.visit('/');
    cy.wait('@users');
    cy.contains(/error|try again/i).should('be.visible');
  });

  it('checks an endpoint directly', () => {
    cy.request('/api/health').then((res) => {
      expect(res.status).to.eq(200);
    });
  });
});
` },
  { id: 'css', label: 'CSS & responsive', hint: 'Check styles, dark mode and breakpoints', source: `describe('Styles', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('primary button uses the brand colour', () => {
    cy.get('button.primary').should('have.css', 'background-color', 'rgb(37, 99, 235)');
    cy.get('button.primary').should('have.css', 'border-radius', '8px');
  });

  [['iphone-6', 375], ['ipad-2', 768], ['macbook-13', 1280]].forEach(([preset, width]) => {
    it('fits the screen on ' + preset, () => {
      cy.viewport(preset);
      cy.window().its('innerWidth').should('eq', width);
      cy.document().its('documentElement.scrollWidth').should('be.lte', width);
      cy.screenshot('layout-' + preset);
    });
  });
});
` },
];

/** Type definitions that give the spec editor autocompletion for the supported Cypress API. */
export const CYPRESS_DTS = `
declare namespace Cypress {
  interface Options { timeout?: number; force?: boolean; log?: boolean; multiple?: boolean; position?: 'topLeft'|'top'|'topRight'|'left'|'center'|'right'|'bottomLeft'|'bottom'|'bottomRight'; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; scrollBehavior?: 'center'|'top'|'bottom'|'nearest'|false; [key: string]: unknown }
  interface Chainable<S = unknown> {
    visit(url: string, options?: { qs?: object; timeout?: number; failOnStatusCode?: boolean; headers?: Record<string, string>; auth?: { username: string; password: string }; method?: 'GET' | 'POST'; body?: object; onBeforeLoad?: (win: any) => void; onLoad?: (win: any) => void }): Chainable<S>;
    go(direction: 'back'|'forward'|number): Chainable<S>;
    reload(): Chainable<S>;
    url(): Chainable<string>;
    hash(): Chainable<string>;
    title(): Chainable<string>;
    location(key?: string): Chainable<any>;
    viewport(width: number, height: number): Chainable<S>;
    viewport(preset: 'macbook-16'|'macbook-15'|'macbook-13'|'macbook-11'|'ipad-2'|'ipad-mini'|'iphone-xr'|'iphone-x'|'iphone-6+'|'iphone-se2'|'iphone-8'|'iphone-7'|'iphone-6'|'iphone-5'|'iphone-4'|'iphone-3'|'samsung-s10'|'samsung-note9', orientation?: 'portrait'|'landscape'): Chainable<S>;
    get(selector: string, options?: Options): Chainable<JQuery>;
    contains(content: string | number | RegExp, options?: Options): Chainable<JQuery>;
    contains(selector: string, content: string | number | RegExp, options?: Options): Chainable<JQuery>;
    find(selector: string, options?: Options): Chainable<JQuery>;
    filter(selector: string): Chainable<JQuery>; not(selector: string): Chainable<JQuery>;
    first(): Chainable<JQuery>; last(): Chainable<JQuery>; eq(index: number): Chainable<JQuery>;
    children(selector?: string): Chainable<JQuery>; parent(selector?: string): Chainable<JQuery>; parents(selector?: string): Chainable<JQuery>;
    closest(selector: string): Chainable<JQuery>; siblings(selector?: string): Chainable<JQuery>;
    next(selector?: string): Chainable<JQuery>; prev(selector?: string): Chainable<JQuery>; nextAll(selector?: string): Chainable<JQuery>; prevAll(selector?: string): Chainable<JQuery>;
    within(fn: (el: JQuery) => void): Chainable<S>;
    root(): Chainable<JQuery>; focused(): Chainable<JQuery>; document(): Chainable<Document>; window(): Chainable<Window>;
    click(options?: Options): Chainable<S>; click(position: string, options?: Options): Chainable<S>; click(x: number, y: number, options?: Options): Chainable<S>;
    dblclick(options?: Options): Chainable<S>; rightclick(options?: Options): Chainable<S>;
    hover(options?: Options): Chainable<S>; realHover(options?: Options): Chainable<S>; realClick(options?: Options): Chainable<S>; realType(text: string, options?: Options): Chainable<S>;
    press(key: string): Chainable<S>; realPress(key: string): Chainable<S>;
    iframe(selector?: string): Chainable<JQuery>; shadow(): Chainable<JQuery>;
    parentsUntil(selector: string): Chainable<JQuery>; nextUntil(selector: string): Chainable<JQuery>; prevUntil(selector: string): Chainable<JQuery>;
    mount(content: string | (() => string), options?: { styles?: string | string[]; scripts?: string | string[] }): Chainable<JQuery>;
    /** Component testing: import a component module from the dev server (baseUrl/componentUrl) and mount it. */
    mount(component: { module: string; export?: string; props?: Record<string, unknown>; framework?: 'react' | 'vue' | 'custom' }): Chainable<JQuery>;
    origin(url: string, callback: () => void): Chainable<S>; origin<A>(url: string, args: A, callback: (args: A) => void): Chainable<S>;
    task(name: string, arg?: unknown, options?: { timeout?: number }): Chainable<any>;
    getAllLocalStorage(): Chainable<any>; getAllSessionStorage(): Chainable<any>;
    type(text: string, options?: Options & { delay?: number; parseSpecialCharSequences?: boolean }): Chainable<S>;
    clear(options?: Options): Chainable<S>;
    check(value?: string | string[], options?: Options): Chainable<S>; uncheck(value?: string | string[], options?: Options): Chainable<S>;
    select(value: string | number | Array<string | number>, options?: Options): Chainable<S>;
    focus(): Chainable<S>; blur(): Chainable<S>; submit(): Chainable<S>;
    trigger(eventName: string, options?: Options): Chainable<S>;
    scrollIntoView(options?: Options): Chainable<S>; scrollTo(position: string | number, y?: number | Options, options?: Options): Chainable<S>;
    selectFile(file: string | { contents: string; fileName?: string; mimeType?: string } | Array<unknown>, options?: Options): Chainable<S>;
    should(chainer: string, ...args: unknown[]): Chainable<S>; should(fn: (subject: any) => void): Chainable<S>;
    and(chainer: string, ...args: unknown[]): Chainable<S>; and(fn: (subject: any) => void): Chainable<S>;
    then<R>(fn: (subject: S) => R | Chainable<R> | void): Chainable<R>;
    each(fn: (item: any, index: number, list: any) => void): Chainable<S>;
    spread(fn: (...args: any[]) => void): Chainable<S>;
    its(property: string): Chainable<any>; invoke(method: string, ...args: unknown[]): Chainable<any>;
    as(alias: string): Chainable<S>; wrap<T>(value: T): Chainable<T>;
    wait(ms: number): Chainable<S>; wait(alias: string | string[], options?: Options): Chainable<any>;
    intercept(url: string | RegExp, response?: unknown): Chainable<null>;
    intercept(method: string, url: string | RegExp, response?: unknown): Chainable<null>;
    intercept(matcher: { method?: string; url?: string | RegExp; pathname?: string; hostname?: string; query?: object; headers?: object; times?: number }, response?: unknown): Chainable<null>;
    request(url: string): Chainable<any>; request(method: string, url: string, body?: unknown): Chainable<any>;
    request(options: { method?: string; url: string; body?: unknown; headers?: object; qs?: object; failOnStatusCode?: boolean }): Chainable<any>;
    fixture(name: string): Chainable<any>;
    readFile(path: string): Chainable<any>; writeFile(path: string, contents: unknown): Chainable<null>;
    exec(command: string, options?: { failOnNonZeroExit?: boolean; timeout?: number }): Chainable<{ code: number; stdout: string; stderr: string }>;
    screenshot(name?: string, options?: Options & { capture?: 'viewport' | 'fullPage'; clip?: { x: number; y: number; width: number; height: number }; padding?: number; blackout?: string[]; disableTimersAndAnimations?: boolean }): Chainable<S>;
    log(message: string): Chainable<S>; pause(): Chainable<S>; debug(): Chainable<S>;
    clock(now?: number | Date, functionNames?: string[]): Chainable<any>; tick(ms: number): Chainable<S>;
    spy(object: any, method: string): Chainable<any>; stub(object?: any, method?: string, fn?: unknown): Chainable<any>;
    getCookie(name: string): Chainable<any>; getCookies(): Chainable<any[]>; setCookie(name: string, value: string, options?: object): Chainable<S>;
    clearCookie(name: string): Chainable<null>; clearCookies(): Chainable<null>; clearAllCookies(): Chainable<null>;
    clearLocalStorage(key?: string): Chainable<S>; clearAllLocalStorage(): Chainable<S>; clearAllSessionStorage(): Chainable<S>;
    session(id: string | object, setup: () => void, options?: { validate?: () => void }): Chainable<null>;
    on(event: 'uncaught:exception' | 'window:alert' | 'window:confirm', fn: (...args: any[]) => any): void;
  }
}
declare const cy: Cypress.Chainable;
declare const Cypress: {
  env(key?: string, value?: unknown): any; config(key?: string | object, value?: unknown): any;
  on(event: 'uncaught:exception' | 'window:alert' | 'window:confirm' | 'test:before:run' | 'test:after:run' | 'fail', fn: (...args: any[]) => any): void;
  tasks(handlers: Record<string, (arg: any) => any>): void; Keyboard: { Keys: Record<string, string>; defaults(o: object): void }; Screenshot: { defaults(o: object): void };
  Commands: { addQuery(name: string, fn: (...args: any[]) => any): void; overwriteQuery(name: string, fn: (...args: any[]) => any): void; add(name: string, fn: (...args: any[]) => any): void; add(name: string, options: { prevSubject?: boolean | string }, fn: (...args: any[]) => any): void; overwrite(name: string, fn: (...args: any[]) => any): void };
  _: any; browser: any; platform: string; spec: { name: string }; currentTest: { title: string; titlePath: string[] };
};
declare function describe(title: string, fn: () => void): void; declare namespace describe { function only(title: string, fn: () => void): void; function skip(title: string, fn: () => void): void }
declare function context(title: string, fn: () => void): void;
declare function it(title: string, fn?: () => void | Promise<void>): void; declare function it(title: string, config: { retries?: number }, fn: () => void): void;
declare namespace it { function only(title: string, fn: () => void): void; function skip(title: string, fn?: () => void): void }
declare function specify(title: string, fn?: () => void): void;
declare function before(fn: () => void): void; declare function beforeEach(fn: () => void): void; declare function after(fn: () => void): void; declare function afterEach(fn: () => void): void;
declare const expect: any; declare const assert: any;
`;

export async function loadStats(): Promise<StatsFile> {
  try { const v = JSON.parse((await readWorktreeFile(STATS_PATH)).content) as unknown; return v && typeof v === 'object' ? v as StatsFile : {}; } catch { return {}; }
}

async function updateStats(spec: string, r: SpecResult): Promise<void> {
  const all = await loadStats();
  const mine = all[spec] ?? {};
  for (const t of r.tests) {
    if (t.status === 'pending' || t.status === 'skipped') continue;
    const key = t.title.join(' › ');
    const st: TestStat = mine[key] ?? { runs: 0, passes: 0, fails: 0, flaky: 0, totalMs: 0, lastMs: 0, lastStatus: '', lastAt: 0 };
    st.runs += 1; st.totalMs += t.ms; st.lastMs = t.ms; st.lastStatus = t.status; st.lastAt = r.startedAt;
    if (t.status === 'passed') { st.passes += 1; if (t.flaky) st.flaky += 1; } else st.fails += 1;
    mine[key] = st;
  }
  all[spec] = mine;
  await writeWorktreeFile(STATS_PATH, JSON.stringify(all));
}

