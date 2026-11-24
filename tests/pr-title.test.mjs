import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestPrTitle } from '../src/lib/prTitle.ts';

test('one commit gives its message as the title', () => {
  assert.equal(suggestPrTitle('feat/x', ['  fix: preserve scroll position  ']), 'fix: preserve scroll position');
});

test('several commits, or none, turn the branch name into words', () => {
  assert.equal(suggestPrTitle('feat/command-menu', ['a', 'b']), 'Feat/command menu');
  assert.equal(suggestPrTitle('fix_lane_rendering', []), 'Fix lane rendering');
  assert.equal(suggestPrTitle('', []), '');
  assert.equal(suggestPrTitle('hotfix', ['']), 'Hotfix');
});
