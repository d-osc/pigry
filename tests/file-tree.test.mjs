import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, flattenVisibleTree } from '../src/lib/fileTree.ts';

test('large sibling folders preserve sorted paths without duplicate nodes', () => {
  const paths = Array.from({ length: 20000 }, (_, i) => `files/file-${String(i).padStart(5, '0')}.txt`);
  const nodes = buildTree(paths);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].children.length, 20000);
  assert.equal(nodes[0].children[19999].path, paths[19999]);
  assert.equal(flattenVisibleTree(nodes, new Set()).length, 1);
  const expanded = flattenVisibleTree(nodes, new Set(['files']));
  assert.equal(expanded.length, 20001);
  assert.equal(expanded[1].depth, 1);
});
