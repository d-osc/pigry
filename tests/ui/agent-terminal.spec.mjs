import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('agent commands stream into the integrated terminal before the tool returns', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'fixture', name: 'Fixture', type: 'custom', apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture',
      enabled: true, model: 'fixture-model',
      models: [{ id: 'fixture-model', name: 'fixture-model', enabled: true }],
    }]));
  });
  await installBackend(page);
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    let firstReply = true;
    bridge.invoke = async (cmd, args) => {
      if (cmd === 'agent_shell_run') {
        args.onOutput.onmessage('working…\n');
        return new Promise((resolve) => {
          window.testBackend.finishCommand = () => {
            args.onOutput.onmessage('failed with a useful error\n');
            resolve({ output: 'failed with a useful error', code: 7, timedOut: false });
          };
        });
      }
      const result = await invoke(cmd, args);
      if (cmd === 'ai_chat' && firstReply) {
        firstReply = false;
        return { ...result, body: JSON.stringify({ choices: [{ message: { tool_calls: [{
          id: 'tool-1',
          function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) },
        }] } }] }) };
      }
      return result;
    };
  });

  const composer = page.getByRole('textbox', { name: 'Ask AI' });
  if (await composer.count() === 0) await page.locator('.ai-rail-strip').click();
  await composer.fill('Run the tests');
  await composer.press('Enter');

  const log = page.getByRole('log', { name: 'Agent commands' });
  await expect(log).toBeVisible();
  await expect(log).toContainText('$ npm test');
  await expect(log).toContainText('working…');
  await expect(log).toContainText('Running');
  await page.evaluate(() => window.testBackend.finishCommand());
  await expect(log).toContainText('failed with a useful error');
  await expect(log).toContainText('Exit code 7');
  await expect(page.getByText('Test model reply', { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls.filter(({ cmd }) => cmd === 'ai_chat'));
  expect(calls.at(-1).args.body).toContain('failed with a useful error');
  await page.getByRole('button', { name: 'Close Agent commands' }).click();
  await expect(log).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent commands', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Integrated terminal' })).toBeVisible();
});
