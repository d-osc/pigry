import test from 'node:test';
import assert from 'node:assert/strict';
import { ASK_REFUSAL, askTools, isAskTool } from '../src/lib/askMode.ts';

const tool = (name, out = 'ran') => ({ id: name, name, description: name, input_schema: {}, run: async () => out });

test('Ask mode keeps the read-only tools and drops everything that changes something', () => {
  for (const name of ['read_file', 'list_files', 'search_code', 'git_status', 'memory_recall', 'model_read', 'audio_analyze', 'video_preview', 'diagram_list', 'run_command']) assert.ok(isAskTool(name), name);
  for (const name of ['write_file', 'delete_file', 'rename_file', 'git_commit', 'git_push', 'memory', 'memory_forget', 'agent_message', 'model_write', 'audio_edit', 'audio_export', 'video_write', 'git_reset']) assert.ok(!isAskTool(name), name);
  const kept = askTools([tool('read_file'), tool('write_file'), tool('model_edit'), tool('list_files')]).map((t) => t.name);
  assert.deepEqual(kept, ['read_file', 'list_files']);
});

test('in Ask mode the shell only runs commands that are certainly read-only', async () => {
  const [shell] = askTools([tool('run_command', 'output')]);
  assert.equal(await shell.run({ command: 'git log --oneline' }), 'output');
  assert.equal(await shell.run({ command: 'ls src' }), 'output');
  for (const command of ['rm -rf src', 'git commit -am x', 'echo hi > a.txt', 'npm install', 'git log; rm a']) assert.equal(await shell.run({ command }), ASK_REFUSAL, command);
});
