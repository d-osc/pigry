import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRestoreFromCommit, restoreButtonTitle, restoreConfirmMessage, restoreNeedsConfirm, restoreSourcePath, restoreToastMessage,
} from '../src/lib/fileRestore.ts';

const commit = { shortOid: 'da9e642', path: 'src/app.ts' };

test('the source path is the path in that commit, falling back to the current path', () => {
  assert.equal(restoreSourcePath('src/app.ts', commit), 'src/app.ts');
  assert.equal(restoreSourcePath('src/app.ts', { path: 'lib/old-app.ts' }), 'lib/old-app.ts');
  assert.equal(restoreSourcePath('src/app.ts', {}), 'src/app.ts');
  assert.equal(restoreSourcePath('src/app.ts', { path: '' }), 'src/app.ts');
});

test('a commit that deleted the file cannot be restored', () => {
  assert.equal(canRestoreFromCommit({}), true);
  assert.equal(canRestoreFromCommit({ deleted: false }), true);
  assert.equal(canRestoreFromCommit({ deleted: true }), false);
  assert.match(restoreButtonTitle('src/app.ts', { ...commit, deleted: true }), /deleted this file/);
});

test('restoring asks first only when work would be lost', () => {
  assert.equal(restoreNeedsConfirm({ unsavedEdits: false, workingChange: false }), false);
  assert.equal(restoreNeedsConfirm({ unsavedEdits: true, workingChange: false }), true);
  assert.equal(restoreNeedsConfirm({ unsavedEdits: false, workingChange: true }), true);
  assert.equal(restoreNeedsConfirm({ unsavedEdits: true, workingChange: true }), true);
});

test('the confirmation names the file, the commit and what is lost', () => {
  assert.equal(
    restoreConfirmMessage('src/app.ts', commit, { unsavedEdits: false, workingChange: true }),
    'Restore app.ts to da9e642? This replaces your uncommitted changes to this file.',
  );
  assert.match(restoreConfirmMessage('src/app.ts', commit, { unsavedEdits: true, workingChange: false }), /your unsaved edits to/);
  assert.match(restoreConfirmMessage('src/app.ts', commit, { unsavedEdits: true, workingChange: true }), /unsaved edits and uncommitted changes/);
});

test('the button title mentions the old name after a rename', () => {
  assert.match(restoreButtonTitle('src/app.ts', commit), /^Revert app\.ts to this version\. Only this file changes/);
  assert.match(restoreButtonTitle('src/app.ts', { shortOid: 'abc1234', path: 'lib/old-app.ts' }), /\(from lib\/old-app\.ts\)/);
});

test('the toast says which commit the file came from', () => {
  assert.equal(
    restoreToastMessage('src/app.ts', { sourcePath: 'src/app.ts', shortOid: 'da9e642', binary: false }),
    'Restored app.ts from commit da9e642. It is now an unstaged change.',
  );
  assert.equal(
    restoreToastMessage('src/app.ts', { sourcePath: 'lib/old-app.ts', shortOid: 'abc1234', binary: false }),
    'Restored app.ts from commit abc1234 (was lib/old-app.ts). It is now an unstaged change.',
  );
  assert.match(restoreToastMessage('logo.png', { sourcePath: 'logo.png', shortOid: 'abc1234', binary: true }), /^Restored binary file logo\.png/);
});
