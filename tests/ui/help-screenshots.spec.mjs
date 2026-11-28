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
  videoeditor: async (page) => { await page.evaluate(() => window.__help.run('video_open', { name: 'launch-teaser' })); await quiet(page.locator('canvas[aria-label="Video preview"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(800); await click(page, page.getByRole('button', { name: /^text clip/ }).first()); await quiet(page.getByLabel('Ruler').click({ position: { x: 222, y: 12 }, timeout: 2500 })); await page.waitForTimeout(700); },
  sheet: async (page) => { await page.evaluate(() => window.__help.run('sheet_open', { name: 'sales-2026', cell: 'F2:F13' })); await quiet(page.locator('canvas[aria-label="Spreadsheet grid"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(900); },
  docs: async (page) => { await page.evaluate(() => window.__help.run('docs_open', { name: 'launch-proposal' })); await quiet(page.getByTestId('docs-surface').locator('[data-style="title"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(700); await click(page, page.getByTestId('comment-card')); await page.waitForTimeout(400); },
  api: async (page) => {
    await page.evaluate(() => {
      const bridge = window.__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      const body = JSON.stringify({ data: [{ id: 101, name: 'Mochi', species: 'cat', age: 3, vaccinated: true, owner: { id: 7, email: 'ann@example.com' } }, { id: 102, name: 'Biscuit', species: 'dog', age: 5, vaccinated: false, owner: null }], page: 1, total: 2 });
      bridge.invoke = async (cmd, args = {}) => {
        if (cmd === 'http_send') return { status: 200, statusText: 'OK', httpVersion: '1.1', headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }, { key: 'X-RateLimit-Remaining', value: '58' }, { key: 'Set-Cookie', value: 'session=s-1; Path=/; HttpOnly' }], body, encoding: 'utf8', timeMs: 86, timings: { dnsMs: 4, connectMs: 18, tlsMs: 41, firstByteMs: 80, totalMs: 86 }, bodySize: body.length, headersSize: 180, url: args.request.url, redirects: 0, truncated: false };
        return invoke(cmd, args);
      };
    });
    await page.evaluate(() => window.__help.run('api_env', { action: 'select', name: 'user/staging' }));
    await page.evaluate(() => window.__help.run('api_open', { name: 'user/petstore', request: 'Pets / List pets' }));
    await quiet(page.getByRole('textbox', { name: 'Request URL' }).waitFor({ timeout: 4000 }));
    await page.waitForTimeout(500);
    await click(page, page.getByRole('button', { name: 'Send', exact: true }));
    await quiet(page.getByRole('status', { name: 'Response status' }).waitFor({ timeout: 4000 }));
    await page.waitForTimeout(500);
  },
  notes: async (page) => { await page.evaluate(() => window.__help.run('notes_open', { name: 'user/notes' })); await quiet(page.getByTestId('note-card').first().waitFor({ timeout: 4000 })); await page.waitForTimeout(600); await quiet(page.getByTestId('note-card').filter({ hasText: 'Groceries' }).hover({ timeout: 2500 })); await page.waitForTimeout(300); },
  slides: async (page) => { await page.evaluate(() => window.__help.run('slides_open', { name: 'launch-pitch', slide: '7' })); await quiet(page.getByTestId('slide-canvas').waitFor({ timeout: 4000 })); await page.waitForTimeout(700); await quiet(page.getByTestId('slide-canvas').click({ position: { x: 300, y: 260 }, timeout: 2500 })); await click(page, page.getByRole('button', { name: 'Animate' })); await page.waitForTimeout(500); },
  audioeditor: async (page) => { await page.evaluate(() => window.__help.run('audio_open', { name: 'podcast-episode' })); await quiet(page.locator('[data-testid="timeline"] canvas').first().waitFor({ timeout: 4000 })); await page.waitForTimeout(1500); await quiet(page.locator('.au-lane').first().click({ position: { x: 330, y: 40 }, timeout: 2500 })); await page.waitForTimeout(500); },
  gameengine: async (page) => { await page.evaluate(() => window.__help.run('game_open', { name: 'playground' })); await quiet(page.locator('canvas[aria-label="Scene viewport"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(1200); await click(page, page.getByRole('treeitem', { name: 'Node Player' }).locator('.gm-row-node')); await page.waitForTimeout(600); },
  model3d: async (page) => { await page.evaluate(() => window.__help.run('model_open', { name: 'workshop-table' })); await quiet(page.locator('canvas[aria-label="3D viewport"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(1200); await click(page, page.getByRole('treeitem', { name: 'Object Mug' }).locator('.m3d-row')); await page.waitForTimeout(500); },
  drawing: async (page) => { await page.evaluate(() => window.__help.run('drawing_open', { name: 'harbour-sunset' })); await quiet(page.locator('canvas[aria-label="Painting"]').waitFor({ timeout: 4000 })); await page.waitForTimeout(600); },
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
    await click(page, page.locator('.compare-branch__controls').getByRole('button', { name: 'Compare branch', exact: true }));
    await quiet(page.getByRole('combobox', { name: 'Search compare branch' }).fill('origin/feat/graph-search', { timeout: 2500 }));
    await quiet(page.keyboard.press('Enter'));
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
  'merge-conflicts': async (page) => {
    await quiet(page.getByRole('region', { name: /^Conflict 1 of/ }).waitFor({ timeout: 4000 }));
    await click(page, page.getByRole('region', { name: /^Conflict 2 of/ }).getByRole('button', { name: 'Accept incoming' }));
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
      if (cmd === 'get_branch_commits' && window.__prShot && args.refName === 'main') {
        const full = await invoke('get_commit_history', { includeRemotes: false });
        return { ...full, commits: full.commits.slice(2) };
      }
      if (cmd === 'get_commit_detail') return { ...(await invoke(cmd, args)), oid: args.oid, isMerge: false };
      // Merge conflicts: a merge of feature/command-menu that stopped on one file.
      if (window.__conflictShot) {
        const file = 'src/app/CommandPalette.tsx';
        const text = [
          "import { useState } from 'react';",
          "import { fuzzyMatch } from '../lib/fuzzy';",
          '',
          'export function CommandPalette({ commands }: Props) {',
          '<<<<<<< HEAD',
          "  const [query, setQuery] = useState('');",
          '  const results = commands.filter((c) => c.title.includes(query));',
          '=======',
          "  const [query, setQuery] = useState('');",
          '  const [active, setActive] = useState(0);',
          '  const results = fuzzyMatch(commands, query).slice(0, 20);',
          '>>>>>>> feat/command-menu',
          '  return (',
          '    <Dialog label="Command palette">',
          '<<<<<<< HEAD',
          '      <input placeholder="Search commands" value={query} onChange={(e) => setQuery(e.target.value)} />',
          '=======',
          '      <input placeholder="Type a command" value={query} onChange={(e) => setQuery(e.target.value)} />',
          '>>>>>>> feat/command-menu',
          '      <ResultList items={results} />',
          '    </Dialog>',
          '  );',
          '}',
          '',
        ].join('\n');
        if (cmd === 'conflict_state') return { operation: 'merge', branch: 'main', currentLabel: 'your branch (main)', incomingLabel: "Merge branch 'feat/command-menu'", incomingCommit: '4f2a9c1 Fuzzy search in the command palette', conflicted: [file, 'src/lib/fuzzy.ts'], step: null };
        if (cmd === 'conflict_versions') return { base: null, current: null, incoming: null, binary: false };
        if (cmd === 'read_worktree_file' && (args.path === file || args.path === 'src/lib/fuzzy.ts')) return { path: args.path, content: text, binary: false, tooLarge: false, language: 'typescript' };
        if (cmd === 'refresh' || cmd === 'get_app_state') {
          const state = await invoke(cmd, args);
          const row = (path) => ({ id: `${path}:conflicted`, path, name: path.split('/').pop(), directory: path.slice(0, path.lastIndexOf('/')), status: 'C', additions: 0, deletions: 0, staged: false, untracked: false });
          return { ...state, repository: { ...state.repository, files: [row(file), row('src/lib/fuzzy.ts')] } };
        }
      }
      // A real backend takes a moment; an instant answer would race the wiki screen's own loading flag.
      if (cmd === 'wiki_read') await new Promise((resolve) => setTimeout(resolve, 250));
      if (cmd in mocks) return structuredClone(mocks[cmd]);
      return invoke(cmd, args);
    };
  }, { reports: REPORT_TEXT, mocks: GH_MOCKS });

  // Sample board, design and diagram, written with the same tools the agents use.
  await page.evaluate(async () => {
    const { BOARD_TOOLS } = await import('/src/extensions/board/boardTools.ts');
    const { DESIGN_TOOLS } = await import('/src/extensions/design/designTools.ts');
    const { DIAGRAM_TOOLS } = await import('/src/extensions/diagram/diagramTools.ts');
    const { DRAWING_TOOLS } = await import('/src/extensions/drawing/drawingTools.ts');
    const { MODEL_TOOLS } = await import('/src/extensions/model3d/model3dTools.ts');
    const { GAME_TOOLS } = await import('/src/extensions/gameengine/gameTools.ts');
    const { VIDEO_TOOLS } = await import('/src/extensions/videoeditor/videoTools.ts');
    const { AUDIO_TOOLS } = await import('/src/extensions/audioeditor/audioTools.ts');
    const { SHEET_TOOLS } = await import('/src/extensions/sheet/sheetTools.ts');
    const { DOCS_TOOLS } = await import('/src/extensions/docs/docsTools.ts');
    const { SLIDES_TOOLS } = await import('/src/extensions/slides/slidesTools.ts');
    const { NOTES_TOOLS } = await import('/src/extensions/notes/notesTools.ts');
    const { API_TOOLS } = await import('/src/extensions/api/apiTools.ts');
    const all = [...BOARD_TOOLS, ...DESIGN_TOOLS, ...DIAGRAM_TOOLS, ...DRAWING_TOOLS, ...MODEL_TOOLS, ...GAME_TOOLS, ...VIDEO_TOOLS, ...AUDIO_TOOLS, ...SHEET_TOOLS, ...DOCS_TOOLS, ...SLIDES_TOOLS, ...NOTES_TOOLS, ...API_TOOLS];
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
    await window.__help.run('drawing_write', {
      name: 'harbour-sunset', title: 'Harbour at sunset', width: 960, height: 600, background: '#1d2b4f',
      ops: [
        { op: 'layer_edit', layer: 1, name: 'Sky' },
        { op: 'gradient', layer: 'Sky', x1: 0, y1: 0, x2: 0, y2: 420, from: '#2b3a7a', to: '#ff9a52' },
        { op: 'layer_add', name: 'Sun glow' },
        { op: 'gradient', layer: 'Sun glow', x1: 600, y1: 330, x2: 600, y2: 120, from: 'rgba(255,214,120,0.95)', to: 'rgba(255,214,120,0)', kind: 'radial' },
        { op: 'layer_edit', layer: 'Sun glow', blend: 'screen' },
        { op: 'layer_add', name: 'Sun' },
        { op: 'ellipse', layer: 'Sun', x: 560, y: 290, w: 80, h: 80, fill: '#fff1b8' },
        { op: 'layer_add', name: 'Sea' },
        { op: 'rect', layer: 'Sea', x: 0, y: 360, w: 960, h: 240, fill: '#173a63' },
        { op: 'gradient', layer: 'Sea', x1: 0, y1: 360, x2: 0, y2: 600, from: 'rgba(255,154,82,0.55)', to: 'rgba(10,25,60,0.9)' },
        { op: 'layer_add', name: 'Hills' },
        { op: 'polygon', layer: 'Hills', points: [[0, 380], [120, 300], [260, 350], [380, 270], [520, 372], [520, 380]], fill: '#17213f' },
        { op: 'polygon', layer: 'Hills', points: [[700, 380], [820, 310], [960, 250], [960, 380]], fill: '#101a35' },
        { op: 'layer_add', name: 'Boat' },
        { op: 'polygon', layer: 'Boat', points: [[250, 430], [370, 430], [345, 460], [275, 460]], fill: '#0b1226' },
        { op: 'polygon', layer: 'Boat', points: [[310, 340], [310, 428], [360, 428]], fill: '#f7d9a8' },
        { op: 'line', layer: 'Boat', x1: 310, y1: 330, x2: 310, y2: 430, color: '#0b1226', width: 3 },
        { op: 'layer_add', name: 'Reflections' },
        { op: 'stroke', layer: 'Reflections', points: [[560, 380], [600, 392], [640, 380]], color: '#ffe3a1', size: 10, brush: 'airbrush' },
        { op: 'stroke', layer: 'Reflections', points: [[570, 410], [600, 418], [630, 410]], color: '#ffd08a', size: 8, brush: 'watercolor' },
        { op: 'text', layer: 'Reflections', x: 24, y: 20, text: 'Harbour at sunset', size: 30, color: '#ffe9c4', weight: 600 },
        { op: 'select', shape: 'ellipse', x: 80, y: 60, w: 220, h: 120 },
      ],
    });
    await window.__help.run('model_write', {
      name: 'workshop-table', title: 'Workshop table', starter: true, background: '#9fb4c9',
      ops: [
        { op: 'update', target: 'Ground', material: { color: '#d7dbe0', roughness: 0.9 } },
        { op: 'remove', target: 'Cube' },
        { op: 'add', kind: 'box', name: 'Table top', position: [0, 0.725, 0], params: { width: 1.6, height: 0.06, depth: 0.9 }, material: { color: '#9b6a3c', roughness: 0.65 } },
        { op: 'add', kind: 'box', name: 'Table leg', position: [0.72, 0.35, 0.38], params: { width: 0.07, height: 0.7, depth: 0.07 }, material: { color: '#7a5230', roughness: 0.7 }, modifiers: [{ type: 'mirror', axis: 'x' }, { type: 'mirror', axis: 'z' }] },
        { op: 'add', kind: 'cylinder', name: 'Mug', position: [0.35, 0.805, 0.1], params: { radiusTop: 0.05, radiusBottom: 0.045, height: 0.11 }, material: { color: '#f4f1ea', roughness: 0.35 } },
        { op: 'add', kind: 'torus', name: 'Mug handle', position: [0.4, 0.805, 0.1], rotation: [0, 0, 0], params: { radius: 0.035, tube: 0.008, segments: 20 }, material: { color: '#f4f1ea', roughness: 0.35 } },
        { op: 'add', kind: 'sphere', name: 'Ball', position: [-0.45, 0.835, 0.1], params: { radius: 0.09 }, material: { color: '#e07a3f', metalness: 0.1, roughness: 0.4 } },
        { op: 'add', kind: 'cylinder', name: 'Lamp base', position: [-0.6, 0.77, -0.25], params: { radiusTop: 0.08, radiusBottom: 0.1, height: 0.03 }, material: { color: '#2b2f36', metalness: 0.8, roughness: 0.35 } },
        { op: 'add', kind: 'cone', name: 'Lamp shade', position: [-0.6, 0.97, -0.25], params: { radius: 0.15, height: 0.22 }, material: { color: '#ffd166', emissive: '#ffb347', emissiveIntensity: 1.2, roughness: 0.5 } },
        { op: 'add', kind: 'box', name: 'Book', position: [0.05, 0.775, -0.2], rotation: [0, 20, 0], params: { width: 0.3, height: 0.04, depth: 0.22 }, material: { color: '#3b6ea5', roughness: 0.6 } },
        { op: 'add', kind: 'icosphere', name: 'Rock', position: [1.6, 0.25, -0.6], params: { radius: 0.35, detail: 1 }, material: { color: '#7f8794', roughness: 0.95, flatShading: true } },
        { op: 'update', target: 'Sun', position: [4, 6, 3], light: { intensity: 3.2 } },
        { op: 'world', ambient: 0.5 },
        { op: 'view', position: [2.6, 1.7, 2.8], target: [0, 0.7, 0] },
      ],
    });
    await window.__help.run('game_write', {
      name: 'playground', title: 'Playground', template: '3d',
      ops: [
        { op: 'set', node: 'Environment', props: { background: '#9fb4c9', ambient: 0.6 } },
        { op: 'add_node', type: 'MeshInstance3D', name: 'Tower', props: { mesh: 'cylinder', size: [1.6, 5, 1.6], position: [-5, 2.5, -4], material: { color: '#c9b79c', roughness: 0.9 } } },
        { op: 'add_node', type: 'MeshInstance3D', name: 'Roof', props: { mesh: 'cone', size: [2.2, 1.6, 2.2], position: [-5, 5.8, -4], material: { color: '#b5443a', roughness: 0.7 } } },
        { op: 'add_node', type: 'MeshInstance3D', name: 'Gem', props: { mesh: 'torus', size: [0.8, 0.8, 0.8], position: [3, 1.2, 2], rotation: [90, 0, 0], material: { color: '#35d0ba', emissive: '#35d0ba', emissiveIntensity: 1.4, metalness: 0.3, roughness: 0.25 } } },
        { op: 'set', node: 'Player/Camera', props: { position: [0, 3.2, 7], rotation: [-18, 0, 0] } },
      ],
    });
    await window.__help.run('video_write', { name: 'launch-teaser', title: 'Launch teaser', template: 'promo' });
    await window.__help.run('sheet_write', { name: 'sales-2026', title: 'Sales 2026', template: 'sales', ops: [{ op: 'note', cell: 'F2', text: 'Revenue = Units × Price' }, { op: 'set', range: 'H8', value: 'Average order' }, { op: 'set', range: 'I8', formula: '=AVERAGE(F2:F13)' }, { op: 'format', range: 'I8', number: 'currency', bold: true }] });
    await window.__help.run('docs_write', {
      name: 'launch-proposal', title: 'Mobile app launch', template: 'proposal',
      ops: [
        { op: 'page', size: 'a4' },
        { op: 'replace', section: 'Summary', markdown: "# Summary\n\nCustomers want to order on their phones: 62% of last quarter's visits came from mobile[^1]. We propose a **native app** for iOS and Android, launched in two phases, to lift repeat orders by 15% within six months.\n\n[^1]: Analytics dashboard, Q3 2026." },
        { op: 'replace', section: 'Goals', markdown: '# Goals\n\n- [x] Agree the scope with sales and support\n- [ ] Beta with 200 customers by March\n- [ ] Public launch before the summer sale' },
        { op: 'suggest', find: 'lift repeat orders', replace: 'increase repeat orders' },
        { op: 'comment', find: 'two phases', text: 'Can we show the phases in the timeline table?' },
        { op: 'table_cell', table: 'Timeline', row: 2, col: 3, text: 'Jan 12' },
        { op: 'table_cell', table: 'Timeline', row: 3, col: 3, text: 'Mar 2' },
        { op: 'table_cell', table: 'Timeline', row: 4, col: 3, text: 'May 18' },
      ],
    });
    await window.__help.run('slides_write', {
      name: 'launch-pitch', title: 'Lumen pitch', template: 'pitch',
      ops: [
        { op: 'text', slide: 1, el: 'title', text: 'Lumen' },
        { op: 'text', slide: 1, el: 'subtitle', text: 'Meeting notes that write themselves — for teams of 5 to 50' },
        { op: 'animate', slide: 7, el: 2, effect: 'fade-in' },
        { op: 'animate', slide: 7, el: 'title', effect: 'fly-up', start: 'with' },
        { op: 'notes', slide: 7, text: 'Pause on June. Say: the price change in March is what tripled revenue. Then hand over to the competition slide.' },
        { op: 'comment', slide: 7, text: 'Add the source of these numbers?' },
      ],
    });
    const sketch = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260"><rect width="480" height="260" fill="#fef7e0"/><circle cx="380" cy="70" r="40" fill="#fbbc04"/><path d="M0 220 L120 120 L210 190 L300 110 L480 230 L480 260 L0 260Z" fill="#81c995"/><path d="M0 240 L160 170 L260 230 L480 200 L480 260 L0 260Z" fill="#34a853"/></svg>');
    await window.__help.run('notes_write', {
      name: 'notes', title: 'Notes', labels: ['Home', 'Work', 'Travel', 'Ideas'],
      ops: [
        { op: 'add', title: 'Book club', body: 'Next pick: The Remains of the Day.\nBring snacks for Thursday.', color: 'blossom', labels: ['Home'] },
        { op: 'add', title: 'App ideas', body: 'A plant-watering reminder that learns from the weather.\n\nShared shopping list with aisle order.', color: 'dusk', background: 'notes', labels: ['Ideas'] },
        { op: 'add', title: 'Lisbon weekend', body: 'Tram 28 early morning, Time Out Market for lunch, sunset at Miradouro da Senhora do Monte.', color: 'fog', background: 'travel', labels: ['Travel'] },
        { op: 'add_image', note: 'Lisbon weekend', src: sketch, alt: 'Hills at sunset' },
        { op: 'add', title: 'Sprint 14 actions', items: ['Write the release notes', 'Fix the login error message', '[x] Book the retro room', 'Review the checkout PR'], color: 'sand', labels: ['Work'], reminder: { at: 'tomorrow 9:00' } },
        { op: 'add', title: 'Groceries', items: ['Oat milk', 'Eggs', 'Spinach', 'Coffee beans', '[x] Bread', '[x] Lemons'], color: 'mint', background: 'groceries', labels: ['Home'], pinned: true },
        { op: 'add', title: 'Wi-Fi at the office', body: 'Network: Pigry-Guest\nAsk reception for the code', color: 'default', labels: ['Work'] },
        { op: 'add', title: 'Call the dentist', body: 'Move the check-up to the week of the 8th.', color: 'coral', pinned: true, reminder: { at: 'today 17:30' } },
      ],
    });
    await window.__help.run('api_env', { action: 'create', name: 'staging', values: { baseUrl: 'https://petstore.example.com/v1', token: 'demo-token' }, secret: ['token'] });
    await window.__help.run('api_write', {
      name: 'petstore', title: 'Petstore API',
      ops: [
        { op: 'set_auth', auth: { type: 'bearer', token: '{{token}}' } },
        { op: 'add_folder', name: 'Pets' }, { op: 'add_folder', name: 'Owners' }, { op: 'add_folder', name: 'Auth' },
        { op: 'add_request', parent: 'Auth', name: 'Log in', method: 'POST', url: '{{baseUrl}}/login', auth: { type: 'none' }, body: { json: { email: 'ann@example.com', password: '{{password}}' } } },
        { op: 'add_request', parent: 'Pets', name: 'List pets', url: '{{baseUrl}}/pets?species=cat&limit=20&page=1', headers: { Accept: 'application/json' },
          tests: 'pm.test("Status code is 200", () => pm.response.to.have.status(200));\npm.test("Returns a list of pets", () => pm.expect(pm.response.json().data).to.be.an("array"));\npm.test("Response time is below 500 ms", () => pm.expect(pm.response.responseTime).to.be.below(500));' },
        { op: 'add_request', parent: 'Pets', name: 'Get pet', url: '{{baseUrl}}/pets/:petId', path_vars: { petId: '101' } },
        { op: 'add_request', parent: 'Pets', name: 'Create pet', method: 'POST', url: '{{baseUrl}}/pets', body: { json: { name: 'Mochi', species: 'cat' } } },
        { op: 'add_request', parent: 'Pets', name: 'Update pet', method: 'PATCH', url: '{{baseUrl}}/pets/:petId', path_vars: { petId: '101' }, body: { json: { age: 4 } } },
        { op: 'add_request', parent: 'Pets', name: 'Delete pet', method: 'DELETE', url: '{{baseUrl}}/pets/:petId', path_vars: { petId: '101' } },
        { op: 'add_request', parent: 'Owners', name: 'List owners', url: '{{baseUrl}}/owners' },
      ],
    });
    await window.__help.run('audio_write', {
      name: 'podcast-episode', title: 'Podcast episode', template: 'podcast',
      ops: [
        { op: 'generate', type: 'tone', wave: 'sawtooth', freq: 140, amp: 0.35, track: 't1', start: 0, duration: 3 },
        { op: 'generate', type: 'chirp', freq: 200, freq2: 3600, amp: 0.4, track: 't1', start: 3, duration: 3 },
        { op: 'generate', type: 'noise', color: 'pink', amp: 0.25, track: 't1', start: 6, duration: 2 },
        { op: 'generate', type: 'tone', wave: 'triangle', freq: 220, amp: 0.4, track: 't2', start: 0, duration: 8 },
        { op: 'generate', type: 'tone', wave: 'triangle', freq: 330, amp: 0.3, track: 't2', start: 1, duration: 7 },
        { op: 'generate', type: 'click', bpm: 120, amp: 0.5, track: 't3', start: 0, duration: 8 },
        { op: 'effect', effect: 'eq', params: { low: -3, highmid: 3 }, from: 0, to: 6, track: 't1' },
        { op: 'effect', effect: 'reverb', params: { room: 0.6, wet: 0.2 }, from: 6, to: 8, track: 't1' },
        { op: 'fade_in', from: 0, to: 1, track: 't2' }, { op: 'fade_out', from: 6.5, to: 8, track: 't2' },
        { op: 'track_set', track: 't1', view: 'both', name: 'Voice' },
        { op: 'label_add', start: 0, text: 'Intro' }, { op: 'label_add', start: 3, end: 6, text: 'Sweep demo' }, { op: 'label_add', start: 6, text: 'Outro' },
      ],
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
  const only = process.env.HELP_ONLY ? process.env.HELP_ONLY.split(',') : null;
  for (const { id, label } of workspaceNav) {
    if (only && !only.includes(id)) continue;
    await page.evaluate((on) => { window.__rebaseShot = on; }, id === 'rebase-branch');
    const conflictShot = id === 'merge-conflicts';
    if (await page.evaluate((on) => { const changed = !!window.__conflictShot !== on; window.__conflictShot = on; if (changed) window.testBackend.emit('repo-changed', null); return changed; }, conflictShot)) await page.waitForTimeout(600);
    await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${label}$`, 'i') }) }).click();
    await page.waitForTimeout(900);
    await PREPARE[id]?.(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${id}.jpg`), type: 'jpeg', quality: 82 });
    results.push(id);
  }
  // A second picture for Pull requests: the Open a pull request page.
  await page.evaluate(() => { window.__prShot = true; });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Pull requests$/ }) }).click();
  await page.getByRole('button', { name: 'New pull request' }).first().click();
  await quiet(page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu', { timeout: 4000 }));
  await quiet(page.getByRole('textbox', { name: 'Pull request description' }).fill('Adds a keyboard-first command palette with fuzzy search.\n\n- opens with Ctrl+K\n- lists repository actions'));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'new-pull-request.jpg'), type: 'jpeg', quality: 82 });
  await page.evaluate(() => { window.__prShot = false; });

  // A second picture for Actions: one run opened on its own page.
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Actions$/ }) }).click();
  await page.locator('.actions-main').getByText('fix: preserve scroll position on refresh', { exact: true }).first().click();
  await quiet(page.getByRole('heading', { name: /preserve scroll position/ }).waitFor({ timeout: 5000 }));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'actions-run.jpg'), type: 'jpeg', quality: 82 });

  // The Extension Store is not a workspace menu: install two packs from it, then show Settings > Extensions.
  await page.locator('.nav-item').filter({ hasText: 'Extension Store' }).click();
  for (const name of ['Code Quality Pack', 'Documentation Pack']) {
    await page.getByRole('button', { name: `Install ${name}` }).click();
    await page.getByRole('dialog', { name: `Install ${name}` }).getByRole('button', { name: 'Install', exact: true }).click();
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'extensions.jpg'), type: 'jpeg', quality: 82 });
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.locator('.app-settings__menu').getByRole('button', { name: 'Extensions' }).click();
  await quiet(page.getByRole('button', { name: 'Details of Code Quality Pack' }).click({ timeout: 3000 }));
  await quiet(page.locator('.app-settings__content').evaluate((el) => { el.scrollTop = 0; }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'extensions-settings.jpg'), type: 'jpeg', quality: 82 });
  expect(results).toHaveLength(only ? workspaceNav.filter(({ id }) => only.includes(id)).length : workspaceNav.length);
});
