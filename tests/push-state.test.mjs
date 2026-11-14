import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePushSort, canPushPreview, pushErrorMessage } from '../src/screens/push-commits/pushState.ts';

test('new branch can be published without an upstream', () => {
  assert.equal(canPushPreview(null, 0), true);
  assert.equal(canPushPreview(null, 5), true);
});
test('tracked branch requires unpushed commits', () => {
  assert.equal(canPushPreview('origin/main', 0), false);
  assert.equal(canPushPreview('origin/main', 1), true);
});
test('sort preference survives current and legacy storage formats', () => {
  for (const value of ['asc', '"asc"']) assert.equal(parsePushSort(value), 'asc');
  for (const value of ['desc', '"desc"', null, 'broken']) assert.equal(parsePushSort(value), 'desc');
});
test('backend failures retain actionable error text', () => {
  assert.equal(pushErrorMessage(new Error('Authentication failed')), 'Authentication failed');
  assert.equal(pushErrorMessage('No remote configured'), 'No remote configured');
  assert.match(pushErrorMessage(undefined), /Check the repository/);
});
