/** A fake "test browser" for the E2E runner: a second Playwright page serves a
 * small web app at http://app.test and the Pigry app page drives it through the
 * same Driver interface the Tauri DevTools session implements. */

export const APP_HTML = {
  '/': `<!doctype html><html><head><title>Test App</title><style>
    body{font-family:sans-serif} .primary{background:#2563eb;color:#fff;border-radius:8px;padding:6px 12px;border:0}
    .tip .tip-text{display:none} .tip:hover .tip-text{display:inline;color:#047857} #mover{display:inline-block;animation:slide .35s ease-out forwards;background:#fde68a;padding:2px 8px} @keyframes slide{from{transform:translateX(0)}to{transform:translateX(160px)}}
    .hidden{display:none} .error{color:#b91c1c} #cover{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:10} .wide{width:1500px;height:10px;background:#eee}
  </style></head><body>
  <h1>Welcome home</h1>
  <nav><a href="/login">Sign in</a> <a href="/about">About</a></nav>
  <button id="inc" class="primary" data-cy="inc">Increment</button> <span id="count">0</span>
  <ul id="users"></ul>
  <div id="late"></div>
  <button id="open">Open modal</button>
  <div id="modal" class="hidden"><span>Modal body</span> <button id="close">Close</button></div>
  <input id="name" placeholder="Your name"> <button id="greet">Greet</button> <p id="greeting"></p>
  <button id="boom">Boom</button> <button id="ask">Ask</button> <button id="shout">Shout</button> <p id="answer"></p>
  <button id="cover-on">Cover</button>
  <div id="hover-box" class="tip">Hover me <span class="tip-text">Tooltip!</span></div>
  <div id="shadow-host"></div> <p id="shadow-out"></p>
  <iframe id="frame" title="inner" srcdoc="<button id='in-frame'>Frame button</button> <p id='frame-out'></p><script>document.getElementById('in-frame').addEventListener('click',function(){document.getElementById('frame-out').textContent='clicked in frame';});<\/script>"></iframe>
  <div style="overflow:hidden;width:420px;height:32px"><button id="mover">Moving</button> <span id="moved-clicks">0</span></div>
  <input id="kbd" placeholder="Type here"> <p id="keys"></p> <p id="trusted"></p>
  <p id="clock-out"></p><button id="timer">Timer</button>
  <script>
    var n = 0;
    var host = document.getElementById('shadow-host'); var root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<button class="shadow-btn">Inside shadow</button>'; root.querySelector('.shadow-btn').addEventListener('click', function () { document.getElementById('shadow-out').textContent = 'shadow clicked'; });
    var mc = 0; document.getElementById('mover').addEventListener('click', function () { mc += 1; document.getElementById('moved-clicks').textContent = String(mc); });
    document.getElementById('kbd').addEventListener('keydown', function (e) { document.getElementById('keys').textContent += e.key + ','; document.getElementById('trusted').textContent = String(e.isTrusted); });
    document.getElementById('inc').addEventListener('click', function (e) { document.getElementById('trusted').textContent = String(e.isTrusted); });
    document.getElementById('inc').addEventListener('click', function () { n += 1; document.getElementById('count').textContent = String(n); });
    setTimeout(function () { document.getElementById('late').innerHTML = '<span class="late-item">Loaded later</span>'; }, 300);
    fetch('/api/users').then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); }).then(function (list) {
      document.getElementById('users').innerHTML = list.map(function (u) { return '<li class="user">' + u.name + '</li>'; }).join('');
    }).catch(function () { document.getElementById('users').innerHTML = '<li class="error">Could not load users</li>'; });
    document.getElementById('open').addEventListener('click', function () { document.getElementById('modal').classList.remove('hidden'); });
    document.getElementById('close').addEventListener('click', function () { document.getElementById('modal').classList.add('hidden'); });
    document.getElementById('greet').addEventListener('click', function () { document.getElementById('greeting').textContent = 'Hello, ' + document.getElementById('name').value; });
    document.getElementById('boom').addEventListener('click', function () { setTimeout(function () { throw new Error('app exploded'); }, 5); });
    document.getElementById('ask').addEventListener('click', function () { document.getElementById('answer').textContent = confirm('Are you sure?') ? 'yes' : 'no'; });
    document.getElementById('shout').addEventListener('click', function () { alert('hi there'); });
    document.getElementById('cover-on').addEventListener('click', function () { var d = document.createElement('div'); d.id = 'cover'; document.body.appendChild(d); });
    document.getElementById('timer').addEventListener('click', function () { setTimeout(function () { document.getElementById('clock-out').textContent = 'ticked'; }, 5000); });
  </script></body></html>`,
  '/login': `<!doctype html><html><head><title>Sign in</title></head><body>
  <h1>Sign in</h1>
  <form id="f">
    <input type="email" id="email" name="email" placeholder="Email">
    <input type="password" id="password" name="password" placeholder="Password">
    <label><input type="checkbox" id="remember" value="yes"> Remember me</label>
    <select id="lang"><option value="es">Español</option><option value="en">English</option><option value="th">ไทย</option></select>
    <button type="submit">Sign in</button>
  </form>
  <p id="out"></p>
  <script>
    document.getElementById('f').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('email').value, pw = document.getElementById('password').value;
      var out = document.getElementById('out');
      if (!email || !pw) { out.innerHTML = '<span role="alert" class="error">Email and password are required</span>'; return; }
      localStorage.setItem('user', email);
      document.cookie = 'session=abc123; path=/';
      out.innerHTML = '<span id="welcome">Welcome ' + email + '</span>';
    });
  </script></body></html>`,
  '/about': '<!doctype html><html><head><title>About</title></head><body><h1>About us</h1><p class="blurb">We test things.</p></body></html>',
  '/wide': '<!doctype html><html><head><title>Wide</title></head><body><div class="wide"></div><p>wide page</p></body></html>',
};

const JSON_ROUTES = {
  '/api/users': JSON.stringify([{ id: 1, name: 'Grace' }, { id: 2, name: 'Alan' }]),
  '/api/health': JSON.stringify({ ok: true }),
};

/** Opens the fake test browser and exposes a `window.__b` Driver bridge in `appPage`. */
export async function installTestBrowser(appPage) {
  const pageB = await appPage.context().newPage();
  const state = { init: '', shots: [], recording: null, networkFiles: [], opened: [] };
  await pageB.route('http://app.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/echo-headers') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().headers()) });
    if (url.pathname === '/auth') { const a = route.request().headers().authorization; return route.fulfill({ status: a ? 200 : 401, contentType: 'text/html', body: '<h1 id="auth">' + (a ? 'authorized ' + a : 'denied') + '</h1>' }); }
    if (url.pathname === '/set-cookie') return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'set-cookie': 'sid=secret-token; Path=/; HttpOnly' }, body: '<h1>cookie set</h1>' });
    if (url.pathname === '/post-target') { const body = route.request().postData() ?? ''; return route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="posted">' + route.request().method() + ' ' + body + '</p>' }); }
    if (JSON_ROUTES[url.pathname]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON_ROUTES[url.pathname] });
    const html = APP_HTML[url.pathname];
    if (!html) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    const script = state.init.split('</script>').join('<\/script>');
    const body = html.replace('<head>', () => '<head><script>' + script + '</script>');
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  await appPage.exposeFunction('__bOpen', async (url) => { state.opened.push(url); if (url === 'about:blank') await pageB.goto('about:blank'); else await pageB.goto(url); return null; });
  await appPage.exposeFunction('__bEval', async (js) => { const v = await pageB.evaluate(js); return JSON.stringify(v === undefined ? null : v, null, 2); });
  await appPage.exposeFunction('__bInit', async (js) => { state.init = js; return null; });
  await appPage.exposeFunction('__bShot', async (path) => { state.shots.push(path); await pageB.screenshot(); return null; });
  await appPage.exposeFunction('__bViewport', async (w, h) => { await pageB.setViewportSize({ width: w, height: h }); return null; });
  await appPage.exposeFunction('__bRecord', async (what, path) => { state.recording = what === 'start' ? path : null; return null; });
  await appPage.exposeFunction('__bNetwork', async (path) => { state.networkFiles.push(path); return null; });
  await appPage.exposeFunction('__bConsole', async () => '(console empty)');
  state.inputs = [];
  await appPage.exposeFunction('__bInput', async (events) => {
    for (const e of events) {
      state.inputs.push(e.t);
      if (e.t === 'move') await pageB.mouse.move(e.x, e.y);
      else if (e.t === 'down') await pageB.mouse.down({ button: e.button === 'right' ? 'right' : 'left', clickCount: e.clicks ?? 1 });
      else if (e.t === 'up') await pageB.mouse.up({ button: e.button === 'right' ? 'right' : 'left', clickCount: e.clicks ?? 1 });
      else if (e.t === 'wheel') await pageB.mouse.wheel(e.dx ?? 0, e.dy ?? 0);
      else if (e.t === 'keydown') await pageB.keyboard.down(e.key);
      else if (e.t === 'keyup') await pageB.keyboard.up(e.key);
      else if (e.t === 'text') await pageB.keyboard.insertText(e.text);
      if (e.delay) await new Promise((r) => setTimeout(r, e.delay));
    }
    return null;
  });
  await appPage.exposeFunction('__bCookies', async () => (await pageB.context().cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires })));
  await appPage.exposeFunction('__bSetCookie', async (c) => { await pageB.context().addCookies([{ name: c.name, value: c.value, domain: c.domain ?? 'app.test', path: c.path ?? '/', httpOnly: !!c.httpOnly, secure: !!c.secure }]); return null; });
  await appPage.exposeFunction('__bClearCookies', async (name) => { if (!name) await pageB.context().clearCookies(); else await pageB.context().clearCookies({ name }); return null; });
  await appPage.exposeFunction('__bHeaders', async (h) => { state.headers = h; await pageB.setExtraHTTPHeaders(h); return null; });
  await defineBridge(appPage);
  return { pageB, state };
}

/** (Re)defines window.__b in the app page — call again after the app page reloads. */
export async function defineBridge(appPage) {
  await appPage.evaluate(() => {
    window.__b = {
      open: (u) => window.__bOpen(u), eval: (js) => window.__bEval(js), initScript: (js) => window.__bInit(js), screenshot: (p) => window.__bShot(p),
      viewport: (w, h) => window.__bViewport(w, h), recordStart: (p) => window.__bRecord('start', p), recordStop: () => window.__bRecord('stop'), networkExport: (p) => window.__bNetwork(p),
      console: () => window.__bConsole(),
      input: (e) => window.__bInput(e), cookies: () => window.__bCookies(), setCookie: (c) => window.__bSetCookie(c), clearCookies: (n) => window.__bClearCookies(n), setHeaders: (h) => window.__bHeaders(h),
    };
  });
}

/** Runs a spec source in the Pigry app page against the fake test browser. */
export function runSpecIn(appPage, source, overrides = {}, extra = {}) {
  return appPage.evaluate(async ({ source, overrides, extra }) => {
    const { runSpec, DEFAULT_CONFIG } = await import('/src/extensions/e2e/engine/runner.ts');
    const { transpileTs } = (extra.ts || extra.esm) ? await import('/src/extensions/e2e/engine/transpile.ts') : { transpileTs: undefined };
    const files = window.__worktree ?? new Map();
    const b = window.__b;
    const driver = {
      open: (u, w) => b.open(u, w), eval: (js) => b.eval(js), initScript: (js) => b.initScript(js), screenshot: (p, o) => { (window.__shotOpts ??= []).push({ p, o }); return b.screenshot(p); },
      viewport: (w, h) => b.viewport(w, h), recordStart: (p) => b.recordStart(p), recordStop: () => b.recordStop(), networkExport: (p) => b.networkExport(p), console: () => b.console(),
      readFile: async (p) => (files.has(p) ? files.get(p) : null), writeFile: async (p, c) => { files.set(p, c); },
      ...(extra.real ? { input: (e) => b.input(e), cookies: () => b.cookies(), setCookie: (c) => b.setCookie(c), clearCookies: (n) => b.clearCookies(n), setHeaders: (h) => b.setHeaders(h) } : {}),
      exec: async (cmd) => ({ code: cmd.includes('fail') ? 1 : 0, output: `ran: ${cmd}` }), close: async () => undefined,
    };
    const snaps = [];
    const events = [];
    const pauses = [];
    const result = await runSpec({
      driver, config: { ...DEFAULT_CONFIG, baseUrl: 'http://app.test', defaultCommandTimeout: 1500, networkEvidence: false, ...overrides },
      spec: 'user/t', source, evidenceDir: '.pigry/e2e/evidence/user/t', snapshotSink: snaps, onEvent: (e) => { if (e.type !== 'snapshot') events.push(e.type); },
      support: extra.support, plugins: extra.plugins, specPath: extra.specPath, supportPath: extra.supportPath, typescript: !!extra.ts, transpile: transpileTs, onPause: extra.pause ? async (info) => { pauses.push(info.command); return pauses.length > 2 ? 'resume' : 'step'; } : undefined,
    });
    return { result, snapshots: snaps.length, events, pauses, shotOpts: window.__shotOpts ?? [] };
  }, { source, overrides, extra });
}

export const statusOf = (r) => Object.fromEntries(r.result.tests.map((t) => [t.title.at(-1), t.status]));
export const errorOf = (r, title) => r.result.tests.find((t) => t.title.at(-1) === title)?.error?.message ?? null;

/** An in-memory worktree plus the DevTools commands routed to the fake test browser — what the E2E screen and the e2e_* tools talk to in the real app. */
export async function installE2eEnvironment(page, seed = {}) {
  await page.evaluate((seed) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    const files = new Map(Object.entries(seed));
    window.__worktree = files;
    window.__devtools = [];
    bridge.invoke = async (cmd, args = {}) => {
      if (cmd === 'browser_devtools') {
        const b = window.__b;
        window.__devtools.push(args.action);
        switch (args.action) {
          case 'open': await b.open(args.url); return `opened ${args.url}`;
          case 'eval': return b.eval(args.js);
          case 'init_script': await b.initScript(args.js || ''); return 'init script registered';
          case 'screenshot': (window.__shots ??= []).push(args.url); return args.url ?? '';
          case 'viewport': { const [w, h] = String(args.js).split(','); await b.viewport(Number(w), Number(h)); return 'viewport set'; }
          case 'record_start': (window.__videos ??= []).push(args.url); return 'recording';
          case 'record_stop': return 'stopped';
          case 'network_export': (window.__network ??= []).push(args.url); return 'exported';
          case 'console': return '(console empty)';
          case 'input': await b.input(JSON.parse(args.js)); return 'ok';
          case 'cookies': return JSON.stringify(await b.cookies());
          case 'set_cookie': await b.setCookie(JSON.parse(args.js)); return 'ok';
          case 'clear_cookies': await b.clearCookies(args.js || undefined); return 'ok';
          case 'headers': await b.setHeaders(JSON.parse(args.js || '{}')); return 'ok';
          case 'websecurity': return 'ok';
          default: return 'ok';
        }
      }
      if (cmd === 'get_file_tree') { const base = await invoke(cmd, args); return { ...base, entries: [...base.entries, ...files.keys()] }; }
      if (cmd === 'read_worktree_file') {
        if (!files.has(args.path)) throw new Error(`no such file: ${args.path}`);
        return { path: args.path, content: files.get(args.path), binary: false, tooLarge: false, language: 'javascript' };
      }
      if (cmd === 'write_worktree_file') { files.set(args.path, args.content); return null; }
      if (cmd === 'delete_worktree_file') { files.delete(args.path); return null; }
      if (cmd === 'agent_shell_run') return { output: `ran: ${args.command}`, code: 0, timedOut: false };
      return invoke(cmd, args);
    };
  }, seed);
}

export const SPEC_PASS = `describe('Home page', () => {
  beforeEach(() => { cy.visit('/'); });
  it('shows the heading', () => {
    cy.get('h1').should('have.text', 'Welcome home');
  });
  it('counts clicks', () => {
    cy.get('#inc').click().click();
    cy.get('#count').should('have.text', '2');
  });
});
`;

export const SPEC_FAIL = `describe('Broken page', () => {
  it('finds the missing button', () => {
    cy.visit('/');
    cy.get('#nope');
  });
  it('still passes', () => {
    cy.visit('/about');
    cy.contains('About us').should('be.visible');
  });
});
`;
