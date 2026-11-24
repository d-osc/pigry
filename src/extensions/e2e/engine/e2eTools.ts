/** Agent tools for the E2E Testing menu (a Cypress-style runner). Specs are
 * plain files — .pigry/e2e/specs/<owner>/<name>.cy.js, one folder per agent —
 * that these tools write, run and report on; the E2E editor shows the same
 * runs live. */
import type { ToolSpec } from '../../../lib/agentTools';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../../lib/ownedFiles';
import { writeWorktreeFile } from '../../../lib/tauriClient';
import { analyticsOf, loadStats, resultPath, SPEC_EXT_TS, type SpecRef, loadResult, listFixtures, listSpecRefs, loadConfig, loadHistory, loadSpecSource, mergeConfig, notifyE2eChanged, resolveSpec, resultSummary, resultToMarkdown, runSpecRef, saveConfig, saveSpecSource, specPath, checkSpecSource, E2E_OPEN, FIXTURES_DIR, SPEC_EXT, SPEC_TEMPLATES, currentRun } from './spec';
import { pageCall, tauriDriver } from './driver';

const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const fail = (message: string): string => `error: ${message}`;
const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.spec ?? '').trim();

/* ---- shared state with the editor: flush unsaved edits, open a spec ---- */

const flushers = new Set<() => Promise<void>>();
export function registerE2eFlush(flush: () => Promise<void>): () => void { flushers.add(flush); return () => { flushers.delete(flush); }; }
export async function flushE2eEditors(): Promise<void> { await Promise.all([...flushers].map((f) => f().catch(() => undefined))); }

export interface E2eOpenRequest { key: string; line?: number; run?: boolean }
let pendingOpen: E2eOpenRequest | null = null;
let openKey: string | null = null;
export function requestOpenE2e(key: string, opts: { line?: number; run?: boolean } = {}): void {
  pendingOpen = { key, ...opts };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<E2eOpenRequest>(E2E_OPEN, { detail: pendingOpen }));
}
export function takePendingOpenE2e(): E2eOpenRequest | null { const r = pendingOpen; pendingOpen = null; return r; }
export const setOpenE2e = (key: string | null): void => { openKey = key; };
export const getOpenE2e = (): string | null => openKey;

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; source: string } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see e2e_list)');
  await flushE2eEditors();
  const resolved = await resolveSpec(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see e2e_list)`);
  try { return { ref: resolved.ref, source: await loadSpecSource(resolved.ref) }; } catch (e) { return fail(`could not read spec "${name}" — ${e instanceof Error ? e.message : String(e)}`); }
}

const API_HELP =
  'Specs are plain JavaScript in the Cypress style: describe/context/it/specify (+ .only/.skip, retries: it("x", {retries: 2}, fn)), before/beforeEach/after/afterEach, cy.visit/get/contains/find/within/click/dblclick/rightclick/type/clear/check/uncheck/select/focus/blur/submit/trigger/scrollTo/scrollIntoView/selectFile, ' +
  '.should/.and chainers (be.visible, exist, not.exist, have.text, contain.text, have.value, have.attr, have.class, have.css, have.length, be.checked, be.disabled, …), cy.intercept (static responses, fixtures, handler functions) + cy.wait("@alias"), cy.request, cy.fixture, cy.readFile/writeFile, cy.exec, cy.clock/tick, cy.viewport (presets like "iphone-x"), ' +
  'cy.screenshot (element, clip, fullPage, blackout), cy.hover-free realHover/realClick/realType/cy.press (trusted browser input), cy.iframe, shadow DOM (includeShadowDom), cy.mount (framework-less components), cy.origin, cy.task via Cypress.tasks, cy.visit options (headers, auth, method, onBeforeLoad), cookies/localStorage commands (httpOnly included), cy.session, cy.on("uncaught:exception"|"window:confirm"|"window:alert"), Cypress.env/config/Commands.add, expect/assert. Relative cy.visit URLs use the baseUrl from e2e_config. Use data-cy / data-testid selectors. No imports, no TypeScript, no await on cy commands.';

export const E2E_TOOLS: ToolSpec[] = [
  {
    id: 'e2e_list',
    name: 'e2e_list',
    description: 'List the E2E specs in the workspace (owner/name with the result of their last run), the fixtures, the settings and whether a run is in progress.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      const [refs, config, fixtures, history] = await Promise.all([listSpecRefs(), loadConfig(), listFixtures(), loadHistory()]);
      const lines: string[] = [];
      for (const ref of refs) {
        const last = history.find((h) => h.spec === refKey(ref));
        lines.push(`- ${refKey(ref)}${last ? ` — last run ${last.status} (${last.passed} passed, ${last.failed} failed)` : ' — never run'}`);
      }
      const running = currentRun();
      return `Specs (${refs.length}):\n${lines.join('\n') || '(none yet — create one with e2e_write)'}\nFixtures: ${fixtures.join(', ') || '(none)'}\nSettings: baseUrl=${config.baseUrl || '(not set)'}, viewport ${config.viewportWidth}x${config.viewportHeight}, timeout ${config.defaultCommandTimeout}ms, retries ${config.retries}, video ${config.video}, env keys: ${Object.keys(config.env).join(', ') || '(none)'}${running ? `\nRunning now: ${running}` : ''}\nTemplates: ${SPEC_TEMPLATES.map((t) => t.id).join(', ')}`;
    },
  },
  {
    id: 'e2e_read',
    name: 'e2e_read',
    description: 'Read a spec with line numbers (so failures that name a line can be fixed). Pass results: true to add the last run.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Spec name, or owner/name' }, results: { type: 'boolean' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const numbered = opened.source.split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
      let out = `${refKey(opened.ref)}\n${numbered}`;
      if (input.results === true) { const r = await loadResult(opened.ref); out += `\n\nLast run:\n${r ? resultSummary(r, 3000) : '(never run)'}`; }
      return out.length > 20000 ? out.slice(0, 20000) + '\n[truncated]' : out;
    },
  },
  {
    id: 'e2e_write',
    name: 'e2e_write',
    description: `Create (or with overwrite: true replace your own) an E2E spec in your own folder and show it in the E2E editor. The source is syntax-checked and lint-checked. ${API_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spec name, e.g. "login" (saved as .pigry/e2e/specs/<you>/login.cy.js)' },
        source: { type: 'string', description: 'The spec source (JavaScript). Omit to start from a template.' },
        template: { type: 'string', enum: SPEC_TEMPLATES.map((t) => t.id), description: 'Starter spec when no source is given' },
        language: { type: 'string', enum: ['javascript', 'typescript'], description: 'typescript saves a .cy.ts spec (types are stripped at run time)' },
        overwrite: { type: 'boolean' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const caller = callerOf(input);
      const name = nameOf(input);
      if (!name) return fail('needs a name');
      const parsed = parseRefName(name, [SPEC_EXT, '.cy', '.js']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create specs in your own folder (${caller}/) — change another owner's spec with e2e_edit`);
      const ref: SpecRef = { owner: caller, slug: parsed.slug, ...(input.language === 'typescript' || /\.ts$/i.test(name) ? { ext: SPEC_EXT_TS } : {}) };
      await flushE2eEditors();
      const exists = (await listSpecRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug);
      if (exists && input.overwrite !== true) return fail(`spec "${refKey(ref)}" already exists. Read it with e2e_read and change it with e2e_edit, or pass overwrite: true.`);
      const tpl = SPEC_TEMPLATES.find((t) => t.id === input.template);
      const source = typeof input.source === 'string' && input.source.trim() ? input.source.replace(/\r\n/g, '\n') : tpl?.source ?? SPEC_TEMPLATES[0].source;
      const check = checkSpecSource(source, { typescript: ref.ext === SPEC_EXT_TS });
      if (check.errors.length) return fail(`the spec was not saved:\n- ${check.errors.join('\n- ')}`);
      const path = await saveSpecSource(ref, source.endsWith('\n') ? source : `${source}\n`, 'agent');
      return `saved ${path}${check.warnings.length ? `\nWarnings:\n- ${check.warnings.join('\n- ')}` : ''}\nRun it with e2e_run {name: "${refKey(ref)}"}.`;
    },
  },
  {
    id: 'e2e_edit',
    name: 'e2e_edit',
    description: 'Change a spec by exact text replacement: edits is a list of {find, replace, all?}. Use the line numbers from e2e_read / a failed run to locate the text. Any owner’s spec can be edited.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } }, required: ['find', 'replace'] } },
        find: { type: 'string' }, replace: { type: 'string' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      let edits = Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : [];
      if (typeof input.edits === 'string') { try { edits = JSON.parse(input.edits) as Array<Record<string, unknown>>; } catch { return fail('edits must be a JSON array of {find, replace}'); } }
      if (!edits.length && typeof input.find === 'string') edits = [{ find: input.find, replace: input.replace ?? '' }];
      if (!edits.length) return fail('needs edits: [{find, replace}]');
      let source = opened.source; const log: string[] = []; const problems: string[] = [];
      for (const e of edits) {
        const find = String(e.find ?? ''), replace = String(e.replace ?? '');
        const count = find ? source.split(find).length - 1 : 0;
        if (!find || count === 0) { problems.push(`not found: ${JSON.stringify(find.slice(0, 60))}`); continue; }
        if (count > 1 && e.all !== true) { problems.push(`found ${count} times (add more context or all: true): ${JSON.stringify(find.slice(0, 60))}`); continue; }
        source = e.all === true ? source.split(find).join(replace) : source.replace(find, () => replace);
        log.push(`✓ replaced ${JSON.stringify(find.slice(0, 40))}`);
      }
      if (!log.length) return fail(`nothing was applied\n- ${problems.join('\n- ')}`);
      const check = checkSpecSource(source, { typescript: (opened.ref as SpecRef).ext === SPEC_EXT_TS });
      if (check.errors.length) return fail(`the edit would break the spec, so nothing was saved:\n- ${check.errors.join('\n- ')}`);
      const path = await saveSpecSource(opened.ref, source, 'agent');
      return `saved ${path}\n${log.join('\n')}${problems.length ? `\nNot applied:\n- ${problems.join('\n- ')}` : ''}${check.warnings.length ? `\nWarnings:\n- ${check.warnings.join('\n- ')}` : ''}`;
    },
  },
  {
    id: 'e2e_run',
    name: 'e2e_run',
    description: 'Run an E2E spec (or every spec with all: true) in the external test browser and return PASS/FAIL per test with the error, a code frame, the last commands and where the evidence is (screenshots on failure, API/network JSON per test, optional video). One run at a time. With report: true a Markdown report with linked screenshots is saved to .pigry/reports/<you>/.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spec name, or owner/name' },
        all: { type: 'boolean', description: 'Run every spec' },
        grep: { type: 'string', description: 'Only tests whose title contains this text' },
        base_url: { type: 'string', description: 'Override the baseUrl for this run' },
        video: { type: 'boolean', description: 'Record a video of the run' },
        retries: { type: 'number', description: 'Retry failed tests this many times (0-5)' },
        report: { type: 'boolean', description: 'Also save a Markdown report under .pigry/reports/<you>/' },
      },
    },
    run: async (input) => {
      const caller = callerOf(input);
      await flushE2eEditors();
      const refs: OwnedRef[] = [];
      if (input.all === true) refs.push(...await listSpecRefs());
      else {
        const name = nameOf(input);
        if (!name) return fail('needs a name or all: true (see e2e_list)');
        const resolved = await resolveSpec(name, caller);
        if ('error' in resolved) return fail(`${resolved.error} (see e2e_list)`);
        refs.push(resolved.ref);
      }
      if (!refs.length) return fail('no specs to run — create one with e2e_write');
      const override = mergeConfig({ ...(await loadConfig()), ...(typeof input.base_url === 'string' && input.base_url ? { baseUrl: input.base_url } : {}), ...(typeof input.video === 'boolean' ? { video: input.video } : {}), ...(typeof input.retries === 'number' ? { retries: input.retries } : {}) });
      const out: string[] = []; let failed = 0;
      for (const ref of refs.slice(0, 20)) {
        try {
          const result = await runSpecRef(ref, { grep: typeof input.grep === 'string' ? input.grep : undefined, configOverride: override });
          if (result.status !== 'passed') failed += 1;
          out.push(resultSummary(result, refs.length > 1 ? 2500 : 7000));
          out.push(`junit: ${resultPath(ref).replace(/\.json$/, '.junit.xml')}`);
          if (input.report === true) {
            const dir = `.pigry/reports/${caller}`;
            const file = `${dir}/e2e-${ref.owner ? `${ref.owner}-` : ''}${ref.slug}.md`;
            await writeWorktreeFile(file, resultToMarkdown(result, dir));
            out.push(`report: ${file}`);
          }
        } catch (e) { failed += 1; out.push(`ERROR ${refKey(ref)}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return `${refs.length > 1 ? `${refs.length - failed}/${refs.length} specs passed\n\n` : ''}${out.join('\n\n')}`;
    },
  },
  {
    id: 'e2e_results',
    name: 'e2e_results',
    description: 'The last run of a spec: summary (default), "log" for the full command log of one test (title substring in test), or "json".',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, view: { type: 'string', enum: ['summary', 'log', 'json'] }, test: { type: 'string' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('needs a name');
      const resolved = await resolveSpec(name, callerOf(input));
      if ('error' in resolved) return fail(resolved.error);
      const r = await loadResult(resolved.ref);
      if (!r) return fail(`${refKey(resolved.ref)} has not been run yet — use e2e_run`);
      if (input.view === 'json') { const j = JSON.stringify(r); return j.length > 16000 ? j.slice(0, 16000) + '\n[truncated]' : j; }
      if (input.view === 'log') {
        const t = r.tests.find((x) => x.title.join(' ').toLowerCase().includes(String(input.test ?? '').toLowerCase()));
        if (!t) return fail('no test matches — pass test: "<part of the title>"');
        return `${t.title.join(' › ')} — ${t.status}\n${t.log.map((l) => `${'  '.repeat(Math.max(0, l.level - 1))}${l.state === 'passed' ? '✓' : l.state === 'failed' ? '✗' : '…'} ${l.name} ${l.message}${l.error ? `\n${'  '.repeat(l.level)}↳ ${l.error.split('\n')[0]}` : ''}`).join('\n')}`.slice(0, 12000);
      }
      return resultSummary(r);
    },
  },
  {
    id: 'e2e_stats',
    name: 'e2e_stats',
    description: 'Analytics over all stored runs: the tests that fail most, the flaky ones (pass after retries or alternate between pass and fail) and the slowest. Use it to decide what to stabilise first.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: async (input) => {
      const a = analyticsOf(await loadStats(), typeof input.limit === 'number' ? Math.min(30, Math.max(1, input.limit)) : 8);
      if (!a.failing.length && !a.flaky.length && !a.slowest.length) return '(no runs recorded yet — use e2e_run)';
      const section = (title: string, rows: string[]) => (rows.length ? `${title}\n${rows.join('\n')}` : '');
      return [
        section('Failing most:', a.failing.map((x) => `- ${x.spec} › ${x.test}: ${x.failRate}% of ${x.runs} runs failed`)),
        section('Flaky:', a.flaky.map((x) => `- ${x.spec} › ${x.test}: ${x.rate}% unstable over ${x.runs} runs`)),
        section('Slowest:', a.slowest.map((x) => `- ${x.spec} › ${x.test}: ${(x.avgMs / 1000).toFixed(1)}s on average (${x.runs} runs)`)),
      ].filter(Boolean).join('\n\n');
    },
  },
  {
    id: 'e2e_selector',
    name: 'e2e_selector',
    description: 'Selector playground against the page open in the test browser (open one first with e2e_run or browser_e2e goto, or pass url): count how many elements a CSS selector matches (supports :contains(), :visible, :first, :eq()) and get a suggested stable selector for the first match.',
    input_schema: { type: 'object', properties: { selector: { type: 'string' }, url: { type: 'string', description: 'Open this URL in the test browser first' } }, required: ['selector'] },
    run: async (input) => {
      const selector = String(input.selector ?? '').trim();
      if (!selector) return fail('needs a selector');
      const driver = tauriDriver();
      try {
        if (typeof input.url === 'string' && input.url.trim()) await driver.open(input.url.trim(), 600);
        const count = { x: undefined as string | undefined, r: await pageCall<number>(driver, 'count', [selector]) };
        if (count.x) return fail(count.x);
        const n = Number(count.r);
        if (n < 0) return fail(`"${selector}" is not a valid selector`);
        let out = `${n} element(s) match ${selector}`;
        if (n > 0) {
          const best = await pageCall<{ selector: string; contains?: string } | null>(driver, 'best', [[{ t: 'get', s: selector }]]);
          if (best) out += `\nSuggested: ${best.contains ? `cy.contains('${best.selector}', ${JSON.stringify(best.contains)})` : `cy.get('${best.selector}')`}`;
        } else out += '\nNothing matches — snapshot the page with browser_e2e snapshot, or try cy.contains().';
        return out;
      } catch (e) { return fail(`${e instanceof Error ? e.message : String(e)} — open a page in the test browser first`); }
    },
  },
  {
    id: 'e2e_fixture',
    name: 'e2e_fixture',
    description: 'Write a JSON fixture (.pigry/e2e/fixtures/<name>.json) used by cy.fixture() and cy.intercept(url, { fixture }).',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, content: { description: 'The JSON value (object, array) or a JSON string' } }, required: ['name', 'content'] },
    run: async (input) => {
      const slug = String(input.name ?? '').trim().replace(/\.json$/i, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return fail('needs a name');
      let value = input.content;
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return fail('content must be valid JSON'); } }
      const path = `${FIXTURES_DIR}${slug}.json`;
      await writeWorktreeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      notifyE2eChanged({ key: slug, source: 'agent', kind: 'spec' });
      return `saved ${path} — use it with cy.fixture('${slug}') or cy.intercept(url, { fixture: '${slug}.json' })`;
    },
  },
  {
    id: 'e2e_config',
    name: 'e2e_config',
    description: 'Read or change the E2E settings: baseUrl, viewportWidth/Height, defaultCommandTimeout, pageLoadTimeout, responseTimeout, retries, video, screenshotOnRunFailure, testIsolation, snapshots, networkEvidence and env (an object, read in specs with Cypress.env("key")). Pass only what should change.',
    input_schema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' }, viewportWidth: { type: 'number' }, viewportHeight: { type: 'number' }, defaultCommandTimeout: { type: 'number' }, pageLoadTimeout: { type: 'number' }, responseTimeout: { type: 'number' },
        retries: { type: 'number' }, video: { type: 'boolean' }, screenshotOnRunFailure: { type: 'boolean' }, testIsolation: { type: 'boolean' }, snapshots: { type: 'boolean' }, networkEvidence: { type: 'boolean' },
        env: { type: 'object', description: 'Merged into the existing env; a null value removes a key' },
      },
    },
    run: async (input) => {
      const current = await loadConfig();
      const patch: Record<string, unknown> = {};
      for (const k of ['baseUrl', 'viewportWidth', 'viewportHeight', 'defaultCommandTimeout', 'pageLoadTimeout', 'responseTimeout', 'retries', 'video', 'screenshotOnRunFailure', 'testIsolation', 'snapshots', 'networkEvidence']) if (input[k] !== undefined) patch[k] = input[k];
      let env = current.env;
      if (input.env && typeof input.env === 'object') { env = { ...env }; for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) { if (v === null) delete env[k]; else env[k] = v; } }
      if (Object.keys(patch).length === 0 && input.env === undefined) return JSON.stringify(current, null, 2);
      const next = mergeConfig({ ...current, ...patch, env });
      await saveConfig(next, 'agent');
      return `saved settings\n${JSON.stringify(next, null, 2)}`;
    },
  },
  {
    id: 'e2e_open',
    name: 'e2e_open',
    description: 'Open a spec in the E2E editor (so the user can see it); run: true also starts it there, with the live command log.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, line: { type: 'number' }, run: { type: 'boolean' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('needs a name');
      const resolved = await resolveSpec(name, callerOf(input));
      if ('error' in resolved) return fail(resolved.error);
      requestOpenE2e(refKey(resolved.ref), { line: typeof input.line === 'number' ? input.line : undefined, run: input.run === true });
      return `opened ${specPath(resolved.ref)} in the E2E editor${input.run === true ? ' and started the run' : ''}`;
    },
  },
];
