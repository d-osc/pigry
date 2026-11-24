import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBoardOps, boardToMarkdown, checkBoard, connectorGeometry, embedKey, findItem, itemsInRect, measureText, normalizeBoard,
  prepareEmbedSvg, renderBoardSvg, snapBox, summarizeBoard, templateBoard, topLevelIds, withChildren,
} from '../src/extensions/board/board.ts';

const retro = () => normalizeBoard({
  title: 'Sprint retro',
  items: [
    { type: 'section', id: 'good', text: 'Went well', color: 'green', notes: ['Fast reviews', 'Good demo', { text: 'Pairing', votes: 3 }] },
    { type: 'section', id: 'bad', text: 'To improve', color: 'orange', notes: ['Flaky tests'] },
    { type: 'connector', from: 'Flaky tests', to: 'Pairing', text: 'blocks' },
  ],
}).board;

test('sections lay their notes out in a grid and notes inherit the section colour', () => {
  const b = retro();
  const good = findItem(b, 'good');
  const kids = b.items.filter((i) => i.parent === 'good');
  assert.equal(kids.length, 3);
  assert.ok(kids.every((k) => k.color === 'green'));
  for (const kid of kids) {
    assert.ok(kid.x >= good.x && kid.y >= good.y + 40 && kid.x + kid.w <= good.x + good.w && kid.y + kid.h <= good.y + good.h, 'note inside its section');
  }
  const bad = findItem(b, 'bad');
  assert.ok(bad.x >= good.x + good.w, 'sections are placed side by side');
  assert.equal(new Set(b.items.map((i) => i.id)).size, b.items.length);
  assert.equal(findItem(b, 'Pairing').votes.length, 3);
});

test('connectors resolve by text and get a path between the items', () => {
  const b = retro();
  const c = b.items.find((i) => i.type === 'connector');
  assert.equal(c.from, b.items.find((i) => i.text === 'Flaky tests').id);
  const g = connectorGeometry(b, c);
  assert.match(g.path, /^M /);
  assert.equal(g.points.length, 2);
  const elbow = connectorGeometry(b, { ...c, route: 'elbow' });
  assert.equal(elbow.points.length, 4);
  assert.match(connectorGeometry(b, { ...c, route: 'curve' }).path, / C /);
});

test('normalize repairs sloppy input', () => {
  const { board, warnings } = normalizeBoard({ items: [
    { type: 'note', text: 'a', color: 'grey' }, { type: 'note', id: 'dup', text: 'b' }, { type: 'note', id: 'dup', text: 'c' },
    { type: 'wat', text: 'x' }, { type: 'arrow', from: 'a', to: 'ghost' }, { type: 'title', text: 'Big' }, 'junk', { text: 'plain', x: 5, y: 6 },
  ] });
  assert.equal(board.items[0].color, 'gray');
  assert.equal(new Set(board.items.map((i) => i.id)).size, board.items.length);
  assert.ok(warnings.some((w) => /Duplicate id/.test(w)));
  assert.ok(warnings.some((w) => /Unknown item type/.test(w)));
  assert.ok(warnings.some((w) => /dropped: unknown item/.test(w)));
  assert.equal(board.items.find((i) => i.text === 'Big').type, 'text');
  const plain = board.items.find((i) => i.text === 'plain');
  assert.deepEqual([plain.x, plain.y], [5, 6]);
  const loose = board.items.filter((i) => i.type === 'sticky' && i.text !== 'plain');
  assert.ok(loose.every((i) => i.w === 180), 'loose stickies get the default size');
  const boxes = loose.map((i) => `${i.x},${i.y}`);
  assert.equal(new Set(boxes).size, boxes.length, 'loose items do not stack on top of each other');
});

test('operations: add into a section, move with drop-in, connect, vote, group, arrange, remove', () => {
  const base = retro();
  const r = applyBoardOps(base, [
    { op: 'add', section: 'bad', text: 'Slow CI', color: 'red' },
    { op: 'add', type: 'sticky', text: 'Loose idea' },
    { op: 'connect', from: 'Slow CI', to: 'Flaky tests', label: 'causes', route: 'elbow', dashed: true },
    { op: 'vote', id: 'Slow CI', by: 'ann' },
    { op: 'vote', id: 'Slow CI', by: 'bob' },
    { op: 'vote', id: 'Slow CI', by: 'ann', remove: true },
    { op: 'update', id: 'Loose idea', text: 'Moved idea' },
    { op: 'remove', id: 'ghost' },
    { op: 'explode' },
  ], 'sa');
  assert.equal(r.errors.length, 2);
  const slow = findItem(r.board, 'Slow CI');
  assert.equal(slow.parent, 'bad');
  assert.equal(slow.author, 'sa');
  assert.deepEqual(slow.votes, ['bob']);
  const bad = findItem(r.board, 'bad');
  assert.ok(slow.x + slow.w <= bad.x + bad.w + 1 && slow.y + slow.h <= bad.y + bad.h + 1, 'new note sits inside the section');
  const conn = r.board.items.find((i) => i.text === 'causes');
  assert.equal(conn.route, 'elbow');
  assert.equal(base.items.length, retro().items.length, 'input board is not mutated');

  // moving a section drags its notes; dropping a loose note into a section adopts it
  const good = findItem(r.board, 'good');
  const note = r.board.items.find((i) => i.parent === 'good');
  const moved = applyBoardOps(r.board, [{ op: 'move', id: 'good', dx: 100, dy: 50 }]).board;
  const note2 = moved.items.find((i) => i.id === note.id);
  assert.equal(note2.x, note.x + 100);
  assert.equal(findItem(moved, 'good').x, good.x + 100);
  assert.deepEqual(withChildren(moved, ['good']).sort(), moved.items.filter((i) => i.id === 'good' || i.parent === 'good').map((i) => i.id).sort());
  assert.deepEqual(topLevelIds(moved, ['good', note.id]), ['good']);
  const loose = findItem(moved, 'Moved idea');
  const adopted = applyBoardOps(moved, [{ op: 'move', id: loose.id, x: findItem(moved, 'good').x + 30, y: findItem(moved, 'good').y + 60 }]).board;
  assert.equal(findItem(adopted, 'Moved idea').parent, 'good');

  const grouped = applyBoardOps(adopted, [{ op: 'group', ids: ['Fast reviews', 'Good demo'], section: 'Highlights', color: 'purple' }]);
  assert.equal(grouped.errors.length, 0);
  const hl = grouped.board.items.find((i) => i.type === 'section' && i.text === 'Highlights');
  assert.equal(findItem(grouped.board, 'Fast reviews').parent, hl.id);
  const arranged = applyBoardOps(grouped.board, [{ op: 'arrange', section: hl.id, columns: 1 }]).board;
  const [a, c] = arranged.items.filter((i) => i.parent === hl.id);
  assert.equal(a.x, c.x);
  assert.ok(c.y > a.y);

  const flaky = findItem(arranged, 'Flaky tests');
  const removed = applyBoardOps(arranged, [{ op: 'remove', id: 'Flaky tests' }]).board;
  assert.ok(removed.items.every((i) => i.type !== 'connector' || (i.from !== flaky.id && i.to !== flaky.id)));
  const dup = applyBoardOps(removed, [{ op: 'duplicate', id: 'good' }]).board;
  assert.equal(dup.items.filter((i) => i.type === 'section').length, removed.items.filter((i) => i.type === 'section').length + 1);
});

test('summary, Markdown and review', () => {
  const b = retro();
  const text = summarizeBoard(b);
  assert.match(text, /Section good "Went well"/);
  assert.match(text, /\[sticky green\] "Pairing" · 3 votes/);
  assert.match(text, /\[connector\] .* -> /);
  const md = boardToMarkdown(b);
  assert.match(md, /^# Sprint retro/);
  assert.match(md, /## Went well \(3\)/);
  assert.ok(md.indexOf('Pairing (3 votes)') < md.indexOf('Fast reviews'), 'most voted note first');
  assert.match(md, /## Relations\n\n- Flaky tests → Pairing \(blocks\)/);
  const messy = applyBoardOps(b, [{ op: 'add', type: 'sticky', text: '', x: 0, y: 0 }, { op: 'add', type: 'sticky', text: 'x'.repeat(200), x: 10, y: 10 }]).board;
  const issues = checkBoard(messy);
  assert.ok(issues.some((i) => /empty sticky/.test(i.message)));
  assert.ok(issues.some((i) => /long note/.test(i.message)));
  assert.ok(issues.some((i) => /not in any section/.test(i.message)));
  assert.ok(issues.some((i) => /overlaps/.test(i.message)));
});

test('SVG export is standalone, escaped and complete', () => {
  const { board } = normalizeBoard({ title: 'A & B', items: [
    { type: 'sticky', id: 'a', text: '<script>alert(1)</script> & "q"', x: 0, y: 0, votes: 2, author: 'sa' },
    { type: 'shape', id: 'b', shape: 'diamond', text: 'Decide?', x: 300, y: 0 },
    { type: 'connector', from: 'a', to: 'b', text: 'x & y', route: 'curve' },
    { type: 'pen', x: 0, y: 300, points: [[0, 0], [20, 10], [40, 0]] },
    { type: 'stamp', emoji: '🔥', x: 400, y: 300 },
    { type: 'section', text: 'Zone', x: -20, y: -60, w: 700, h: 500 },
  ] });
  const svg = renderBoardSvg(board);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('x &amp; y'));
  assert.match(svg, /feDropShadow/);
  assert.match(svg, /🔥/);
  assert.ok(svg.indexOf('Zone') < svg.indexOf('Decide?'), 'sections are drawn behind everything');
  const only = renderBoardSvg(board, { only: ['b'], padding: 0 });
  assert.match(only, /viewBox="300 0 170 130"/);
});

test('text measuring, snapping and selection helpers', () => {
  const m = measureText('one two three four five six', 16, false, 80);
  assert.ok(m.lines.length > 2);
  const near = snapBox({ x: 98, y: 22, w: 100, h: 50 }, [{ x: 200, y: 20, w: 100, h: 50 }], 6);
  assert.deepEqual([near.dx, near.dy, near.guides.length], [2, -2, 2]);
  assert.deepEqual(snapBox({ x: 0, y: 0, w: 10, h: 10 }, [{ x: 500, y: 500, w: 10, h: 10 }], 6).guides, []);
  const b = retro();
  const good = findItem(b, 'good');
  const hit = itemsInRect(b, { x: good.x, y: good.y, w: 50, h: 100 });
  assert.ok(hit.includes('good'));
});

test('templates produce valid boards', () => {
  for (const kind of ['blank', 'brainstorm', 'retro', 'journey', 'matrix']) {
    const b = templateBoard(kind, kind);
    assert.equal(b.items.filter((i) => i.type === 'section').length, { blank: 0, brainstorm: 3, retro: 3, journey: 4, matrix: 4 }[kind]);
    assert.deepEqual(checkBoard(b).filter((i) => i.severity === 'warn'), [], `${kind} template has no warnings`);
  }
});

test('embeds of diagrams and designs: aliases, ops, markdown and nested rendering', () => {
  const { board, warnings } = normalizeBoard({ items: [
    { type: 'diagram', ref: 'sa\\login-flow', text: 'Login flow', x: 0, y: 0 },
    { type: 'design', ref: 'uxui/home', node: 'Mobile — Home', x: 500, y: 0, w: 300, h: 500 },
    { type: 'embed', kind: 'design', ref: 'uxui/home', x: 900, y: 0 },
    { type: 'diagram', text: 'no reference' },
    { type: 'sticky', text: 'Discuss', x: 0, y: 400 },
    { type: 'connector', from: 'Discuss', to: 'Login flow' },
  ] });
  const embeds = board.items.filter((i) => i.type === 'embed');
  assert.equal(embeds.length, 3);
  assert.deepEqual(embeds[0].embed, { kind: 'diagram', ref: 'sa/login-flow' });
  assert.deepEqual(embeds[1].embed, { kind: 'design', ref: 'uxui/home', node: 'Mobile — Home' });
  assert.deepEqual([embeds[1].w, embeds[1].h], [300, 500]);
  assert.deepEqual([embeds[0].w, embeds[0].h], [380, 280], 'default embed size');
  assert.ok(warnings.some((w) => /embed without a diagram or design reference/.test(w)));
  assert.equal(board.items.find((i) => i.type === 'connector').to, embeds[0].id, 'connectors can point at an embed by its title');
  assert.match(summarizeBoard(board), /\[diagram embed\] sa\/login-flow "Login flow"/);
  assert.match(summarizeBoard(board), /\[design embed\] uxui\/home › Mobile — Home/);
  const md = boardToMarkdown(board);
  assert.match(md, /## Embedded/);
  assert.match(md, /- Diagram: Login flow \(`sa\/login-flow`\)/);

  const added = applyBoardOps(board, [{ op: 'add', type: 'design', ref: 'uxui/checkout', text: 'Checkout', x: 0, y: 700 }, { op: 'add', type: 'diagram' }]);
  assert.equal(added.errors.length, 1);
  assert.equal(added.board.items.filter((i) => i.type === 'embed').length, 4);
  const retargeted = applyBoardOps(added.board, [{ op: 'update', id: embeds[0].id, ref: 'sa/signup-flow' }]).board;
  assert.equal(retargeted.items.find((i) => i.id === embeds[0].id).embed.ref, 'sa/signup-flow');

  const content = prepareEmbedSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><defs><clipPath id="clip-a"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#clip-a)"><rect id="r" width="5" height="5"/></g></svg>', 'p1-');
  assert.deepEqual(content.viewBox, [0, 0, 200, 100]);
  assert.match(content.inner, /id="p1-clip-a"/);
  assert.match(content.inner, /url\(#p1-clip-a\)/);
  assert.equal(prepareEmbedSvg('<svg>no viewbox</svg>', 'x-'), null);

  const svg = renderBoardSvg(board, { embeds: { [embedKey(embeds[0].embed)]: content } });
  assert.match(svg, /DIAGRAM/);
  assert.match(svg, /DESIGN/);
  assert.match(svg, /viewBox="0 0 200 100" preserveAspectRatio/, 'the embedded content is nested in the card');
  assert.match(svg, /design not found: uxui\/home/, 'embeds without content show a placeholder');
});
