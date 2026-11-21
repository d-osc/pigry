import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCall, isReadOnlyCommand, runInBatches } from '../src/lib/toolBatch.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('plain reading commands are read-only', () => {
  for (const command of [
    'ls -la src', 'cat package.json', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'grep -rn "foo" src',
    'grep -o foo file.txt', 'cd src && ls', 'git status | head -5', 'find . -name "*.ts"', 'git branch -a', 'git stash list', 'git tag',
    'sort names.txt', 'pwd',
  ]) assert.equal(isReadOnlyCommand(command), true, command);
});

test('anything that might write, chain or run something else is not', () => {
  for (const command of [
    '', 'npm install', 'git commit -m x', 'git add .', 'git checkout main', 'git branch -D x', 'git tag v1', 'git stash', 'git push',
    'git -C other status', 'git diff --output=out.txt', 'ls > files.txt', 'echo hi >> a.txt', 'cat a | tee b', 'ls; rm -rf x', 'ls && rm x',
    'ls &', 'echo $(rm x)', 'echo `rm x`', 'find . -delete', 'find . -exec rm {} ;', 'sort -o out.txt in.txt', 'tree -o out.txt', 'sed -i s/a/b/ f',
    'rm file', 'mv a b', 'node script.js', 'ls\nrm x', 'git config user.name x',
  ]) assert.equal(isReadOnlyCommand(command), false, command);
});

test('tool names: readers are read-only, changers are not, run_command depends on the command', () => {
  assert.equal(isReadOnlyCall('read_file', {}), true);
  assert.equal(isReadOnlyCall('search_code', {}), true);
  assert.equal(isReadOnlyCall('write_file', {}), false);
  assert.equal(isReadOnlyCall('commit', {}), false);
  assert.equal(isReadOnlyCall('run_command', { command: 'git status' }), true);
  assert.equal(isReadOnlyCall('run_command', { command: 'npm test' }), false);
});

test('consecutive read-only items run together; a change runs alone and in order', async () => {
  const log = [];
  const gates = new Map();
  const wait = (id) => new Promise((resolve) => gates.set(id, resolve));
  const items = [
    { id: 'r1', ro: true }, { id: 'r2', ro: true }, { id: 'w', ro: false }, { id: 'r3', ro: true },
  ];
  const run = runInBatches(items, (item) => item.ro, async (item) => {
    log.push(`start ${item.id}`);
    await wait(item.id);
    log.push(`end ${item.id}`);
    return item.id.toUpperCase();
  });
  await tick();
  assert.deepEqual(log, ['start r1', 'start r2'], 'both readers started at once');
  gates.get('r2')(); await tick();
  assert.deepEqual(log, ['start r1', 'start r2', 'end r2'], 'the writer waits for r1 too');
  gates.get('r1')(); await tick();
  assert.deepEqual(log.slice(3), ['end r1', 'start w']);
  gates.get('w')(); await tick();
  assert.equal(log.at(-1), 'start r3', 'r3 only starts after the change');
  gates.get('r3')();
  assert.deepEqual(await run, ['R1', 'R2', 'W', 'R3'], 'outputs keep the original order');
});

test('a failing read-only call is reported after the others in its batch finish', async () => {
  let finished = false;
  await assert.rejects(runInBatches([1, 2], () => true, async (n) => {
    if (n === 1) throw new Error('boom');
    await tick();
    finished = true;
    return 'ok';
  }), /boom/);
  assert.equal(finished, true);
});
