import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addSlide, alignEls, animSteps, animTimes, contrast, distributeEls, duplicateSlide, emptyDeck, findAll, findEl, findSlide, groupEls, hiddenAt, layoutElements, listNumbers,
  makeSlide, moveSlides, normalizeDeck, parasText, parasToText, parseDeckJson, reorder, replaceAll, resizeBox, rotatedBounds, serializeDeck, slideTitle, snapBox, textToParas,
  ungroupEls, LAYOUTS, THEMES,
} from '../src/extensions/slides/slides.ts';
import { chartSvg, shapePath, slideHtml, stepAnimations, SLIDE_CSS } from '../src/extensions/slides/slidesRender.ts';
import { TEMPLATES, deckToHtml, deckToMarkdown, deckToText, markdownToDeck, templateDeck } from '../src/extensions/slides/slidesFormat.ts';
import { applyOps, parseOps, readDeck, relayout, reviewDeck, summarizeDeck } from '../src/extensions/slides/slidesOps.ts';
import { pdfFromJpegs, pptxBytes } from '../src/extensions/slides/slidesExport.ts';
import { unzipNames } from '../src/extensions/docs/docsDocx.ts';

const CTX = { author: 'presenter', now: '2026-11-26T10:00:00.000Z' };
const run = (deck, ops) => { const r = applyOps(deck, ops, CTX); assert.equal(r.error, undefined, r.error); return r.deck; };
const deckWith = (...layouts) => { const d = emptyDeck('T'); for (const l of layouts) addSlide(d, l); return d; };
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('layouts make placeholders inside the slide, and makeSlide fills them', () => {
  const d = emptyDeck();
  for (const { id } of LAYOUTS) {
    for (const e of layoutElements(d, id)) {
      assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= d.size.w && e.y + e.h <= d.size.h, `${id} ${e.role} inside`);
      assert.equal(e.placeholder, true);
    }
  }
  const s = makeSlide(d, 'two-columns', { title: 'Plan', left: ['One', 'Two'], right: 'Right side' });
  assert.equal(slideTitle(s), 'Plan');
  const bodies = s.elements.filter((e) => e.role === 'body');
  assert.equal(parasText(bodies[0].paras), 'One\nTwo');
  assert.equal(bodies[0].paras[0].list, 'bullet');
  assert.equal(parasText(bodies[1].paras), 'Right side');
});

test('light Markdown round-trips through paragraphs, with list levels and numbering', () => {
  const paras = textToParas('Intro **bold** and *it*\n- one\n  - nested\n1. first\n2. second\nplain [link](https://x.y)');
  assert.equal(paras[0].runs[1].b, true);
  assert.equal(paras[0].runs[3].i, true);
  assert.equal(paras[1].list, 'bullet');
  assert.equal(paras[2].level, 1);
  assert.equal(paras[3].list, 'number');
  assert.equal(paras[5].runs[1].link, 'https://x.y');
  assert.deepEqual([...listNumbers(paras).entries()], [[3, 1], [4, 2]]);
  assert.equal(parasToText(paras), 'Intro **bold** and *it*\n- one\n  - nested\n1. first\n2. second\nplain [link](https://x.y)');
});

test('normalize repairs input, keeps ids unique and the counter ahead', () => {
  const { deck, warnings } = normalizeDeck({
    title: 'X', seq: 1,
    slides: [{ id: 's9', layout: 'nope', elements: [{ id: 'e5', type: 'text', text: 'Hi' }, { id: 'e5', type: 'shape', shape: 'weird' }, { type: 'bogus' }, { type: 'image' }], anims: [{ el: 'e5', effect: 'zap' }, { el: 'missing' }], comments: [{ text: 'c' }] }, { id: 's9' }],
  });
  assert.equal(deck.slides.length, 2);
  assert.notEqual(deck.slides[0].id, deck.slides[1].id);
  const [a, b] = deck.slides[0].elements;
  assert.equal(a.id, 'e5'); assert.notEqual(b.id, 'e5');
  assert.equal(b.shape, 'rect');
  assert.equal(parasText(a.paras), 'Hi');
  assert.equal(deck.slides[0].layout, 'blank');
  assert.equal(deck.slides[0].anims.length, 1);
  assert.equal(deck.slides[0].anims[0].effect, 'fade-in');
  assert.ok(warnings.some((w) => w.includes('unknown type')));
  assert.ok(deck.seq >= 9);
  const again = parseDeckJson(serializeDeck(deck)).deck;
  assert.deepEqual(again, deck);
  assert.ok(parseDeckJson('{not json').warnings.length);
});

test('slide and element lookup by number, id, title, role and text', () => {
  const d = templateDeck('update', 'Status', '2026-11-26');
  assert.equal(findSlide(d, 2), d.slides[1]);
  assert.equal(findSlide(d, '3'), d.slides[2]);
  assert.equal(findSlide(d, 'milestones'), d.slides[3]);
  assert.equal(findSlide(d, d.slides[4].id), d.slides[4]);
  const s = d.slides[4];
  assert.equal(findEl(s, 'title').role, 'title');
  assert.equal(findEl(s, 'body2'), s.elements.filter((e) => e.role === 'body')[1]);
  assert.equal(findEl(s, 'device lab').role, 'body');
});

test('duplicate, move, reorder, align, distribute, group and ungroup', () => {
  const d = deckWith('title', 'title-body', 'blank');
  const s1 = d.slides[0];
  s1.anims.push({ id: 'a1', el: s1.elements[0].id, effect: 'fade-in', start: 'click', duration: 0.5 });
  const copy = duplicateSlide(d, s1);
  assert.equal(d.slides[1], copy);
  assert.notEqual(copy.elements[0].id, s1.elements[0].id);
  assert.equal(copy.anims[0].el, copy.elements[0].id);
  moveSlides(d, [d.slides[3].id], 0);
  assert.equal(d.slides[0].layout, 'blank');
  const s = d.slides[0];
  for (let i = 0; i < 3; i++) s.elements.push({ id: `x${i}`, type: 'shape', shape: 'rect', x: i * 100 + (i === 2 ? 300 : 0), y: i * 10, w: 50, h: 40, paras: [] });
  reorder(s, ['x0'], 'front');
  assert.equal(s.elements.at(-1).id, 'x0');
  reorder(s, ['x0'], 'backward');
  assert.equal(s.elements.at(-2).id, 'x0');
  alignEls(d, s, ['x0', 'x1', 'x2'], 'top');
  assert.deepEqual(s.elements.map((e) => e.y), [0, 0, 0]);
  distributeEls(s, ['x0', 'x1', 'x2'], 'h');
  const xs = s.elements.map((e) => e.x).sort((a, b) => a - b);
  assert.equal(xs[1] - xs[0], xs[2] - xs[1]);
  alignEls(d, s, ['x1'], 'center');
  assert.equal(s.elements.find((e) => e.id === 'x1').x, (d.size.w - 50) / 2);
  const g = groupEls(d, s, ['x0', 'x2']);
  assert.ok(g);
  assert.equal(s.elements.filter((e) => e.group === g).length, 2);
  ungroupEls(s, ['x0']);
  assert.equal(s.elements.filter((e) => e.group).length, 0);
});

test('snapping to the slide centre and other elements, with guides', () => {
  const size = { w: 960, h: 540 };
  const r = snapBox({ x: 427, y: 100, w: 100, h: 80 }, [{ x: 100, y: 103, w: 80, h: 40 }], size, 6);
  assert.equal(r.dx, 3); // centre 477 → 480
  assert.equal(r.dy, 3); // top 100 → 103
  assert.ok(r.guides.some((g) => g.axis === 'x' && g.at === 480));
  assert.ok(r.guides.some((g) => g.axis === 'y' && g.at === 103));
  assert.deepEqual(snapBox({ x: 300, y: 300, w: 10, h: 10 }, [], size, 4), { dx: 0, dy: 0, guides: [] });
});

test('resizing keeps the opposite corner fixed, also when rotated, and can keep the ratio', () => {
  assert.deepEqual(resizeBox({ x: 10, y: 10, w: 100, h: 50 }, 'se', 20, 10), { x: 10, y: 10, w: 120, h: 60 });
  assert.deepEqual(resizeBox({ x: 10, y: 10, w: 100, h: 50 }, 'nw', -10, -10), { x: 0, y: 0, w: 110, h: 60 });
  const k = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, 'e', 100, 0, { keepRatio: true });
  assert.equal(k.w, 200); assert.equal(k.h, 100);
  const rot = resizeBox({ x: 0, y: 0, w: 100, h: 100, rot: 90 }, 'e', 0, 50);
  assert.ok(Math.abs(rot.w - 150) < 1e-6 && Math.abs(rot.h - 100) < 1e-6);
  // the west edge (world top, at rotation 90°) stays where it was
  assert.ok(Math.abs(rot.y + rot.h / 2 - rot.w / 2 - 0) < 1e-6);
  const b = rotatedBounds({ x: 0, y: 0, w: 100, h: 20, rot: 90 });
  assert.ok(Math.abs(b.w - 20) < 1e-6 && Math.abs(b.h - 100) < 1e-6);
});

test('find and replace across text, tables and notes keeps run formatting', () => {
  const d = emptyDeck();
  const s = addSlide(d, 'title-body', undefined, { title: 'Revenue grew', body: 'Revenue is **up** in Q3', notes: 'Say revenue twice: revenue' });
  s.elements.push({ id: 't1', type: 'table', x: 0, y: 0, w: 100, h: 100, rows: [[{ text: 'Revenue' }]] });
  assert.equal(findAll(d, 'revenue').length, 5);
  assert.equal(findAll(d, 'revenue', { matchCase: true }).length, 2);
  assert.equal(findAll(d, 'revenue', { notes: false }).length, 3);
  const n = replaceAll(d, 'Revenue', 'Sales', { matchCase: true });
  assert.equal(n, 3);
  const body = s.elements.find((e) => e.role === 'body');
  assert.equal(parasText(body.paras), 'Sales is up in Q3');
  assert.equal(body.paras[0].runs.find((r) => r.t === 'up').b, true);
  assert.equal(s.elements.at(-1).rows[0][0].text, 'Sales');
  assert.equal(replaceAll(d, 'revenue', 'sales'), 2);
  assert.equal(s.notes, 'Say sales twice: sales');
});

test('animation steps, timing and what is hidden at each click', () => {
  const s = { id: 's1', layout: 'blank', notes: '', comments: [], elements: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 1, h: 1, paras: [] })), anims: [
    { id: 'n1', el: 'a', effect: 'fade-in', start: 'with', duration: 0.5 },
    { id: 'n2', el: 'b', effect: 'fly-left', start: 'click', duration: 1 },
    { id: 'n3', el: 'c', effect: 'appear', start: 'after', duration: 0.5, delay: 0.25 },
    { id: 'n4', el: 'd', effect: 'fade-out', start: 'click', duration: 0.5 },
  ] };
  const steps = animSteps(s);
  assert.deepEqual(steps.map((st) => st.map((a) => a.id)), [['n1'], ['n2', 'n3'], ['n4']]);
  assert.deepEqual([...animTimes(steps[1]).entries()], [['n2', 0], ['n3', 1.25]]);
  assert.deepEqual([...hiddenAt(s, 0)].sort(), ['b', 'c']);
  assert.deepEqual([...hiddenAt(s, 1)], []);
  assert.deepEqual([...hiddenAt(s, 2)], ['d']);
  assert.ok(stepAnimations(s, 1).get('c').includes('1.3s') || stepAnimations(s, 1).get('c').includes('1.2s'));
});

test('templates and the Markdown outline importer', () => {
  for (const t of TEMPLATES) {
    const d = templateDeck(t.id, 'Deck', '2026-11-26');
    assert.ok(d.slides.length >= 1, t.id);
    assert.equal(d.theme.id, t.theme);
    for (const s of d.slides) for (const e of s.elements) assert.ok(e.x >= -1 && e.y >= -1 && e.x + e.w <= d.size.w + 1 && e.y + e.h <= d.size.h + 1, `${t.id} ${e.id} inside`);
  }
  assert.equal(templateDeck('pitch', 'P').slides.length, 10);
  const d = markdownToDeck('# Quarterly review\nNovember 2026\n\n## Sales are up 12%\n- North +20%\n- South +4%\n> Mention the new hires\n\n---\n\n## Section only\n\n## Table\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## 42%\n\n## Picture\n![A chart](data:image/png;base64,AAAA)\nNotes: say why');
  assert.equal(d.title, 'Quarterly review');
  assert.deepEqual(d.slides.map((s) => s.layout), ['title', 'title-body', 'title-only', 'title-only', 'big-number', 'title-only']);
  assert.equal(d.slides[1].notes, 'Mention the new hires');
  assert.equal(parasText(d.slides[1].elements.find((e) => e.role === 'body').paras), 'North +20%\nSouth +4%');
  assert.equal(d.slides[3].elements.find((e) => e.type === 'table').rows[1][1].text, '2');
  assert.equal(d.slides[5].elements.find((e) => e.type === 'image').alt, 'A chart');
  assert.equal(d.slides[5].notes, 'say why');
  const md = deckToMarkdown(d);
  assert.match(md, /## Sales are up 12%\n\n- North \+20%\n- South \+4%/);
  assert.match(md, /Notes: Mention the new hires/);
  assert.match(deckToText(d), /Slide 2: Sales are up 12%/);
});

test('rendering: slide HTML, placeholders, shapes, charts and the player page', () => {
  const d = emptyDeck('Talk');
  const s = addSlide(d, 'title-body', undefined, { title: 'Hello <world>' });
  s.elements.push({ id: 'sh', type: 'shape', shape: 'star', x: 10, y: 10, w: 100, h: 100, fill: '$accent', paras: textToParas('Star') });
  s.elements.push({ id: 'ch', type: 'chart', chart: 'column', x: 0, y: 0, w: 400, h: 200, labels: ['A', 'B'], series: [{ name: 'S', values: [3, 5] }], title: 'Sales' });
  const html = slideHtml(d, s);
  assert.match(html, /Hello &lt;world&gt;/);
  assert.doesNotMatch(html, /Click to add text/); // empty placeholders hidden outside the editor
  assert.match(slideHtml(d, s, { editor: true }), /Click to add text/);
  assert.match(html, new RegExp(THEMES[0].colors.accent));
  assert.match(html, /data-id="sh"/);
  for (const k of ['rect', 'roundRect', 'ellipse', 'star', 'arrowRight', 'callout', 'heart', 'cloud']) assert.ok(shapePath(k, 100, 60).startsWith('M'), k);
  const chart = s.elements.find((e) => e.type === 'chart');
  const svg = chartSvg(chart, d.theme);
  assert.equal((svg.match(/<rect /g) ?? []).length, 2);
  assert.match(svg, />Sales</);
  for (const k of ['bar', 'line', 'pie', 'doughnut']) assert.match(chartSvg({ ...chart, chart: k }, d.theme), /<svg/);
  assert.match(SLIDE_CSS, /counter-increment/);
  s.transition = { type: 'fade', duration: 0.6 };
  addSlide(d, 'title', undefined, { title: 'Hidden' }).hidden = true;
  const page = deckToHtml(d);
  assert.match(page, /<!doctype html>/);
  assert.match(page, /"tr":"fade"/);
  assert.equal((page.match(/<section class="slide"/g) ?? []).length, 1);
  assert.doesNotMatch(page, /<\/script><script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/);
});

test('ops: build a deck, all-or-nothing, with a log', () => {
  const d = emptyDeck('Ops');
  const r = applyOps(d, [
    { op: 'add_slide', layout: 'title', title: 'Launch plan', subtitle: 'Q1 2027' },
    { op: 'add_slide', layout: 'title-body', title: 'Why now', body: ['Customers ask for it', 'Competitors are slow'], notes: 'Lead with the customer quote.' },
    { op: 'add', slide: 2, type: 'shape', shape: 'ellipse', x: 700, y: 300, w: 120, h: 120, fill: '$accent2', text: '**Go**', name: 'Badge' },
    { op: 'add', slide: 2, type: 'line', x1: 100, y1: 500, x2: 300, y2: 450, end: 'arrow' },
    { op: 'add', slide: 2, type: 'chart', chart: 'bar', labels: ['A', 'B'], series: [{ name: 'Votes', values: [4, 9] }], x: 60, y: 60, w: 300, h: 200, title: 'Votes' },
    { op: 'add', slide: 2, type: 'table', rows: [['Who', 'When'], ['Ana', 'Mon']], x: 60, y: 300, w: 300, h: 100 },
    { op: 'add', slide: 2, type: 'image', src: PNG_1x1, alt: 'Logo', x: 0, y: 0, w: 40, h: 40 },
    { op: 'format', slide: 2, el: 'body', size: 24, color: '$accent' },
    { op: 'animate', slide: 2, el: 'Badge', effect: 'zoom-in' },
    { op: 'transition', all: true, type: 'fade' },
    { op: 'theme', theme: 'midnight' },
    { op: 'comment', slide: 1, text: 'Add the date?' },
    { op: 'table_cell', slide: 2, el: 'Who', row: 2, col: 2, text: 'Tue', bold: true },
    { op: 'set', slide: 2, el: 'Badge', x: 710, rot: 15 },
    { op: 'arrange', slide: 2, el: 'Badge', z: 'back' },
    { op: 'markdown', markdown: '## Next steps\n- Ship it', at: 2 },
  ], CTX);
  assert.equal(r.error, undefined, r.error);
  const deck = r.deck;
  assert.equal(r.log.length, 16);
  assert.equal(deck.slides.length, 3);
  assert.equal(slideTitle(deck.slides[1]), 'Next steps');
  const s2 = deck.slides[2];
  const badge = findEl(s2, 'Badge');
  assert.equal(s2.elements[0], badge);
  assert.equal(badge.x, 710); assert.equal(badge.rot, 15);
  assert.equal(s2.anims[0].el, badge.id);
  const line = s2.elements.find((e) => e.type === 'line');
  assert.deepEqual([line.x, line.y, line.w, line.h, line.dir], [100, 450, 200, 50, 'up']);
  assert.equal(findEl(s2, 'body').paras[0].runs[0].size, 24);
  assert.equal(s2.elements.find((e) => e.type === 'table').rows[1][1].text, 'Tue');
  assert.equal(deck.theme.id, 'midnight');
  assert.equal(deck.slides[0].comments[0].author, 'presenter');
  assert.ok(deck.slides.every((s) => s.transition?.type === 'fade' || s === deck.slides[1]));
  assert.equal(d.slides.length, 0, 'the input deck is not changed');

  const bad = applyOps(deck, [{ op: 'title', title: 'New' }, { op: 'delete', slide: 9, el: 'x' }], CTX);
  assert.match(bad.error, /op 2 \(delete\): no slide "9"/);
  assert.equal(bad.deck, deck);
  assert.match(applyOps(deck, [{ op: 'add', slide: 1, type: 'shape', fill: 'blue' }], CTX).error, /#hex colour/);
  assert.match(applyOps(deck, [{ op: 'set', slide: 3, el: 'nothing-like-this' }], CTX).error, /has no element/);
  assert.deepEqual(parseOps([{ op: 'zap' }, {}]).errors.length, 2);
  assert.equal(parseOps({ op: 'title', title: 'x' }).ops.length, 1);
});

test('ops: layout change keeps text; size change scales; replace, hide, delete', () => {
  let d = run(emptyDeck(), [{ op: 'add_slide', layout: 'title-body', title: 'Keep me', body: 'Body' }]);
  relayout(d, d.slides[0], 'two-columns');
  assert.equal(slideTitle(d.slides[0]), 'Keep me');
  assert.equal(d.slides[0].elements.filter((e) => e.role === 'body').length, 2);
  d = run(d, [{ op: 'size', aspect: '4:3' }, { op: 'hide_slide', slide: 1 }, { op: 'replace_text', find: 'Keep', replace: 'Kept' }]);
  assert.deepEqual(d.size, { w: 960, h: 720 });
  assert.equal(d.slides[0].hidden, true);
  assert.equal(slideTitle(d.slides[0]), 'Kept me');
  for (const e of d.slides[0].elements) assert.ok(e.y + e.h <= 720);
  d = run(d, [{ op: 'duplicate_slide', slide: 1 }, { op: 'delete_slide', slide: 1 }, { op: 'move_slide', slide: 1, to: 1 }]);
  assert.equal(d.slides.length, 1);
});

test('read and review', () => {
  const d = run(emptyDeck('Review me'), [
    { op: 'add_slide', layout: 'title-body', title: 'Dense', body: Array.from({ length: 9 }, (_, i) => `Point number ${i} with several extra words to read aloud`) },
    { op: 'add', slide: 1, type: 'text', text: 'tiny', size: 9, x: 10, y: 10, w: 100, h: 30 },
    { op: 'add', slide: 1, type: 'text', text: 'low contrast words here', color: '#eeeeee', size: 20, x: 600, y: 10, w: 300, h: 60 },
    { op: 'add', slide: 1, type: 'image', src: PNG_1x1, x: 1200, y: 10, w: 40, h: 40 },
    { op: 'add_slide', layout: 'title-body', title: 'Dense' },
  ]);
  const r = reviewDeck(d);
  const has = (re) => assert.ok(r.some((l) => re.test(l)), `${re} in\n${r.join('\n')}`);
  has(/slide 1: \d+ words/);
  has(/9 bullet points/);
  has(/\dpt text — too small/);
  has(/contrast is 1\.\d:1/);
  has(/no alt text/);
  has(/outside the slide/);
  has(/share the title "dense"/);
  const text = readDeck(d);
  assert.match(text, /\[1\] s\d+ title-body/);
  assert.match(text, /NO ALT TEXT/);
  assert.match(summarizeDeck(d), /2 slides · 16:9 · theme Simple Light/);
  assert.ok(contrast('#000000', '#ffffff') > 20);
});

test('PowerPoint export: parts, slides, notes, media, links and hidden slides', () => {
  const d = run(templateDeck('update', 'Status'), [
    { op: 'add', slide: 1, type: 'image', src: PNG_1x1, alt: 'Logo', x: 10, y: 10, w: 60, h: 30 },
    { op: 'add', slide: 1, type: 'text', text: 'See [the plan](https://example.com/plan)', x: 10, y: 480, w: 400, h: 40 },
    { op: 'hide_slide', slide: 3 },
    { op: 'slide', slide: 2, background: { type: 'gradient', from: '#ffffff', to: '$surface' } },
  ]);
  const bytes = pptxBytes(d);
  const names = unzipNames(bytes);
  assert.equal(names[0], '[Content_Types].xml');
  for (const n of ['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/media/image1.png', 'docProps/core.xml']) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, d.slides.length);
  assert.ok(names.includes('ppt/notesSlides/notesSlide1.xml'));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /<p:sldSz cx="9144000" cy="5143500"\/>/);
  assert.match(text, /show="0"/);
  assert.match(text, /<a:gradFill/);
  assert.match(text, /TargetMode="External"/);
  assert.match(text, /<a:tbl>/);
  assert.match(text, /descr="Logo"/);
  assert.match(text, /<a:buChar/);
  // every relationship id used in a slide is declared in its rels file
  for (const n of names.filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x))) assert.ok(names.includes(n.replace('slides/', 'slides/_rels/') + '.rels'));
});

test('PDF writer: pages, images and a valid cross-reference table', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = pdfFromJpegs([{ jpeg, w: 2, h: 1 }, { jpeg, w: 2, h: 1 }], 720, 405, 'Talk (draft)');
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 720 405\]/);
  assert.match(text, /\/Title \(Talk \\\(draft\\\)\)/);
  const start = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(start).startsWith('xref'));
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});
