/** Captures the screenshots shown in the in-app guides (public/help/<menu>.jpg).
 * Not part of the normal test run: `npm run help:screenshots` sets HELP_CAPTURE=1 and rewrites the images. */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { demoTree } from '../../src/lib/demoWorkspace.ts';
import { workspaceNav } from '../../src/app/navigation.ts';
import { installBackend, openFixture } from './backend.mjs';
import { SPEC_FAIL, SPEC_PASS, installE2eEnvironment, installTestBrowser } from './e2e-helpers.mjs';
import { GH_MOCKS } from './help-fixtures.mjs';

test.skip(!process.env.HELP_CAPTURE, 'run with npm run help:screenshots');
test.setTimeout(300_000);

const OUT = path.resolve('public/help');
const REPORT = '.pigry/reports/qa/login-test-cases.md';
const REPORT2 = '.pigry/reports/white-hat/security-review.md';
const REPORT_TEXT = {
  [REPORT]: '# Login test cases\n\nAll **12** cases ran against the staging build.\n\n## Results\n\n| Case | Result |\n| --- | --- |\n| TC-01 valid login | passed |\n| TC-07 wrong password message | failed |\n\n## Failures\n\n- TC-07: the error says "Invalid" instead of "Wrong email or password" (`src/auth/login.ts`)\n\n## Next steps\n\n- Fix the message and re-run the login spec.',
  [REPORT2]: '# Security review\n\nNo secrets were found in the working tree.\n\n## Findings\n\n- Medium: outdated dependency in package.json',
};
const PACKAGE_JSON = '{\n  "name": "platform",\n  "version": "1.4.0",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "test": "vitest run"\n  },\n  "dependencies": {\n    "react": "^19.0.0"\n  }\n}\n';

const quiet = (promise) => promise.catch(() => {});
const click = (page, locator) => quiet(locator.first().click({ timeout: 2500 }));

/** What to do after opening a menu so the screenshot shows something useful. */
const PREPARE = {
  explorer: async (page) => { await click(page, page.getByText('package.json', { exact: true })); },
  diagram: async (page) => { await page.evaluate(() => window.__help.run('diagram_open', { name: 'checkout-flow' })); await quiet(page.locator('.dgm__svg').waitFor({ timeout: 4000 })); },
  design: async (page) => { await page.evaluate(() => window.__help.run('design_open', { name: 'login-screen' })); await quiet(page.locator('.dsg__svg, .dsg__stage, svg').first().waitFor({ timeout: 4000 })); await click(page, page.getByRole('button', { name: /fit/i })); },
  board: async (page) => { await page.evaluate(() => window.__help.run('board_open', { name: 'checkout-retro' })); await quiet(page.locator('.brd__svg').waitFor({ timeout: 4000 })); await click(page, page.getByRole('button', { name: /fit/i })); },
  e2e: async (page) => {
    await click(page, page.getByRole('button', { name: 'home', exact: true }));
    await click(page, page.getByRole('button', { name: 'Run spec' }));
    await quiet(page.getByRole('button', { name: 'Run again' }).waitFor({ timeout: 30000 }));
  },
  'ai-agent': async (page) => { await quiet(page.getByRole('textbox', { name: 'Ask AI' }).first().fill('@', { timeout: 2500 })); },
  'working-changes': async (page) => { await click(page, page.getByText('fixture.txt', { exact: false })); },
  'push-commits': async (page) => { await click(page, page.getByText('feat: add keyboard-first command palette')); },
  'pull-commits': async (page) => { await click(page, page.getByText('feat: highlight matching commits in graph')); },
  'merge-branch': async (page) => { await quiet(page.getByRole('combobox', { name: 'Source branch' }).selectOption({ index: 1 }, { timeout: 2500 })); },
  'compare-branch': async (page) => {
    await quiet(page.getByRole('combobox', { name: 'Compare branch' }).selectOption('refs/remotes/origin/feat/graph-search', { timeout: 2500 }));
    await click(page, page.getByRole('button', { name: /commands\.ts/ }));
  },
  'cherry-pick': async (page) => { await click(page, page.locator('.cherry__row')); },
  'revert-commit': async (page) => { await click(page, page.locator('.cherry__row')); },
  'commit-graph': async (page) => { await click(page, page.getByText('feat: add keyboard-first command palette')); },
  issues: async (page) => { await click(page, page.getByText('Command palette does not close on Escape')); },
  releases: async (page) => { await click(page, page.getByText('PIGRY v1.4.0', { exact: true })); },
  security: async (page) => { await click(page, page.getByText('Uncontrolled data used in path expression')); },
  wiki: async (page) => {
    await click(page, page.getByText('Architecture', { exact: true }));
    await quiet(page.locator('.wiki-md').waitFor({ timeout: 5000 }));
    await quiet(page.locator('.wiki-skeleton').first().waitFor({ state: 'detached', timeout: 8000 }));
    await page.waitForTimeout(800);
  },
  'rebase-branch': async (page) => { await click(page, page.getByText('feat: add keyboard-first command palette')); },
};

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test('capture one screenshot per workspace menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page, { entries: [...demoTree.entries, REPORT, REPORT2] });
  await openFixture(page);
  await installTestBrowser(page);
  await installE2eEnvironment(page, {
    '.pigry/e2e/e2e.config.json': JSON.stringify({ baseUrl: 'http://app.test', defaultCommandTimeout: 1500, networkEvidence: true }),
    '.pigry/e2e/specs/user/home.cy.js': SPEC_PASS,
    '.pigry/e2e/specs/user/checkout.cy.js': SPEC_FAIL,
    'package.json': PACKAGE_JSON,
  });
  await page.evaluate(({ reports, mocks }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'read_worktree_file' && reports[args.path] !== undefined) return { path: args.path, content: reports[args.path], binary: false, tooLarge: false, language: 'markdown' };
      if (cmd === 'get_branch_commits' && window.__rebaseShot) {
        const full = await invoke('get_commit_history', { includeRemotes: false });
        return { ...full, commits: full.commits.slice(6) };
      }
      if (cmd === 'get_commit_detail') return { ...(await invoke(cmd, args)), oid: args.oid, isMerge: false };
      // A real backend takes a moment; an instant answer would race the wiki screen's own loading flag.
      if (cmd === 'wiki_read') await new Promise((resolve) => setTimeout(resolve, 250));
      if (cmd in mocks) return structuredClone(mocks[cmd]);
      return invoke(cmd, args);
    };
  }, { reports: REPORT_TEXT, mocks: GH_MOCKS });

  // Sample board, design and diagram, written with the same tools the agents use.
  await page.evaluate(async () => {
    const { BOARD_TOOLS } = await import('/src/lib/boardTools.ts');
    const { DESIGN_TOOLS } = await import('/src/lib/designTools.ts');
    const { DIAGRAM_TOOLS } = await import('/src/lib/diagramTools.ts');
    const all = [...BOARD_TOOLS, ...DESIGN_TOOLS, ...DIAGRAM_TOOLS];
    window.__help = { run: (name, input) => all.find((tool) => tool.name === name).run({ agent: 'user', ...input }) };
    await window.__help.run('board_write', {
      name: 'checkout-retro', title: 'Checkout retro',
      items: [
        { type: 'text', text: 'Checkout redesign — retro', fontSize: 28, bold: true, x: 0, y: -80 },
        { type: 'section', text: 'Went well', color: 'green', notes: ['Fast payment', 'Clear errors', { text: 'Guest checkout', votes: 3 }] },
        { type: 'section', text: 'To improve', color: 'orange', notes: ['Slow address lookup', 'Coupons confusing', { text: 'Too many form fields', votes: 2 }] },
        { type: 'section', text: 'Actions', color: 'blue', notes: ['Add address autocomplete', 'Simplify the coupon box'] },
      ],
    });
    await window.__help.run('design_write', {
      name: 'login-screen', title: 'Login', tokens: { colors: { primary: '#2563eb', text: '#111827' } },
      nodes: [{
        type: 'frame', name: 'Mobile — Login', w: 390, h: 700, fill: '#ffffff', layout: { dir: 'column', gap: 16, padding: 24, align: 'stretch', justify: 'center' },
        children: [
          { type: 'text', name: 'Title', text: 'Welcome back', fontSize: 28, fontWeight: 700, fill: '$text' },
          { type: 'text', name: 'Hint', text: 'Sign in to continue', fontSize: 14, fill: '#6b7280' },
          { type: 'frame', name: 'Email input', h: 48, radius: 10, stroke: '#d1d5db', layout: { dir: 'row', padding: [0, 12, 0, 12], align: 'center' }, children: [{ type: 'text', name: 'Placeholder', text: 'Email', fill: '#6b7280' }] },
          { type: 'frame', name: 'Password input', h: 48, radius: 10, stroke: '#d1d5db', layout: { dir: 'row', padding: [0, 12, 0, 12], align: 'center' }, children: [{ type: 'text', name: 'Placeholder', text: 'Password', fill: '#6b7280' }] },
          { type: 'frame', name: 'Sign in button', h: 48, radius: 10, fill: '$primary', layout: { dir: 'row', justify: 'center', align: 'center' }, children: [{ type: 'text', name: 'Label', text: 'Sign in', fill: '#ffffff', fontWeight: 600 }] },
        ],
      }],
    });
    await window.__help.run('diagram_write', {
      name: 'checkout-flow', type: 'flowchart', direction: 'TB',
      nodes: [
        { id: 'cart', label: 'Cart' }, { id: 'address', label: 'Shipping address' }, { id: 'pay', label: 'Payment' },
        { id: 'ok', label: 'Order confirmed' }, { id: 'fail', label: 'Payment failed' },
      ],
      edges: [
        { from: 'cart', to: 'address' }, { from: 'address', to: 'pay' },
        { from: 'pay', to: 'ok', label: 'approved' }, { from: 'pay', to: 'fail', label: 'declined' },
      ],
    });
  });

  const results = [];
  for (const { id, label } of workspaceNav) {
    await page.evaluate((on) => { window.__rebaseShot = on; }, id === 'rebase-branch');
    await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${label}$`, 'i') }) }).click();
    await page.waitForTimeout(900);
    await PREPARE[id]?.(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${id}.jpg`), type: 'jpeg', quality: 82 });
    results.push(id);
  }
  expect(results).toHaveLength(workspaceNav.length);
});
