import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';
import { SPEC_PASS, defineBridge, installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await installBackend(page);
  await openFixture(page);
  await installTestBrowser(page);
  await installE2eEnvironment(page, {
    '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1200, networkEvidence: true }),
    '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS,
  });
}

const tool = (page, name, input) => page.evaluate(async ({ name, input }) => {
  const { E2E_TOOLS } = await import('/src/lib/e2e/e2eTools.ts');
  return E2E_TOOLS.find((t) => t.name === name).run(input);
}, { name, input });

test('e2e tools: write, lint, run, read results, edit, config, fixtures and report', async ({ page }) => {
  await setup(page);
  // the first import of Monaco can make the dev server re-optimise and reload the page — warm it up before the real work
  for (let i = 0; i < 3; i += 1) {
    const ok = await page.evaluate(() => import('/src/lib/e2e/transpile.ts').then((m) => m.transpileTs('const a: number = 1;')).then(() => true, () => false)).catch(() => false);
    if (ok) break;
    await page.waitForLoadState('load'); await page.waitForTimeout(1500);
    await openFixture(page); await defineBridge(page); await installE2eEnvironment(page, {
      '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1200, networkEvidence: true }),
      '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS,
    });
  }

  // list sees the user's spec and the settings
  const list = await tool(page, 'e2e_list', {});
  expect(list).toContain('user/home');
  expect(list).toContain('baseUrl=http://app.test');

  // an agent writes into its own folder; bad specs are refused with reasons
  const bad = await tool(page, 'e2e_write', { agent: 'qa', name: 'broken', source: 'describe("x", () => { it("y", () => { cy.visit(' });
  expect(bad).toContain('error: the spec was not saved');
  expect(bad).toContain('syntax error');
  const imp = await tool(page, 'e2e_write', { agent: 'qa', name: 'imports', source: "import x from 'y';\nit('a', () => {});" });
  expect(imp).toContain('remove import/export');
  const ok = await tool(page, 'e2e_write', {
    agent: 'qa', name: 'about page', source: `describe('About', () => {
  it('says who we are', () => {
    cy.visit('/about');
    cy.get('h1').should('have.text', 'About us');
    cy.contains('.blurb', 'We test things.').should('be.visible');
  });
  it('has a wrong expectation', () => {
    cy.visit('/about');
    cy.get('h1').should('have.text', 'About them');
  });
});`,
  });
  expect(ok).toContain('saved .pigry/e2e/specs/qa/about-page.cy.js');
  const again = await tool(page, 'e2e_write', { agent: 'qa', name: 'about-page', source: 'it("x", () => {});' });
  expect(again).toContain('already exists');
  const other = await tool(page, 'e2e_write', { agent: 'qa', name: 'user/steal', source: 'it("x", () => {});' });
  expect(other).toContain('your own folder');

  // templates work without a source
  const tpl = await tool(page, 'e2e_write', { agent: 'qa', name: 'smoke', template: 'smoke' });
  expect(tpl).toContain('saved .pigry/e2e/specs/qa/smoke.cy.js');

  // run: PASS/FAIL per test with error, code frame, evidence and an optional report
  const run = await tool(page, 'e2e_run', { agent: 'qa', name: 'about-page', report: true });
  expect(run).toContain('FAIL qa/about-page — 1 passed, 1 failed');
  expect(run).toContain('✓ About › says who we are');
  expect(run).toContain('✗ About › has a wrong expectation');
  expect(run).toContain("expected <h1> to have text 'About them'");
  expect(run).toContain("    >   9 |     cy.get('h1').should('have.text', 'About them');");
  expect(run).toContain('screenshot: .pigry/e2e/evidence/qa/about-page/');
  expect(run).toContain('network: .pigry/e2e/evidence/qa/about-page/');
  expect(run).toContain('report: .pigry/reports/qa/e2e-qa-about-page.md');
  const report = await page.evaluate(() => window.__worktree.get('.pigry/reports/qa/e2e-qa-about-page.md'));
  expect(report).toContain('# E2E report — qa/about-page');
  expect(report).toContain('(../../e2e/evidence/qa/about-page/');
  expect(report).toContain('About them');

  // results: summary, command log, json
  const log = await tool(page, 'e2e_results', { agent: 'qa', name: 'about-page', view: 'log', test: 'wrong' });
  expect(log).toContain('✓ visit');
  expect(log).toContain('✗ should');
  const json = await tool(page, 'e2e_results', { agent: 'qa', name: 'about-page', view: 'json' });
  expect(JSON.parse(json).failed).toBe(1);

  // fix the spec with an exact edit and run again, one test only
  const edit = await tool(page, 'e2e_edit', { agent: 'qa', name: 'about-page', edits: [{ find: "'About them'", replace: "'About us'" }] });
  expect(edit).toContain('✓ replaced');
  const missing = await tool(page, 'e2e_edit', { agent: 'qa', name: 'about-page', edits: [{ find: 'does not occur', replace: 'x' }] });
  expect(missing).toContain('nothing was applied');
  const breaking = await tool(page, 'e2e_edit', { agent: 'qa', name: 'about-page', edits: [{ find: 'describe(', replace: 'describe((' }] });
  expect(breaking).toContain('would break the spec');
  const second = await tool(page, 'e2e_run', { agent: 'qa', name: 'qa/about-page', grep: 'wrong' });
  expect(second).toContain('PASS qa/about-page — 1 passed, 0 failed, 1 pending');

  // everything
  const all = await tool(page, 'e2e_run', { agent: 'qa', all: true, base_url: 'http://app.test' });
  expect(all).toMatch(/\d+\/3 specs passed/);

  expect(run).toContain('junit: .pigry/e2e/results/qa/about-page.junit.xml');
  const stats = await tool(page, 'e2e_stats', {});
  expect(stats).toContain('Failing most:');
  expect(stats).toContain('qa/about-page › About › has a wrong expectation');
  expect(stats).toContain('Slowest:');
  const ts = await tool(page, 'e2e_write', { agent: 'qa', name: 'typed-one', language: 'typescript', source: "const t: string = 'x'; it('a', () => { cy.visit('/'); cy.get('h1').should('exist'); });" });
  expect(ts).toContain('saved .pigry/e2e/specs/qa/typed-one.cy.ts');
  expect(await tool(page, 'e2e_run', { agent: 'qa', name: 'qa/typed-one' })).toContain('PASS qa/typed-one');

  // read with line numbers and last run
  const read = await tool(page, 'e2e_read', { agent: 'qa', name: 'user/home', results: true });
  expect(read).toContain("  2 |   beforeEach(() => { cy.visit('/'); });");
  expect(read).toContain('Last run:');

  // fixtures and config
  const fx = await tool(page, 'e2e_fixture', { agent: 'qa', name: 'people', content: [{ id: 1, name: 'Ada' }] });
  expect(fx).toContain('saved .pigry/e2e/fixtures/people.json');
  expect(await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/fixtures/people.json')))).toEqual([{ id: 1, name: 'Ada' }]);
  const cfg = await tool(page, 'e2e_config', { agent: 'qa', retries: 1, video: true, env: { user: 'ada', password: 'x' } });
  expect(cfg).toContain('saved settings');
  const stored = await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/e2e.config.json')));
  expect(stored).toMatchObject({ retries: 1, video: true, baseUrl: 'http://app.test', env: { user: 'ada', password: 'x' } });
  await tool(page, 'e2e_config', { agent: 'qa', env: { password: null } });
  expect((await page.evaluate(() => JSON.parse(window.__worktree.get('.pigry/e2e/e2e.config.json')))).env).toEqual({ user: 'ada' });
  const withVideo = await tool(page, 'e2e_run', { agent: 'qa', name: 'user/home' });
  expect(withVideo).toContain('video: .pigry/e2e/evidence/user/home/user-home.webm');
  expect(await page.evaluate(() => window.__videos.length)).toBeGreaterThan(0);

  // the selector playground tool
  await page.evaluate(() => window.__b.open('http://app.test/'));
  const sel = await tool(page, 'e2e_selector', { selector: 'button.primary' });
  expect(sel).toContain('1 element(s) match button.primary');
  expect(sel).toContain("Suggested: cy.get('[data-cy=\"inc\"]')");
  expect(await tool(page, 'e2e_selector', { selector: '.missing' })).toContain('0 element(s)');

  // open shows the spec in the editor and can start the run there
  await page.getByRole('button', { name: 'E2E Testing', exact: true }).click();
  await tool(page, 'e2e_open', { agent: 'qa', name: 'qa/about-page', run: true });
  await expect(page.locator('.e2e-bar__name')).toHaveText('qa/about-page');
  await expect(page.getByRole('status', { name: 'Run summary' }).locator('.e2e-stat--pass')).toHaveText('2', { timeout: 30000 });
});

test('e2e: base agent QA lives in the E2E menu with the tools and the Cypress skill', async ({ page }) => {
  await installBackend(page);
  await openFixture(page);
  const info = await page.evaluate(async () => {
    const { builtinAgents } = await import('/src/lib/agentExtras.ts');
    const { AGENT_TOOLS } = await import('/src/lib/agentTools.ts');
    const { BUILTIN_SKILLS } = await import('/src/lib/skills.ts');
    const agents = builtinAgents();
    return {
      qa: agents.find((a) => a.username === 'e2e-qa'),
      lead: agents.find((a) => a.username === 'e2e'),
      explorerQa: agents.find((a) => a.username === 'qa'),
      copilotQa: agents.find((a) => a.username === 'copilot-qa'),
      everyone: agents.filter((a) => a.team === 'E2E Testing').map((a) => a.username),
      tools: AGENT_TOOLS.filter((t) => t.group === 'E2E').map((t) => t.name),
      skill: BUILTIN_SKILLS.find((s) => s.id === 'cypress-e2e-testing'),
      qaSkill: BUILTIN_SKILLS.find((s) => s.id === 'qa-test-cases-and-e2e')?.content ?? '',
    };
  });
  expect(info.qa.team).toBe('E2E Testing');
  expect(info.qa.tier).toBe('base');
  expect(info.qa.name).toBe('QA');
  expect(info.qa.tools).toEqual(expect.arrayContaining(['e2e_write', 'e2e_run', 'e2e_results', 'e2e_selector', 'browser_e2e', 'run_command']));
  expect(info.qa.skills).toEqual(expect.arrayContaining(['cypress-e2e-testing', 'qa-test-cases-and-e2e', 'qa-css-style-testing']));
  expect(info.explorerQa.tools).toEqual(expect.arrayContaining(['e2e_run', 'e2e_write']));
  expect(info.explorerQa.skills).toContain('cypress-e2e-testing');
  expect(info.copilotQa.tools).toContain('e2e_run');
  expect(info.lead.tier).toBe('default');
  expect(info.lead.tools).toEqual(expect.arrayContaining(['e2e_write', 'e2e_run', 'e2e_edit', 'e2e_open']));
  expect(info.everyone.sort()).toEqual(['e2e', 'e2e-qa']);
  expect(info.tools).toHaveLength(11);
  expect(info.skill.content).toContain('cy.intercept');
  expect(info.skill.content).toContain('e2e_run');
  expect(info.qaSkill).toContain('e2e_write');
});
