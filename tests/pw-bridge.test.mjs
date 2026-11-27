import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PIGRY_PW_BRIDGE_TEST = '1';
const { cleanError, handle } = await import('../scripts/pw-bridge.mjs');

test('Playwright errors become one clean line', () => {
  assert.equal(cleanError(new Error('page.evaluate: ReferenceError: x is not defined\n    at eval (eval at evaluate)')), 'ReferenceError: x is not defined');
  assert.equal(cleanError(new Error('browserContext.addCookies: Cookie should have a url or a domain/path pair\nCall log:')), 'Cookie should have a url or a domain/path pair');
  assert.equal(cleanError('plain text'), 'plain text');
});

test('the protocol answers unknown actions and calls before "open" with an error', async () => {
  assert.deepEqual(await handle({ id: 1, action: 'fly' }), { id: 1, ok: false, error: 'unknown devtools action: fly' });
  const early = await handle({ id: 2, action: 'eval', js: '1' });
  assert.equal(early.ok, false);
  assert.match(early.error, /call browser_devtools with action "open" first/);
  // the init script may be registered before the first page (the runner does that)
  assert.deepEqual(await handle({ id: 3, action: 'init_script', js: 'window.a = 1' }), { id: 3, ok: true, result: 'init script registered (12 bytes)' });
});
