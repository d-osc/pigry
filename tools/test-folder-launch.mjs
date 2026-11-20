import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

// Use a debug binary and the running dev server. Each process has an isolated profile.
const exe = resolve(process.argv[2] ?? 'src-tauri/target/debug/pigry.exe');
const root = mkdtempSync(join(tmpdir(), 'pigry-folder-launch-'));
const repo = join(root, 'My Projects งานทดสอบ');
mkdirSync(repo);
const git = spawnSync('git', ['init', '-b', 'main', repo], { windowsHide: true });
if (git.status !== 0) throw new Error('Could not create test repository');
const nested = join(repo, 'nested folder');
mkdirSync(nested);
const plain = join(root, 'plain folder');
mkdirSync(plain);

for (const scenario of ['normal', 'repository', 'relative', 'plain']) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const profile = join(root, scenario);
  mkdirSync(profile);
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ recent: [], active: null }));
  const args = scenario === 'relative' ? ['./My Projects งานทดสอบ/nested folder']
    : scenario === 'normal' ? [] : ['--open-folder', join(scenario === 'repository' ? nested : plain, '.')];
  const child = spawn(exe, args, {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PIGRY_TEST_CONFIG_DIR: profile, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  let browser;
  try {
    const deadline = Date.now() + 60000;
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!browser) throw new Error('Native WebView did not start');
    const page = browser.contexts()[0].pages()[0];
    if (scenario === 'repository' || scenario === 'relative') {
      await expect.poll(async () => {
        const active = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_app_state').then(state => state.activePath)).catch(() => null);
        return active ? resolve(active) : null;
      }, { timeout: 45000 }).toBe(resolve(repo));
      await expect(page.locator('.home__card')).toBeHidden({ timeout: 15000 });
    } else {
      await expect(page.locator('.home__card')).toBeVisible({ timeout: 45000 });
      if (scenario === 'plain') await expect(page.locator('.home__error')).toContainText('not a git repository');
    }
    console.log(`PASS: native folder launch — ${scenario}`);
  } finally {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })).catch(() => {});
    await browser?.close().catch(() => {});
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}
