import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function openTauriWorkspace(page) {
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    let nextTerminal = 300;
    bridge.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      if (cmd === 'read_worktree_file' && args.path === 'package.json') {
        return { ...result, content: JSON.stringify({ scripts: { tauri: 'tauri', dev: 'vite' } }) };
      }
      if (cmd === 'pty_create') {
        const id = ++nextTerminal;
        if (args.startupCommand) window.testBackend.startupId = id;
        return { id, label: 'Shell', shellName: 'shell' };
      }
      return result;
    };
  });
  const composer = page.getByRole('textbox', { name: 'Ask AI' });
  if (await composer.count() === 0) await page.locator('.ai-rail-strip').click();
  await composer.fill('start ให้หน่อย');
  await composer.press('Enter');
  await expect(page.getByText(/Ran .* in the workspace terminal/)).toBeVisible();
  await expect(page.locator('.terminal-panel')).toBeVisible();
}

test('Explorer starts a Tauri workspace in a fresh terminal without an AI provider', async ({ page }) => {
  await openTauriWorkspace(page);
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls.filter(({ cmd, args }) => cmd === 'pty_create' && args.startupCommand).map(({ args }) => args.startupCommand))
    .toEqual(['npm run tauri dev']);
  expect(calls.some(({ cmd }) => cmd === 'ai_chat')).toBe(false);
});

test('Explorer passes a failed startup and its redacted log to Coder', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'fixture', name: 'Fixture', type: 'custom', apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture',
      enabled: true, model: 'fixture-model',
      models: [{ id: 'fixture-model', name: 'fixture-model', enabled: true }],
    }]));
  });
  await openTauriWorkspace(page);
  await page.evaluate(() => {
    const backend = window.testBackend;
    backend.emit('pty-output', { id: backend.startupId, data: 'warning: compile output\n' });
    backend.emit('pty-exit', { id: backend.startupId + 100, code: 1, output: 'Unrelated failure' });
  });
  expect(await page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'ai_chat').length)).toBe(0);
  await page.evaluate(() => {
    const backend = window.testBackend;
    backend.emit('pty-exit', {
      id: backend.startupId, code: 1,
      output: 'error: cannot find module ./main.js\nAPI_KEY=fixture-secret',
    });
  });
  await expect(page.getByText('Test model reply', { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'ai_chat'));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.body).toContain('cannot find module ./main.js');
  expect(calls[0].args.body).toContain('code-implementation');
  expect(calls[0].args.body).not.toContain('fixture-secret');
  expect(calls[0].args.body).not.toContain('Unrelated failure');
});
