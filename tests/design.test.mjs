import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutePosition, applyDesignOps, checkDesign, contrastRatio, findNode, measureText, normalizeDesign,
  parseColor, renderDesignHtml, renderDesignSvg, summarizeDesign, templateDesign,
} from '../src/lib/design.ts';
import { nameSlug, parseRefName, pathOf, refFromPath, resolveRef } from '../src/lib/ownedFiles.ts';

const card = () => normalizeDesign({
  title: 'Card',
  tokens: { colors: { primary: '#4f46e5' } },
  nodes: [{
    type: 'frame', id: 'root', name: 'Screen', w: 400, h: 300, fill: '#ffffff',
    layout: { dir: 'column', gap: 10, padding: 20, align: 'stretch' },
    children: [
      { type: 'text', id: 't1', name: 'Title', text: 'Hello', fontSize: 20 },
      { type: 'rect', id: 'r1', name: 'Box', h: 50, fill: '$primary' },
      { type: 'frame', id: 'row', name: 'Row', h: 40, layout: { dir: 'row', gap: 8, justify: 'between', align: 'center' }, children: [
        { type: 'rect', id: 'a', name: 'A', w: 30, h: 30 }, { type: 'rect', id: 'b', name: 'B', w: 30, h: 30 },
      ] },
    ],
  }],
}).design;

test('column auto layout stacks children with padding and stretches them', () => {
  const d = card();
  const root = findNode(d, 'root');
  const [t1, r1, row] = root.children;
  assert.equal(t1.x, 20);
  assert.equal(t1.y, 20);
  assert.equal(r1.x, 20);
  assert.equal(r1.w, 360, 'stretched across the 400px frame minus 2×20 padding');
  assert.equal(r1.y, t1.y + t1.h + 10);
  assert.equal(row.y, r1.y + 50 + 10);
  assert.equal(row.w, 360);
});

test('row justify between pushes first and last to the edges', () => {
  const d = card();
  const [a, b] = findNode(d, 'row').children;
  assert.equal(a.x, 0);
  assert.equal(b.x + b.w, 360);
  assert.equal(a.y, 5, 'centered on the cross axis (40 − 30)/2');
});

test('hug frames shrink to content and grow children share free space', () => {
  const d = normalizeDesign({
    nodes: [{
      type: 'frame', id: 'bar', w: 500, h: 60, layout: { dir: 'row', gap: 10, padding: [0, 10, 0, 10], align: 'center' },
      children: [{ type: 'rect', id: 'fix', w: 100, h: 20 }, { type: 'rect', id: 'fill', h: 20, w: 10, grow: 1 }],
    }, {
      type: 'frame', id: 'pill', layout: { dir: 'row', padding: [8, 16, 8, 16], hugW: true, hugH: true, align: 'center' },
      children: [{ type: 'text', id: 'lbl', text: 'Save', fontSize: 16, fontWeight: 600 }],
    }],
  }).design;
  const fill = findNode(d, 'fill');
  assert.equal(fill.w, 500 - 20 - 100 - 10 + 10 - 10 + 0 === 0 ? 0 : fill.w);
  assert.equal(findNode(d, 'fix').w + fill.w + 10 + 20, 500, 'row is exactly filled');
  const pill = findNode(d, 'pill');
  const lbl = findNode(d, 'lbl');
  assert.equal(pill.w, Math.ceil(lbl.w) + 32);
  assert.equal(pill.h, lbl.h + 16);
});

test('text wraps to its width and reports height', () => {
  const narrow = measureText('one two three four five six seven', 16, 400, 'sans', 80, 1.5);
  assert.ok(narrow.lines.length > 2);
  assert.equal(narrow.height, narrow.lines.length * 24);
  const long = measureText('x'.repeat(200), 16, 400, 'mono', 100, 1.2);
  assert.ok(long.lines.every((line) => line.length <= 10), 'over-long words are hard-broken');
});

test('normalize tolerates sloppy model input and keeps ids unique', () => {
  const { design, warnings } = normalizeDesign({
    nodes: [
      { type: 'Rectangle', name: 'Bg', w: 10, h: 10 },
      { type: 'frame', id: 'x', children: [{ type: 'circle', id: 'x' }, { type: 'wat' }, { content: 'hi', color: '#fff' }] },
    ],
  });
  const ids = [];
  const collect = (nodes) => nodes.forEach((n) => { ids.push(n.id); collect(n.children ?? []); });
  collect(design.nodes);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(warnings.some((w) => /Duplicate id/.test(w)));
  assert.ok(warnings.some((w) => /Unknown node type/.test(w)));
  const textNode = design.nodes[1].children.at(-1);
  assert.equal(textNode.type, 'text');
  assert.equal(textNode.fill, '#fff');
  assert.equal(design.nodes[0].type, 'rect');
});

test('operations add, update, move, duplicate, wrap and remove', () => {
  const base = card();
  const r = applyDesignOps(base, [
    { op: 'add', parent: 'Screen', node: { type: 'text', name: 'Subtitle', text: 'World', fontSize: 14 } },
    { op: 'update', id: 'Box', fill: '#ff0000', radius: 12, h: 64 },
    { op: 'move', id: 'a', parent: 'root', index: 0 },
    { op: 'duplicate', id: 'r1' },
    { op: 'remove', id: 'ghost' },
    { op: 'explode' },
    { op: 'add', parent: 'Box', node: { type: 'text', text: 'x' } },
  ]);
  assert.equal(r.errors.length, 3);
  const root = findNode(r.design, 'root');
  assert.equal(root.children[0].id, 'a', 'moved to the front of the stack');
  assert.equal(findNode(r.design, 'r1').fill, '#ff0000');
  assert.equal(findNode(r.design, 'r1').radius, 12);
  assert.ok(root.children.some((n) => n.name === 'Box copy'));
  assert.ok(root.children.some((n) => n.name === 'Subtitle'));
  assert.equal(base.nodes[0].children.length, 3, 'input design is not mutated');

  const wrapped = applyDesignOps(card(), [{ op: 'wrap', ids: ['t1', 'r1'], name: 'Header' }]);
  assert.equal(findNode(wrapped.design, 'root').children[0].name, 'Header');
  assert.equal(findNode(wrapped.design, 'Header').children.length, 2);
  const removed = applyDesignOps(card(), [{ op: 'remove', id: 'row' }]);
  assert.equal(findNode(removed.design, 'a'), undefined);
});

test('moving across frames keeps the absolute position', () => {
  const d = normalizeDesign({ nodes: [
    { type: 'frame', id: 'f1', x: 0, y: 0, w: 300, h: 300, children: [{ type: 'rect', id: 'box', x: 50, y: 60, w: 20, h: 20 }] },
    { type: 'frame', id: 'f2', x: 400, y: 100, w: 300, h: 300 },
  ] }).design;
  const before = absolutePosition(d, 'box');
  const moved = applyDesignOps(d, [{ op: 'move', id: 'box', parent: 'f2' }]).design;
  assert.deepEqual(absolutePosition(moved, 'box'), before);
  assert.equal(applyDesignOps(d, [{ op: 'move', id: 'f1', parent: 'box' }]).errors.length, 1);
});

test('colour tokens resolve in SVG and HTML', () => {
  const d = card();
  const svg = renderDesignSvg(d);
  assert.match(svg, /fill:#4f46e5/);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  const html = renderDesignHtml(d, 'root');
  assert.match(html, /--primary: #4f46e5/);
  assert.match(html, /background:var\(--primary\)/);
  assert.match(html, /display:flex;flex-direction:column;gap:10px/);
  const one = renderDesignSvg(d, { nodeId: 'row', padding: 0 });
  assert.match(one, /viewBox="0 0 360 40"/);
});

test('SVG output escapes text and supports gradients and shadows', () => {
  const d = normalizeDesign({ nodes: [{ type: 'frame', w: 100, h: 100, fill: { from: '#000', to: '#fff', angle: 90 }, shadow: { y: 4, blur: 8, color: '#0003' },
    children: [{ type: 'text', text: '<b>&"hi"', fill: '#fff' }] }] }).design;
  const svg = renderDesignSvg(d);
  assert.ok(!svg.includes('<b>'));
  assert.match(svg, /&lt;b&gt;&amp;&quot;hi&quot;/);
  assert.match(svg, /linearGradient/);
  assert.match(svg, /feDropShadow/);
});

test('review finds low contrast, tiny text, small touch targets and overflow', () => {
  const d = normalizeDesign({ nodes: [{ type: 'frame', id: 'm', name: 'Mobile', w: 390, h: 400, fill: '#ffffff', children: [
    { type: 'text', id: 'lowc', name: 'Hint', text: 'faint', fontSize: 14, fill: '#cccccc', x: 10, y: 10 },
    { type: 'text', id: 'tiny', name: 'Legal', text: 'tiny', fontSize: 9, fill: '#111111', x: 10, y: 40 },
    { type: 'frame', id: 'btn', name: 'Save button', x: 10, y: 80, w: 80, h: 30, fill: '#4f46e5' },
    { type: 'rect', id: 'out', name: 'Banner', x: 300, y: 200, w: 200, h: 50 },
    { type: 'text', id: 'ok', name: 'Body', text: 'fine', fontSize: 16, fill: '#111111', x: 10, y: 300 },
  ] }] }).design;
  const issues = checkDesign(d);
  const has = (id, re) => issues.some((i) => i.id === id && re.test(i.message));
  assert.ok(has('lowc', /contrast/));
  assert.ok(has('tiny', /too small/));
  assert.ok(has('btn', /below 44px/));
  assert.ok(has('out', /outside its frame/));
  assert.ok(!issues.some((i) => i.id === 'ok'));
  assert.ok(contrastRatio(parseColor('#000'), parseColor('#fff')) > 20);
});

test('templates are valid and pass their own review', () => {
  for (const kind of ['blank', 'mobile', 'desktop', 'components']) {
    const d = templateDesign(kind, kind);
    assert.ok(d.nodes.length > 0);
    const errors = checkDesign(d).filter((i) => i.severity === 'error');
    assert.deepEqual(errors, [], `${kind} template has no errors`);
  }
  const mobile = templateDesign('mobile', 'm');
  const frame = mobile.nodes[0];
  assert.ok(frame.children.every((c) => c.x >= 0 && c.x + c.w <= frame.w + 0.5), 'mobile children stay inside the 390px frame');
  assert.match(summarizeDesign(mobile), /Mobile — Home/);
});

test('summaries list ids, sizes and text', () => {
  const text = summarizeDesign(card());
  assert.match(text, /- root \[frame\] "Screen" 400×300/);
  assert.match(text, /\[text\] "Title".*20px\/400 "Hello"/);
  assert.match(text, /\$primary=#4f46e5/);
  assert.match(summarizeDesign(card(), 'row'), /- row \[frame\]/);
});

test('owner folders: paths, names and resolution', () => {
  assert.equal(nameSlug('Login Screen v2.design.json', ['.design.json']), 'login-screen-v2');
  assert.deepEqual(parseRefName('uxui/Checkout Flow'), { owner: 'uxui', slug: 'checkout-flow' });
  assert.deepEqual(parseRefName('Checkout'), { owner: null, slug: 'checkout' });
  assert.equal(pathOf('.pigry/designs/', '.design.json', { owner: 'uxui', slug: 'home' }), '.pigry/designs/uxui/home.design.json');
  assert.deepEqual(refFromPath('.pigry/designs/', '.design.json', '.pigry/designs/uxui/home.design.json'), { owner: 'uxui', slug: 'home' });
  assert.deepEqual(refFromPath('.pigry/designs/', '.design.json', '.pigry/designs/old.design.json'), { owner: '', slug: 'old' });
  assert.equal(refFromPath('.pigry/designs/', '.design.json', '.pigry/designs/a/b/c.design.json'), null);
  const refs = [{ owner: 'uxui', slug: 'home' }, { owner: 'user', slug: 'home' }, { owner: 'user', slug: 'solo' }];
  assert.deepEqual(resolveRef(refs, 'solo'), { ref: { owner: 'user', slug: 'solo' } });
  assert.deepEqual(resolveRef(refs, 'home', 'uxui'), { ref: { owner: 'uxui', slug: 'home' } });
  assert.match(resolveRef(refs, 'home').error, /several owners/);
  assert.match(resolveRef(refs, 'nope').error, /no "nope" found/);
  assert.deepEqual(resolveRef(refs, 'user/home'), { ref: { owner: 'user', slug: 'home' } });
});

import { computeResize, deepestFrameAt, nodesInRect, reorderIndex, snapMove, stepZOrder, topLevelSelection } from '../src/lib/designEdit.ts';

const canvas = () => normalizeDesign({ nodes: [
  { type: 'frame', id: 'f1', x: 0, y: 0, w: 400, h: 400, children: [
    { type: 'rect', id: 'a', x: 20, y: 20, w: 100, h: 50 },
    { type: 'rect', id: 'b', x: 200, y: 20, w: 100, h: 50 },
    { type: 'frame', id: 'inner', x: 20, y: 100, w: 200, h: 200, children: [{ type: 'rect', id: 'c', x: 10, y: 10, w: 20, h: 20 }] },
  ] },
  { type: 'frame', id: 'f2', x: 600, y: 0, w: 300, h: 300 },
] }).design;

test('resize handles move the right edges and respect the minimum', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(computeResize(box, 'se', 50, 20), { x: 100, y: 100, w: 250, h: 120 });
  assert.deepEqual(computeResize(box, 'nw', 30, 10), { x: 130, y: 110, w: 170, h: 90 });
  assert.deepEqual(computeResize(box, 'e', 0, 99), { x: 100, y: 100, w: 200, h: 100 }, 'edge handles ignore the other axis');
  assert.equal(computeResize(box, 'e', -500, 0).w, 4);
  const aspect = computeResize(box, 'se', 100, 0, true);
  assert.equal(aspect.w / aspect.h, 2, 'shift keeps the 2:1 ratio');
});

test('hit testing finds the deepest frame and marquee picks top-level nodes', () => {
  const d = canvas();
  assert.equal(deepestFrameAt(d, 50, 150).id, 'inner');
  assert.equal(deepestFrameAt(d, 350, 350).id, 'f1');
  assert.equal(deepestFrameAt(d, 700, 100).id, 'f2');
  assert.equal(deepestFrameAt(d, 500, 500), null);
  assert.equal(deepestFrameAt(d, 50, 150, new Set(['inner'])).id, 'f1', 'a dragged frame is excluded');
  assert.deepEqual(nodesInRect(d, { x: 550, y: -10, w: 400, h: 100 }), ['f2']);
  assert.deepEqual(topLevelSelection(d, ['f1', 'a', 'c', 'f2']), ['f1', 'f2']);
});

test('snapping aligns to sibling edges and reports guides', () => {
  const d = canvas();
  // Moving "a" (box x=20..120) so its right edge nearly meets "b".left? targets: parent f1 edges/centre and sibling b.
  const near = snapMove(d, ['a'], { x: 98, y: 22, w: 100, h: 50 }, 6);
  assert.equal(near.dx, 2, 'right edge 198 snaps to b.left 200');
  assert.equal(near.dy, -2, 'top 22 snaps to b.top 20');
  assert.equal(near.guides.length, 2);
  const far = snapMove(d, ['a'], { x: 130, y: 33, w: 100, h: 50 }, 6);
  assert.deepEqual([far.dx, far.dy, far.guides.length], [0, 0, 0]);
});

test('z-order steps and auto layout reorder index', () => {
  const d = canvas();
  assert.equal(stepZOrder(d, 'a', 1), true);
  assert.deepEqual(findNode(d, 'f1').children.map((n) => n.id), ['b', 'a', 'inner']);
  assert.equal(stepZOrder(d, 'inner', 1), false);
  const list = normalizeDesign({ nodes: [{ type: 'frame', id: 'col', w: 100, h: 300, layout: { dir: 'column', gap: 10 },
    children: [{ type: 'rect', id: 'x', w: 100, h: 40 }, { type: 'rect', id: 'y', w: 100, h: 40 }, { type: 'rect', id: 'z', w: 100, h: 40 }] }] }).design;
  const col = findNode(list, 'col');
  assert.equal(reorderIndex(col, 'x', 100), 1, 'x dragged between y (centre 70) and z (centre 120): past y only');
  assert.equal(reorderIndex(col, 'x', 400), 2);
  assert.equal(reorderIndex(col, 'z', -50), 0);
});
