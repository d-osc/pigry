import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { avatarCandidates, githubLoginAvatar, gravatarUrl, noreplyAvatar, sha256Hex } from '../src/lib/avatarUrl.ts';

const nodeSha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('sha256Hex matches node:crypto across block boundaries and UTF-8', () => {
  for (const text of ['', 'abc', 'maya@acme.dev', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(200), 'สมชาย@ตัวอย่าง.ไทย']) {
    assert.equal(sha256Hex(text), nodeSha(text), `hash of ${text.length} chars`);
  }
});

test('GitHub noreply emails map to the account avatar without a lookup', () => {
  assert.equal(noreplyAvatar('583231+octocat@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/583231?s=40&v=4');
  assert.equal(noreplyAvatar('octocat@users.noreply.github.com', 64), 'https://github.com/octocat.png?size=64');
  assert.equal(noreplyAvatar('maya@acme.dev'), '');
});

test('logins become github.com avatars; invalid logins are dropped', () => {
  assert.equal(githubLoginAvatar('validation'), 'https://github.com/validation.png?size=40');
  assert.equal(githubLoginAvatar('app/dependabot'), 'https://github.com/dependabot.png?size=40');
  assert.equal(githubLoginAvatar('renovate[bot]'), 'https://github.com/renovate%5Bbot%5D.png?size=40');
  assert.equal(githubLoginAvatar('../etc'), '');
  assert.equal(githubLoginAvatar('Maya Chen'), '');
  assert.equal(githubLoginAvatar(''), '');
});

test('Gravatar only ever carries the hash of the normalized email', () => {
  const url = gravatarUrl('  Maya@Acme.dev ');
  assert.equal(url, `https://www.gravatar.com/avatar/${nodeSha('maya@acme.dev')}?s=80&d=404`);
  assert.ok(!url.includes('acme'));
  assert.equal(gravatarUrl('not-an-email'), '');
  assert.equal(gravatarUrl('1+octocat@users.noreply.github.com'), '');
});

test('candidates are ordered best first and de-duplicated', () => {
  const avatarMap = { 'maya@acme.dev': 'https://avatars.githubusercontent.com/u/1?v=4' };
  assert.deepEqual(avatarCandidates({ email: 'maya@acme.dev', avatarMap }), [
    'https://avatars.githubusercontent.com/u/1?v=4',
    gravatarUrl('maya@acme.dev'),
  ]);
  assert.deepEqual(avatarCandidates({ login: 'validation', avatarUrl: 'https://github.com/validation.png?size=40' }), [
    'https://github.com/validation.png?size=40',
  ]);
  assert.deepEqual(avatarCandidates({ avatarUrl: 'javascript:alert(1)' }), []);
  assert.deepEqual(avatarCandidates({}), []);
});
