import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoChoice, blockContext, choiceFromName, choiceLabel, describeBlock, hasConflictMarkers, markerLines, parseConflicts, resolveText,
} from '../src/lib/conflicts.ts';

const FILE = [
  'const title = "Pigry";',
  '<<<<<<< HEAD',
  'const color = "red";',
  '=======',
  'const color = "green";',
  '>>>>>>> feature/green',
  'const size = 10;',
  '<<<<<<< HEAD',
  'export default title;',
  '=======',
  'export default title;',
  '>>>>>>> feature/green',
  '',
].join('\n');

test('a conflicted file is split into text and blocks with their labels and line numbers', () => {
  const p = parseConflicts(FILE);
  assert.equal(p.malformed, null);
  assert.equal(p.blocks.length, 2);
  const [a] = p.blocks;
  assert.deepEqual([a.startLine, a.endLine, a.currentLabel, a.incomingLabel], [2, 6, 'HEAD', 'feature/green']);
  assert.deepEqual(a.current, ['const color = "red";']);
  assert.deepEqual(a.incoming, ['const color = "green";']);
  assert.equal(a.base, null);
  assert.deepEqual(p.segments.map((s) => s.kind), ['text', 'conflict', 'text', 'conflict', 'text']);
  assert.ok(hasConflictMarkers(FILE));
  assert.ok(!hasConflictMarkers('no markers\n======= not alone\n'));
});

test('choices rebuild the file; blocks without a choice keep their markers exactly', () => {
  const p = parseConflicts(FILE);
  assert.equal(resolveText(p, {}), FILE, 'no choice → unchanged');
  const out = resolveText(p, { 0: { kind: 'incoming' }, 1: { kind: 'current' } });
  assert.equal(out, 'const title = "Pigry";\nconst color = "green";\nconst size = 10;\nexport default title;\n');
  assert.ok(!hasConflictMarkers(out));
  const partly = resolveText(p, { 0: { kind: 'both', order: 'incoming-first' } });
  assert.ok(partly.includes('const color = "green";\nconst color = "red";'));
  assert.equal(parseConflicts(partly).blocks.length, 1, 'the unresolved block is still there');
  assert.equal(resolveText(p, { 0: { kind: 'custom', text: 'const color = "purple";' }, 1: { kind: 'current' } }).split('\n')[1], 'const color = "purple";');
});

test('diff3 ancestors are read and allow safe automatic choices', () => {
  const diff3 = ['a', '<<<<<<< ours', 'x = 2', '||||||| base', 'x = 1', '=======', 'x = 1', '>>>>>>> theirs', 'b'].join('\n');
  const p = parseConflicts(diff3);
  const [blk] = p.blocks;
  assert.deepEqual(blk.base, ['x = 1']);
  assert.equal(blk.baseLabel, 'base');
  assert.deepEqual(autoChoice(blk)?.choice, { kind: 'current' }, 'only our side changed');
  assert.match(autoChoice(blk).reason, /Only your side/);
  assert.equal(resolveText(p, { 0: { kind: 'base' } }), 'a\nx = 1\nb');
  assert.deepEqual(markerLines(blk), diff3.split('\n').slice(1, 8));
  // same change on both sides
  assert.deepEqual(autoChoice(parseConflicts(FILE).blocks[1])?.choice, { kind: 'current' });
  // whitespace only
  assert.equal(autoChoice(parseConflicts('<<<<<<< a\n  x\n=======\nx\n\n>>>>>>> b').blocks[0])?.choice.kind, 'incoming');
  // a real conflict has no automatic answer
  assert.equal(autoChoice(parseConflicts(FILE).blocks[0]), null);
});

test('Windows line endings are kept', () => {
  const crlf = FILE.replace(/\n/g, '\r\n');
  const p = parseConflicts(crlf);
  assert.equal(p.eol, '\r\n');
  assert.equal(p.blocks.length, 2);
  const out = resolveText(p, { 0: { kind: 'current' }, 1: { kind: 'current' } });
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
});

test('an unfinished block is reported as malformed and its lines are kept as text', () => {
  const broken = 'a\n<<<<<<< HEAD\nb\n=======\nc\n';
  const p = parseConflicts(broken);
  assert.equal(p.blocks.length, 0);
  assert.match(p.malformed, /line 2 has no >>>>>>> end marker/);
  assert.equal(resolveText(p, {}), broken);
  assert.match(parseConflicts('<<<<<<< HEAD\nb\n').malformed, /======= separator/);
});

test('descriptions, context, labels and choice names', () => {
  const p = parseConflicts(FILE);
  assert.match(describeBlock(p.blocks[0]), /Both sides changed the same place/);
  assert.match(describeBlock(parseConflicts('<<<<<<< a\n=======\nx\n>>>>>>> b').blocks[0]), /Your side removed/);
  assert.deepEqual(blockContext(p, 0), { before: ['const title = "Pigry";'], after: ['const size = 10;'] });
  assert.equal(choiceLabel({ kind: 'both', order: 'current-first' }), 'Both (current first)');
  assert.deepEqual(choiceFromName('theirs'), { kind: 'incoming' });
  assert.deepEqual(choiceFromName('both-incoming-first'), { kind: 'both', order: 'incoming-first' });
  assert.equal(choiceFromName('custom'), null, 'custom needs text');
  assert.equal(choiceFromName('nope'), null);
});
