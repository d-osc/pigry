import test from 'node:test';
import assert from 'node:assert/strict';
import { beginFanOut, claimWrite, endFanOut } from '../src/lib/writeGuard.ts';

test('outside a parallel run nothing is guarded', () => {
  assert.equal(claimWrite('src/a.ts', 'coder'), null);
  assert.equal(claimWrite('src/a.ts', 'qa'), null);
});

test('during a fan-out the first agent owns a file and others are refused', () => {
  beginFanOut();
  try {
    assert.equal(claimWrite('src/a.ts', 'coder'), null);
    assert.equal(claimWrite('src/a.ts', 'coder'), null, 'the owner can write again');
    assert.match(claimWrite('./SRC' + String.fromCharCode(92) + 'a.ts', 'qa'), /already written by @coder/, 'paths are compared normalized');
    assert.equal(claimWrite('src/b.ts', 'qa'), null, 'other files stay free');
  } finally { endFanOut(); }
  assert.equal(claimWrite('src/a.ts', 'qa'), null, 'claims are forgotten when the run ends');
});

test('nested fan-outs keep the claims until the outermost one ends', () => {
  beginFanOut(); beginFanOut();
  claimWrite('x.ts', 'a');
  endFanOut();
  assert.match(claimWrite('x.ts', 'b'), /already written/);
  endFanOut();
  assert.equal(claimWrite('x.ts', 'b'), null);
});
