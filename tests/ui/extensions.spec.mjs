import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

async function setup(page) {
  await page.setViewportSize({ width: 1440, height: 860 });
  await installBackend(page);
  await openFixture(page);
}

const nav = (page) => page.locator('.nav-sidebar');
const stored = (page, key) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), key);
const skillIds = (page) => page.evaluate(async () => (await (await import('/src/lib/skills.ts')).listSkills()).map((s) => s.id));

const openStore = async (page) => {
  await nav(page).getByRole('button', { name: /Extension Store/ }).click();
  await expect(page.getByRole('heading', { name: 'Extension Store', exact: true })).toBeVisible();
};
const openSettingsExtensions = async (page) => {
  await page.locator('.profile-button').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.locator('.app-settings__menu').getByRole('button', { name: 'Extensions' }).click();
  await expect(page.getByRole('heading', { name: 'Extensions', level: 2 })).toBeVisible();
};
const installFromStore = async (page, name) => {
  await page.getByRole('button', { name: `Install ${name}` }).click();
  await page.getByRole('dialog', { name: `Install ${name}` }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `Install ${name}` })).toHaveCount(0);
};

const PACK = {
  pigryExtension: 1, id: 'acme.runner', name: 'Runner Pack', version: '2.0.0', author: 'Acme', description: 'Runs a check after every reply.',
  agents: [{ username: 'runner', name: 'Runner', role: 'Check runner', tools: ['read_file'] }],
  skills: [{ id: 'run-checks', name: 'Run checks', content: '# Run checks\n\n- run the checks' }],
  hooks: [{ event: 'after-reply', command: 'npm run lint' }],
};

test('the side bar has an Extensions group next to Workspace, starting with the Extension Store', async ({ page }) => {
  await setup(page);
  const headings = nav(page).locator('.nav-sidebar__heading');
  await expect(headings.nth(0)).toHaveText('Quick access');
  await expect(headings.nth(1)).toHaveText('Workspace');
  await expect(headings.nth(2)).toHaveText('Extensions');
  await expect(nav(page).getByRole('navigation', { name: 'Extensions' }).getByRole('button').first()).toContainText('Extension Store');
  await expect(page.locator('.nav-item--extension')).toHaveCount(0);
});

test('the Extension Store lists the packs, searches them and filters by category', async ({ page }) => {
  await setup(page);
  await openStore(page);
  const cards = page.locator('.store-card');
  await expect(cards.first()).toBeVisible();
  const total = await cards.count();
  expect(total).toBeGreaterThanOrEqual(8);
  await expect(page.getByRole('status')).toContainText(`${total} extensions`);
  await expect(page.getByRole('searchbox', { name: 'Search extensions' })).toBeFocused();

  const search = page.getByRole('searchbox', { name: 'Search extensions' });
  await search.fill('secrets');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Security Review Pack');
  await expect(page.getByRole('status')).toContainText('1 extension found');

  // an agent's @handle and a skill's #id find their pack
  await search.fill('@lint-coach');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Code Quality Pack');
  await search.fill('#a11y-checklist');
  await expect(cards.first()).toContainText('Accessibility Pack');

  // nothing matches
  await search.fill('zzz-nothing');
  await expect(cards).toHaveCount(0);
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(cards).toHaveCount(total);

  // categories
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Git', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Git Hygiene Pack');
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'All', exact: true }).click();
  await expect(cards).toHaveCount(total);

  // what a pack adds
  await page.getByRole('button', { name: 'What Security Review Pack adds' }).click();
  await expect(page.getByRole('article', { name: 'Security Review Pack' })).toContainText('@threat-modeler');
  await expect(page.getByRole('article', { name: 'Security Review Pack' })).toContainText('#security-checklist');
});

test('install a pack from the store, use its agent and skill; it is then managed in Settings', async ({ page }) => {
  await setup(page);
  await openStore(page);
  await page.getByRole('button', { name: 'Install Code Quality Pack' }).click();
  const review = page.getByRole('dialog', { name: 'Install Code Quality Pack' });
  await expect(review).toContainText('@lint-coach');
  await expect(review).toContainText('#test-review-checklist');
  await expect(review.getByText('I trust')).toHaveCount(0); // agents and skills only: nothing to trust
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(review).toHaveCount(0);

  const card = page.getByRole('article', { name: 'Code Quality Pack' });
  await expect(page.getByRole('status').first()).toContainText('Installed Code Quality Pack');
  await expect(card).toContainText('Installed');
  await expect(card.getByRole('button', { name: 'Install Code Quality Pack' })).toHaveCount(0);
  await expect(nav(page).locator('.nav-item--extension', { hasText: 'Code Quality Pack' })).toBeVisible();

  const agents = await stored(page, 'pigry:agents');
  expect(agents.filter((a) => a.extensionId === 'pigry.code-quality').map((a) => a.username).sort()).toEqual(['lint-coach', 'test-gap-finder']);
  expect(agents.every((a) => a.enabled)).toBe(true);
  expect(await skillIds(page)).toContain('test-review-checklist');

  // "Manage" in the store opens Settings › Extensions with that pack shown
  await card.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByRole('heading', { name: 'Extensions', level: 2 })).toBeVisible();
  await expect(page.locator('#ext-pigry\\.code-quality')).toHaveClass(/ext-card--selected/);
  await expect(page.locator('#ext-pigry\\.code-quality')).toContainText('@lint-coach');
});

test('Settings › Extensions manages what is installed: switch off, on and remove', async ({ page }) => {
  await setup(page);
  await openStore(page);
  await installFromStore(page, 'Code Quality Pack');
  await openSettingsExtensions(page);

  // no store in Settings: only what is installed, plus upload
  await expect(page.getByRole('button', { name: /^Install / })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Upload an extension' })).toBeVisible();
  const installed = page.getByRole('region', { name: 'Installed extensions' });
  await expect(installed).toContainText('Code Quality Pack');
  await expect(installed).toContainText('from the store');

  await installed.getByRole('switch', { name: 'Enable Code Quality Pack' }).click();
  await expect(installed.getByRole('switch', { name: 'Enable Code Quality Pack' })).toHaveAttribute('aria-checked', 'false');
  expect((await stored(page, 'pigry:agents')).filter((a) => a.extensionId).every((a) => !a.enabled)).toBe(true);
  expect(await skillIds(page)).not.toContain('test-review-checklist');
  await installed.getByRole('switch', { name: 'Enable Code Quality Pack' }).click();
  expect(await skillIds(page)).toContain('test-review-checklist');

  const details = installed.getByRole('button', { name: 'Details of Code Quality Pack' });
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
  await installed.getByRole('button', { name: 'Remove' }).click();
  await installed.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(installed.getByText('No extensions installed yet')).toBeVisible();
  expect((await stored(page, 'pigry:agents')).filter((a) => a.extensionId)).toEqual([]);
  expect(await skillIds(page)).not.toContain('test-review-checklist');

  // the empty state points back to the store
  await installed.getByRole('button', { name: /Find extensions in the Extension Store/ }).click();
  await expect(page.getByRole('heading', { name: 'Extension Store', exact: true })).toBeVisible();
});

test('upload a pasted extension: bad JSON is explained and one that runs commands needs trust', async ({ page }) => {
  await setup(page);
  await openSettingsExtensions(page);
  await page.getByRole('button', { name: 'Paste JSON…' }).click();

  await page.getByRole('textbox', { name: 'Extension JSON' }).fill('{ not json');
  await page.getByRole('button', { name: 'Review…' }).click();
  await expect(page.locator('.ext-errors')).toContainText('Not valid JSON');

  await page.getByRole('textbox', { name: 'Extension JSON' }).fill(JSON.stringify({ ...PACK, id: 'Bad Id' }));
  await page.getByRole('button', { name: 'Review…' }).click();
  await expect(page.locator('.ext-errors')).toContainText('"id" must be');

  await page.getByRole('textbox', { name: 'Extension JSON' }).fill(JSON.stringify(PACK));
  await page.getByRole('button', { name: 'Review…' }).click();
  const review = page.getByRole('dialog', { name: 'Install Runner Pack' });
  await expect(review).toContainText('npm run lint');
  const install = review.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  await review.getByRole('checkbox').check();
  await expect(install).toBeEnabled();
  await install.click();

  const hooks = await stored(page, 'pigry:hooks');
  expect(hooks.filter((h) => h.extensionId === 'acme.runner')).toEqual([expect.objectContaining({ command: 'npm run lint', event: 'after-reply', enabled: true })]);
  await expect(page.getByRole('region', { name: 'Installed extensions' })).toContainText('uploaded');

  await page.getByRole('switch', { name: 'Enable Runner Pack' }).click();
  expect((await stored(page, 'pigry:hooks')).find((h) => h.extensionId === 'acme.runner').enabled).toBe(false);
});

test('an uploaded extension cannot take a handle that is already in use', async ({ page }) => {
  await setup(page);
  await openSettingsExtensions(page);
  await page.getByRole('button', { name: 'Paste JSON…' }).click();
  await page.getByRole('textbox', { name: 'Extension JSON' }).fill(JSON.stringify({ ...PACK, hooks: undefined, agents: [{ username: 'explorer', name: 'Mine' }] }));
  await page.getByRole('button', { name: 'Review…' }).click();
  const review = page.getByRole('dialog', { name: 'Install Runner Pack' });
  await expect(review).toContainText('@explorer is already used');
  await expect(review.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
});

test('upload a file from the computer, and uploading it again updates it', async ({ page }) => {
  await setup(page);
  await openSettingsExtensions(page);
  const manifest = { ...PACK, hooks: undefined };
  await page.getByLabel('Extension file').setInputFiles({ name: 'runner.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
  await page.getByRole('dialog', { name: 'Install Runner Pack' }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Installed extensions' })).toContainText('v2.0.0');

  await page.getByRole('switch', { name: 'Enable Runner Pack' }).click(); // off
  await page.getByLabel('Extension file').setInputFiles({ name: 'runner.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...manifest, version: '2.1.0' })) });
  const review = page.getByRole('dialog', { name: 'Install Runner Pack' });
  await expect(review).toContainText('replaces the installed version');
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Installed extensions' })).toContainText('v2.1.0');
  await expect(page.getByRole('switch', { name: 'Enable Runner Pack' })).toHaveAttribute('aria-checked', 'false'); // stays off
  expect((await stored(page, 'pigry:agents')).filter((a) => a.extensionId === 'acme.runner')).toHaveLength(1);

  // a file that is too big is refused before it is read
  await page.getByLabel('Extension file').setInputFiles({ name: 'huge.json', mimeType: 'application/json', buffer: Buffer.alloc(401_000, 'a') });
  await expect(page.locator('.ext-errors')).toContainText('larger than 400 KB');
});

test('clicking an installed pack in the side bar opens Settings › Extensions on it', async ({ page }) => {
  await setup(page);
  await openStore(page);
  await installFromStore(page, 'Documentation Pack');
  await nav(page).getByRole('button', { name: /Working changes/ }).click();

  await nav(page).locator('.nav-item--extension', { hasText: 'Documentation Pack' }).click();
  await expect(page.getByRole('heading', { name: 'Extensions', level: 2 })).toBeVisible();
  const card = page.locator('#ext-pigry\\.documentation');
  await expect(card).toHaveClass(/ext-card--selected/);
  await expect(card).toContainText('@readme-writer');
  await expect(card).toContainText('#docs-style-guide');
});

test('right-clicking an installed pack in the side bar turns it off', async ({ page }) => {
  await setup(page);
  await openStore(page);
  await installFromStore(page, 'Documentation Pack');
  await nav(page).locator('.nav-item--extension', { hasText: 'Documentation Pack' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Manage in Settings' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Turn off' }).click();
  await expect(nav(page).locator('.nav-item--extension')).toContainText('off');
});

test('every pack in the store can be installed: none clashes with an agent or skill that already exists', async ({ page }) => {
  await setup(page);
  const problems = await page.evaluate(async () => {
    const { STORE_CATALOG } = await import('/src/lib/extensionCatalog.ts');
    const { previewInstall } = await import('/src/lib/extensions.ts');
    const found = [];
    for (const { manifest } of STORE_CATALOG) {
      const plan = await previewInstall(manifest);
      if (plan.conflicts.length > 0) found.push(`${manifest.id}: ${plan.conflicts.join('; ')}`);
      if (plan.skills.some((skill, index) => skill.id !== manifest.skills[index].id)) found.push(`${manifest.id}: a skill id is already taken`);
    }
    return found;
  });
  expect(problems).toEqual([]);
});

test('the command palette and the guide know about the Extension Store', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.keyboard.type('>extension');
  await expect(page.getByText('Go to Extension Store')).toBeVisible();
  await page.keyboard.press('Escape');

  await openStore(page);
  await page.getByRole('button', { name: 'Guide for this menu' }).click();
  const dialog = page.getByRole('dialog', { name: 'Extension Store guide' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Step-by-step tutorial' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Ask the agents' })).toHaveCount(0); // no agent panel in this menu
});

const MENUS = ['Diagram', 'Design', 'Drawing', '3D Model', 'Game Engine', 'Video Editor', 'Audio Editor', 'Sheet', 'Docs', 'Board', 'E2E Testing', 'Reports'];

test('Diagram, Design, Board, E2E Testing and Reports are built-in extensions in the Extensions group', async ({ page }) => {
  await setup(page);
  const workspace = nav(page).locator('.nav-sidebar__workspace').first();
  const extensions = nav(page).getByRole('navigation', { name: 'Extensions' });
  for (const name of MENUS) {
    await expect(extensions.getByRole('button', { name: new RegExp(`^${name}$`) }), name).toBeVisible();
    await expect(workspace.getByRole('button', { name: new RegExp(`^${name}$`) }), `${name} left the Workspace group`).toHaveCount(0);
  }
  await expect(workspace.getByRole('button', { name: 'Explorer' })).toBeVisible();
  await extensions.getByRole('button', { name: /^Reports$/ }).click();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
});

test('a built-in extension is switched off and on in Settings, and the choice is remembered', async ({ page }) => {
  await setup(page);
  await openSettingsExtensions(page);
  const builtin = page.getByRole('region', { name: 'Built-in extensions' });
  for (const name of MENUS) await expect(builtin.getByRole('switch', { name: `Enable ${name}` })).toHaveAttribute('aria-checked', 'true');

  await builtin.getByRole('switch', { name: 'Enable Board' }).click();
  await expect(builtin.getByRole('switch', { name: 'Enable Board' })).toHaveAttribute('aria-checked', 'false');
  await expect(builtin.getByRole('button', { name: 'Open Board' })).toHaveCount(0);

  // remembered after a reload, and gone from the side bar and the command palette
  await page.reload();
  await page.locator('.home__recent-item').first().click();
  await expect(nav(page).getByRole('button', { name: /Extension Store/ })).toBeVisible();
  await expect(nav(page).getByRole('button', { name: /^Board$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.keyboard.type('>go to board');
  await expect(page.getByText('Go to Board')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openSettingsExtensions(page);
  await builtin.getByRole('switch', { name: 'Enable Board' }).click();
  await builtin.getByRole('button', { name: 'Open Board' }).click();
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
  await expect(nav(page).getByRole('button', { name: /^Board$/ })).toBeVisible();
});

test('the Extension Store uses the whole width of the page', async ({ page }) => {
  await setup(page);
  await openStore(page);
  const grid = await page.locator('.store-grid').boundingBox();
  const search = await page.locator('.store-search').boundingBox();
  const body = await page.locator('.extensions-screen__body').boundingBox();
  expect(search.width).toBeGreaterThan(body.width - 120);
  expect(grid.width).toBeGreaterThan(body.width - 120);
  // three or more cards per row at this width
  const first = await page.locator('.store-card').nth(0).boundingBox();
  const third = await page.locator('.store-card').nth(2).boundingBox();
  expect(Math.abs(first.y - third.y)).toBeLessThan(4);
});

test('clicking a pack opens its own page with its agents, skills and what it can do', async ({ page }) => {
  await setup(page);
  await openStore(page);
  await page.getByRole('searchbox', { name: 'Search extensions' }).fill('threat-modeler');
  await page.getByRole('button', { name: 'Open Security Review Pack' }).click();

  const detail = page.getByRole('article', { name: 'Security Review Pack extension' });
  await expect(detail.getByRole('heading', { name: 'Security Review Pack', level: 2 })).toBeVisible();
  await expect(detail).toContainText('Pigry · v1.0.0 · Security');
  await expect(page.locator('.store-grid')).toHaveCount(0); // the list is replaced by the page

  const agents = detail.getByRole('region', { name: 'Agents' });
  await expect(agents).toContainText('Threat Modeler');
  await expect(agents).toContainText('@threat-modeler');
  await expect(agents).toContainText('Threat modeling reviewer');
  await expect(agents).toContainText('read_diff');
  await expect(agents).toContainText('@secrets-hunter');

  const skills = detail.getByRole('region', { name: 'Skills' });
  await expect(skills).toContainText('#security-checklist');
  await expect(skills).toContainText('# Security checklist');
  await skills.getByRole('button', { name: /Show all \d+ lines/ }).click();
  await expect(skills).toContainText('Report findings with file, line, impact and a concrete fix');

  const side = detail.getByRole('complementary', { name: 'Details' });
  await expect(side).toContainText('pigry.security-review');
  await expect(side).toContainText('No hooks');
  await expect(side).toContainText('No MCP servers');
  await expect(side).toContainText('@threat-modeler');

  // install from the page
  await detail.getByRole('button', { name: 'Install Security Review Pack' }).click();
  await page.getByRole('dialog', { name: 'Install Security Review Pack' }).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(detail).toContainText('Installed');
  await expect(detail.getByRole('button', { name: 'Install Security Review Pack' })).toHaveCount(0);
  expect((await stored(page, 'pigry:agents')).filter((a) => a.extensionId === 'pigry.security-review')).toHaveLength(2);

  // back to the list, with the search kept
  await detail.getByRole('button', { name: 'Extension Store' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search extensions' })).toHaveValue('threat-modeler');
  await expect(page.locator('.store-card')).toHaveCount(1);
  await expect(page.getByRole('article', { name: 'Security Review Pack' })).toContainText('Installed');

  // Manage on an installed pack's page opens Settings on it
  await page.getByRole('button', { name: 'Open Security Review Pack' }).click();
  await page.getByRole('article', { name: 'Security Review Pack extension' }).getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByRole('heading', { name: 'Extensions', level: 2 })).toBeVisible();
  await expect(page.locator('#ext-pigry\\.security-review')).toHaveClass(/ext-card--selected/);
});

test('the built-in menus are in the Extension Store: searchable, with a page and a switch', async ({ page }) => {
  await setup(page);
  await openStore(page);
  const search = page.getByRole('searchbox', { name: 'Search extensions' });
  await search.fill('diagram');
  await expect(page.getByRole('article', { name: 'Diagram (built-in)' })).toContainText('Included');
  await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Built-in' }).click();
  await search.fill('');
  await expect(page.locator('.store-card')).toHaveCount(12);

  await page.getByRole('button', { name: 'Open Reports page' }).click();
  const detail = page.getByRole('article', { name: 'Reports extension' });
  await expect(detail.getByRole('heading', { name: 'Reports', level: 2 })).toBeVisible();
  await expect(detail.getByRole('region', { name: 'Features' })).toBeVisible();
  await detail.getByRole('switch', { name: 'Enable Reports' }).click();
  await expect(detail.getByRole('switch', { name: 'Enable Reports' })).toHaveAttribute('aria-checked', 'false');
  await expect(detail.getByRole('button', { name: 'Open Reports' })).toHaveCount(0);
});
