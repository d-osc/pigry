import { expect, test } from '@playwright/test';
import { installBackend, openFixture } from './backend.mjs';

/** An in-memory worktree (so collections, environments and the local cache persist) and a fake http_send that
 * records what was sent and answers like a small JSON API. */
async function installApiBackend(page) {
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map();
    window.__worktree = files;
    window.__sent = [];
    window.__cancelled = [];
    window.__slow = 0;
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'get_file_tree') {
        const base = await invoke(cmd, args);
        return { ...base, entries: [...base.entries, ...[...files.keys()].filter((p) => !p.startsWith('.pigry/cache/'))] };
      }
      if (cmd === 'read_worktree_file') {
        if (files.has(args.path)) return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'json' };
        if (args.path.startsWith('.pigry/')) throw new Error(`not found: ${args.path}`);
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      if (cmd === 'http_cancel') { window.__cancelled.push(args.id); window.__cancel?.(); return true; }
      if (cmd === 'api_yaml_to_json') throw new Error('YAML is not available in the test backend');
      if (cmd === 'http_send') {
        const req = args.request;
        window.__sent.push(req);
        if (window.__slow) {
          await new Promise((resolve, reject) => { const t = setTimeout(resolve, window.__slow); window.__cancel = () => { clearTimeout(t); reject(new Error('Request cancelled')); }; });
        }
        const url = new URL(req.url);
        const json = (status, body, extra = []) => ({
          status, statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'Unauthorized', httpVersion: '1.1',
          headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }, { key: 'X-Request-Id', value: 'req-1' }, ...extra],
          body: JSON.stringify(body), encoding: 'utf8', timeMs: 42.4, timings: { dnsMs: 1, connectMs: 2, tlsMs: 0, firstByteMs: 30, totalMs: 42.4 },
          bodySize: JSON.stringify(body).length, headersSize: 120, url: req.url, redirects: 0, truncated: false,
        });
        const auth = req.headers.find((h) => h.key.toLowerCase() === 'authorization')?.value;
        if (url.pathname === '/login') return json(200, { token: 'tok-123' }, [{ key: 'Set-Cookie', value: 'sid=abc; Path=/; HttpOnly' }]);
        if (url.pathname === '/secure') return auth === 'Bearer tok-123' ? json(200, { ok: true }) : json(401, { error: 'no token' });
        if (url.pathname.startsWith('/users') && req.method === 'POST') return json(201, { id: 7, ...JSON.parse(req.body ?? '{}') });
        if (url.pathname === '/users/1') return json(200, { id: 1, name: 'Ann', email: 'ann@example.com', tags: ['admin', 'beta'], active: true, score: null });
        if (url.pathname === '/html') return { ...json(200, {}), headers: [{ key: 'Content-Type', value: 'text/html' }], body: '<html><body><h1>Hello</h1></body></html>' };
        return json(404, { error: 'not found', path: url.pathname, query: url.search });
      }
      return invoke(cmd, args);
    };
  });
}

async function setup(page) {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installBackend(page);
  await openFixture(page);
  await installApiBackend(page);
  await page.evaluate(() => localStorage.removeItem('pigry:api-environment'));
  await page.getByRole('button', { name: 'RESTful API', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'RESTful API', level: 1 })).toBeVisible();
}
const file = async (page, path) => JSON.parse(await page.evaluate((p) => window.__worktree.get(p) ?? 'null', path));
const saved = (page, path, fn) => expect.poll(async () => { try { return fn(await file(page, path)); } catch { return undefined; } }, { timeout: 6000 });
const sent = (page) => page.evaluate(() => window.__sent);
const url = (page) => page.getByRole('textbox', { name: 'Request URL' });
const response = (page) => page.getByRole('region', { name: 'Response' });
const status = (page) => page.getByRole('status', { name: 'Response status' });
const tools = async (page, name, input) => page.evaluate(async ([n, i]) => {
  const { API_TOOLS } = await import('/src/extensions/api/apiTools.ts');
  return API_TOOLS.find((t) => t.name === n).run({ agent: 'api-tester', ...i });
}, [name, input]);

async function newEnvironment(page, name, vars) {
  await page.getByRole('tab', { name: 'Environments' }).click();
  await page.getByRole('button', { name: 'New environment' }).click();
  await page.getByRole('dialog', { name: 'New environment' }).getByLabel('Environment name').fill(name);
  await page.getByRole('dialog', { name: 'New environment' }).getByRole('button', { name: 'Create' }).click();
  for (const [i, [key, value, secret]] of vars.entries()) {
    await page.getByLabel('New variable key').fill(key);
    await page.getByRole('textbox', { name: `Variable value ${i + 1}` }).fill(value);
    if (secret) await page.getByLabel(`Variable ${i + 1} secret`).check();
  }
  await page.getByRole('combobox', { name: 'Environment' }).selectOption({ label: name });
}

test('send a request: variables are highlighted, the response shows status, pretty JSON, headers and history', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('Send HTTP requests, save them in collections')).toBeVisible();
  await page.getByRole('button', { name: 'New request', exact: true }).first().click();
  await url(page).fill('{{baseUrl}}/users/1?expand=tags');
  await expect(page.locator('.api-urlbar .api-var__bad')).toHaveText('{{baseUrl}}');
  await expect(page.getByRole('note').filter({ hasText: 'Not defined' })).toContainText('{{baseUrl}}');
  // the params table follows the URL
  await expect(page.getByLabel('Param key 1')).toHaveValue('expand');
  await expect(page.getByRole('textbox', { name: 'Param value 1' })).toHaveValue('tags');

  await newEnvironment(page, 'Development', [['baseUrl', 'https://api.test']]);
  await saved(page, '.pigry/apis/user/development.env.json', (e) => e.values[0].value).toBe('https://api.test');
  await page.getByRole('tab', { name: 'Untitled Request' }).click();
  await expect(page.locator('.api-urlbar .api-var__ok')).toHaveText('{{baseUrl}}');
  await expect(page.getByRole('note').filter({ hasText: 'Not defined' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(status(page)).toContainText('200 OK');
  await expect(status(page)).toContainText('42 ms');
  const body = response(page).getByLabel('Response body', { exact: true });
  await expect(body).toContainText('"name": "Ann"');
  await expect(body.locator('.api-json--key').first()).toHaveText('"id"');
  expect((await sent(page))[0]).toMatchObject({ method: 'GET', url: 'https://api.test/users/1?expand=tags' });

  // search in the body, raw view, headers
  await page.getByRole('button', { name: 'Search the response' }).click();
  await page.getByRole('textbox', { name: 'Search response' }).fill('a');
  await expect(page.getByLabel('Matches')).toContainText('1 /');
  await response(page).getByRole('button', { name: 'Raw' }).click();
  await expect(body).toContainText('{"id":1,"name":"Ann"');
  await response(page).getByRole('tab', { name: /Headers/ }).click();
  await expect(response(page).getByRole('table', { name: 'Response headers' })).toContainText('X-Request-Id');

  // history (local, not in the file tree)
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'GET https://api.test/users/1?expand=tags', exact: true })).toBeVisible();
  await expect.poll(async () => (await file(page, '.pigry/cache/apis/history.json'))?.length).toBe(1);
  expect(await page.evaluate(() => window.__worktree.get('.pigry/cache/.gitignore'))).toContain('*');
});

test('params, headers and a JSON body go out as typed; a pasted cURL command becomes the request', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'New request tab' }).click();
  await page.getByRole('combobox', { name: 'HTTP method' }).selectOption('POST');
  await url(page).fill('https://api.test/users');
  await page.getByLabel('New param key').fill('notify');
  await page.getByRole('textbox', { name: 'Param value 1' }).fill('yes');
  await expect(url(page)).toHaveValue('https://api.test/users?notify=yes');
  await page.getByLabel('Param 1 enabled').uncheck();
  await expect(url(page)).toHaveValue('https://api.test/users');
  await page.getByRole('tab', { name: /^Headers/ }).click();
  await page.getByLabel('New header key').fill('X-Trace');
  await page.getByRole('textbox', { name: 'Header value 1' }).fill('t-1');
  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByRole('radio', { name: 'raw' }).check();
  await page.getByRole('textbox', { name: 'Raw body' }).fill('{"name":"Bea"}');
  await page.getByRole('button', { name: 'Beautify' }).click();
  await expect(page.getByRole('textbox', { name: 'Raw body' })).toHaveValue('{\n  "name": "Bea"\n}');
  await page.keyboard.press('Control+Enter');
  await expect(status(page)).toContainText('201 Created');
  const [req] = await sent(page);
  expect(req.url).toBe('https://api.test/users');
  expect(req.headers).toEqual([{ key: 'X-Trace', value: 't-1' }, { key: 'Content-Type', value: 'application/json' }]);
  expect(JSON.parse(req.body)).toEqual({ name: 'Bea' });

  // code snippet
  await page.getByRole('button', { name: 'Code snippet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Code snippet' });
  await expect(dialog.getByLabel('Generated code')).toContainText("curl --location --request POST 'https://api.test/users'");
  await dialog.getByLabel('Snippet language').selectOption('python');
  await expect(dialog.getByLabel('Generated code')).toContainText("requests.request('POST', url");
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();

  // cURL in the URL bar
  await page.getByRole('button', { name: 'New request tab' }).click();
  await url(page).fill("curl -X PUT 'https://api.test/users/1' -H 'Accept: application/json' --data-raw '{\"a\":1}'");
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'HTTP method' })).toHaveValue('PUT');
  await expect(url(page)).toHaveValue('https://api.test/users/1');
  await page.getByRole('tab', { name: /^Headers/ }).click();
  await expect(page.getByLabel('Header key 1')).toHaveValue('Accept');
});

test('collections: save a request, add a folder, rename, drag into the folder, duplicate and delete', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'New collection', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'New collection' }).getByLabel('Collection name').fill('Shop API');
  await page.getByRole('dialog', { name: 'New collection' }).getByRole('button', { name: 'Create' }).click();
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.name).toBe('Shop API');

  await page.getByRole('button', { name: 'New request', exact: true }).first().click();
  await page.getByLabel('Request title').fill('Get user');
  await url(page).fill('https://api.test/users/:id');
  await expect(page.getByLabel('Path variable key 1', { exact: true })).toHaveCount(0);
  await expect(page.locator('.api-table__key')).toHaveText('id');
  await page.getByRole('textbox', { name: 'Path variable value 1' }).fill('1');
  await page.keyboard.press('Control+s');
  await page.getByRole('dialog', { name: 'Save request' }).getByRole('button', { name: 'Save' }).click();
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.items.map((i) => [i.name, i.url, i.pathVars[0].value])).toEqual([['Get user', 'https://api.test/users/:id', '1']]);
  const tree = page.getByRole('tree', { name: 'Collections' });
  await expect(tree.getByRole('treeitem', { name: 'Get user', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent(page))[0].url).toBe('https://api.test/users/1');

  // a folder, renamed inline
  await tree.getByRole('button', { name: 'More actions for Shop API' }).click();
  await page.getByRole('menuitem', { name: 'Add folder' }).click();
  await page.getByLabel('Folder name').fill('Users');
  await page.getByLabel('Folder name').press('Enter');
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.items.map((i) => i.name)).toEqual(['Get user', 'Users']);

  // drag the request into the folder
  await tree.getByRole('treeitem', { name: 'Get user', exact: true }).dragTo(tree.getByRole('treeitem', { name: 'Users', exact: true }).locator('.api-row').first());
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.items.map((i) => [i.name, (i.items ?? []).map((x) => x.name)])).toEqual([['Users', ['Get user']]]);

  // duplicate and delete
  await tree.getByRole('button', { name: 'More actions for Get user', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.items[0].items.map((x) => x.name)).toEqual(['Get user', 'Get user Copy']);
  await tree.getByRole('button', { name: 'More actions for Get user Copy' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete' }).getByRole('button', { name: 'Delete' }).click();
  await saved(page, '.pigry/apis/user/shop-api.api.json', (c) => c.items[0].items.length).toBe(1);

  // unsaved edits ask before closing
  await url(page).fill('https://api.test/users/:id/posts');
  await expect(page.getByLabel('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Close Get user' }).click();
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: "Don't save" }).click();
  await expect(page.getByRole('tab', { name: 'Get user' })).toHaveCount(0);
});

test('collection auth is inherited, secrets stay out of git, and test scripts save variables', async ({ page }) => {
  await setup(page);
  await tools(page, 'api_write', {
    name: 'secure-api', title: 'Secure API',
    ops: [
      { op: 'set_auth', auth: { type: 'bearer', token: '{{token}}' } },
      { op: 'add_request', name: 'Login', method: 'POST', url: '{{baseUrl}}/login', auth: { type: 'none' }, body: { json: { user: 'ann' } },
        tests: 'pm.test("Status code is 200", () => pm.response.to.have.status(200));\npm.environment.set("token", pm.response.json().token);\npm.test("fails on purpose", () => pm.expect(1).to.equal(2));' },
      { op: 'add_request', name: 'Secure', url: '{{baseUrl}}/secure', tests: 'pm.test("ok", () => pm.expect(pm.response.json().ok).to.be.true);' },
    ],
  });
  await tools(page, 'api_env', { action: 'create', name: 'staging', values: { baseUrl: 'https://api.test', token: '' }, secret: ['token'] });
  await tools(page, 'api_env', { action: 'select', name: 'staging' });
  await page.getByRole('tab', { name: 'Collections' }).click();
  await page.getByRole('tree', { name: 'Collections' }).getByRole('button', { name: 'Expand Secure API' }).click();
  await page.getByRole('treeitem', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(response(page).getByRole('tab', { name: 'Test Results (1/2)' })).toBeVisible();
  await expect(response(page).getByText('AssertionError: expected 1 to equal 2')).toBeVisible();
  await response(page).getByRole('button', { name: 'Failed' }).click();
  await expect(response(page).locator('.api-test')).toHaveCount(1);
  // the token is stored as a secret: not in the committed environment file
  await expect.poll(async () => (await file(page, '.pigry/cache/apis/secrets.json'))?.['environment:api-tester/staging']?.token).toBe('tok-123');
  expect((await file(page, '.pigry/apis/api-tester/staging.env.json')).values.find((v) => v.key === 'token').value).toBe('');
  // the cookie from login is kept in the jar
  await response(page).getByRole('tab', { name: 'Cookies (1)' }).click();
  await expect(response(page).getByRole('table', { name: 'Response cookies' })).toContainText('sid');

  await page.getByRole('treeitem', { name: 'Secure', exact: true }).click();
  await page.getByRole('tab', { name: 'Authorization' }).click();
  await expect(page.getByText('This request is using Bearer Token from the collection.')).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(status(page)).toContainText('200 OK');
  const last = (await sent(page)).at(-1);
  expect(last.headers).toEqual(expect.arrayContaining([{ key: 'Authorization', value: 'Bearer tok-123' }, { key: 'Cookie', value: 'sid=abc' }]));
  await expect(response(page).getByRole('tab', { name: 'Test Results (1/1)' })).toBeVisible();

  // the collection runner
  await page.getByRole('tree', { name: 'Collections' }).getByRole('button', { name: 'More actions for Secure API' }).click();
  await page.getByRole('menuitem', { name: 'Run collection' }).click();
  const runner = page.getByRole('dialog', { name: 'Run Secure API' });
  await runner.getByRole('button', { name: 'Run 2 requests' }).click();
  await expect(runner.getByRole('status')).toContainText('Finished: 2 request(s)');
  await expect(runner.getByRole('status')).toContainText('2 passed');
  await expect(runner.getByRole('status')).toContainText('1 failed');
});

test('import a Postman collection and an OpenAPI document; export Postman JSON', async ({ page }) => {
  await setup(page);
  const postman = {
    info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: 'https://api.test' }],
    item: [{ name: 'Pets', item: [{ name: 'List pets', request: { method: 'GET', url: '{{baseUrl}}/pets?limit=5' } }] }],
  };
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Import' }).getByLabel('Import text').fill(JSON.stringify(postman));
  await page.getByRole('dialog', { name: 'Import' }).getByRole('button', { name: 'Import', exact: true }).click();
  await saved(page, '.pigry/apis/user/pets.api.json', (c) => c.items[0].items[0].url).toBe('{{baseUrl}}/pets?limit=5');
  await expect(page.getByRole('tree', { name: 'Collections' }).getByRole('treeitem', { name: 'Pets' }).first()).toBeVisible();

  const openapi = { openapi: '3.0.0', info: { title: 'Users API' }, servers: [{ url: 'https://users.test' }], paths: { '/users/{id}': { get: { tags: ['users'], summary: 'Get user', parameters: [{ name: 'id', in: 'path', required: true, example: 1 }], responses: { 200: { description: 'ok' } } } } } };
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Import' }).getByLabel('Import text').fill(JSON.stringify(openapi));
  await page.getByRole('dialog', { name: 'Import' }).getByRole('button', { name: 'Import', exact: true }).click();
  await saved(page, '.pigry/apis/user/users-api.api.json', (c) => [c.variables[0].value, c.items[0].name, c.items[0].items[0].url]).toEqual(['https://users.test', 'users', '{{baseUrl}}/users/:id']);
  // the collection tab shows its variables
  await page.getByRole('tab', { name: 'Variables' }).click();
  await expect(page.getByRole('textbox', { name: 'Variable value 1' })).toHaveValue('https://users.test');

  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Import' }).getByLabel('Import text').fill('{"hello": 1}');
  await page.getByRole('dialog', { name: 'Import' }).getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Import' }).getByRole('alert')).toContainText('not a Postman collection');
  await page.getByRole('dialog', { name: 'Import' }).getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('tree', { name: 'Collections' }).getByRole('button', { name: 'More actions for Pets' }).first().click();
  await page.getByRole('menuitem', { name: 'Export (Postman v2.1)' }).click();
  const exp = page.getByRole('dialog', { name: 'Export Pets' });
  await expect(exp.getByLabel('Exported JSON')).toContainText('"schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"');
  await exp.getByRole('button', { name: 'Save file' }).click();
  await saved(page, '.pigry/apis/exports/pets.postman_collection.json', (c) => c.info.name).toBe('Pets');
});

test('a slow request can be cancelled, and the response preview renders HTML in a sandbox', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__slow = 20_000; });
  await page.getByRole('button', { name: 'New request tab' }).click();
  await url(page).fill('https://api.test/slow');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(response(page)).toContainText('Sending request…');
  await page.locator('.api-urlbar').getByRole('button', { name: 'Cancel' }).click();
  await expect(response(page).getByRole('alert')).toHaveText('Request cancelled');
  expect(await page.evaluate(() => window.__cancelled.length)).toBe(1);

  await page.evaluate(() => { window.__slow = 0; });
  await url(page).fill('https://api.test/html');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await response(page).getByRole('button', { name: 'Preview' }).click();
  const frame = response(page).locator('iframe[title="Response preview"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().getByRole('heading', { name: 'Hello' })).toBeVisible();
});

test('scripts run in the worker sandbox: no network, a time limit, and errors are shown', async ({ page }) => {
  await setup(page);
  const out = await page.evaluate(async () => {
    const { runScriptSandboxed } = await import('/src/extensions/api/apiStore.ts');
    const base = { event: 'test', request: { method: 'GET', url: 'https://x.test', headers: [], body: { mode: 'none', raw: '' } }, response: { code: 200, status: 'OK', headers: [], body: '{}', responseTime: 1, responseSize: 2, cookies: [] }, scopes: { globals: {}, collection: {}, environment: {}, local: {} } };
    const escape = await runScriptSandboxed({ ...base, code: 'const F = (function(){}).constructor; pm.test("no Function", () => pm.expect(F).to.be.undefined); pm.test("no fetch", () => pm.expect(typeof fetch).to.equal("undefined"));' });
    const loop = await runScriptSandboxed({ ...base, code: 'while (true) {}' }, 800);
    const imp = await runScriptSandboxed({ ...base, code: 'await import("https://x.test/a.js")' });
    return { escape: escape.tests.map((t) => t.passed), loop: loop.error, imp: imp.error };
  });
  expect(out.escape).toEqual([true, true]);
  expect(out.loop).toMatch(/ran longer than 0.8 s/);
  expect(out.imp).toMatch(/import and export are not available/);
});

test('agent tools: list, read, edit, send and export', async ({ page }) => {
  await setup(page);
  expect(await tools(page, 'api_list', {})).toContain('(none yet');
  const made = await tools(page, 'api_write', { name: 'demo', ops: [{ op: 'add_folder', name: 'Users' }, { op: 'add_request', parent: 'Users', name: 'Get user', url: 'https://api.test/users/1', tests: 'pm.test("200", () => pm.response.to.have.status(200));' }] });
  expect(made).toContain('saved .pigry/apis/api-tester/demo.api.json');
  expect(await tools(page, 'api_read', { name: 'demo', request: 'Users / Get user' })).toContain('GET https://api.test/users/1');
  expect(await tools(page, 'api_edit', { name: 'demo', ops: [{ op: 'add_request', name: 'Create', method: 'POST', url: 'https://api.test/users', body: { json: { name: 'Cy' } } }] })).toContain('added request');
  const result = await tools(page, 'api_send', { name: 'demo', request: 'Get user' });
  expect(result).toContain('→ 200 OK');
  expect(result).toContain('"name": "Ann"');
  expect(result).toContain('1 passed, 0 failed');
  const adhoc = await tools(page, 'api_send', { method: 'POST', url: 'https://api.test/users', body: { json: { name: 'Di' } } });
  expect(adhoc).toContain('→ 201 Created');
  expect(await tools(page, 'api_export', { name: 'demo', format: 'curl', request: 'Create' })).toContain("--data-raw '{\n  \"name\": \"Cy\"\n}'");
  expect(await tools(page, 'api_run', { name: 'demo' })).toContain('ran 2 request(s)');
  expect(await tools(page, 'api_open', { name: 'demo', request: 'Get user' })).toContain('opened "api-tester/demo"');
  await expect(page.getByRole('tab', { name: 'Get user' })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Collections' }).getByRole('treeitem', { name: 'Get user', exact: true })).toHaveAttribute('aria-selected', 'true');
});
