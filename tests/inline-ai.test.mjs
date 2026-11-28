import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiSkipReason, agentPromptFor, buildCompletionPrompt, buildInlineEditPrompt, cleanCompletion, contextWindow, createDebouncer,
  createRequestGate, CURSOR, debounceFor, isIgnoredPath, isSecretPath, overlapLength, parseInlineEditReply, reuseCompletion,
  shouldOfferCompletion, stripFence, COMPLETION_DEBOUNCE_MS,
} from '../src/lib/inlineAi.ts';

test('secret-looking files are never sent', () => {
  for (const path of ['.env', 'app/.env.local', 'config/.env.production', 'prod.env', 'keys/server.pem', 'id_rsa', 'id_ed25519.pub',
    '.npmrc', 'certs/site.key', 'secrets.json', 'config/credentials.yml', 'service-account.json', 'main.tfvars', 'GOOGLE_TOKEN.txt']) {
    assert.equal(isSecretPath(path), true, path);
  }
  for (const path of ['src/env.ts', 'src/environment.tsx', 'src/lib/tokenizer.ts', 'README.md', 'src/secretary.ts', 'keyboard.ts']) {
    assert.equal(isSecretPath(path), false, path);
  }
});

test('ignored files and files under ignored folders are recognised', () => {
  const ignored = ['node_modules/', 'debug.log', 'dist/'];
  assert.equal(isIgnoredPath('node_modules/react/index.js', ignored), true);
  assert.equal(isIgnoredPath('debug.log', ignored), true);
  assert.equal(isIgnoredPath('dist/app.js', ignored), true);
  assert.equal(isIgnoredPath('src/debug.log.ts', ignored), false);
  assert.equal(isIgnoredPath('distribution/a.ts', ignored), false);
});

test('the skip reason covers binary, secret, ignored and large files', () => {
  assert.equal(aiSkipReason({ path: 'src/a.ts', size: 100 }), null);
  assert.equal(aiSkipReason({ path: 'logo.png', size: 10 }), 'binary file');
  assert.equal(aiSkipReason({ path: 'a.dat', size: 10, binary: true }), 'binary file');
  assert.equal(aiSkipReason({ path: '.env', size: 10 }), 'looks like a secrets file');
  assert.equal(aiSkipReason({ path: 'out/a.js', size: 10, ignored: ['out/'] }), 'ignored by git');
  assert.equal(aiSkipReason({ path: 'big.json', size: 2_000_000 }), 'file is too large');
  assert.equal(aiSkipReason({ path: 'a.ts', size: 10, tooLarge: true }), 'file is too large');
  assert.equal(aiSkipReason({ path: 'a.ts', size: 101 }, 100), 'file is too large');
});

test('the context window keeps everything when it fits', () => {
  const text = 'line1\nline2\nline3';
  const window = contextWindow(text, 8);
  assert.deepEqual(window, { prefix: 'line1\nli', suffix: 'ne2\nline3', prefixCut: false, suffixCut: false });
});

test('the context window is cut on whole lines and always keeps the cursor line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
  const text = lines.join('\n');
  const offset = text.indexOf('line 25') + 4;
  const window = contextWindow(text, offset, 30, 30);
  assert.equal(window.prefixCut, true);
  assert.equal(window.suffixCut, true);
  assert.ok(window.prefix.endsWith('\nline'), window.prefix);
  assert.ok(window.prefix.startsWith('line '), 'starts on a line boundary');
  assert.ok(window.prefix.length <= 30 + 'line'.length);
  assert.ok(window.suffix.startsWith(' 25\n'));
  assert.ok(!window.suffix.endsWith('\n'));
  assert.ok(window.suffix.length <= 30);
  // A single huge cursor line is kept whole.
  const long = 'x'.repeat(100);
  assert.equal(contextWindow(long, 50, 10, 10).prefix, 'x'.repeat(50));
  assert.equal(contextWindow(long, 50, 10, 10).suffix, 'x'.repeat(50));
});

test('the completion prompt carries the path, language and a cursor marker between prefix and suffix', () => {
  const prompt = buildCompletionPrompt({ path: 'src/a.ts', language: 'typescript', prefix: 'const a = ', suffix: ';\n' });
  assert.match(prompt, /File: src\/a\.ts \(typescript\)/);
  assert.ok(prompt.includes(`const a = ${CURSOR};\n`));
  assert.match(prompt, /ONLY the text to insert/);
});

test('fences and cursor markers are stripped from completions', () => {
  assert.equal(stripFence('```ts\nfoo()\n```'), 'foo()');
  assert.equal(stripFence('plain'), 'plain');
  assert.equal(cleanCompletion('```js\n42;\n```', 'const a = ', ''), '42;');
  assert.equal(cleanCompletion(`42${CURSOR};`, 'const a = ', ''), '42;');
});

test('an echo of the typed line is removed', () => {
  assert.equal(cleanCompletion('const total = items.length;', 'function f() {\n  const total = ', '\n}'), 'items.length;');
  assert.equal(cleanCompletion('    return 1;', 'if (x) {\n    ', '\n}'), 'return 1;');
});

test('overlap with the code after the cursor is removed', () => {
  assert.equal(overlapLength('a, b)', ')\n}'), 1);
  assert.equal(cleanCompletion('a, b)', 'call(', ')\n'), 'a, b');
  assert.equal(cleanCompletion('\n  return x;\n}', 'function f() {', '\n}\n'), '\n  return x;');
  assert.equal(cleanCompletion('"hello");', 'log(', '");'), '"hello');
  assert.equal(cleanCompletion(')', 'call(', ')'), '');
  assert.equal(cleanCompletion('   \n', 'a', ''), '');
});

test('long completions are cut to the line limit', () => {
  const raw = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  assert.equal(cleanCompletion(raw, 'x', '', 3), 'l0\nl1\nl2');
});

test('ghost text is offered at the end of a line or before closing characters only', () => {
  assert.equal(shouldOfferCompletion('const a = ', ''), true);
  assert.equal(shouldOfferCompletion('call(', ')'), true);
  assert.equal(shouldOfferCompletion('log("', '");'), true);
  assert.equal(shouldOfferCompletion('cons', 'ole.log()'), false);
  assert.equal(shouldOfferCompletion('', ''), true);
});

test('the cached completion is reused while the user types it out', () => {
  const cache = { path: 'a.ts', prefix: 'const a = ', suffix: '', text: 'items.length;' };
  assert.equal(reuseCompletion(cache, 'a.ts', 'const a = ', ''), 'items.length;');
  assert.equal(reuseCompletion(cache, 'a.ts', 'const a = ite', ''), 'ms.length;');
  assert.equal(reuseCompletion(cache, 'a.ts', 'const a = items.length;', ''), '');
  assert.equal(reuseCompletion(cache, 'a.ts', 'const a = x', ''), null, 'typed something else');
  assert.equal(reuseCompletion(cache, 'b.ts', 'const a = ', ''), null, 'other file');
  assert.equal(reuseCompletion(cache, 'a.ts', 'const a = ', ';'), null, 'suffix changed');
  assert.equal(reuseCompletion(cache, 'a.ts', 'const ', ''), null, 'deleted back');
  assert.equal(reuseCompletion(null, 'a.ts', 'x', ''), null);
});

test('only the newest request may show its answer', () => {
  const gate = createRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.cancelAll();
  assert.equal(gate.isCurrent(second), false);
});

/** Manual clock for the debouncer. */
function fakeTimers() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => { pending.set(++id, { fn, at: now + ms }); return id; },
      clearTimeout: (handle) => pending.delete(handle),
    },
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...pending]) {
        if (timer.at <= now) { pending.delete(key); timer.fn(); }
      }
    },
    get pending() { return pending.size; },
  };
}

test('the debouncer lets only the last call through, after the pause', async () => {
  const clock = fakeTimers();
  const debounce = createDebouncer(300, clock.timers);
  const first = debounce.wait();
  clock.advance(200);
  const second = debounce.wait();
  assert.equal(await first, false, 'superseded by a newer keystroke');
  clock.advance(200);
  assert.equal(clock.pending, 1, 'the pause restarted');
  clock.advance(100);
  assert.equal(await second, true);
});

test('cancel settles the waiting call with false, and explicit requests go at once', async () => {
  const clock = fakeTimers();
  const debounce = createDebouncer(300, clock.timers);
  const waiting = debounce.wait();
  debounce.cancel();
  assert.equal(await waiting, false);
  assert.equal(clock.pending, 0);
  assert.equal(await debounce.wait(0), true);
  assert.equal(debounceFor(true), 0);
  assert.equal(debounceFor(false), COMPLETION_DEBOUNCE_MS);
});

test('the inline-edit prompt marks the region and asks for its replacement only', () => {
  const prompt = buildInlineEditPrompt({
    path: 'src/a.ts', language: 'typescript', instruction: ' convert to async ', before: 'import x;\n', region: 'function f() {}\n', after: 'f();\n', selected: true,
  });
  assert.match(prompt, /Instruction: convert to async\n/);
  assert.ok(prompt.includes('<region>\nfunction f() {}\n\n</region>'));
  assert.ok(prompt.includes('<before>\nimport x;\n'));
  assert.match(prompt, /ONLY the full replacement/);
  const line = buildInlineEditPrompt({ path: 'a.py', language: 'python', instruction: 'add a main', before: '', region: '', after: '', selected: false });
  assert.match(line, /The cursor is on the line/);
});

test('the inline-edit reply keeps the fence body and matches the region\'s trailing newline', () => {
  assert.equal(parseInlineEditReply('Here:\n```ts\nasync function f() {}\n```\nDone.', 'function f() {}\n'), 'async function f() {}\n');
  assert.equal(parseInlineEditReply('\n  return 1;\n\n', '  return 0;'), '  return 1;');
  assert.equal(parseInlineEditReply('```\n  return 1;\n```', '  return 0;'), '  return 1;');
  assert.equal(parseInlineEditReply('<region>\nx\n</region>', 'y\n'), 'x\n');
});

test('agent prompts name the file and lines', () => {
  assert.match(agentPromptFor('explain', 'src/a.ts', 3, 9), /Explain the selected code in `src\/a\.ts` lines 3–9/);
  assert.match(agentPromptFor('tests', 'src/a.ts', 1, 2), /unit tests/);
});
