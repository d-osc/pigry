import test from 'node:test';
import assert from 'node:assert/strict';
import { changesSnapshot, codeKey, describeCode, diffSnapshot, fileSnapshot, fitCodeSize, normalizeCodeRef } from '../src/lib/codeSnap.ts';
import { normalizeBoard, renderBoardSvg, summarizeBoard, boardToMarkdown, applyBoardOps } from '../src/extensions/board/board.ts';

test('code references are read from loose input', () => {
  assert.deepEqual(normalizeCodeRef({ path: 'src' + String.fromCharCode(92) + 'App.tsx', start: 1, end: 10 }), { kind: 'file', path: 'src/App.tsx', start: 1, end: 10 });
  assert.deepEqual(normalizeCodeRef({ file: './a.ts', lines: '5-9' }), { kind: 'file', path: 'a.ts', start: 5, end: 9 });
  assert.deepEqual(normalizeCodeRef({ path: 'a.ts', start: 4 }), { kind: 'file', path: 'a.ts', start: 4, end: 23 }, 'a lone start shows 20 lines');
  assert.deepEqual(normalizeCodeRef({ path: 'a.ts', rev: 'abc123' }), { kind: 'file', path: 'a.ts', rev: 'abc123' });
  assert.deepEqual(normalizeCodeRef({ base: 'main', head: 'feat', path: 'x.ts' }), { kind: 'compare', base: 'main', head: 'feat', path: 'x.ts' });
  assert.deepEqual(normalizeCodeRef({ commit: '1a2b3c4' }), { kind: 'commit', oid: '1a2b3c4' });
  assert.equal(normalizeCodeRef({ text: 'nothing' }), null);
  assert.equal(normalizeCodeRef({ base: 'main' }, 'compare'), null);
  assert.equal(describeCode({ kind: 'file', path: 'a.ts', start: 1, end: 10 }), 'a.ts:1-10');
  assert.equal(describeCode({ kind: 'compare', base: 'main', head: 'dev' }), 'main…dev');
  assert.notEqual(codeKey({ kind: 'file', path: 'a', start: 1 }), codeKey({ kind: 'file', path: 'a', start: 2 }));
});

test('file snapshots keep real line numbers and clamp the range', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const snap = fileSnapshot('a.ts', text, 5, 8);
  assert.deepEqual(snap.lines.map((l) => l.n), ['5', '6', '7', '8']);
  assert.equal(snap.lines[0].t, 'line 5');
  assert.match(snap.subtitle, /lines 5-8 of 30/);
  assert.equal(fileSnapshot('a.ts', text, 28, 99).lines.length, 3);
  assert.equal(fileSnapshot('a.ts', text).lines.length, 30);
  assert.equal(fileSnapshot('a.ts', '').lines.length, 0);
});

test('diff snapshots show hunks with context and numbering', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
  const after = before.replace('l10', 'ten').replace('l18\n', 'l18\nnew\n');
  const snap = diffSnapshot('a.ts', before, after, 'main … dev');
  const kinds = snap.lines.map((l) => l.k);
  assert.equal(kinds.filter((k) => k === 'hunk').length, 2);
  assert.deepEqual(snap.lines.filter((l) => l.k === 'del').map((l) => l.t), ['l10']);
  assert.deepEqual(snap.lines.filter((l) => l.k === 'add').map((l) => l.t), ['ten', 'new']);
  assert.match(snap.subtitle, /\+2 −1/);
  assert.ok(snap.lines.length < 20, 'unchanged lines far from a change are left out');
  assert.match(diffSnapshot('a', 'x\n', 'x\n').subtitle, /no changes/);
});

test('change lists, sizes and board integration', () => {
  const list = changesSnapshot('1a2b3c4 Fix', 'Ann · 2 files', ['Fix'], [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }, { path: 'b.ts', status: 'A', additions: 9, deletions: 0 }]);
  assert.equal(list.lines.filter((l) => l.k === 'file').length, 2);
  const size = fitCodeSize(fileSnapshot('a.ts', 'a\nb\nc\nd\ne\nf\n'));
  assert.ok(size.w >= 380 && size.h >= 100);

  const { board, warnings } = normalizeBoard({ items: [
    { type: 'code', path: 'src/App.tsx', start: 1, end: 10, text: 'App header' },
    { type: 'compare', base: 'main', head: 'feat/x' },
    { type: 'commit', oid: '1a2b3c4', path: 'src/App.tsx' },
    { type: 'file', path: 'README.md' },
    { type: 'code', text: 'no source' },
  ] });
  const codes = board.items.filter((i) => i.type === 'code');
  assert.equal(codes.length, 4);
  assert.deepEqual(codes.map((c) => c.code.kind), ['file', 'compare', 'commit', 'file']);
  assert.ok(warnings.some((w) => /code item without/.test(w)));
  assert.match(summarizeBoard(board), /\[code file\] src\/App\.tsx:1-10 "App header"/);
  assert.match(boardToMarkdown(board), /## Code/);

  const updated = applyBoardOps(board, [{ op: 'update', id: codes[0].id, start: 3, end: 6 }]).board.items.find((i) => i.id === codes[0].id);
  assert.equal(updated.code.start, 3);
  assert.equal(updated.code.end, 6);

  const key = codeKey(codes[0].code);
  const svg = renderBoardSvg(board, { codes: { [key]: fileSnapshot('src/App.tsx', 'const a = 1;\nconst b = 2;\n', 1, 2) } });
  assert.match(svg, /FILE/);
  assert.match(svg, /const a = 1;/);
  assert.match(svg, /COMPARE/);
  assert.match(svg, /loading…/, 'cards without a loaded snapshot show a placeholder');
});
