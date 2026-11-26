import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnedFileTool, withCaller } from '../src/lib/ownedFiles.ts';

test('every editor tool family is told which agent is calling', () => {
  for (const name of ['diagram_write', 'design_edit', 'board_write', 'e2e_write', 'drawing_write', 'game_write', 'model_write', 'sheet_write', 'video_write', 'audio_write', 'read_image']) {
    assert.ok(isOwnedFileTool(name), name);
    assert.deepEqual(withCaller(name, { name: 'cat' }, 'illustrator'), { name: 'cat', agent: 'illustrator' }, name);
  }
});

test('other tools and calls without an agent are left alone', () => {
  const input = { path: 'a.txt' };
  assert.equal(withCaller('read_file', input, 'coder'), input);
  assert.equal(withCaller('drawing_write', input, undefined), input);
  assert.equal(isOwnedFileTool('shell'), false);
});
