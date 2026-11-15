import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const [exeArg, repo, secondsArg = '300', outputArg = 'docs/native-soak.json', profileArg] = process.argv.slice(2);
if (!exeArg) throw new Error('Usage: node tools/native-soak.mjs EXE REPO_OR_DASH [SECONDS] [OUTPUT]');
const output = resolve(outputArg);
const root = profileArg ? resolve(profileArg) : mkdtempSync(join(tmpdir(), 'pigry-native-'));
mkdirSync(root, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
writeFileSync(join(root, 'config.json'), JSON.stringify({ recent: repo === '-' ? [] : [repo], active: null }));
const child = spawn(resolve(exeArg), [], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PIGRY_TEST_CONFIG_DIR: root, WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
let browser;
const samples = [];
const errors = [];
const measureTree = () => {
  const script = `$all=Get-CimInstance Win32_Process;$ids=@(${child.pid});do{$next=@($all|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object {[int]$_.ProcessId});$ids+=$next}while($next.Count);$p=Get-Process -Id $ids -ErrorAction SilentlyContinue;@{workingSetMiB=[math]::Round(($p|Measure-Object WorkingSet64 -Sum).Sum/1MB,1);privateMiB=[math]::Round(($p|Measure-Object PrivateMemorySize64 -Sum).Sum/1MB,1);processes=$p.Count}|ConvertTo-Json -Compress`;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
};
try {
  const start = Date.now();
  while (!browser && Date.now() - start < 40_000) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!browser) throw new Error('Native WebView did not start its validation CDP endpoint');
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.home__card')).toBeVisible({ timeout: 30_000 });
  const homeReadyMs = Date.now() - start;
  if (process.env.PIGRY_INSTALLER_MARKER === 'write') {
    await page.evaluate(() => { localStorage.setItem('pigry:installer-validation', 'preserved'); localStorage.setItem('pigry:theme', 'light'); });
  } else if (process.env.PIGRY_INSTALLER_MARKER === 'check') {
    if (await page.evaluate(() => localStorage.getItem('pigry:installer-validation')) !== 'preserved') throw new Error('Upgrade lost saved profile data');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  }
  if (repo !== '-') {
    await page.locator('.home__recent-item').first().click();
    await expect(page.locator('.nav-item').first()).toBeVisible({ timeout: 30_000 });
  }
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = await cdp.send('Runtime.getHeapUsage');
    return Math.round(usage.usedSize / 1048576 * 10) / 10;
  };
  const takeSample = async cycle => {
    const jsHeapMiB = await heap();
    const dom = await cdp.send('Memory.getDOMCounters');
    const sample = { seconds: Math.round((Date.now() - start) / 1000), cycle, ...(measureTree()), jsHeapMiB, domNodes: dom.nodes, jsEventListeners: dom.jsEventListeners };
    samples.push(sample); console.log(JSON.stringify(sample));
  };
  let cycles = 0;
  const deadline = Date.now() + Number(secondsArg) * 1000;
  let lastSample = 0;
  do {
    if (repo !== '-') {
      for (const name of ['Working changes', 'Commit graph', 'Branches', 'Explorer']) {
        await page.locator('.nav-item').filter({ has: page.locator('.nav-item__label', { hasText: new RegExp(`^${name}$`, 'i') }) }).click();
        await expect(page.locator('.screen-loading')).toHaveCount(0);
        await expect(page.locator('.error-boundary')).toHaveCount(0);
        if (name === 'Commit graph') await expect(page.locator('.commit-history__subtitle')).toContainText('10000', { timeout: 30_000 });
        if (name === 'Explorer') {
          await expect(page.locator('.explorer-tree-foot')).toContainText('20200 files', { timeout: 30_000 });
          await page.waitForFunction(() => {
            const editor = document.querySelector('.monaco-editor');
            return editor && editor.getBoundingClientRect().width > 0;
          }, null, { timeout: 30_000 });
          const renderedRows = await page.locator('.file-tree .tree-row').count();
          if (renderedRows > 150) throw new Error(`Large tree rendered ${renderedRows} rows; expected a bounded window`);
        }
      }
    } else {
      await expect(page.locator('.home__card')).toBeVisible();
    }
    cycles++;
    if (Date.now() - lastSample >= 30_000) { await takeSample(cycles); lastSample = Date.now(); }
    if (repo === '-') await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  await takeSample(cycles);
  mkdirSync(resolve(output, '..'), { recursive: true });
  await page.screenshot({ path: output.replace(/\.json$/, '.png') });
  const warm = samples.find(sample => sample.seconds >= 30) ?? samples[0];
  const later = samples.filter(sample => sample.seconds >= warm.seconds);
  const resourceBudget = {
    baselineSeconds: warm.seconds,
    domGrowth: Math.max(...later.map(sample => sample.domNodes)) - warm.domNodes,
    jsHeapGrowthMiB: Math.round((Math.max(...later.map(sample => sample.jsHeapMiB)) - warm.jsHeapMiB) * 10) / 10,
    maxDomGrowth: 2000, maxJsHeapGrowthMiB: 20,
  };
  resourceBudget.passed = resourceBudget.domGrowth <= 2000 && resourceBudget.jsHeapGrowthMiB <= 20;
  if (repo !== '-' && !resourceBudget.passed) errors.push('Repeated navigation exceeded its warmed DOM/JS heap budget');
  const result = { exe: resolve(exeArg), scope: repo === '-' ? 'Installed release Home; isolated WebView profile; no repository/config mutations' : 'Native debug, real 10000-commit/20000-file repository; navigation plus live Rust calls', homeReadyMs, durationSeconds: Math.round((Date.now() - start) / 1000), cycles, errors, samples, fixtureRoot: root };
  result.frontendUrl = page.url();
  result.resourceBudget = resourceBudget;
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  if (errors.length) throw new Error(errors.join('\n'));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    mkdirSync(resolve(output, '..'), { recursive: true });
    await page.screenshot({ path: output.replace(/\.json$/, '-failed.png') }).catch(() => {});
    const text = await page.locator('body').innerText().catch(() => 'Page unavailable');
    writeFileSync(join(root, 'failure.txt'), text);
    const editorMarkup = await page.locator('.editor-pane__editor').evaluate(element => element.innerHTML.slice(0, 1600)).catch(() => 'No editor host');
    console.error(JSON.stringify({ failure: String(error).slice(0, 700), fixtureRoot: root, pageTail: text.slice(-2000), editorMarkup, rows: await page.locator('.file-tree .tree-row').count().catch(() => -1), errors }));
  }
  throw new Error('Native validation failed; see its failure screenshot and fixture diagnostics');
} finally {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    // Close the native window normally so WebView storage can flush before exit.
    if (page) await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })).catch(() => {});
    await Promise.race([
      new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    await browser.close().catch(() => {});
  }
  if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
