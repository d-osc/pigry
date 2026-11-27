import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const COMPARISON = {
  baseOid: '1'.repeat(40), compareOid: '2'.repeat(40), baseOnly: 0, compareOnly: 2,
  files: [
    { path: 'src/components/command-menu.tsx', status: 'A', additions: 3, deletions: 0 },
    { path: 'src/components/command-menu.spec.tsx', status: 'A', additions: 2, deletions: 0 },
  ],
};

const DRAFT_CONTEXT = {
  mergeBaseOid: '1'.repeat(40),
  commits: [
    { shortOid: 'a1b2c3d', message: 'feat: add the command menu\n\nOpens with Ctrl+K.' },
    { shortOid: 'e4f5a6b', message: 'test: cover the command menu' },
  ],
  files: [
    {
      path: 'src/components/command-menu.tsx', previousPath: null, status: 'A', additions: 3, deletions: 0, binary: false, truncated: false,
      patch: 'diff --git a/src/components/command-menu.tsx b/src/components/command-menu.tsx\n@@ -0,0 +1,3 @@\n+export function CommandMenu() {\n+  return null;\n+}\n',
    },
    {
      path: 'src/components/command-menu.spec.tsx', previousPath: null, status: 'A', additions: 2, deletions: 0, binary: false, truncated: false,
      patch: '@@ -0,0 +1,2 @@\n+test("opens", () => {});\n+test("closes", () => {});\n',
    },
  ],
  template: null,
};

const REPLY = 'TITLE: Add a command menu opened with Ctrl+K\n---\n## Summary\n- Adds a command menu.\n\n## Changes\n**UI**\n- New `CommandMenu` component.\n\n## Testing\n- New spec covers opening and closing.';
const GENERATED = '## Summary\n- Adds a command menu.\n\n## Changes\n**UI**\n- New `CommandMenu` component.\n\n## Testing\n- New spec covers opening and closing.';

/** `provider: false` starts with no AI provider set up; `model` (and its `effort`) is the provider's selected model. */
async function setup(page, { provider = true, model = 'fixture-model', effort } = {}) {
  if (provider) {
    await page.addInitScript(({ model, effort }) => {
      localStorage.setItem('pigry:ai-providers', JSON.stringify([{
        id: 'fixture', name: 'Fixture', type: 'custom', apiFormat: 'openai',
        baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture',
        enabled: true, model,
        models: [{ id: model, name: model, enabled: true, ...(effort ? { effort } : {}) }],
      }]));
    }, { model, effort });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page, { branchComparison: COMPARISON });
  await openFixture(page);
  await page.evaluate(({ context, reply }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__prPrompts = [];
    window.__prReply = { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: reply } }] }), error: '' };
    // Set to a promise to hold the model's answer until the test resolves it.
    window.__prHold = null;
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'get_branch_commits') {
        const full = await invoke('get_commit_history', { includeRemotes: false });
        return args.refName === 'main' ? { ...full, commits: full.commits.slice(2) } : full;
      }
      if (cmd === 'pr_draft_context') return context;
      if (cmd === 'ai_chat' && args.body.includes('GitHub pull request')) {
        window.__prPayloads = [...(window.__prPayloads ?? []), JSON.parse(args.body)];
        window.__prPrompts.push(JSON.parse(args.body).messages[0].content);
        if (window.__prHold) await window.__prHold;
        return window.__prReply;
      }
      return invoke(cmd, args);
    };
  }, { context: DRAFT_CONTEXT, reply: REPLY });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Pull requests$/ }) }).click();
  await page.getByRole('button', { name: 'New pull request' }).first().click();
  await expect(page.getByRole('heading', { name: 'Open a pull request' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Compare branch' }).selectOption('feat/command-menu');
  await expect(page.locator('.npr-compare__status')).toContainText('2 commits');
}

test('Generate description fills an empty description from the commits and the diff, and offers a better title', async ({ page }) => {
  await setup(page);
  const body = page.getByRole('textbox', { name: 'Pull request description' });
  const generate = page.getByRole('button', { name: 'Generate description' });
  await expect(generate).toBeEnabled();

  // While the model works the description is locked and the run can be cancelled; a cancelled answer is dropped.
  await page.evaluate(() => { window.__prHold = new Promise((resolve) => { window.__prRelease = resolve; }); });
  await generate.click();
  await expect(page.getByRole('status').filter({ hasText: 'Writing a description from 2 commits and 2 changed files' })).toBeVisible();
  await expect(body).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Cancel generating the description' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Writing a description' })).toHaveCount(0);
  await page.evaluate(() => { window.__prHold = null; window.__prRelease(); });
  await page.waitForTimeout(150);
  await expect(body).toHaveValue('');
  await expect(body).not.toHaveAttribute('readonly', '');

  await generate.click();
  await expect(body).toHaveValue(GENERATED);

  // The prompt carries the commits (with bodies), the patch and the layout, in the commits' language.
  const prompt = await page.evaluate(() => window.__prPrompts.at(-1));
  expect(prompt).toContain('merges "feat/command-menu" into "main"');
  expect(prompt).toContain('Write it in English');
  expect(prompt).toContain('a1b2c3d feat: add the command menu');
  expect(prompt).toContain('Opens with Ctrl+K.');
  expect(prompt).toContain('+export function CommandMenu() {');
  expect(prompt).toContain('## Testing');

  const suggestion = page.getByRole('group', { name: 'Suggested title' });
  await expect(suggestion).toContainText('Add a command menu opened with Ctrl+K');
  await suggestion.getByRole('button', { name: 'Use this title' }).click();
  await expect(page.getByRole('textbox', { name: 'Pull request title' })).toHaveValue('Add a command menu opened with Ctrl+K');
  await expect(suggestion).toHaveCount(0);

  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.locator('.npr-preview h2').first()).toHaveText('Summary');
});

test('text already in the description is kept until the user chooses where the generated one goes', async ({ page }) => {
  await setup(page);
  const body = page.getByRole('textbox', { name: 'Pull request description' });
  await body.fill('Fixes #12');
  await page.getByRole('button', { name: 'Generate description' }).click();

  const ask = page.getByRole('alertdialog', { name: 'Use the generated description' });
  await expect(ask).toContainText('already has text');
  await expect(ask.getByLabel('Generated description')).toContainText('Adds a command menu.');
  await expect(body).toHaveValue('Fixes #12');

  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(ask).toHaveCount(0);
  await expect(body).toHaveValue('Fixes #12');

  await page.getByRole('button', { name: 'Generate description' }).click();
  await ask.getByRole('button', { name: 'Add below' }).click();
  await expect(body).toHaveValue(`Fixes #12\n\n${GENERATED}`);

  await page.getByRole('button', { name: 'Generate description' }).click();
  await ask.getByRole('button', { name: 'Replace' }).click();
  await expect(body).toHaveValue(GENERATED);
});

test('a failed call or a missing provider shows an error and keeps the description', async ({ page }) => {
  await setup(page);
  const body = page.getByRole('textbox', { name: 'Pull request description' });
  await body.fill('My own notes');
  await page.evaluate(() => {
    window.__prReply = { ok: false, status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }), error: '' };
  });
  await page.getByRole('button', { name: 'Generate description' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t generate the description' });
  await expect(alert).toContainText('Invalid API key');
  await expect(body).toHaveValue('My own notes');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await alert.getByRole('button', { name: 'Dismiss the error' }).click();
  await expect(alert).toHaveCount(0);
});

test('without an AI provider the button says how to set one up', async ({ page }) => {
  await setup(page, { provider: false });
  const body = page.getByRole('textbox', { name: 'Pull request description' });
  await body.fill('Draft');
  await page.getByRole('button', { name: 'Generate description' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t generate the description' })).toContainText('No AI provider is connected');
  await expect(body).toHaveValue('Draft');
  expect(await page.evaluate(() => window.__prPrompts.length)).toBe(0);
});

test('a reasoning model gets its output-token limit and effort, and running out of tokens is explained', async ({ page }) => {
  await setup(page, { model: 'gpt-6.2-sol', effort: 'medium' });
  const body = page.getByRole('textbox', { name: 'Pull request description' });
  await page.evaluate(() => {
    window.__prReply = {
      ok: true, status: 200, error: '',
      body: JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Thinking about the diff…' }, finish_reason: 'length' }] }),
    };
  });
  await page.getByRole('button', { name: 'Generate description' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t generate the description' });
  await expect(alert).toContainText('gpt-6.2-sol · medium ran out of output tokens before it answered (length)');
  await expect(body).toHaveValue('');

  // The request is built like an AI panel turn: the model's own limit and the chosen effort, no temperature.
  const [payload] = await page.evaluate(() => window.__prPayloads);
  expect(payload).toMatchObject({ model: 'gpt-6.2-sol', max_tokens: 128000, reasoning_effort: 'medium', stream: false });
  expect(payload).not.toHaveProperty('temperature');

  // The answer may come back as content parts.
  await page.evaluate(() => {
    window.__prReply = {
      ok: true, status: 200, error: '',
      body: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'TITLE: Parts\n---\n## Summary\n- From parts.' }] }, finish_reason: 'stop' }] }),
    };
  });
  await page.getByRole('button', { name: 'Generate description' }).click();
  await expect(body).toHaveValue('## Summary\n- From parts.');
  await expect(alert).toHaveCount(0);
});
