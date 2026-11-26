import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_ACCESS_LIMIT, movePinned, readQuickAccess, togglePinned } from '../src/lib/quickAccess.ts';

const storageOf = (value) => ({ getItem: () => value });

test('pinned menus are read defensively from storage, in order and without duplicates', () => {
  assert.deepEqual(readQuickAccess(storageOf('["explorer","drawing","explorer"]')), ['explorer', 'drawing']);
  assert.deepEqual(readQuickAccess(storageOf(null)), []);
  assert.deepEqual(readQuickAccess(storageOf('{oops')), []);
  assert.deepEqual(readQuickAccess(storageOf('{"a":1}')), []);
  assert.deepEqual(readQuickAccess(storageOf('[1, "", "board", null]')), ['board']);
  assert.deepEqual(readQuickAccess(undefined), []);
  const many = JSON.stringify(Array.from({ length: QUICK_ACCESS_LIMIT + 5 }, (_, i) => `m${i}`));
  assert.equal(readQuickAccess(storageOf(many)).length, QUICK_ACCESS_LIMIT);
});

test('toggling pins at the end and unpins in place', () => {
  assert.deepEqual(togglePinned([], 'explorer'), ['explorer']);
  assert.deepEqual(togglePinned(['explorer'], 'drawing'), ['explorer', 'drawing']);
  assert.deepEqual(togglePinned(['explorer', 'drawing', 'board'], 'drawing'), ['explorer', 'board']);
});

test('moving a pinned menu reorders it and clamps the position', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(movePinned(list, 'c', 0), ['c', 'a', 'b', 'd']);
  assert.deepEqual(movePinned(list, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(movePinned(list, 'b', 99), ['a', 'c', 'd', 'b']);
  assert.deepEqual(movePinned(list, 'b', -3), ['b', 'a', 'c', 'd']);
  assert.equal(movePinned(list, 'zzz', 0), list);
});
