import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOperations, autoLayout, borderPoint, normalizeDiagram,
  renderDiagramSvg, summarizeDiagram, templateDiagram, toMermaid, validateDiagram,
} from '../src/extensions/diagram/diagram.ts';

const sample = () => normalizeDiagram({
  title: 'Login flow', type: 'flowchart',
  nodes: [
    { id: 'start', kind: 'terminator', label: 'Start' },
    { id: 'form', label: 'Show login form' },
    { id: 'ok', kind: 'decision', label: 'Valid?' },
    { id: 'home', label: 'Home' },
  ],
  edges: [
    { from: 'start', to: 'form' },
    { from: 'form', to: 'ok' },
    { from: 'ok', to: 'home', label: 'yes' },
    { from: 'ok', to: 'form', label: 'no' },
  ],
});

test('normalize repairs bad input instead of throwing', () => {
  const { diagram, warnings, needsLayout } = normalizeDiagram({
    nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Dup' }, { kind: 'bogus', label: 'B' }, { label: 'Users', fields: ['id PK'] }],
    edges: [{ from: 'a', to: 'B' }, { from: 'a', to: 'missing' }, { from: 'Users', to: 'a' }],
  });
  assert.equal(new Set(diagram.nodes.map((n) => n.id)).size, 4);
  assert.equal(diagram.nodes[3].kind, 'entity');
  assert.equal(diagram.edges.length, 2, 'edge to a missing node is dropped, label references resolve');
  assert.ok(warnings.some((w) => /Duplicate node id/.test(w)));
  assert.ok(warnings.some((w) => /Unknown kind/.test(w)));
  assert.ok(warnings.some((w) => /unknown node/.test(w)));
  assert.equal(needsLayout, true);
});

test('auto layout ranks a flow top-down and survives cycles', () => {
  const { diagram } = sample();
  const laid = autoLayout(diagram, 'TB');
  const y = Object.fromEntries(laid.nodes.map((n) => [n.id, n.y]));
  assert.ok(y.start < y.form && y.form < y.ok && y.ok < y.home, 'ranks follow edge direction despite the no-loop back edge');
  assert.deepEqual(validateDiagram(laid).filter((m) => /overlap/.test(m)), []);
  const lr = autoLayout(diagram, 'LR');
  const x = Object.fromEntries(lr.nodes.map((n) => [n.id, n.x]));
  assert.ok(x.start < x.form && x.form < x.ok);
});

test('system boundary is fitted around its children', () => {
  const d = templateDiagram('usecase', 'Orders');
  const box = d.nodes.find((n) => n.id === 'box');
  for (const kid of d.nodes.filter((n) => n.parent === 'box')) {
    assert.ok(kid.x >= box.x && kid.y >= box.y && kid.x + kid.w <= box.x + box.w && kid.y + kid.h <= box.y + box.h);
  }
});

test('operations apply, report errors and resolve nodes by label', () => {
  const { diagram } = sample();
  const result = applyOperations(autoLayout(diagram), [
    { op: 'add_node', id: 'audit', label: 'Write audit log' },
    { op: 'add_edge', from: 'Valid?', to: 'audit', label: 'log' },
    { op: 'update_node', id: 'home', label: 'Dashboard' },
    { op: 'update_edge', from: 'ok', to: 'home', dashed: true },
    { op: 'remove_node', id: 'nope' },
    { op: 'explode' },
  ]);
  assert.equal(result.errors.length, 2);
  assert.equal(result.diagram.nodes.find((n) => n.id === 'home').label, 'Dashboard');
  assert.equal(result.diagram.edges.find((e) => e.from === 'ok' && e.to === 'home').dashed, true);
  assert.ok(result.diagram.edges.some((e) => e.to === 'audit' && e.label === 'log'));
  const removed = applyOperations(result.diagram, [{ op: 'remove_node', id: 'form' }]);
  assert.ok(removed.diagram.edges.every((e) => e.from !== 'form' && e.to !== 'form'));
  assert.ok(removed.log[0].includes('edge(s)'));
});

test('entity height follows its fields and ERD exports as Mermaid erDiagram', () => {
  const erd = templateDiagram('erd', 'Shop');
  const user = erd.nodes.find((n) => n.id === 'user');
  assert.equal(user.kind, 'entity');
  const more = applyOperations(erd, [{ op: 'update_node', id: 'user', fields: ['id PK', 'email', 'name', 'created_at timestamp'] }]);
  assert.ok(more.diagram.nodes.find((n) => n.id === 'user').h > user.h);
  const text = toMermaid(more.diagram);
  assert.match(text, /^erDiagram/);
  assert.match(text, /User \|\|--o\{ Order : "places"/);
  assert.match(text, /string id PK/);
  assert.match(text, /timestamp created_at/);
});

test('flowchart Mermaid uses shapes and edge styles', () => {
  const { diagram } = sample();
  const text = toMermaid({ ...diagram, direction: 'LR' });
  assert.match(text, /^flowchart LR/);
  assert.match(text, /n_start\(\["Start"\]\)/);
  assert.match(text, /n_ok\{"Valid\?"\}/);
  assert.match(text, /n_ok -->\|"yes"\| n_home/);
});

test('SVG output is standalone, escaped and complete', () => {
  const { diagram } = normalizeDiagram({
    title: 'A <b> & "c"',
    nodes: [{ id: 'a', label: '<script>alert(1)</script>', x: 0, y: 0 }, { id: 'b', kind: 'database', label: 'DB', x: 300, y: 0 }, { id: 'c', kind: 'actor', label: 'Ann', x: 0, y: 200 }],
    edges: [{ from: 'a', to: 'b', label: 'x & y' }, { from: 'a', to: 'a' }],
  });
  const svg = renderDiagramSvg(diagram);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('x &amp; y'));
  assert.ok((svg.match(/<polygon/g) ?? []).length >= 2, 'arrow heads drawn for both edges');
});

test('edges leave nodes at their outline', () => {
  const rect = { id: 'r', kind: 'process', label: 'r', x: 0, y: 0, w: 100, h: 50 };
  const p = borderPoint(rect, 300, 25);
  assert.equal(Math.round(p.x), 100);
  const diamond = { ...rect, kind: 'decision' };
  const q = borderPoint(diamond, 300, 25);
  assert.equal(Math.round(q.x), 100);
  const slanted = borderPoint(diamond, 100, 100);
  assert.ok(slanted.x < 100 && slanted.y < 50, 'diagonal hits the diamond edge, not its bounding box corner');
});

test('summary lists nodes and edges for the model', () => {
  const { diagram } = sample();
  const text = summarizeDiagram(diagram);
  assert.match(text, /"Login flow" — flowchart, TB, 4 nodes, 4 edges/);
  assert.match(text, /- ok \[decision\] "Valid\?"/);
  assert.match(text, /ok -> home "yes"/);
});
