import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/**
 * Explorer tree geometry on a deep repo: every child sits exactly one indent
 * step past its parent, same-depth files and folders share one icon column,
 * and each indent guide is one unbroken vertical line per level.
 */
const APP = 'projects/demo/app';
const entries = [
  'README.md',
  'projects/corp/readme.md',
  `${APP}/project.json`,
  `${APP}/src/app/app.component.ts`,
  `${APP}/src/app/app.module.ts`,
  `${APP}/src/assets/logo.svg`,
  `${APP}/src/environments/environment.development.ts`,
  `${APP}/src/environments/environment.prod.ts`,
  `${APP}/src/environments/environment.ts`,
  `${APP}/src/mocks/data.json`,
  `${APP}/src/favicon.ico`,
  `${APP}/src/index.html`,
  `${APP}/src/main.ts`,
  `${APP}/src/styles.scss`,
];
// Enough rows (once opened) to switch the tree to its virtualised renderer.
const bulk = Array.from({ length: 600 }, (_, i) => `projects/zbulk/file-${String(i).padStart(3, '0')}.txt`);

async function openDeepTree(page, extra = []) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installBackend(page, { entries: [...entries, ...extra] });
  await openFixture(page);
  await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: /^Explorer$/ }) }).click();
  const tree = page.locator('.file-tree');
  // `projects` is open by default; `demo/app` is a compacted single-child chain.
  for (const path of [APP, `${APP}/src`, `${APP}/src/environments`]) {
    await tree.locator(`.tree-row[data-path="${path}"]`).click();
  }
  await expect(tree.locator(`.tree-row[data-path="${APP}/src/environments/environment.ts"]`)).toBeVisible();
  return tree;
}

/** Rows in visual order with the rects that matter, relative to the tree. */
async function measure(tree) {
  return tree.evaluate((host) => {
    const origin = host.getBoundingClientRect();
    const rel = (r) => ({ left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top });
    return [...host.querySelectorAll('.tree-row')]
      .map((row) => ({
        path: row.dataset.path,
        folder: row.classList.contains('tree-row--folder'),
        overflow: getComputedStyle(row).overflow,
        row: rel(row.getBoundingClientRect()),
        twisty: rel(row.querySelector('.tree-row__twisty').getBoundingClientRect()),
        icon: rel(row.querySelector('.tree-row__fileicon').getBoundingClientRect()),
        guides: [...row.querySelectorAll('.tree-row__guide')].map((g) => rel(g.getBoundingClientRect())),
      }))
      .sort((a, b) => a.row.top - b.row.top);
  });
}

function depthOf(path) {
  // `projects/demo/app` is one compacted row at depth 1.
  const parts = path.replace(APP, 'projects/demo~app').split('/');
  return parts.length - 1;
}

function checkGeometry(rows) {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const root = byPath.get('projects');
  expect(root, 'projects row').toBeTruthy();
  const step = byPath.get(APP).icon.left - root.icon.left;
  expect(step).toBeGreaterThan(6);
  expect(step).toBeLessThanOrEqual(16);

  for (const r of rows) {
    const depth = depthOf(r.path);
    expect(r.guides.length, `${r.path} guide count`).toBe(depth);
    // One indent step per level, for files and folders alike.
    expect(r.icon.left - root.icon.left, `${r.path} icon x`).toBeCloseTo(depth * step, 0);
    expect(r.twisty.left - root.twisty.left, `${r.path} chevron x`).toBeCloseTo(depth * step, 0);
    expect(r.overflow, `${r.path} must not clip its guides`).toBe('visible');
  }

  // Same-depth files and folders in src share one icon column.
  const srcKids = ['app', 'assets', 'environments', 'mocks', 'favicon.ico', 'index.html', 'main.ts', 'styles.scss']
    .map((name) => byPath.get(`${APP}/src/${name}`));
  for (const kid of srcKids) expect(kid.icon.left).toBeCloseTo(srcKids[0].icon.left, 1);
  expect(srcKids.filter((k) => k.folder).length).toBe(4);
  // environment.* files are exactly one step past `environments`.
  const envFolder = byPath.get(`${APP}/src/environments`);
  for (const name of ['environment.development.ts', 'environment.prod.ts', 'environment.ts']) {
    expect(byPath.get(`${APP}/src/environments/${name}`).icon.left - envFolder.icon.left).toBeCloseTo(step, 1);
  }

  // Guides: level k of a row sits under its depth-k ancestor's chevron, and
  // consecutive rows' segments at that level touch with no gap.
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    r.guides.forEach((g, level) => {
      const ancestor = [...rows.slice(0, i)].reverse().find((p) => depthOf(p.path) === level);
      const chevronCentre = (ancestor.twisty.left + ancestor.twisty.right) / 2;
      expect(Math.abs(g.left - chevronCentre), `${r.path} guide ${level} under its ancestor`).toBeLessThanOrEqual(1);
      const prev = rows[i - 1];
      // The segment above is either the same guide level on the previous row,
      // or (first child) the ancestor row itself.
      const above = prev.guides[level] ?? prev.row;
      expect(Math.abs(g.top - above.bottom), `${r.path} guide ${level} joins the row above`).toBeLessThanOrEqual(0.5);
      if (prev.guides[level]) expect(g.left).toBeCloseTo(prev.guides[level].left, 1);
    });
  }
}

test('Explorer tree indents one step per level and draws continuous guides', async ({ page }) => {
  const tree = await openDeepTree(page);
  const rows = await measure(tree);
  checkGeometry(rows);
  await tree.screenshot({ path: test.info().outputPath('file-tree-indent.png') });
});

test('virtualised Explorer tree keeps the same indent and guide geometry', async ({ page }) => {
  const tree = await openDeepTree(page, bulk);
  await tree.locator('.tree-row[data-path="projects/zbulk"]').click();
  await expect(tree.locator('.file-tree__virtual-row').first()).toBeAttached();
  // The virtual tree scrolls the selected README.md (last row) into view.
  await tree.evaluate((host) => { host.scrollTop = 0; });
  await expect(tree.locator('.tree-row[data-path="projects"]')).toBeVisible();
  const rows = await measure(tree);
  expect(rows.some((r) => r.path.startsWith('projects/zbulk/'))).toBe(true);
  checkGeometry(rows);
});
