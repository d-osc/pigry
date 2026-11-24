import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutePath, allPaths, baseName, isFolderPath, joinPath, parentDir, uniquePastePath } from '../src/lib/fileClipboard.ts';

test('names, folders and joins', () => {
  assert.equal(baseName('src/app/a.ts'), 'a.ts');
  assert.equal(baseName('a.ts'), 'a.ts');
  assert.equal(parentDir('src/app/a.ts'), 'src/app');
  assert.equal(parentDir('a.ts'), '');
  assert.equal(joinPath('', 'a.ts'), 'a.ts');
  assert.equal(joinPath('src', 'a.ts'), 'src/a.ts');
});

test('a folder is a path with files below it', () => {
  const entries = ['src/app/a.ts', 'src/b.ts', 'README.md'];
  assert.equal(isFolderPath(entries, 'src'), true);
  assert.equal(isFolderPath(entries, 'src/app'), true);
  assert.equal(isFolderPath(entries, 'src/b.ts'), false);
  assert.equal(isFolderPath(entries, 'sr'), false, 'a shared prefix is not a parent');
  assert.deepEqual([...allPaths(entries)].sort(), ['README.md', 'src', 'src/app', 'src/app/a.ts', 'src/b.ts']);
});

test('a pasted copy keeps its name when free and otherwise gets "copy" like VS Code', () => {
  const taken = new Set(['src/a.ts', 'src/a copy.ts', 'src/.env', 'lib/a.ts']);
  const exists = (path) => taken.has(path);
  assert.equal(uniquePastePath('src/a.ts', 'other', exists), 'other/a.ts', 'a different folder keeps the name');
  assert.equal(uniquePastePath('src/a.ts', 'src', exists), 'src/a copy 2.ts', 'same folder: copy is taken, so copy 2');
  assert.equal(uniquePastePath('lib/a.ts', 'src', exists), 'src/a copy 2.ts');
  assert.equal(uniquePastePath('src/b.ts', 'src', exists), 'src/b.ts');
  assert.equal(uniquePastePath('x/.env', 'src', exists), 'src/.env copy', 'dot files have no extension');
  assert.equal(uniquePastePath('src/a.ts', '', exists), 'a.ts', 'the root');
});

test('absolute paths use the separator of the repository root', () => {
  assert.equal(absolutePath('C:\\work\\app', 'src/a.ts'), 'C:\\work\\app\\src\\a.ts');
  assert.equal(absolutePath('C:\\work\\app\\', 'src/a.ts'), 'C:\\work\\app\\src\\a.ts');
  assert.equal(absolutePath('/home/me/app', 'src/a.ts'), '/home/me/app/src/a.ts');
  assert.equal(absolutePath('/home/me/app/', ''), '/home/me/app');
  assert.equal(absolutePath('', 'src/a.ts'), 'src/a.ts');
});
