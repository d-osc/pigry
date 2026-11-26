import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisabledMenus } from '../src/lib/builtinExtensions.ts';
import { workspaceNav } from '../src/app/navigation.ts';

const storageOf = (value) => ({ getItem: () => value });

test('the menus that are built-in extensions are the ones that left the Workspace group', () => {
  assert.deepEqual(workspaceNav.filter((item) => item.group === 'extension').map((item) => item.id), ['diagram', 'design', 'drawing', 'model3d', 'gameengine', 'videoeditor', 'audioeditor', 'sheet', 'docs', 'slides', 'notes', 'board', 'e2e', 'reports']);
});

test('the switched-off menus are read defensively from storage', () => {
  assert.deepEqual([...readDisabledMenus(storageOf('["board","e2e"]'))], ['board', 'e2e']);
  assert.deepEqual([...readDisabledMenus(storageOf(null))], []);
  assert.deepEqual([...readDisabledMenus(storageOf('{broken'))], []);
  assert.deepEqual([...readDisabledMenus(storageOf('{"a":1}'))], []);
  assert.deepEqual([...readDisabledMenus(storageOf('["board",3,null]'))], ['board']);
  assert.deepEqual([...readDisabledMenus(undefined)], []);
});
