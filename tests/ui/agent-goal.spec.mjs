import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('Goal continues past summaries and partial blockers until the work is verified', async ({ page }) => {
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
    let round = 0;
    bridge.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      if (cmd !== 'ai_chat' || args.body.includes('[session-end task]')) return result;
      round++;
      const message = round === 1 ? { content: 'Browser launch failed. I can still write the test cases. Which would you like?' }
        : round === 2 ? { content: 'Browser launch failed.\n**Goal status: blocked**' }
          : round === 3 ? { tool_calls: [{ id: 'write-qa', function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: '.pigry/reports/qa.md', content: '# Test cases\n1. Open a note.' }),
          } }] }
            : round <= 9 ? { content: `Verification checkpoint ${round}.\nGoal status: continue` }
              : { content: 'Saved and verified the report.\n**Goal status: complete**' };
      return { ...result, body: JSON.stringify({ choices: [{ message }] }) };
    };
  });
  const composer = page.getByRole('textbox', { name: 'Ask AI' });
  if (await composer.count() === 0) await page.locator('.ai-rail-strip').click();
  const mode = page.getByRole('combobox', { name: 'Chat mode' });
  await expect(mode).toHaveValue('normal');
  await mode.selectOption('goal');
  await composer.fill('@qa Write test cases and run the available checks.');
  await composer.press('Enter');
  await expect(page.getByText(/Saved and verified the report/)).toBeVisible();
  await expect(mode).toBeEnabled();
  const calls = await page.evaluate(() => window.testBackend.calls);
  const modelCalls = calls.filter(({ cmd, args }) => cmd === 'ai_chat' && !args.body.includes('[session-end task]'));
  expect(modelCalls).toHaveLength(10);
  expect(modelCalls[2].args.body).toContain('Finish any independent deliverables now');
  expect(modelCalls[2].args.body).toContain('Write test cases and run the available checks');
  expect(calls.some(({ cmd, args }) => cmd === 'write_worktree_file' && args.path === '.pigry/reports/qa.md')).toBe(true);
});
