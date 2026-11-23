import { expect, test } from '@playwright/test';
import { workspaceNav } from '../../src/app/navigation.ts';
import { MENU_GUIDES } from '../../src/lib/menuGuides.ts';
import { installBackend, openFixture } from './backend.mjs';

async function open(page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
}

const openMenu = (page, label) => page.locator('.nav-item').filter({
  has: page.locator('.nav-item__label', { hasText: new RegExp(`^${label}$`, 'i') }),
}).click();

test('the info button opens a full-screen guide for the current menu and Escape closes it', async ({ page }) => {
  await open(page);
  await openMenu(page, 'Cherry Pick');
  const info = page.getByRole('button', { name: 'Guide for this menu' });
  await expect(info).toBeVisible();
  await info.click();

  const dialog = page.getByRole('dialog', { name: 'Cherry Pick guide' });
  await expect(dialog).toBeVisible();
  // full screen: it covers the whole window
  const box = await dialog.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(1430);
  expect(box.height).toBeGreaterThanOrEqual(850);
  for (const heading of ['Overview', 'Screenshots', 'What you can do', 'Step-by-step tutorial', 'Tips', 'Cautions', 'Ask the agents']) {
    await expect(dialog.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(dialog).toContainText(MENU_GUIDES['cherry-pick'].summary);
  await expect(dialog).toContainText('@pick-reviewer');

  // the screenshot is a real picture, not a broken image
  const image = dialog.locator('.help-shot img').first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(400);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('every menu has its own guide behind the info button, with a working screenshot', async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  for (const { id, label } of workspaceNav) {
    await openMenu(page, label);
    await page.getByRole('button', { name: 'Guide for this menu' }).click();
    const dialog = page.getByRole('dialog', { name: `${label} guide` });
    await expect(dialog, id).toBeVisible();
    await expect(dialog).toContainText(MENU_GUIDES[id].summary);
    await expect(dialog.locator('.help-step')).toHaveCount(MENU_GUIDES[id].tutorial.length);
    const image = dialog.locator('.help-shot img').first();
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth), { message: `${id} screenshot` }).toBeGreaterThan(400);
    await page.getByRole('button', { name: 'Close guide' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('the agents named in each guide are the real default and base agents of that menu', async ({ page }) => {
  await open(page);
  const guides = Object.fromEntries(workspaceNav.map(({ id, label }) => [id, { label, ...MENU_GUIDES[id].agents }]));
  const problems = await page.evaluate(async (guides) => {
    const { builtinAgents } = await import('/src/lib/agentExtras.ts');
    const agents = builtinAgents();
    const missing = [];
    for (const [id, { label, default: main, base }] of Object.entries(guides)) {
      if (!agents.some((a) => a.team === label && a.tier === 'default' && a.username === main)) missing.push(`${id}: default @${main}`);
      if (!agents.some((a) => a.team === label && a.tier === 'base' && a.username === base)) missing.push(`${id}: base @${base}`);
    }
    return missing;
  }, guides);
  expect(problems).toEqual([]);
});

test('there is no guide button on the home screen or in app settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Guide for this menu' })).toHaveCount(0);
});
