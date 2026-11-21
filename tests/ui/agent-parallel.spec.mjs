import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('tagging two agents in one message runs their turns at the same time and lands both replies', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'par-fixture', name: 'Parallel fixture', type: 'custom', kind: 'custom', apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions', apiKey: 'fixture', enabled: true,
      model: 'par-model', models: [{ id: 'par-model', name: 'par-model', enabled: true }],
    }]));
    localStorage.setItem('pigry:agent-factory-version', '3');
  });
  await installBackend(page, { branchComparison: { baseOid: '1'.repeat(40), compareOid: '2'.repeat(40), baseOnly: 0, compareOnly: 0, files: [] } });
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.__inflight = 0;
    window.__maxInflight = 0;
    window.__turns = 0;
    bridge.invoke = async (cmd, args) => {
      const reply = await invoke(cmd, args);
      if (cmd !== 'ai_chat') return reply;
      const n = (window.__turns += 1);
      window.__inflight += 1;
      window.__maxInflight = Math.max(window.__maxInflight, window.__inflight);
      await new Promise((resolve) => setTimeout(resolve, 700));
      window.__inflight -= 1;
      return { ...reply, body: JSON.stringify({ choices: [{ message: { content: `parallel reply ${n}` } }] }) };
    };
  });
  await page.locator('.nav-item').filter({ hasText: 'Compare branch' }).click();
  await page.locator('.ai-rail-strip').click();
  await page.getByRole('textbox', { name: 'Ask AI' }).fill('@branch-diff-reviewer @e2e-qa say hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.getByText(/^parallel reply \d$/)).toHaveCount(2, { timeout: 20000 });
  const stats = await page.evaluate(() => ({ max: window.__maxInflight, turns: window.__turns }));
  expect(stats.turns).toBe(2);
  expect(stats.max, 'both agents were calling the model at the same time').toBe(2);
});
