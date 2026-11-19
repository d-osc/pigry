import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('workspace tools run for default and tagged agents and honor the Tools switch', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'tool-fixture',
      name: 'Tool fixture',
      type: 'custom',
      kind: 'custom',
      apiFormat: 'openai',
      baseUrl: 'https://fixture.invalid/v1/chat/completions',
      apiKey: 'fixture',
      enabled: true,
      model: 'tool-model',
      models: [{ id: 'tool-model', name: 'tool-model', enabled: true }],
    }]));
    localStorage.setItem('pigry:agent-factory-version', '3');
    localStorage.setItem('pigry:agent-overrides', JSON.stringify({
      'branch-diff-reviewer': { tools: ['git-compare-branches'] },
    }));
  });
  const comparison = {
    baseOid: '1'.repeat(40),
    compareOid: '2'.repeat(40),
    baseOnly: 1,
    compareOnly: 2,
    files: [{ path: 'changed.txt', status: 'M', additions: 1, deletions: 1 }],
  };
  await installBackend(page, { branchComparison: comparison });
  await openFixture(page);
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (cmd, args) => {
      const reply = await invoke(cmd, args);
      if (cmd !== 'ai_chat') return reply;
      const payload = JSON.parse(args.body);
      const last = payload.messages.at(-1);
      const message = last.role === 'tool'
        ? { content: last.content.startsWith('error:') ? 'Unavailable tool was blocked' : 'Compared file versions' }
        : { tool_calls: [{
            id: 'compare',
            type: 'function',
            function: { name: 'compare_branches', arguments: JSON.stringify({
              base_ref: 'refs/heads/main', compare_ref: 'refs/heads/feature', path: 'changed.txt',
            }) },
          }] };
      return { ...reply, body: JSON.stringify({ choices: [{ message }] }) };
    };
  });
  await page.locator('.nav-item').filter({ hasText: 'Compare branch' }).click();
  await page.locator('.ai-rail-strip').click();

  const send = async (text) => {
    await page.getByRole('textbox', { name: 'Ask AI' }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await send('Compare the file');
  await expect(page.getByText('Compared file versions', { exact: true })).toHaveCount(1);
  await send('@branch-diff-reviewer Compare the file');
  await expect(page.getByText('Compared file versions', { exact: true })).toHaveCount(2);

  await page.getByRole('tab', { name: 'Tools' }).click();
  const compareTool = page.getByRole('checkbox', { name: /compare_branches/ });
  await expect(compareTool).toBeChecked();
  await compareTool.uncheck();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await send('@branch-diff-reviewer Compare with the tool disabled');
  await expect(page.getByText('Unavailable tool was blocked', { exact: true })).toBeVisible();

  const calls = await page.evaluate(() => window.testBackend.calls);
  const comparisons = calls.filter(({ cmd, args }) => cmd === 'compare_branches' && args.compareRef === 'refs/heads/feature');
  expect(comparisons.map(({ args }) => args)).toEqual([
    { baseRef: 'refs/heads/main', compareRef: 'refs/heads/feature' },
    { baseRef: 'refs/heads/main', compareRef: 'refs/heads/feature' },
  ]);
  const payloads = calls.filter(({ cmd }) => cmd === 'ai_chat').map(({ args }) => JSON.parse(args.body));
  const firstTools = payloads[0].tools.map(({ function: tool }) => tool.name);
  expect(firstTools).toEqual(expect.arrayContaining(['compare_branches', 'read_history', 'read_commit', 'git_status']));
  expect(firstTools).not.toContain('delete_file');
  expect(payloads[2].tools.map(({ function: tool }) => tool.name)).toEqual(['compare_branches']);
  expect(payloads[4].tools).toEqual([]);
  const results = payloads.map(payload => payload.messages.at(-1)).filter(message => message.role === 'tool');
  expect(results.map(result => result.content)).toEqual([
    JSON.stringify({ original: 'before\n', modified: 'after\n' }),
    JSON.stringify({ original: 'before\n', modified: 'after\n' }),
    'error: unknown tool compare_branches',
  ]);
});
