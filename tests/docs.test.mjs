import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptSuggestion, addComment, cleanupRefs, clearFormatting, countWords, deleteComment, deleteRange, docListLabels, docStats, emptyDoc, findAll, footnoteNumbers,
  formatRange, insertBlockAt, insertFragment, insertText, listSuggestions, makeTable, normalizeDoc, orderedComments, outline, paraText, parseDocJson, rangeHas,
  rejectSuggestion, replaceAll, replyComment, resolveComment, serializeDoc, splitPara, suggestDelete, suggestInsert, tableDeleteCol, tableDeleteRow, tableInsertCol,
  tableInsertRow, tableMerge, tableUnmerge, textBlocks, toggleList, toggleMark, indent, fillFields, pageInches,
} from '../src/extensions/docs/docs.ts';
import { blocksHtml, docToHtml, docToMarkdown, docToText, eqToHtml, eqToText, markdownToDoc, parseInline, templateDoc } from '../src/extensions/docs/docsFormat.ts';
import { applyOps, parseOps, readDoc, reviewDoc, summarizeDoc } from '../src/extensions/docs/docsOps.ts';
import { docxBytes, unzipNames } from '../src/extensions/docs/docsDocx.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const O = { author: 'writer', now: NOW };
const md = (text) => markdownToDoc(text, 'T');
const run = (doc, ops) => { const r = applyOps(doc, ops, O); assert.equal(r.error, undefined, r.error); return r.doc; };
const texts = (doc) => textBlocks(doc).map((t) => paraText(t.para));
const P = (b, o) => ({ b, o });

test('normalize repairs input, keeps ids unique and the counter ahead', () => {
  const { doc, warnings } = normalizeDoc({
    title: '  Plan ', seq: 2,
    page: { size: 'a4', orientation: 'landscape', margins: { top: 0.5, left: 9 }, color: '#FFFFFF' },
    blocks: [
      { type: 'p', id: 'b9', style: 'h1', runs: [{ t: 'Hi', b: true }, { t: ' there', b: true }, { t: '' }] },
      { type: 'p', id: 'b9', runs: [{ t: 'dup id', color: 'red', size: 900 }] },
      { type: 'nope' },
      { type: 'table', rows: [[{ cs: 5, paras: [] }, {}], [{}, {}]] },
    ],
    comments: [{ id: 'c1', text: 'x', quote: 'q' }],
  });
  assert.equal(doc.title, 'Plan');
  assert.equal(doc.page.size, 'a4'); assert.equal(doc.page.orientation, 'landscape');
  assert.equal(doc.page.margins.top, 0.5); assert.equal(doc.page.margins.left, 4);
  assert.equal(doc.page.color, undefined);
  assert.deepEqual(doc.blocks[0].runs, [{ t: 'Hi there', b: true }], 'equal neighbouring runs merge, empty runs go');
  assert.notEqual(doc.blocks[1].id, 'b9');
  assert.equal(doc.blocks[1].runs[0].color, undefined, 'bad colour dropped');
  assert.equal(doc.blocks[1].runs[0].size, 400, 'size clamped');
  assert.ok(warnings.some((w) => w.includes('unknown type')));
  const t = doc.blocks[2];
  assert.equal(t.rows[0][0].cs, 2, 'merge clamped to the table');
  assert.equal(t.rows[0][1].hidden, true);
  assert.equal(doc.blocks[doc.blocks.length - 1].type, 'p', 'a paragraph always ends the document');
  assert.ok(doc.seq >= 9);
  const again = parseDocJson(serializeDoc(doc)).doc;
  assert.deepEqual(again, doc, 'serialize → parse is stable');
  assert.deepEqual(parseDocJson('{bad').warnings, ['the file is not valid JSON; started empty']);
});

test('inline marks: format, toggle, clear across paragraphs', () => {
  const doc = md('Hello world\n\nSecond line');
  toggleMark(doc, { from: P(0, 6), to: P(1, 6) }, 'b');
  assert.deepEqual(doc.blocks[0].runs, [{ t: 'Hello ' }, { t: 'world', b: true }]);
  assert.deepEqual(doc.blocks[1].runs, [{ t: 'Second', b: true }, { t: ' line' }]);
  assert.equal(rangeHas(doc, { from: P(0, 6), to: P(0, 11) }, 'b'), true);
  toggleMark(doc, { from: P(0, 0), to: P(0, 11) }, 'b');
  assert.equal(rangeHas(doc, { from: P(0, 0), to: P(0, 11) }, 'b'), true, 'mixed selection turns bold on');
  toggleMark(doc, { from: P(0, 0), to: P(0, 11) }, 'b');
  assert.deepEqual(doc.blocks[0].runs, [{ t: 'Hello world' }], 'then off, merged back');
  formatRange(doc, { from: P(1, 0), to: P(1, 11) }, { color: '#ff0000', size: 14, sup: true });
  formatRange(doc, { from: P(1, 0), to: P(1, 3) }, { sub: true });
  assert.equal(doc.blocks[1].runs[0].sup, undefined, 'sub replaces sup');
  formatRange(doc, { from: P(1, 0), to: P(1, 11) }, { link: 'https://x.dev' });
  clearFormatting(doc, { from: P(1, 0), to: P(1, 11) });
  assert.deepEqual(doc.blocks[1].runs, [{ t: 'Second line', link: 'https://x.dev' }], 'clear formatting keeps links');
});

test('typing, Enter and Backspace semantics', () => {
  const doc = md('# Heading\n\n- one\n- two');
  let pos = insertText(doc, P(0, 7), '!');
  assert.equal(texts(doc)[0], 'Heading!');
  pos = splitPara(doc, pos);
  assert.equal(doc.blocks[1].style, undefined, 'Enter at the end of a heading gives Normal text');
  assert.deepEqual(pos, P(1, 0));
  const li = splitPara(doc, P(3, 3));
  assert.equal(doc.blocks[4].list, 'bullet', 'lists continue');
  splitPara(doc, li);
  assert.equal(doc.blocks[4].list, undefined, 'Enter in an empty item ends the list');
  const d2 = md('Alpha beta\n\nGamma delta\n\nEpsilon');
  deleteRange(d2, { from: P(0, 6), to: P(2, 3) });
  assert.deepEqual(texts(d2), ['Alpha ilon'], 'joined across paragraphs, middle removed');
  const d3 = md('ab');
  splitPara(d3, P(0, 1));
  assert.deepEqual(texts(d3), ['a', 'b']);
});

test('paste fragments inline or as blocks', () => {
  const doc = md('Start end');
  insertFragment(doc, P(0, 6), [{ type: 'p', id: 'x', runs: [{ t: 'bold ', b: true }] }]);
  assert.equal(texts(doc)[0], 'Start bold end');
  const frag = md('one\n\n## two\n\nthree').blocks;
  const after = insertFragment(doc, P(0, 6), frag);
  assert.deepEqual(texts(doc), ['Start one', 'two', 'threebold end']);
  assert.equal(doc.blocks[1].style, 'h2');
  assert.deepEqual(after, P(2, 5));
  const d2 = md('x');
  const t = makeTable(d2, 2, 2);
  const pos = insertBlockAt(d2, P(0, 1), t);
  assert.equal(d2.blocks[1].type, 'table');
  assert.equal(d2.blocks[2].type, 'p', 'a paragraph follows an inserted table');
  assert.equal(textBlocks(d2)[pos.b].top, 2);
});

test('lists: toggle, indent and labels by level', () => {
  const doc = md('a\n\nb\n\nc\n\nd');
  toggleList(doc, { from: P(0, 0), to: P(2, 0) }, 'number');
  indent(doc, { from: P(1, 0), to: P(1, 0) }, 1);
  const labels = docListLabels(doc);
  assert.deepEqual(doc.blocks.slice(0, 3).map((p) => labels.get(p)), ['1.', 'a.', '2.']);
  toggleList(doc, { from: P(0, 0), to: P(2, 0) }, 'number');
  assert.ok(doc.blocks.slice(0, 3).every((p) => !p.list), 'toggling again removes the list');
  const d2 = md('- [x] done\n- [ ] todo\n    - nested\n\n1. x\n2. y\n\npara\n\n1. again');
  const l2 = docListLabels(d2);
  assert.deepEqual(d2.blocks.map((p) => l2.get(p) ?? ''), ['☑', '☐', '○', '1.', '2.', '', '1.']);
});

test('tables: rows, columns, merge and unmerge keep a rectangular grid', () => {
  const doc = emptyDoc();
  doc.blocks.unshift(makeTable(doc, 3, 3, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]));
  const cellText = () => doc.blocks[0].rows.map((r) => r.map((c) => (c.hidden ? '·' : c.paras.map(paraText).join('+'))));
  tableMerge(doc, 0, 0, 0, 1, 1);
  assert.deepEqual(cellText(), [['a+b+d+e', '·', 'c'], ['·', '·', 'f'], ['g', 'h', 'i']]);
  tableInsertRow(doc, 0, 1);
  assert.equal(doc.blocks[0].rows[0][0].rs, 3, 'a row inserted inside a merge grows it');
  assert.equal(doc.blocks[0].rows[1][0].hidden, true);
  tableInsertCol(doc, 0, 1);
  assert.equal(doc.blocks[0].rows[0][0].cs, 3);
  tableDeleteRow(doc, 0, 0);
  assert.equal(doc.blocks[0].rows[0][0].hidden, undefined, 'deleting the top row moves the merge anchor down');
  assert.equal(doc.blocks[0].rows[0][0].rs, 2);
  assert.equal(paraText(doc.blocks[0].rows[0][0].paras[0]), 'a');
  tableDeleteCol(doc, 0, 0);
  assert.equal(doc.blocks[0].rows[0][0].cs, 2);
  tableUnmerge(doc, 0, 1, 1);
  assert.ok(doc.blocks[0].rows.flat().every((c) => !c.hidden && !c.cs && !c.rs));
  assert.throws(() => tableUnmerge(doc, 0, 0, 0), /not merged/);
  assert.throws(() => tableMerge(doc, 0, 1, 1, 1, 1), /at least two/);
  while (doc.blocks[0].type === 'table') tableDeleteRow(doc, 0, 0);
  assert.equal(doc.blocks.length, 1, 'deleting the last row removes the table');
});

test('comments: add, reply, resolve, delete; anchors survive editing', () => {
  const doc = md('The quick brown fox');
  const id = addComment(doc, { from: P(0, 4), to: P(0, 9) }, 'Faster?', 'ana', NOW);
  assert.equal(doc.comments[0].quote, 'quick');
  assert.deepEqual(doc.blocks[0].runs[1], { t: 'quick', c: [id] });
  replyComment(doc, id, 'Agreed', 'bo', NOW);
  resolveComment(doc, id);
  assert.equal(doc.comments[0].resolved, true);
  replyComment(doc, id, 'Reopen', 'ana', NOW);
  assert.equal(doc.comments[0].resolved, undefined, 'a reply reopens');
  const id2 = addComment(doc, { from: P(0, 0), to: P(0, 3) }, 'Article', 'ana', NOW);
  assert.deepEqual(orderedComments(doc).map((c) => c.id), [id2, id]);
  deleteComment(doc, id);
  assert.equal(doc.blocks[0].runs.some((r) => r.c?.includes(id)), false);
  assert.throws(() => addComment(doc, { from: P(0, 2), to: P(0, 2) }, 'x', 'a', NOW), /select/);
});

test('suggestions: insert, delete, accept and reject', () => {
  const doc = md('We utilise tools');
  const [r] = findAll(doc, 'utilise');
  const del = suggestDelete(doc, r, 'writer', NOW);
  const ins = suggestInsert(doc, r.to, 'use', 'writer', NOW).id;
  assert.deepEqual(listSuggestions(doc).map((s) => [s.kind, s.text]), [['del', 'utilise'], ['ins', 'use']]);
  assert.equal(docStats(doc).suggestions, 2);
  const copy = structuredClone(doc);
  acceptSuggestion(doc, 'all');
  assert.equal(texts(doc)[0], 'We use tools');
  assert.equal(doc.suggestions.length, 0);
  rejectSuggestion(copy, ins);
  rejectSuggestion(copy, del);
  assert.equal(texts(copy)[0], 'We utilise tools');
  const d2 = md('abc');
  const s = suggestInsert(d2, P(0, 1), 'XY', 'w', NOW);
  suggestDelete(d2, { from: P(0, 0), to: P(0, 5) }, 'w', NOW);
  assert.equal(texts(d2)[0], 'abc', 'deleting your own suggested insertion removes it');
  assert.ok(!d2.suggestions.some((x) => x.id === s.id));
  assert.throws(() => acceptSuggestion(d2, 'nope'), /no suggestion/);
});

test('find and replace: case, whole words, regex groups and Thai', () => {
  const doc = md('Cat cat CAT category\n\nแมว กิน ปลา แมว');
  assert.equal(findAll(doc, 'cat').length, 4);
  assert.equal(findAll(doc, 'cat', { matchCase: true }).length, 2);
  assert.equal(findAll(doc, 'cat', { wholeWord: true }).length, 3);
  assert.equal(findAll(doc, 'แมว').length, 2);
  assert.equal(replaceAll(doc, '(c)at\\b', '$1ow', { regex: true }), 3);
  assert.equal(texts(doc)[0], 'Cow cow Cow category');
  assert.throws(() => findAll(doc, '(', { regex: true }), /bad regular expression/);
});

test('word count, outline, footnotes and page helpers', () => {
  assert.equal(countWords('Hello, world!'), 2);
  assert.ok(countWords('ภาษาไทยไม่มีการเว้นวรรค') > 1, 'Thai words are segmented without spaces');
  const doc = md('# Title here\n\nSome words here[^n].\n\n## Part\n\nMore.\n\n[^n]: A note.');
  const st = docStats(doc);
  assert.equal(st.words, 7);
  assert.deepEqual(outline(doc).map((o) => [o.level, o.text]), [[1, 'Title here'], [2, 'Part']]);
  assert.equal(doc.footnotes[0].text, 'A note.');
  assert.equal(footnoteNumbers(doc).get(doc.footnotes[0].id), 1);
  assert.deepEqual(pageInches({ size: 'a4', orientation: 'landscape', margins: {} }), { w: 11.69, h: 8.27 });
  assert.equal(fillFields('Page {page} of {PAGES} — {title}', { page: 2, pages: 5, title: 'X', date: 'd' }), 'Page 2 of 5 — X');
  cleanupRefs(doc);
  assert.equal(doc.footnotes.length, 1);
});

test('Markdown in: inline marks, lists, tables, code, quotes, equations', () => {
  assert.deepEqual(parseInline('a **b _c_** ~~d~~ `e*` [f](https://g.h) <u>u</u> x^2 $E=mc^2$ 5$ and $6'), [
    { t: 'a ' }, { t: 'b ', b: true }, { t: 'c', b: true, i: true }, { t: ' ' }, { t: 'd', s: true }, { t: ' ' }, { t: 'e*', code: true }, { t: ' ' },
    { t: 'f', link: 'https://g.h' }, { t: ' ' }, { t: 'u', u: true }, { t: ' x^2 ' }, { eq: 'E=mc^2' }, { t: ' 5$ and $6' },
  ]);
  assert.deepEqual(parseInline('snake_case_name and _it_'), [{ t: 'snake_case_name and ' }, { t: 'it', i: true }]);
  const doc = md('Title\n=====\n\n> quoted\n\n```\ncode line\n```\n\n| A | B |\n|---|:-:|\n| 1 | 2 \\| 3 |\n\n![logo](data:image/png;base64,AAA)\n\n---\n\n1) first\n2) second');
  assert.equal(doc.blocks[0].style, 'h1');
  assert.equal(doc.blocks[1].ind, 1);
  assert.equal(doc.blocks[2].runs[0].code, true);
  const t = doc.blocks[3];
  assert.equal(t.type, 'table');
  assert.equal(paraText(t.rows[1][1].paras[0]), '2 | 3');
  assert.equal(t.rows[0][0].paras[0].runs[0].b, true, 'header row is bold');
  assert.equal(doc.blocks[4].runs[0].img, 'data:image/png;base64,AAA');
  assert.equal(doc.blocks[5].type, 'hr');
  assert.equal(doc.blocks[6].list, 'number');
});

test('Markdown out round-trips the structure', () => {
  const src = '# Plan\n\nIntro with **bold**, *italic*, ~~gone~~, `code` and a [link](https://x.dev).\n\n- one\n    - nested\n- [x] done\n\n1. a\n2. b\n\n| H1 | H2 |\n| --- | --- |\n| c | d |\n\n---\n\nNote[^1]\n\n[^1]: Footnote text.\n';
  const doc = md(src);
  const out = docToMarkdown(doc);
  const back = md(out);
  assert.deepEqual(texts(back), texts(doc));
  assert.deepEqual(back.blocks.map((b) => b.type === 'p' ? `${b.style ?? ''}${b.list ?? ''}${b.lvl ?? ''}` : b.type), doc.blocks.map((b) => b.type === 'p' ? `${b.style ?? ''}${b.list ?? ''}${b.lvl ?? ''}` : b.type));
  assert.match(out, /\[\^1\]: Footnote text\./);
  assert.match(out, /- \[x\] done/);
  const imgs = [];
  const withImg = md('![a](data:image/png;base64,QUJD)');
  assert.match(docToMarkdown(withImg, { imageRef: (src, n) => { imgs.push(src); return `img-${n}.png`; } }), /!\[a\]\(img-1\.png\)/);
  assert.equal(imgs.length, 1);
  const sug = md('keep this');
  suggestDelete(sug, findAll(sug, 'this')[0], 'w', NOW);
  assert.equal(docToMarkdown(sug).trim(), 'keep', 'exports show suggestions as accepted');
  assert.match(docToMarkdown(sug, { critic: true }), /\{--this--\}\[s\d+\]/);
});

test('HTML: editor markup carries ids, lists, atoms, comments and suggestions', () => {
  const doc = md('## Head\n\n- item\n\nx $a^2$ and note[^1]\n\n[^1]: n');
  addComment(doc, { from: P(2, 0), to: P(2, 1) }, 'c', 'a', NOW);
  suggestInsert(doc, P(0, 4), 'ing', 'w', NOW);
  const html = blocksHtml(doc, { editor: true });
  assert.match(html, /<h2 data-id="b\d+" data-style="h2">Head<ins data-s="s\d+" data-a="w"/);
  assert.match(html, /data-list="bullet" data-lvl="0" data-label="●"/);
  assert.match(html, /<span class="dc-eq" contenteditable="false" data-eq="a\^2">a<sup>2<\/sup><\/span>/);
  assert.match(html, /<sup class="dc-fn" contenteditable="false" data-fn="f\d+">1<\/sup>/);
  assert.match(html, /<span class="dc-c" data-c="c\d+">x<\/span>/);
  assert.doesNotMatch(html, /\n/, 'no whitespace between tags (the editor uses pre-wrap)');
  const page = docToHtml(doc);
  assert.match(page, /@page\{size:8\.5in 11in;margin:1in 1in 1in 1in\}/);
  assert.match(page, /<ol class="footnotes"><li id="fn-1">n/);
  assert.doesNotMatch(page, /data-c=|<ins/);
  assert.equal(eqToText('\\frac{a}{b} + \\alpha^2'), '(a)/(b) + α^2');
  assert.match(eqToHtml('x_{i}'), /x<sub>i<\/sub>/);
});

test('plain text export and templates', () => {
  const doc = templateDoc('meeting', 'Weekly sync', '2026-11-25');
  assert.equal(doc.blocks[0].style, 'title');
  assert.ok(outline(doc).some((o) => o.text === 'Action items'));
  const txt = docToText(doc);
  assert.match(txt, /^Weekly sync\n2026-11-25 · Meeting notes/);
  assert.match(txt, /1\. Topic one/);
  assert.match(txt, /☐ Owner — task — due date/);
  const report = templateDoc('report', 'R', 'd');
  assert.ok(report.blocks.some((b) => b.type === 'toc'));
  assert.ok(report.blocks.some((b) => b.type === 'table'));
  assert.equal(report.footer.text, '{page}');
  for (const id of ['blank', 'proposal']) assert.equal(normalizeDoc(JSON.parse(serializeDoc(templateDoc(id, 'x', 'd')))).warnings.length, 0);
});

test('agent ops apply all-or-nothing and log what they did', () => {
  let doc = md('# Intro\n\nHello world.\n\n# Goals\n\nShip it.');
  doc = run(doc, [
    { op: 'insert', markdown: '- fast\n- safe', under: 'Goals' },
    { op: 'style', block: 2, align: 'justify', line_height: 1.5 },
    { op: 'format', find: 'world', bold: true, color: '#c00000' },
    { op: 'replace_text', find: 'Ship', replace: 'Deliver' },
    { op: 'table', data: [['Name', 'Owner'], ['A', 'B']], header: true, after: 'Intro' },
    { op: 'table_insert_row', table: 2 },
    { op: 'table_cell', table: 2, row: 3, col: 1, text: '**C**', bg: '#d9ead3' },
    { op: 'footnote', find: 'Hello', text: 'Greeting.' },
    { op: 'comment', find: 'Deliver', text: 'When?' },
    { op: 'suggest', find: 'fast', replace: 'quick' },
    { op: 'page', size: 'a4', margin: 0.75 },
    { op: 'page_numbers', align: 'center' },
    { op: 'toc', at: 'start' },
    { op: 'equation', tex: 'E=mc^2', block: 'Goals' },
  ]);
  assert.equal(doc.blocks[0].type, 'toc');
  assert.equal(doc.blocks[2].type, 'table');
  assert.equal(doc.blocks[2].rows.length, 3);
  assert.equal(doc.blocks[2].rows[2][0].bg, '#d9ead3');
  assert.equal(doc.page.size, 'a4'); assert.equal(doc.page.margins.left, 0.75);
  assert.deepEqual(doc.footer, { text: '{page}', align: 'center' });
  assert.equal(doc.comments.length, 1); assert.equal(doc.suggestions.length, 2);
  assert.ok(texts(doc).includes('Deliver it.'));
  assert.ok(doc.blocks.some((b) => b.type === 'p' && b.list === 'bullet' && paraText(b).startsWith('fast')));
  const bad = applyOps(doc, [{ op: 'delete', block: 1 }, { op: 'format', find: 'nowhere', bold: true }], O);
  assert.match(bad.error, /^op 2 \(format\): "nowhere" was not found/);
  assert.equal(bad.doc, doc, 'nothing changes when an op fails');
  assert.match(applyOps(doc, [{ op: 'style', block: 99, style: 'h1' }], O).error, /block 99 does not exist/);
  assert.match(applyOps(doc, [{ op: 'warp' }], O).error, /unknown op/);
  const moved = run(doc, [{ op: 'move', section: 'Goals', before: 'Intro' }]);
  assert.ok(outline(moved).findIndex((o) => o.text === 'Goals') < outline(moved).findIndex((o) => o.text === 'Intro'));
  const accepted = run(doc, [{ op: 'accept', all: true }]);
  assert.ok(texts(accepted).some((t) => t.startsWith('quick')));
  const del = run(doc, [{ op: 'delete', section: 'Goals' }]);
  assert.ok(!outline(del).some((o) => o.text === 'Goals'));
  assert.deepEqual(parseOps({}).errors, ['ops must be an array of {op: …} objects']);
});

test('docs_read text shows numbered blocks, marks, comments and suggestions; review flags problems', () => {
  let doc = md('# A\n\n#### Skipped\n\nThe the cat  sat. ![](data:image/png;base64,AAAA)\n\n[here](https://x.dev)');
  doc = run(doc, [{ op: 'comment', find: 'cat', text: 'Dog?' }, { op: 'suggest', find: 'sat', replace: 'stood' }]);
  const text = readDoc(doc);
  assert.match(text, /^"T" — Letter portrait/);
  assert.match(text, /\[1\] b\d+ h1: A/);
  assert.match(text, /\{==cat==\}\[c\d+\]/);
  assert.match(text, /\{--sat--\}\[s\d+\]\{\+\+stood\+\+\}\[s\d+\]/);
  assert.match(text, /Comments:\n- c\d+ \(open\) writer/);
  assert.match(summarizeDoc(doc), /1 open comment\(s\) · 2 suggestion\(s\)/);
  const review = reviewDoc(doc).join('\n');
  assert.match(review, /skips a heading level/);
  assert.match(review, /repeated word "The the"/);
  assert.match(review, /double spaces/);
  assert.match(review, /image without alt text/);
  assert.match(review, /link text "here"/);
  const part = readDoc(doc, { from: 2, to: 2 });
  assert.match(part, /\[2\] b\d+ h4: Skipped/);
  assert.doesNotMatch(part, /\[(1|3)\] b\d+/);
});

test('DOCX export is a valid zip with the Word parts', () => {
  let doc = md('# Heading\n\n**Bold** text with a [link](https://x.dev) and note[^1].\n\n- a\n- b\n\n1. one\n\n| H | I |\n| --- | --- |\n| 1 | 2 |\n\n![pic](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)\n\n[^1]: The note.');
  doc = run(doc, [{ op: 'comment', find: 'text', text: 'ok?' }, { op: 'suggest', find: 'Bold', replace: 'Strong' }, { op: 'header', text: 'Draft' }, { op: 'page_numbers' }, { op: 'page_break', at: 2 }]);
  const bytes = docxBytes(doc);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const names = unzipNames(bytes);
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/footnotes.xml', 'word/comments.xml', 'word/header1.xml', 'word/footer1.xml', 'word/_rels/document.xml.rels', 'word/media/image1.png']) assert.ok(names.includes(n), n);
  const xml = new TextDecoder().decode(bytes);
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(xml, /<w:ins w:id="\d+" w:author="writer"/);
  assert.match(xml, /<w:delText xml:space="preserve">Bold<\/w:delText>/);
  assert.match(xml, /<w:footnoteReference w:id="1"\/>/);
  assert.match(xml, /<w:commentRangeStart w:id="0"\/>/);
  assert.match(xml, /<w:br w:type="page"\/>/);
  assert.match(xml, /<w:gridCol/);
  assert.match(xml, / PAGE /);
});

test('pagination moves blocks that do not fit to the next page and honours page breaks', async () => {
  const { paginate } = await import('../src/extensions/docs/docs.ts');
  // Page text height 100, pages 150 apart.
  const r = paginate([{ top: 0, height: 60 }, { top: 60, height: 30 }, { top: 90, height: 30 }, { top: 120, height: 10, pageBreak: true }, { top: 130, height: 10 }], 100, 150);
  assert.deepEqual(r.pushes, [0, 0, 60, 0, 110]);
  assert.equal(r.pages, 3);
  assert.deepEqual(paginate([{ top: 0, height: 250 }], 100, 150), { pushes: [0], pages: 2 });
  assert.equal(paginate([], 100, 150).pages, 1);
});

test('wordRangeAt finds the word around the caret', async () => {
  const { wordRangeAt } = await import('../src/extensions/docs/docs.ts');
  const doc = md('Hello brave world');
  assert.deepEqual(wordRangeAt(doc, P(0, 8)), { from: P(0, 6), to: P(0, 11) });
  assert.equal(wordRangeAt(doc, P(0, 5)), null, 'at a word edge there is no word to format');
});

test('a table can be addressed by the heading of its section', () => {
  const doc = run(templateDoc('proposal', 'P', 'd'), [{ op: 'table_cell', table: 'Timeline', row: 2, col: 3, text: 'Jan 12' }]);
  const t = doc.blocks.find((b) => b.type === 'table');
  assert.equal(paraText(t.rows[1][2].paras[0]), 'Jan 12');
  assert.match(applyOps(doc, [{ op: 'table_cell', table: 'Summary', row: 1, col: 1, text: 'x' }], O).error, /is not a table/);
});
