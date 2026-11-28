import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { demoHistory } from '../../src/lib/demoWorkspace.ts';
import { installBackend, openFixture } from './backend.mjs';

// Author rows in the Workspace menus show the author's real profile picture
// (GitHub avatar from the gh email map, a noreply email or a login, else
// Gravatar by email hash), and fall back to initials when there is none or
// the picture fails to load. Image hosts are mocked: nothing leaves the test.

const MAYA_MAPPED = 'https://avatars.githubusercontent.com/u/1001?v=4';
const samNoreply = (size = 40) => `https://avatars.githubusercontent.com/u/583231?s=${size}&v=4`;
const SAM_NOREPLY = samNoreply();
const gravatar = (email, size = 40) =>
  `https://www.gravatar.com/avatar/${createHash('sha256').update(email).digest('hex')}?s=${size * 2}&d=404`;
const ALEX_GRAVATAR = gravatar('alex@acme.dev');
const JORDAN_GRAVATAR = gravatar('jordan@acme.dev');
const VALIDATION_GH = 'https://github.com/validation.png?size=40';

const EMAILS = {
  'Alex Liu': 'alex@acme.dev',
  'Maya Chen': 'maya@acme.dev',
  'Sam Rivera': '583231+samr@users.noreply.github.com',
  'Jordan Lee': 'jordan@acme.dev',
};
const HISTORY = {
  ...demoHistory,
  commits: demoHistory.commits.map((row) => ({ ...row, authorEmail: EMAILS[row.authorName] })),
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** Pictures that exist; every other avatar URL answers 404. */
const AVAILABLE = new Set([MAYA_MAPPED, SAM_NOREPLY, samNoreply(28), ALEX_GRAVATAR, VALIDATION_GH]);

async function mockImageHosts(page) {
  const requested = [];
  await page.route(/^https:\/\/(github\.com|avatars\.githubusercontent\.com|www\.gravatar\.com)\//, (route) => {
    const url = route.request().url();
    requested.push(url);
    return AVAILABLE.has(url)
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      : route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });
  return requested;
}

async function setup(page, { withEmails = true } = {}) {
  const requested = await mockImageHosts(page);
  await installBackend(page, { entries: ['src/app.ts', 'README.md'], branchHistory: withEmails ? HISTORY : demoHistory });
  await page.addInitScript(({ history, withEmails, mapped }) => {
    const internals = window.__TAURI_INTERNALS__;
    const fallback = internals.invoke;
    const byOid = new Map(history.commits.map((row) => [row.oid, row]));
    internals.invoke = async (cmd, args = {}) => {
      if (!withEmails) return fallback(cmd, args);
      switch (cmd) {
        case 'get_commit_history': return history;
        case 'commit_avatars': return [{ email: 'maya@acme.dev', name: 'Maya Chen', avatarUrl: mapped }];
        case 'get_commit_detail': {
          const detail = await fallback(cmd, args);
          const row = byOid.get(args.oid);
          return row ? { ...detail, authorName: row.authorName, authorEmail: row.authorEmail, authorInitials: row.authorInitials } : detail;
        }
        case 'get_file_history':
          return history.commits.slice(1, 3).map((row) => ({
            oid: row.oid, shortOid: row.shortOid, summary: row.summary, authorName: row.authorName,
            authorEmail: row.authorEmail, authorInitials: row.authorInitials, timeSeconds: row.timeSeconds, path: args.path,
          }));
        case 'read_file_at_commit': case 'read_worktree_file':
          return { content: 'export {};\n', binary: false, tooLarge: false, language: 'typescript' };
        case 'get_branch_commits':
          // Rebase onto fix/lane-rendering: its tip sits 9 commits below HEAD.
          return args.refName === 'fix/lane-rendering' ? { ...history, commits: history.commits.slice(9) } : history;
        case 'gh_delivery_stats': throw new Error('gh unavailable');
        case 'gh_issue_view':
          return { number: 7, title: 'Avatar issue', body: '', state: 'OPEN', stateReason: '', author: 'validation', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', url: '', labels: [], assignees: ['validation'], milestone: '', comments: [] };
        case 'gh_issue_list':
          return [{ number: 7, title: 'Avatar issue', state: 'OPEN', author: 'validation', updatedAt: '2026-11-15T00:00:00Z', url: '', comments: 0, labels: [], assignees: ['validation'], milestone: '' }];
        case 'get_insights':
          return {
            headBranch: 'main', nowSeconds: Math.floor(Date.now() / 1000), periodDays: args.days ?? 28,
            commits: 3, prevCommits: 0, contributors: 2, prevContributors: 0, additions: 0, deletions: 0,
            weekly: [], prevWeekly: [], days: [], recent: [], lineCommitsScanned: 0, lineCommitsTotal: 0,
            people: [
              { name: 'Maya Chen', email: 'maya@acme.dev', commits: 2, additions: 0, deletions: 0 },
              { name: 'Jordan Lee', email: 'jordan@acme.dev', commits: 1, additions: 0, deletions: 0 },
            ],
          };
        default: return fallback(cmd, args);
      }
    };
  }, { history: HISTORY, withEmails, mapped: MAYA_MAPPED });
  await openFixture(page);
  return requested;
}

/** The avatar shows a loaded picture with this exact URL. */
async function expectPicture(avatar, url) {
  const img = avatar.locator('img.author-avatar__img');
  await expect(img).toHaveAttribute('src', url);
  await expect(img).toHaveAttribute('loading', 'lazy');
  await expect(avatar).toHaveClass(/author-avatar--loaded/);
  await expect(img).toHaveCSS('opacity', '1');
}

/** The avatar has no picture (none resolved, or it failed) and shows initials. */
async function expectInitials(avatar, initials) {
  await expect(avatar.locator('img')).toHaveCount(0);
  await expect(avatar).not.toHaveClass(/author-avatar--loaded/);
  await expect(avatar.locator('.author-avatar__initials')).toHaveText(initials);
  await expect(avatar.locator('.author-avatar__initials')).toBeVisible();
}

const graphAvatar = (page, name) =>
  page.locator('.commit-row--clickable').filter({ hasText: name }).first().locator('.commit-row__avatar');

test('commit graph rows and the detail panel show real author pictures', async ({ page }) => {
  const requested = await setup(page);
  await page.locator('.nav-item').filter({ hasText: 'Commit graph' }).click();

  await expectPicture(graphAvatar(page, 'Maya Chen'), MAYA_MAPPED); // gh email map
  await expectPicture(graphAvatar(page, 'Sam Rivera'), SAM_NOREPLY); // noreply email
  await expectPicture(graphAvatar(page, 'Alex Liu'), ALEX_GRAVATAR); // Gravatar hash
  await expectInitials(graphAvatar(page, 'Jordan Lee'), 'JL'); // Gravatar 404 → initials
  expect(requested).toContain(JORDAN_GRAVATAR);
  // Only hashes ever reach Gravatar — no address in any image URL.
  expect(requested.filter((url) => /acme|%40|@/.test(url))).toEqual([]);

  await page.locator('.commit-row--clickable').filter({ hasText: 'Maya Chen' }).first().click();
  await expectPicture(page.locator('.commit-detail__avatar'), MAYA_MAPPED);
});

test('branch, cherry-pick and rebase commit lists use the same pictures', async ({ page }) => {
  await setup(page);
  for (const menu of ['Branches', 'Cherry Pick', 'Rebase Branch']) {
    await page.locator('.nav-item').filter({ hasText: menu }).first().click();
    if (menu === 'Rebase Branch') {
      await page.getByRole('combobox', { name: 'Rebase main onto' }).selectOption('fix/lane-rendering');
    }
    const maya = page.locator('.commit-avatar[title="Maya Chen"]').first();
    await expectPicture(maya, MAYA_MAPPED);
    await expectPicture(page.locator('.commit-avatar[title="Sam Rivera"]').first(), SAM_NOREPLY);
    await expectInitials(page.locator('.commit-avatar[title="Jordan Lee"]').first(), 'JL');
  }
});

test('Explorer file history shows the commit authors\' pictures', async ({ page }) => {
  await setup(page);
  await page.locator('[title="src/app.ts"]').click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const avatars = page.locator('.file-history__avatar');
  await expect(avatars).toHaveCount(2);
  await expectPicture(avatars.nth(0), MAYA_MAPPED); // row 2 of the history = Maya
  await expectPicture(avatars.nth(1), samNoreply(28)); // noreply email, panel-sized
});

test('Working changes shows the committer\'s picture', async ({ page }) => {
  await setup(page);
  await page.locator('.nav-item').filter({ hasText: 'Working changes' }).click();
  await expectPicture(page.locator('.commit-composer__author .avatar'), ALEX_GRAVATAR);
});

test('pull request and issue people show their GitHub pictures by login', async ({ page }) => {
  await setup(page);
  await page.locator('.nav-item').filter({ hasText: 'Pull requests' }).click();
  await expectPicture(page.locator('.pr-row__meta-line .pr-row__avatar').first(), VALIDATION_GH);
  await expectPicture(page.locator('.pr-detail__author-line .pr-row__avatar'), VALIDATION_GH);

  await page.locator('.nav-item').filter({ hasText: 'Issues' }).click();
  await expectPicture(page.locator('.issue-row__avatar').first(), VALIDATION_GH);
});

test('Insights contributors show pictures and fall back to initials', async ({ page }) => {
  await setup(page);
  await page.locator('.nav-item').filter({ hasText: 'Insights' }).click();
  const maya = page.locator('.insights-contributor').filter({ hasText: 'Maya Chen' }).first();
  await expectPicture(maya.locator('.insights-contributor__avatar'), MAYA_MAPPED);
  const jordan = page.locator('.insights-contributor').filter({ hasText: 'Jordan Lee' }).first();
  await expectInitials(jordan.locator('.insights-contributor__avatar'), 'JO'); // the screen's own initials rule
});

test('authors without an email or picture keep their initials', async ({ page }) => {
  const requested = await setup(page, { withEmails: false });
  await page.locator('.nav-item').filter({ hasText: 'Commit graph' }).click();
  await expectInitials(graphAvatar(page, 'Maya Chen'), 'MC');
  await expectInitials(graphAvatar(page, 'Alex Liu'), 'AL');
  await page.locator('.nav-item').filter({ hasText: 'Branches' }).click();
  await expectInitials(page.locator('.commit-avatar[title="Sam Rivera"]').first(), 'SR');
  expect(requested).toEqual([]);
});
