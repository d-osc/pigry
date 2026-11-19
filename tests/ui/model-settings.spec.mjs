import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

test('model settings prefill, survive reload, and apply to chat requests', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('pigry:ai-providers')) return;
    localStorage.setItem('pigry:ai-providers', JSON.stringify([{
      id: 'fixture-provider',
      name: 'Fixture provider',
      type: 'custom',
      kind: 'custom',
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'fixture',
      enabled: true,
      model: 'gpt-5.4',
      models: [{ id: 'saved-model', name: 'gpt-5.4', enabled: true, vision: false }],
    }]));
  });
  await installBackend(page);
  await openFixture(page);
  const openModels = async () => {
    await page.locator('.profile-button').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'AI Provider', exact: true }).click();
  };
  await openModels();
  const existing = page.locator('.prov-mgr__model').filter({ hasText: 'gpt-5.4' });
  await expect(existing).toContainText(/Context window 1[,.]050[,.]000/);
  await expect(existing).toContainText(/Max output tokens 128[,.]000/);
  await expect(existing).toContainText('Default effort none');
  await existing.getByRole('button', { name: 'Edit gpt-5.4' }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit model' });
  await expect(dialog.getByLabel('Context window')).toHaveValue('1050000');
  await expect(dialog.getByLabel('Max output tokens')).toHaveValue('128000');
  await dialog.getByLabel('Default effort').selectOption('medium');
  await dialog.getByLabel('Text output language').fill('Thai');
  await dialog.getByLabel('Max output tokens').fill('12,000');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(existing).toContainText('Default effort medium');
  await expect(existing).toContainText('Text output Thai');

  await page.getByRole('button', { name: 'Add model' }).click();
  dialog = page.getByRole('dialog', { name: 'Add model' });
  await dialog.getByLabel('Model ID').fill('glm-5.3-flash');
  await expect(dialog.getByLabel('Context window')).toHaveValue('1000000');
  await expect(dialog.getByLabel('Max output tokens')).toHaveValue('128000');
  await expect(dialog.getByRole('option', { name: 'Provider default (max)' })).toHaveCount(1);
  await dialog.getByLabel('Model ID').fill('my-private-model');
  await expect(dialog.getByLabel('Context window')).toHaveValue('');
  await dialog.getByLabel('Text output language').fill('Japanese');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();

  await page.reload();
  await openModels();
  await expect(existing).toContainText('Text output Thai');
  await expect(page.locator('.prov-mgr__model').filter({ hasText: 'my-private-model' })).toContainText('Text output Japanese');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.home__recent-item').first().click();
  await page.locator('.nav-item').filter({ hasText: 'Copilot' }).click();
  await page.getByRole('textbox', { name: 'Ask AI' }).fill('Hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Test model reply')).toBeVisible();
  const payload = await page.evaluate(() => {
    const call = window.testBackend.calls.find(({ cmd }) => cmd === 'ai_chat');
    return JSON.parse(call.args.body);
  });
  expect(payload).toMatchObject({ model: 'gpt-5.4', max_completion_tokens: 12000, reasoning_effort: 'medium' });
  expect(payload.messages.at(-1).content).toContain('Write your response in "Thai"');
});
