import test from 'node:test';
import assert from 'node:assert/strict';
import { beginFanOut, endFanOut, exclusive, guardedChange, noteRead } from '../src/lib/writeGuard.ts';
import { clearImages, hasImages, queueImage, takeImages } from '../src/lib/pendingImages.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const BS = String.fromCharCode(92);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A fake worktree: path -> content. */
function disk(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    snapshot: async (path) => files.get(path.toLowerCase()) ?? null,
    write: (path, content) => async () => { files.set(path.toLowerCase(), content); return `wrote ${path}`; },
  };
}

test('outside a parallel run nothing is guarded', async () => {
  const d = disk();
  assert.equal(await guardedChange(['a.ts'], 'coder', d.write('a.ts', '1'), d.snapshot), 'wrote a.ts');
  assert.equal(await guardedChange(['a.ts'], 'qa', d.write('a.ts', '2'), d.snapshot), 'wrote a.ts');
  assert.equal(await exclusive('repo', 'qa', async () => 'ok'), 'ok');
});

test('a later writer queues behind the running write, then must re-read what changed', async () => {
  beginFanOut();
  try {
    const d = disk({ 'src/a.ts': 'v0' });
    const gate = deferred();
    let waitedFor = '';
    await noteRead('src/a.ts', 'coder', d.snapshot);
    await noteRead('src/a.ts', 'qa', d.snapshot);
    const first = guardedChange(['src/a.ts'], 'coder', async () => { await gate.promise; d.files.set('src/a.ts', 'v1'); return 'wrote coder'; }, d.snapshot);
    await tick();
    let secondDone = false;
    const second = guardedChange(['./SRC' + BS + 'a.ts'], 'qa', d.write('src/a.ts', 'qa'), d.snapshot, { onWait: (w) => { waitedFor = w; } }).then((r) => { secondDone = true; return r; });
    await tick();
    assert.equal(secondDone, false, 'qa is paused while coder is writing');
    gate.resolve();
    assert.equal(await first, 'wrote coder');
    assert.match(await second, /read_file .* again/, 'qa goes next but its picture of the file is stale');
    assert.equal(waitedFor, 'coder');
    assert.equal(d.files.get('src/a.ts'), 'v1', 'nothing of qa was written');
    await noteRead('src/a.ts', 'qa', d.snapshot);
    assert.equal(await guardedChange(['src/a.ts'], 'qa', d.write('src/a.ts', 'v2'), d.snapshot), 'wrote src/a.ts');
    assert.equal(await guardedChange(['src/a.ts'], 'qa', d.write('src/a.ts', 'v3'), d.snapshot), 'wrote src/a.ts', 'own writes keep the agent current');
    assert.match(await guardedChange(['src/a.ts'], 'coder', d.write('src/a.ts', 'x'), d.snapshot), /read_file/, 'coder is now the stale one');
  } finally { endFanOut(); }
});

test('a change made outside the guard (a shell command) is caught by the content check', async () => {
  beginFanOut();
  try {
    const d = disk({ 'f.ts': 'one' });
    await noteRead('f.ts', 'a', d.snapshot);
    d.files.set('f.ts', 'edited by sed');
    assert.match(await guardedChange(['f.ts'], 'a', d.write('f.ts', 'two'), d.snapshot), /read_file/);
    assert.equal(d.files.get('f.ts'), 'edited by sed');
  } finally { endFanOut(); }
});

test('three agents on one file go one at a time in arrival order', async () => {
  beginFanOut();
  try {
    const d = disk({ 'f.ts': '0' });
    const order = [];
    const gate = deferred();
    for (const who of ['a', 'b', 'c']) await noteRead('f.ts', who, d.snapshot);
    const a = guardedChange(['f.ts'], 'a', async () => { order.push('a start'); await gate.promise; order.push('a end'); d.files.set('f.ts', 'a'); return 'ok'; }, d.snapshot);
    await tick();
    const b = guardedChange(['f.ts'], 'b', async () => { order.push('b'); return 'ok'; }, d.snapshot);
    const c = guardedChange(['f.ts'], 'c', async () => { order.push('c'); return 'ok'; }, d.snapshot);
    await tick();
    assert.deepEqual(order, ['a start']);
    gate.resolve();
    const results = await Promise.all([a, b, c]);
    assert.deepEqual(order, ['a start', 'a end'], 'b and c were stale after a wrote, so they re-read instead of overwriting');
    assert.match(results[1], /read_file/);
    assert.match(results[2], /read_file/);
  } finally { endFanOut(); }
});

test('delete and rename go through the same per-file queues', async () => {
  beginFanOut();
  try {
    const d = disk({ 'old.ts': 'x' });
    const gate = deferred();
    await noteRead('old.ts', 'a', d.snapshot);
    await noteRead('old.ts', 'b', d.snapshot);
    const writing = guardedChange(['old.ts'], 'a', async () => { await gate.promise; d.files.set('old.ts', 'y'); return 'wrote'; }, d.snapshot);
    await tick();
    let renamed = false;
    const rename = guardedChange(['old.ts', 'new.ts'], 'b', async () => { renamed = true; return 'renamed'; }, d.snapshot);
    await tick();
    assert.equal(renamed, false, 'rename waits for the write on old.ts');
    gate.resolve();
    await writing;
    assert.match(await rename, /read_file old.ts/, 'and must re-read the file it would move');
    assert.equal(renamed, false);
  } finally { endFanOut(); }
});

test('different files never wait on each other', async () => {
  beginFanOut();
  try {
    const d = disk();
    const gate = deferred();
    const slow = guardedChange(['x.ts'], 'a', async () => { await gate.promise; return 'ok'; }, d.snapshot);
    assert.equal(await guardedChange(['y.ts'], 'b', async () => 'ok', d.snapshot), 'ok');
    gate.resolve();
    await slow;
  } finally { endFanOut(); }
});

test('two multi-file changes in opposite order cannot deadlock', async () => {
  beginFanOut();
  try {
    const d = disk();
    const results = await Promise.all([
      guardedChange(['a.ts', 'b.ts'], 'one', async () => { await tick(); return 'ok'; }, d.snapshot),
      guardedChange(['b.ts', 'a.ts'], 'two', async () => 'ok', d.snapshot),
    ]);
    assert.equal(results[0], 'ok');
    assert.match(results[1], /ok|read_file/);
  } finally { endFanOut(); }
});

test('an aborted waiter drops out and the queue keeps moving', async () => {
  beginFanOut();
  try {
    const d = disk();
    const gate = deferred();
    const a = guardedChange(['z.ts'], 'a', async () => { await gate.promise; return 'ok'; }, d.snapshot);
    await tick();
    const controller = new AbortController();
    const b = guardedChange(['z.ts'], 'b', async () => 'ok', d.snapshot, { signal: controller.signal });
    const c = guardedChange(['z.ts'], 'c', d.write('z.ts', 'from c'), d.snapshot);
    await tick();
    controller.abort(new Error('stopped'));
    await assert.rejects(b, /stopped/);
    gate.resolve();
    await a;
    assert.match(await c, /ok|wrote|read_file/);
  } finally { endFanOut(); }
});

test('a failed change does not make others re-read', async () => {
  beginFanOut();
  try {
    const d = disk();
    assert.equal(await guardedChange(['e.ts'], 'a', async () => 'error: disk full', d.snapshot), 'error: disk full');
    assert.equal(await guardedChange(['e.ts'], 'b', d.write('e.ts', 'b'), d.snapshot), 'wrote e.ts');
  } finally { endFanOut(); }
});

test('repo-wide operations (shell, stage, commit) run one at a time in order', async () => {
  beginFanOut();
  try {
    const order = [];
    const gate = deferred();
    const first = exclusive('repo', 'a', async () => { order.push('a start'); await gate.promise; order.push('a end'); return 'a'; });
    await tick();
    let waitedFor = '';
    const second = exclusive('repo', 'b', async () => { order.push('b'); return 'b'; }, { onWait: (w) => { waitedFor = w; } });
    await tick();
    assert.deepEqual(order, ['a start']);
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
    assert.deepEqual(order, ['a start', 'a end', 'b']);
    assert.equal(waitedFor, 'a');
  } finally { endFanOut(); }
});

test('queued images stay with the agent that asked for them', () => {
  queueImage('data:a', 'coder');
  queueImage('data:b', 'qa');
  assert.equal(hasImages('coder'), true);
  assert.deepEqual(takeImages('coder'), ['data:a']);
  assert.equal(hasImages('coder'), false);
  assert.equal(hasImages('qa'), true, 'qa still has its own image');
  clearImages('qa');
  assert.equal(hasImages('qa'), false);
});
