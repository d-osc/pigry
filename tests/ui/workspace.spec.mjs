import { test, expect } from '@playwright/test';
import { workspaceNav } from '../../src/app/navigation.ts';

const pages = ['Explorer', 'Diagram', 'Design', 'Board', 'E2E Testing', 'Copilot', 'Working changes', 'Push Commits', 'Pull commit', 'Merge branch',
  'Compare branch', 'Stashes Code', 'Cherry Pick', 'Duplicate commit', 'Edit commit', 'Rebase Branch', 'Pull requests', 'Commit graph',
  'Branches', 'Releases', 'Actions', 'Security and quality', 'Issues', 'Projects', 'Wiki', 'Insights'];

for (const theme of ['light', 'dark']) {
  test(`${theme}: every workspace page renders at minimum width`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('pigry:theme', theme), theme);
    await page.goto('/');
    for (const name of pages) {
      const nav = page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${name}$`, 'i') }) });
      await nav.click();
      await expect(nav).toHaveClass(/nav-item--active/);
      await expect(page.locator('.screen-loading')).toHaveCount(0);
      await expect(page.locator('.error-boundary')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('command palette can navigate with the keyboard and close', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.command-palette')).toHaveCount(0);
});

test('every workspace menu has a default agent and a mentionable base agent', async ({ page }) => {
  const overrides = {
    explorer: { name: 'My Explorer', model: 'custom-explorer-model' },
    refactorer: { name: 'My Refactorer' },
  };
  await page.addInitScript((overrides) => {
    localStorage.setItem('pigry:agent-factory-version', '3');
    localStorage.setItem('pigry:agent-overrides', JSON.stringify(overrides));
  }, overrides);
  await page.goto('/');
  const handleByScreen = {
    'ai-agent': 'copilot',
    stashes: 'stashes-code',
    security: 'security-and-quality',
  };
  const baseHandleByScreen = {
    explorer: 'refactorer',
    diagram: 'diagram-sa',
    design: 'uxui',
    board: 'board-sa',
    e2e: 'e2e-qa',
    'ai-agent': 'workspace-guide',
    'working-changes': 'code-reviewer',
    'push-commits': 'push-checklist',
    'pull-commits': 'incoming-impact',
    'merge-branch': 'merge-conflict-helper',
    'compare-branch': 'branch-diff-reviewer',
    stashes: 'stash-inspector',
    'cherry-pick': 'pick-reviewer',
    'duplicate-commit': 'transfer-check',
    'edit-commit': 'amend-reviewer',
    'rebase-branch': 'rebase-plan-reviewer',
    'pull-requests': 'pr-reviewer',
    'commit-graph': 'bug-hunter',
    branches: 'upstream-checker',
    releases: 'release-notes-writer',
    actions: 'ci-log-reviewer',
    security: 'security-auditor',
    issues: 'issue-triage-helper',
    projects: 'board-planner',
    wiki: 'docs-writer',
    insights: 'activity-analyst',
  };
  // Screens that keep their agent panel mounted while hidden: only the visible one counts.
  const hint = page.locator('.ai-composer__hint:visible');
  const composer = page.getByRole('textbox', { name: 'Ask AI' }).and(page.locator(':visible'));
  const picker = page.getByRole('listbox', { name: 'Mention an agent' });
  for (const { id, label } of workspaceNav) {
    await page.locator('.nav-item').filter({
      has: page.locator('.nav-item__label', { hasText: new RegExp(`^${label}$`, 'i') }),
    }).click();
    if (id !== 'ai-agent' && await hint.count() === 0) {
      await page.locator('.ai-rail-strip').click();
    }
    await expect(hint).toContainText(`default @${handleByScreen[id] ?? id} answers`);
    await composer.fill('@');
    const handle = baseHandleByScreen[id];
    const baseAgent = picker.getByRole('option', { name: new RegExp(`@${handle}\\b`) });
    await expect(baseAgent).toContainText(label);
    await baseAgent.click();
    await expect(composer).toHaveValue(`@${handle} `);
    await composer.clear();
  }
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pigry:agent-overrides')));
  expect(stored).toEqual(overrides);
});

test('workspace sidebar resizes, remembers its width and resets on double-click', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('.nav-sidebar');
  const handle = page.getByRole('separator', { name: 'Resize workspace sidebar' });
  const original = await sidebar.evaluate(element => element.offsetWidth);
  const bounds = await handle.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 70, y, { steps: 7 });
  await page.mouse.up();
  await expect.poll(() => sidebar.evaluate(element => element.offsetWidth)).toBe(original + 70);

  await page.getByRole('button', { name: 'Collapse side bar' }).click();
  await expect(handle).toHaveCount(0);
  await page.getByRole('button', { name: 'Show side bar' }).click();
  await expect.poll(() => sidebar.evaluate(element => element.offsetWidth)).toBe(original + 70);

  await page.reload();
  await expect.poll(() => sidebar.evaluate(element => element.offsetWidth)).toBe(original + 70);
  await handle.dblclick();
  await expect.poll(() => sidebar.evaluate(element => element.offsetWidth)).toBe(original);
});
