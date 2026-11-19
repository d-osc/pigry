import { expect, test } from '@playwright/test';
import { installBackend } from './backend.mjs';

test('opens a remote SSH folder in the regular Explorer and Git workspace', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  const local = page.getByRole('button', { name: 'Local', exact: true });
  const server = page.getByRole('button', { name: 'Server', exact: true });
  await expect(local).toHaveAttribute('aria-pressed', 'true');
  await server.click();
  await page.getByLabel('Host', { exact: true }).fill('dev.example.com');
  await page.getByLabel('Username (optional)').fill('dev');
  await page.getByLabel('Port (optional)').fill('2222');
  await page.getByRole('button', { name: 'Connect over SSH' }).click();
  await expect(page.getByRole('region', { name: 'SSH terminal' }).locator('.xterm')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Remote folder picker' })).toHaveCount(0);
  await showRemoteFolders(page, '/home/dev', ['Client’s project', 'Work'], true);
  const picker = page.getByRole('region', { name: 'Remote folder picker' });
  await expect(picker.getByLabel('Remote folder path')).toHaveValue('/home/dev');
  await picker.getByRole('button', { name: 'Client’s project' }).click();
  await expectSshWrite(page, 'list /home/dev/Client’s project\r');
  await showRemoteFolders(page, '/home/dev/Client’s project', ['src']);
  await expect(picker.getByRole('button', { name: 'src' })).toBeVisible();
  await picker.getByRole('button', { name: 'Parent folder' }).click();
  await expectSshWrite(page, 'list /home/dev\r');
  await showRemoteFolders(page, '/home/dev', ['Client’s project', 'Work']);

  await picker.getByLabel('Remote folder path').fill("/srv/client's files");
  await picker.getByRole('button', { name: 'Browse' }).click();
  await expectSshWrite(page, "list /srv/client's files\r");
  await sendFolderMessages(page, ['error']);
  await expect(page.getByRole('alert')).toHaveText('Could not list that folder on the server.');
  await page.evaluate(() => {
    window.testBackend.failures.open_ssh_workspace = 'The selected server folder is not a Git working repository.';
  });
  await picker.getByRole('button', { name: 'Open folder' }).click();
  const opening = page.getByRole('region', { name: 'Opening server workspace' });
  await expect(opening.getByRole('alert')).toHaveText('The selected server folder is not a Git working repository.');
  await opening.getByRole('button', { name: 'Back to folders' }).click();
  await page.evaluate(() => { delete window.testBackend.failures.open_ssh_workspace; });

  await picker.getByLabel('Remote folder path').fill("/srv/client's project");
  await picker.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByRole('button', { name: /Connect over SSH/ })).toHaveCount(0);
  await expect(page.getByText("ssh://dev@dev.example.com:2222/srv/client's project")).toBeVisible();
  await expect(page.locator('.nav-item').filter({ hasText: 'Explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testBackend.calls.some(({ cmd, args }) =>
    cmd === 'read_worktree_file' && args.path === 'README.md'))).toBe(true);
  await page.locator('.nav-item').filter({ hasText: 'Commit graph' }).click();
  await expect(page.locator('.commit-row--clickable').first()).toBeVisible();
  const calls = await page.evaluate(() => window.testBackend.calls);
  expect(calls).toContainEqual({ cmd: 'pty_start_ssh_workspace', args: { id: 271, path: "/srv/client's project" } });
  expect(calls).toContainEqual({ cmd: 'open_ssh_workspace', args: { id: 273 } });
  expect(calls).toContainEqual({ cmd: 'cancel_ssh_workspace_start', args: { id: 272 } });
  expect(calls.filter(({ cmd }) => cmd === 'pty_create_ssh')).toEqual([
    { cmd: 'pty_create_ssh', args: { host: 'dev.example.com', username: 'dev', port: 2222, browseFolders: true } },
  ]);
  await page.getByRole('button', { name: 'Disconnect SSH workspace' }).click();
  await expect(page.getByRole('button', { name: 'Connect over SSH' })).toBeVisible();
});

test('terminal-only SSH opens without requesting the folder picker', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.keyboard.press('Control+Shift+p');
  await page.getByRole('dialog', { name: 'Command palette' }).getByLabel('Command search').fill('Connect to SSH host');
  await page.getByText('Connect to SSH host…', { exact: true }).click();
  await page.getByLabel('Host', { exact: true }).fill('fixture@dev.example.com');
  await page.getByLabel('Terminal only').check();
  await page.getByRole('button', { name: 'Connect over SSH' }).click();
  await expect(page.getByRole('region', { name: 'SSH terminal' }).locator('.xterm')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testBackend.calls
    .find(({ cmd }) => cmd === 'pty_create_ssh')?.args)).toEqual({
    host: 'dev.example.com', username: 'fixture', port: null, browseFolders: false,
  });
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByLabel('Host', { exact: true })).toBeVisible();
});

async function expectSshWrite(page, data) {
  await expect.poll(() => page.evaluate(() => window.testBackend.calls
    .filter(({ cmd }) => cmd === 'pty_write').at(-1)?.args))
    .toEqual({ id: 271, data });
}

async function showRemoteFolders(page, path, folders, initial = false) {
  const hex = Buffer.from([path, ...folders, ''].join('\0'), 'utf8').toString('hex');
  const chunks = hex.match(/.{1,32}/g).map((part) => 'data; ' + part.match(/../g).join(' '));
  await sendFolderMessages(page, [...(initial ? ['ready'] : []), 'begin', ...chunks, 'end']);
}

async function sendFolderMessages(page, messages) {
  await page.evaluate((messages) => {
    for (const message of messages) {
      window.testBackend.emit('pty-output', { id: 271, data: '\x1b]697;pigry;' + message });
      window.testBackend.emit('pty-output', { id: 271, data: '\x07' });
    }
  }, messages);
}
