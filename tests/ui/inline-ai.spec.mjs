import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

const PATH = 'src/lib/search.ts';
const SOURCE = [
  'export function add(a: number, b: number) {',
  '  return a + b;',
  '}',
  '',
  '',
].join('\n');
const COMPLETION = 'add(1, 2);';
const EDIT_REPLY = 'Here you go:\n```ts\n  if (!Number.isFinite(a + b)) throw new Error("not a number");\n  return a + b;\n```';

/** `provider: false` starts with no AI provider set up. Completion and inline-edit calls are recorded in
 * `window.__aiCalls` ({ kind, prompt }); `window.__aiHold` (a promise) holds the answers back. */
async function setup(page, { provider = true, files = {} } = {}) {
  await page.addInitScript((provider) => {
    localStorage.removeItem('pigry:ai-completions');
    localStorage.removeItem('pigry:ai-completions-model');
    if (!provider) return;
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'fixture', name: 'Fixture', type: 'custom', apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture',
      enabled: true, model: 'fixture-model',
      models: [{ id: 'fixture-model', name: 'fixture-model', enabled: true }, { id: 'fast-model', name: 'fast-model', enabled: true }],
    }]));
  }, provider);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(({ path, source, completion, editReply, files }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__aiCalls = [];
    window.__aiHold = null;
    window.__completion = completion;
    window.__editReply = editReply;
    const reply = (content) => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }), error: '' });
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'read_worktree_file' && (args.path === path || files[args.path] !== undefined)) {
        return { path: args.path, content: files[args.path] ?? source, binary: false, tooLarge: false, language: 'typescript' };
      }
      if (cmd === 'get_file_tree') {
        const tree = await invoke(cmd, args);
        return { ...tree, entries: [...tree.entries, ...Object.keys(files)] };
      }
      if (cmd === 'ai_chat') {
        const body = JSON.parse(args.body);
        const prompt = body.messages[0].content;
        const kind = prompt.includes('code completion engine') ? 'complete' : prompt.includes('inline chat') ? 'edit' : 'other';
        if (kind !== 'other') {
          window.__aiCalls.push({ kind, prompt, body });
          if (window.__aiHold) await window.__aiHold;
          return reply(kind === 'complete' ? window.__completion : window.__editReply);
        }
      }
      return invoke(cmd, args);
    };
  }, { path: PATH, source: SOURCE, completion: COMPLETION, editReply: EDIT_REPLY, files });
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Explorer$/ }) }).click();
  await page.locator('.tree-row[data-path="src/lib"]').click();
  await page.locator(`.tree-row[data-path="${PATH}"]`).click();
  await expect(editorText(page)).toContainText('return a + b;');
}

const editorText = (page) => page.locator('.editor-pane__editor .monaco-editor .view-lines').first();
/** The buffer as rendered: view lines in top-to-bottom order, ghost text left out. */
const editorValue = (page) => page.evaluate(() => {
  const host = document.querySelector('.editor-pane__editor .monaco-editor .view-lines');
  return [...host.querySelectorAll('.view-line')]
    .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
    .map((line) => {
      const copy = line.cloneNode(true);
      copy.querySelectorAll('.ghost-text-decoration, .ghost-text-decoration-preview').forEach((span) => span.remove());
      return copy.textContent.replaceAll(String.fromCharCode(160), ' ');
    })
    .join('\n');
});
const ghost = (page) => page.locator('.editor-pane__editor .ghost-text-decoration');
/** Ghost text is split into syntax-coloured spans: join them. */
const ghostText = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.editor-pane__editor .ghost-text-decoration')].map((span) => span.textContent).join('').replaceAll(String.fromCharCode(160), ' '));
const calls = (page, kind) => page.evaluate((kind) => window.__aiCalls.filter((call) => call.kind === kind), kind);

/** Puts the cursor on the empty line under the function and types (insertText skips the suggest widget). */
async function typeAtEnd(page, text) {
  await editorText(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

test('ghost text appears after a pause, Tab inserts it and the request carries the file context', async ({ page }) => {
  await setup(page);
  const toggle = page.getByRole('button', { name: /^AI completions:/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => { window.__aiHold = new Promise((resolve) => { window.__aiRelease = resolve; }); });
  await typeAtEnd(page, 'const sum = ');
  // The status bar spins while the model thinks.
  await expect(page.getByLabel('AI is thinking')).toBeVisible();
  await page.evaluate(() => window.__aiRelease());
  await expect.poll(() => ghostText(page)).toBe('add(1, 2);');
  await expect(page.getByLabel('AI is thinking')).toHaveCount(0);

  const [call] = await calls(page, 'complete');
  expect(call.prompt).toContain(`File: ${PATH} (typescript)`);
  expect(call.prompt).toContain('export function add(a: number, b: number) {\n  return a + b;\n}\n\nconst sum = <CURSOR>');
  expect(call.body.model).toBe('fixture-model');
  expect(call.body.max_tokens).toBe(256);

  await page.keyboard.press('Tab');
  await expect(ghost(page)).toHaveCount(0);
  expect(await editorValue(page)).toContain('const sum = add(1, 2);');
});

test('Esc dismisses the ghost text, and Ctrl+→ accepts it one word at a time', async ({ page }) => {
  await setup(page);
  await typeAtEnd(page, 'const sum = ');
  await expect.poll(() => ghostText(page)).toBe('add(1, 2);');
  await page.keyboard.press('Escape');
  await expect(ghost(page)).toHaveCount(0);
  expect(await editorValue(page)).toMatch(/const sum = $/m);

  await page.keyboard.insertText(' ');
  await page.keyboard.press('Backspace');
  await expect.poll(() => ghostText(page)).toBe('add(1, 2);');
  await page.keyboard.press('Control+ArrowRight');
  await expect.poll(() => editorValue(page)).toContain('const sum = add');
  expect(await editorValue(page)).not.toContain('add(1, 2);');
});

test('the status-bar toggle turns completions off and the choice is saved', async ({ page }) => {
  await setup(page);
  const toggle = page.getByRole('button', { name: /^AI completions:/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAccessibleName('AI completions: off');
  expect(await page.evaluate(() => localStorage.getItem('pigry:ai-completions'))).toBe('0');

  await typeAtEnd(page, 'const sum = ');
  await page.waitForTimeout(900);
  await expect(ghost(page)).toHaveCount(0);
  expect(await calls(page, 'complete')).toHaveLength(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.insertText('a');
  await page.keyboard.press('Backspace');
  await expect.poll(() => ghostText(page)).toBe('add(1, 2);');
});

test('secret-looking files are never sent for completions', async ({ page }) => {
  await setup(page, { files: { '.env.local': 'API_URL=https://example.invalid\n' } });
  await page.locator('.tree-row[data-path=".env.local"]').click();
  await expect(editorText(page)).toContainText('API_URL');
  await expect(page.getByRole('button', { name: /^AI completions:/ })).toHaveAttribute('title', /off for this file \(looks like a secrets file\)/);
  await editorText(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('SECRET=');
  await page.waitForTimeout(900);
  await expect(ghost(page)).toHaveCount(0);
  expect(await calls(page, 'complete')).toHaveLength(0);
});

/** Selects the `return a + b;` line. */
async function selectReturnLine(page) {
  await editorText(page).locator('.view-line', { hasText: 'return' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Shift+Home');
}

test('Ctrl+I shows the edit as an inline diff: Accept applies it, Discard keeps the original', async ({ page }) => {
  await setup(page);
  await selectReturnLine(page);
  await page.keyboard.press('Control+i');
  const panel = page.getByRole('dialog', { name: 'AI inline edit' });
  const instruction = panel.getByRole('textbox', { name: 'Edit instruction' });
  await expect(instruction).toBeFocused();
  await instruction.fill('add error handling');
  await page.evaluate(() => { window.__aiHold = new Promise((resolve) => { window.__aiRelease = resolve; }); });
  await instruction.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Generating…');
  await page.evaluate(() => window.__aiRelease());

  // The old line is marked removed in the editor, the new lines are shown under it.
  const suggested = panel.getByLabel('Suggested code');
  await expect(suggested).toContainText('if (!Number.isFinite(a + b)) throw new Error("not a number");');
  await expect(page.locator('.editor-pane__editor .inline-edit-removed')).toHaveCount(1);
  expect(await editorValue(page)).not.toContain('throw new Error');

  const [call] = await calls(page, 'edit');
  expect(call.prompt).toContain('Instruction: add error handling');
  expect(call.prompt).toContain('<region>\n  return a + b;\n</region>');
  expect(call.prompt).toContain('<before>\nexport function add(a: number, b: number) {\n');

  await panel.getByRole('button', { name: 'Accept' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.editor-pane__editor .inline-edit-removed')).toHaveCount(0);
  await expect.poll(() => editorValue(page)).toContain('  if (!Number.isFinite(a + b)) throw new Error("not a number");\n  return a + b;\n}');
  await expect(page.locator('.editor-pane__dirty')).toBeVisible();

  // Undo puts the original back in one step.
  await page.keyboard.press('Control+z');
  await expect.poll(() => editorValue(page)).not.toContain('throw new Error');

  // Discard leaves the code as it was.
  await selectReturnLine(page);
  await page.keyboard.press('Control+i');
  await instruction.fill('convert to async');
  await instruction.press('Enter');
  await expect(suggested).toBeVisible();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(panel).toHaveCount(0);
  expect(await editorValue(page)).toContain('export function add(a: number, b: number) {\n  return a + b;\n}');
  expect(await editorValue(page)).not.toContain('throw new Error');

  // Esc closes the panel too.
  await page.keyboard.press('Control+i');
  await expect(instruction).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('with no AI provider, Ctrl+I says so and keeps the code, and no completion is requested', async ({ page }) => {
  await setup(page, { provider: false });
  await typeAtEnd(page, 'const sum = ');
  await page.waitForTimeout(900);
  await expect(ghost(page)).toHaveCount(0);

  await selectReturnLine(page);
  await page.keyboard.press('Control+i');
  const panel = page.getByRole('dialog', { name: 'AI inline edit' });
  await panel.getByRole('textbox', { name: 'Edit instruction' }).fill('add error handling');
  await panel.getByRole('button', { name: 'Generate' }).click();
  await expect(panel.getByRole('alert')).toContainText('No AI provider is connected — add one in Settings → AI Provider');
  expect(await calls(page, 'edit')).toHaveLength(0);
  expect(await calls(page, 'complete')).toHaveLength(0);
  await panel.getByRole('button', { name: 'Close inline edit' }).click();
  await expect(panel).toHaveCount(0);
  expect(await editorValue(page)).toContain('  return a + b;\n}');
});

test('Explain in the editor context menu sends the selection to the AI Agent panel', async ({ page }) => {
  await setup(page);
  await selectReturnLine(page);
  await editorText(page).locator('.view-line', { hasText: 'return' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'AI: Explain' }).click();
  const chat = page.locator('.explorer-ai__msg-selection').first();
  await expect(chat).toBeVisible();
  await expect(chat).toContainText('return a + b;');
  await expect(page.locator('.explorer-ai').getByText(/Explain the selected code in/).first()).toBeVisible();
});

test('Settings turns completions off and picks the completion model', async ({ page }) => {
  await setup(page);
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Text Editor', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'AI completion model' });
  await expect(model).toHaveValue('');
  await expect(model.getByRole('option')).toHaveText(['Same as chat (fixture-model)', 'fixture-model', 'fast-model']);
  await model.selectOption('fast-model');
  const enabled = page.getByRole('checkbox', { name: 'AI completions' });
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  expect(await page.evaluate(() => [localStorage.getItem('pigry:ai-completions'), localStorage.getItem('pigry:ai-completions-model')])).toEqual(['0', 'fast-model']);
  await enabled.check();

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator(`.tree-row[data-path="${PATH}"]`).click();
  await typeAtEnd(page, 'const sum = ');
  await expect.poll(() => ghostText(page)).toBe('add(1, 2);');
  const [call] = await calls(page, 'complete');
  expect(call.body.model).toBe('fast-model');
});
