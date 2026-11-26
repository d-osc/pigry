/** Editing operations for agents (all-or-nothing, with a log), the compact read-out agents get from docs_read and a
 * writing review. Pure TypeScript with explicit .ts imports — node tests use exactly this. */
import {
  ALIGNS_LIST, DocError, PAGE_SIZES, acceptSuggestion, addComment, cleanupRefs, deleteComment, docListLabels, docStats, emptyPara, ensureTrailingPara, findAll,
  footnoteNumbers, formatRange, insertInline, isTextRun, listSuggestions, makeTable, newId, orderedComments, outline, paraLen, paraText, plainText,
  rejectSuggestion, replaceAll, replaceRange, replyComment, resolveComment, setParaProps, suggestDelete, suggestInsert, tableDeleteCol, tableDeleteRow, tableInsertCol, tableInsertRow,
  tableMerge, tableUnmerge, textBlocks, toggleMark, type Align, type Block, type Doc, type ListKind, type Para, type ParaPatch, type ParaStyle, type Range, type Table,
} from './docs.ts';
import { markdownToBlocks, parseInline, runsToMarkdown, textToBlocks } from './docsFormat.ts';

export type Op = Record<string, unknown> & { op: string };
export interface OpOptions { author: string; now: string }
export interface ApplyResult { doc: Doc; error?: string; log: string[] }

export const OP_HELP = [
  'Blocks are numbered from 1 as docs_read shows them ([3]); a block can also be given by its id ("b12") or by the text of a heading ("Goals").',
  'Where to put new blocks: at ("start" | "end" | n = before block n), after: block, before: block, or under: heading (end of that section). Default: the end.',
  'Text targets: find: "exact text" (occurrence: n, default 1; block: limits the search to one block).',
  '- {op:"insert", markdown:"## Heading\\n\\nText with **bold**, lists, | tables |, [^1] footnotes", after:"Intro"} — or text: plain lines',
  '- {op:"replace", block:4, markdown:"…"} (or from:4, to:7, or section:"Goals" = the heading and everything under it)',
  '- {op:"delete", block:5} / {op:"delete", from:5, to:8} / {op:"delete", section:"Old part"}',
  '- {op:"move", block:6, before:2} (or from/to, after, at)',
  '- {op:"style", block:3, style:"normal|title|subtitle|h1…h6", align:"left|center|right|justify", line_height:1.5, space_before:12, space_after:6, indent:1, list:"bullet|number|check|none", level:0, checked:true} (block, from/to or all:true)',
  '- {op:"replace_text", find:"colour", replace:"color", all:true, match_case:false, whole_word:false, regex:false}',
  '- {op:"format", find:"Total", occurrence:2 | all:true, bold, italic, underline, strike, superscript, subscript, code, color:"#c00000", highlight:"#fff2cc", font:"Georgia", size:14, link:"https://…", clear:true} (or block: n for a whole block)',
  '- {op:"title", title:"…"} · {op:"page", size:"letter|a4|legal|a5|tabloid|executive", orientation:"portrait|landscape", margins:{top,right,bottom,left} | margin:1 (inches), color:"#fffbea"} · {op:"font", family:"Georgia", size:12}',
  '- {op:"header", text:"Draft — {title}", align:"right"} · {op:"footer", text:"Page {page} of {pages}", align:"center"} (fields {page} {pages} {title} {date}; text:"" removes) · {op:"page_numbers", where:"footer", align:"right"}',
  '- {op:"table", rows:3, cols:4, data:[["Name","Owner"],…], header:true, widths:[2,1,1,1], after:"Timeline"} · {op:"table_cell", table:7, row:2, col:3, text:"**Done**", bg:"#d9ead3"}',
  '- {op:"table_insert_row", table:7, at:3} (before row 3; default the end) · table_delete_row {table,row} · table_insert_col {table,at} · table_delete_col {table,col} · {op:"table_merge", table:7, row:1, col:1, rows:1, cols:3} · {op:"table_unmerge", table:7, row:1, col:1}',
  '- {op:"hr"} · {op:"page_break"} · {op:"toc"} (table of contents from the headings) — all take a location',
  '- {op:"image", src:"data:image/png;base64,…" (docs_edit also takes path: a workspace image), width:400, alt:"Chart of …"} + location, or find: to put it inline after that text',
  '- {op:"equation", tex:"E = mc^2", find:"energy"} (inline after the text; or block: n = end of that block; or a location = its own paragraph)',
  '- {op:"footnote", find:"claim", text:"Source: …"}',
  '- {op:"comment", find:"this sentence", text:"Is this still true?"} · {op:"reply", id:"c3", text:"…"} · {op:"resolve", id:"c3"} (reopen:true) · {op:"delete_comment", id:"c3"}',
  '- {op:"suggest", find:"utilise", replace:"use"} — a tracked change the user accepts or rejects; also delete:true, insert_before:"…", insert_after:"…"',
  '- {op:"accept", id:"s4"} / {op:"reject", id:"s4"} / all:true',
].join('\n');

const fail = (message: string): never => { throw new DocError(message); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/* ---------------- locating blocks and text ---------------- */

/** Block reference → index in doc.blocks. Numbers are 1-based; strings are ids or heading text. */
export function blockIndex(doc: Doc, ref: unknown, what = 'block'): number {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1 || n > doc.blocks.length) fail(`${what} ${String(ref)} does not exist (the document has ${doc.blocks.length} blocks)`);
    return n - 1;
  }
  if (typeof ref !== 'string' || !ref.trim()) return fail(`${what} must be a block number, id or heading text`);
  const t = ref.trim();
  const byId = doc.blocks.findIndex((b) => b.id === t);
  if (byId >= 0) return byId;
  const heads = outline(doc);
  const exact = heads.find((h) => h.text.toLowerCase() === t.toLowerCase()) ?? heads.find((h) => h.text.toLowerCase().startsWith(t.toLowerCase()));
  if (exact) return exact.top;
  return fail(`no ${what} "${t}" — use a block number from docs_read, an id like b12 or the text of a heading`);
}
/** The end (exclusive) of the section a heading starts: the next heading of the same or a higher level. */
export function sectionEnd(doc: Doc, top: number): number {
  const b = doc.blocks[top];
  const level = (s?: ParaStyle) => (s === 'title' ? 0 : s && /^h\d$/.test(s) ? Number(s[1]) : 99);
  const own = b.type === 'p' ? level(b.style) : 99;
  for (let i = top + 1; i < doc.blocks.length; i++) { const x = doc.blocks[i]; if (x.type === 'p' && level(x.style) <= own) return i; }
  return doc.blocks.length;
}
/** Where new blocks go (an index in doc.blocks). */
function location(doc: Doc, op: Op): number {
  const end = () => { const last = doc.blocks[doc.blocks.length - 1]; return last.type === 'p' && paraLen(last) === 0 && !last.list && !last.style ? doc.blocks.length - 1 : doc.blocks.length; };
  if (op.after !== undefined) return blockIndex(doc, op.after) + 1;
  if (op.before !== undefined) return blockIndex(doc, op.before);
  if (op.under !== undefined) { const top = blockIndex(doc, op.under, 'heading'); return sectionEnd(doc, top); }
  if (op.at === 'start') return 0;
  if (op.at === undefined || op.at === 'end') return end();
  const n = Number(op.at);
  if (!Number.isInteger(n) || n < 1 || n > doc.blocks.length + 1) fail(`at must be "start", "end" or 1…${doc.blocks.length + 1}`);
  return n - 1;
}
/** from/to, block or section → [start, end) in doc.blocks. */
function blockSpan(doc: Doc, op: Op): [number, number] {
  if (op.section !== undefined) { const top = blockIndex(doc, op.section, 'section'); return [top, sectionEnd(doc, top)]; }
  if (op.from !== undefined || op.to !== undefined) {
    const a = blockIndex(doc, op.from ?? op.to), b = blockIndex(doc, op.to ?? op.from);
    return [Math.min(a, b), Math.max(a, b) + 1];
  }
  if (op.block !== undefined) { const i = blockIndex(doc, op.block); return [i, i + 1]; }
  return fail('say which blocks: block, from/to or section');
}
/** find (+ occurrence, block) → a range in one paragraph. */
function findRange(doc: Doc, op: Op, all = false): Range[] {
  const find = typeof op.find === 'string' ? op.find : '';
  if (!find) fail('find must be the exact text to act on');
  let ranges = findAll(doc, find, { matchCase: op.match_case === true, wholeWord: op.whole_word === true, regex: op.regex === true });
  if (op.block !== undefined) {
    const top = blockIndex(doc, op.block);
    const tbs = textBlocks(doc);
    ranges = ranges.filter((r) => tbs[r.from.b].top === top);
  }
  if (!ranges.length) {
    const loose = findAll(doc, find, { matchCase: false });
    return fail(`"${short(find)}" was not found${loose.length && op.match_case === true ? ' with that case (it is there in another case)' : ''}${op.block !== undefined ? ' in that block' : ''} — copy the text exactly from docs_read (formatting marks like ** are not part of the text)`);
  }
  if (all || op.all === true) return ranges;
  const n = op.occurrence === undefined ? 1 : Number(op.occurrence);
  if (!Number.isInteger(n) || n < 1 || n > ranges.length) fail(`occurrence ${String(op.occurrence)} does not exist ("${short(find)}" occurs ${ranges.length} time(s))`);
  return [ranges[n - 1]];
}
function tableAt(doc: Doc, ref: unknown): { top: number; t: Table } {
  let top = blockIndex(doc, ref, 'table');
  // A heading stands for the first table in its section.
  if (doc.blocks[top].type === 'p') {
    const end = sectionEnd(doc, top);
    const inside = doc.blocks.findIndex((b, i) => i > top && i < end && b.type === 'table');
    if (inside >= 0) top = inside;
  }
  const t = doc.blocks[top];
  if (t.type !== 'table') fail(`block ${top + 1} is not a table (it is ${t.type === 'p' ? 'a paragraph' : t.type})`);
  return { top, t: t as Table };
}
const int1 = (v: unknown, what: string, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${what} must be 1…${max}`);
  return n - 1;
};
const COLOR = /^#[0-9a-f]{6}$/i;
const colorOf = (v: unknown, what: string): string | null => {
  if (v === null || v === '' || v === 'none') return null;
  if (typeof v !== 'string' || !COLOR.test(v)) return fail(`${what} must be a colour like #1a73e8`);
  return v.toLowerCase();
};
function blocksFrom(doc: Doc, op: Op): Block[] {
  if (typeof op.markdown === 'string') return markdownToBlocks(doc, op.markdown);
  if (typeof op.text === 'string') return textToBlocks(doc, op.text);
  return fail('give markdown (or text)');
}

/* ---------------- ops ---------------- */

const STYLE_NAMES: Record<string, ParaStyle> = { normal: 'normal', text: 'normal', title: 'title', subtitle: 'subtitle', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', heading1: 'h1', heading2: 'h2', heading3: 'h3', heading4: 'h4', heading5: 'h5', heading6: 'h6' };

function step(doc: Doc, op: Op, o: OpOptions, log: string[]): void {
  switch (op.op) {
    case 'insert': {
      const at = location(doc, op);
      const blocks = blocksFrom(doc, op);
      if (!blocks.length) fail('nothing to insert');
      doc.blocks.splice(at, 0, ...blocks);
      log.push(`inserted ${blocks.length} block(s) at [${at + 1}]`);
      return;
    }
    case 'replace': {
      const [a, z] = blockSpan(doc, op);
      const blocks = blocksFrom(doc, op);
      doc.blocks.splice(a, z - a, ...blocks);
      log.push(`replaced [${a + 1}${z - a > 1 ? `–${z}` : ''}] with ${blocks.length} block(s)`);
      return;
    }
    case 'delete': {
      const [a, z] = blockSpan(doc, op);
      doc.blocks.splice(a, z - a);
      if (!doc.blocks.length) doc.blocks.push(emptyPara(newId(doc, 'b')));
      log.push(`deleted [${a + 1}${z - a > 1 ? `–${z}` : ''}]`);
      return;
    }
    case 'move': {
      const [a, z] = blockSpan(doc, { ...op, after: undefined, before: undefined, at: undefined } as Op);
      const target = location(doc, op);
      if (target > a && target < z) fail('cannot move blocks into themselves');
      const moved = doc.blocks.splice(a, z - a);
      const dest = target > a ? target - moved.length : target;
      doc.blocks.splice(dest, 0, ...moved);
      log.push(`moved [${a + 1}${z - a > 1 ? `–${z}` : ''}] to [${dest + 1}]`);
      return;
    }
    case 'style': {
      const span = op.all === true ? [0, doc.blocks.length] as [number, number] : blockSpan(doc, op);
      const patch: ParaPatch = {};
      if (op.style !== undefined) { const s = STYLE_NAMES[String(op.style).toLowerCase().replace(/[\s_-]/g, '')]; if (!s) fail('style must be normal, title, subtitle or h1…h6'); patch.style = s; if (s !== 'normal') { patch.list = null; } }
      if (op.align !== undefined) { if (!ALIGNS_LIST.includes(String(op.align) as Align)) fail('align must be left, center, right or justify'); patch.align = op.align as Align; }
      if (op.line_height !== undefined) { const n = Number(op.line_height); if (!(n >= 0.5 && n <= 5)) fail('line_height must be 0.5…5 (1, 1.15, 1.5, 2)'); patch.lh = n === 1.15 ? null : n; }
      if (op.space_before !== undefined) { const n = Number(op.space_before); if (!(n >= 0 && n <= 200)) fail('space_before is points 0…200'); patch.sb = n; }
      if (op.space_after !== undefined) { const n = Number(op.space_after); if (!(n >= 0 && n <= 200)) fail('space_after is points 0…200'); patch.sa = n; }
      if (op.indent !== undefined) patch.ind = Number(op.indent) || 0;
      if (op.list !== undefined) { const l = String(op.list); if (l === 'none' || op.list === null) patch.list = null; else if (l === 'bullet' || l === 'number' || l === 'check') patch.list = l as ListKind; else fail('list must be bullet, number, check or none'); }
      if (op.level !== undefined) patch.lvl = Number(op.level) || 0;
      if (op.checked !== undefined) patch.checked = op.checked === true;
      if (!Object.keys(patch).length) fail('give style, align, line_height, space_before, space_after, indent, list, level or checked');
      let n = 0;
      for (let i = span[0]; i < span[1]; i++) {
        const b = doc.blocks[i];
        const paras = b.type === 'p' ? [b] : b.type === 'table' && op.all !== true ? b.rows.flatMap((r) => r.flatMap((c) => c.paras)) : [];
        for (const p of paras) { setParaProps(p, patch); n++; }
      }
      if (!n) fail('there is no paragraph there to style');
      log.push(`styled ${n} paragraph(s) [${span[0] + 1}${span[1] - span[0] > 1 ? `–${span[1]}` : ''}]: ${Object.entries(patch).map(([k, v]) => `${k}=${v ?? 'none'}`).join(', ')}`);
      return;
    }
    case 'replace_text': {
      const find = typeof op.find === 'string' ? op.find : '';
      if (!find) fail('find is empty');
      const repl = typeof op.replace === 'string' ? op.replace : fail('replace must be text ("" removes)');
      const opts = { matchCase: op.match_case === true, wholeWord: op.whole_word === true, regex: op.regex === true };
      if (op.all === false || op.occurrence !== undefined || op.block !== undefined) {
        const [r] = findRange(doc, op);
        const tbs = textBlocks(doc);
        const text = paraText(tbs[r.from.b].para).slice(r.from.o, r.to.o);
        const out = opts.regex ? text.replace(new RegExp(find, opts.matchCase ? 'u' : 'iu'), repl) : repl;
        replaceRange(doc, r, out);
        log.push(`replaced "${short(text, 40)}" in [${tbs[r.from.b].top + 1}]`);
        return;
      }
      const n = replaceAll(doc, find, repl, opts);
      if (!n) fail(`"${short(find)}" was not found`);
      log.push(`replaced ${n} × "${short(find, 40)}" → "${short(repl, 40)}"`);
      return;
    }
    case 'format': {
      const ranges: Range[] = op.find !== undefined ? findRange(doc, op) : (() => {
        const [a, z] = blockSpan(doc, op);
        const tbs = textBlocks(doc);
        const idx = tbs.map((t, i) => ({ t, i })).filter(({ t }) => t.top >= a && t.top < z);
        if (!idx.length) fail('there is no text there');
        return idx.map(({ t, i }) => ({ from: { b: i, o: 0 }, to: { b: i, o: paraLen(t.para) } }));
      })();
      const patch: Record<string, unknown> = {};
      const flag = (key: string, mark: string) => { if (op[key] !== undefined) patch[mark] = op[key] === true ? true : null; };
      flag('bold', 'b'); flag('italic', 'i'); flag('underline', 'u'); flag('strike', 's'); flag('superscript', 'sup'); flag('subscript', 'sub'); flag('code', 'code');
      if (op.color !== undefined) patch.color = colorOf(op.color, 'color');
      if (op.highlight !== undefined) patch.bg = colorOf(op.highlight, 'highlight');
      if (op.font !== undefined) patch.font = typeof op.font === 'string' && op.font.trim() ? op.font.trim() : null;
      if (op.size !== undefined) { const n = Number(op.size); if (op.size !== null && !(n >= 1 && n <= 400)) fail('size is points 1…400'); patch.size = op.size === null ? null : n; }
      if (op.link !== undefined) { const l = typeof op.link === 'string' ? op.link.trim() : ''; if (l && !/^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+\.\w)/i.test(l)) fail('link must be a URL'); patch.link = l || null; }
      if (op.clear === true) for (const k of ['b', 'i', 'u', 's', 'sup', 'sub', 'code', 'color', 'bg', 'font', 'size']) if (!(k in patch)) patch[k] = null;
      if (!Object.keys(patch).length) fail('say what to change: bold, italic, underline, strike, superscript, subscript, code, color, highlight, font, size, link or clear');
      for (const r of ranges) formatRange(doc, r, patch);
      log.push(`formatted ${ranges.length} place(s): ${Object.entries(patch).map(([k, v]) => `${k}=${v ?? 'off'}`).join(', ')}`);
      return;
    }
    case 'toggle': { const [r] = findRange(doc, op); const mark = String(op.mark ?? 'b'); if (!['b', 'i', 'u', 's', 'sup', 'sub', 'code'].includes(mark)) fail('mark must be b, i, u, s, sup, sub or code'); toggleMark(doc, r, mark as 'b'); log.push(`toggled ${mark}`); return; }
    case 'title': { const t = String(op.title ?? '').trim(); if (!t) fail('title is empty'); doc.title = t.slice(0, 300); log.push(`title "${short(t)}"`); return; }
    case 'page': {
      if (op.size !== undefined) { if (!(String(op.size) in PAGE_SIZES)) fail(`size must be ${Object.keys(PAGE_SIZES).join(', ')}`); doc.page.size = op.size as Doc['page']['size']; }
      if (op.orientation !== undefined) { if (op.orientation !== 'portrait' && op.orientation !== 'landscape') fail('orientation must be portrait or landscape'); doc.page.orientation = op.orientation as 'portrait' | 'landscape'; }
      const setM = (k: keyof Doc['page']['margins'], v: unknown) => { const n = Number(v); if (!(n >= 0 && n <= 4)) fail('margins are inches 0…4'); doc.page.margins[k] = n; };
      if (op.margin !== undefined) for (const k of ['top', 'right', 'bottom', 'left'] as const) setM(k, op.margin);
      if (isObj(op.margins)) for (const k of ['top', 'right', 'bottom', 'left'] as const) if (op.margins[k] !== undefined) setM(k, op.margins[k]);
      if (op.color !== undefined) { const c = colorOf(op.color, 'color'); if (c && c !== '#ffffff') doc.page.color = c; else delete doc.page.color; }
      log.push(`page ${doc.page.size} ${doc.page.orientation}, margins ${['top', 'right', 'bottom', 'left'].map((k) => doc.page.margins[k as 'top']).join('/')} in`);
      return;
    }
    case 'font': {
      if (op.family !== undefined) { const f = String(op.family).trim(); if (!f) fail('family is empty'); doc.font.family = f; }
      if (op.size !== undefined) { const n = Number(op.size); if (!(n >= 6 && n <= 96)) fail('size must be 6…96 pt'); doc.font.size = n; }
      log.push(`default font ${doc.font.family} ${doc.font.size}pt`);
      return;
    }
    case 'header': case 'footer': {
      const k = op.op as 'header' | 'footer';
      const text = String(op.text ?? '');
      if (!text.trim()) { delete doc[k]; log.push(`removed the ${k}`); return; }
      const align = op.align === undefined ? doc[k]?.align : String(op.align);
      if (align !== undefined && !ALIGNS_LIST.includes(align as Align)) fail('align must be left, center, right or justify');
      doc[k] = { text: text.slice(0, 1000), ...(align && align !== 'left' ? { align: align as Align } : {}) };
      if (op.first_page_different !== undefined) { if (op.first_page_different === true) doc.firstPageDifferent = true; else delete doc.firstPageDifferent; }
      log.push(`${k}: "${short(text)}"`);
      return;
    }
    case 'page_numbers': {
      const k = op.where === 'header' ? 'header' : 'footer';
      const align = String(op.align ?? 'right');
      if (!ALIGNS_LIST.includes(align as Align)) fail('align must be left, center or right');
      const text = String(op.format ?? '{page}');
      doc[k] = { text, ...(align !== 'left' ? { align: align as Align } : {}) };
      log.push(`page numbers in the ${k} (${align})`);
      return;
    }
    case 'table': {
      const data = Array.isArray(op.data) ? op.data.filter(Array.isArray).map((r) => (r as unknown[]).map((x) => (x === null || x === undefined ? '' : String(x)))) : undefined;
      const rows = Number(op.rows ?? data?.length ?? 0), cols = Number(op.cols ?? Math.max(0, ...(data ?? []).map((r) => r.length)));
      if (!(rows >= 1 && rows <= 500) || !(cols >= 1 && cols <= 50)) fail('a table needs rows 1…500 and cols 1…50 (or data)');
      const at = location(doc, op);
      const t = makeTable(doc, rows, cols);
      t.rows.forEach((row, r) => row.forEach((cell, c) => { const text = data?.[r]?.[c]; if (text) cell.paras[0].runs = parseInline(text); }));
      if (op.header === true) for (const cell of t.rows[0]) { cell.bg = '#f3f3f3'; cell.paras[0].runs = cell.paras[0].runs.map((x) => ({ ...x, b: true })); }
      if (Array.isArray(op.widths)) { const w = op.widths.map(Number); if (w.length !== cols || w.some((x) => !(x > 0))) fail(`widths needs ${cols} positive numbers`); t.widths = w; }
      doc.blocks.splice(at, 0, t);
      log.push(`table ${rows}×${cols} at [${at + 1}]`);
      return;
    }
    case 'table_cell': {
      const { t } = tableAt(doc, op.table);
      const r = int1(op.row, 'row', t.rows.length), c = int1(op.col, 'col', t.rows[0].length);
      const cell = t.rows[r][c];
      if (cell.hidden) fail(`row ${r + 1} col ${c + 1} is covered by a merged cell — address its top-left cell`);
      if (op.text !== undefined) {
        const lines = String(op.text).split('\n');
        cell.paras = lines.map((line) => ({ ...emptyPara(newId(doc, 'b')), runs: parseInline(line) }));
      }
      if (op.bg !== undefined) { const bg = colorOf(op.bg, 'bg'); if (bg) cell.bg = bg; else delete cell.bg; }
      if (op.align !== undefined) { if (!ALIGNS_LIST.includes(String(op.align) as Align)) fail('align must be left, center, right or justify'); for (const p of cell.paras) setParaProps(p, { align: op.align as Align }); }
      log.push(`cell r${r + 1}c${c + 1} set`);
      return;
    }
    case 'table_insert_row': { const { top, t } = tableAt(doc, op.table); const at = op.at === undefined ? t.rows.length : int1(op.at, 'at', t.rows.length + 1); tableInsertRow(doc, top, at); log.push(`row inserted at ${at + 1}`); return; }
    case 'table_delete_row': { const { top, t } = tableAt(doc, op.table); const r = int1(op.row, 'row', t.rows.length); tableDeleteRow(doc, top, r); log.push(`row ${r + 1} deleted`); return; }
    case 'table_insert_col': { const { top, t } = tableAt(doc, op.table); const at = op.at === undefined ? t.rows[0].length : int1(op.at, 'at', t.rows[0].length + 1); tableInsertCol(doc, top, at); log.push(`column inserted at ${at + 1}`); return; }
    case 'table_delete_col': { const { top, t } = tableAt(doc, op.table); const c = int1(op.col, 'col', t.rows[0].length); tableDeleteCol(doc, top, c); log.push(`column ${c + 1} deleted`); return; }
    case 'table_merge': {
      const { top, t } = tableAt(doc, op.table);
      const r = int1(op.row, 'row', t.rows.length), c = int1(op.col, 'col', t.rows[0].length);
      const rows = Number(op.rows ?? 1), cols = Number(op.cols ?? 1);
      if (!(rows >= 1) || !(cols >= 1)) fail('rows and cols must be at least 1');
      tableMerge(doc, top, r, c, r + rows - 1, c + cols - 1);
      log.push(`merged r${r + 1}c${c + 1} over ${rows}×${cols}`);
      return;
    }
    case 'table_unmerge': { const { top, t } = tableAt(doc, op.table); tableUnmerge(doc, top, int1(op.row, 'row', t.rows.length), int1(op.col, 'col', t.rows[0].length)); log.push('unmerged'); return; }
    case 'hr': case 'page_break': case 'toc': {
      const at = location(doc, op);
      const type = op.op === 'page_break' ? 'pagebreak' : op.op;
      doc.blocks.splice(at, 0, { type, id: newId(doc, 'b') } as Block);
      log.push(`${op.op} at [${at + 1}]`);
      return;
    }
    case 'image': {
      const src = typeof op.src === 'string' ? op.src : '';
      if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(src) && !/^https?:\/\//i.test(src)) fail('src must be a data:image/… URL (docs_edit accepts path: for a workspace image)');
      const run = { img: src, ...(Number(op.width) > 0 ? { w: Math.round(Number(op.width)) } : {}), ...(Number(op.height) > 0 ? { h: Math.round(Number(op.height)) } : {}), ...(typeof op.alt === 'string' && op.alt ? { alt: op.alt.slice(0, 500) } : {}) };
      if (op.find !== undefined) { const [r] = findRange(doc, op); insertInline(doc, r.to, run); log.push('image inserted inline'); return; }
      const at = location(doc, op);
      doc.blocks.splice(at, 0, { ...emptyPara(newId(doc, 'b')), ...(op.align ? { align: op.align as Align } : { align: 'center' as Align }), runs: [run] });
      log.push(`image at [${at + 1}]${run.alt ? '' : ' (no alt text — add alt: for accessibility)'}`);
      return;
    }
    case 'equation': {
      const tex = String(op.tex ?? '').trim();
      if (!tex) fail('tex is empty');
      if (op.find !== undefined) { const [r] = findRange(doc, op); insertInline(doc, r.to, { eq: tex }); log.push('equation inline'); return; }
      if (op.block !== undefined && op.after === undefined) {
        const top = blockIndex(doc, op.block);
        const tbs = textBlocks(doc);
        const i = tbs.map((t, k) => ({ t, k })).filter(({ t }) => t.top === top).pop();
        if (!i) fail('that block has no text');
        insertInline(doc, { b: i!.k, o: paraLen(i!.t.para) }, { eq: tex });
        log.push(`equation at the end of [${top + 1}]`);
        return;
      }
      const at = location(doc, op);
      doc.blocks.splice(at, 0, { ...emptyPara(newId(doc, 'b')), align: 'center', runs: [{ eq: tex }] });
      log.push(`equation at [${at + 1}]`);
      return;
    }
    case 'footnote': {
      const text = String(op.text ?? '').trim();
      if (!text) fail('footnote text is empty');
      const [r] = findRange(doc, op);
      const id = newId(doc, 'f');
      doc.footnotes.push({ id, text });
      insertInline(doc, r.to, { fn: id });
      log.push(`footnote ${id} after "${short(String(op.find), 30)}"`);
      return;
    }
    case 'comment': {
      const [r] = findRange(doc, op);
      const id = addComment(doc, r, String(op.text ?? ''), o.author, o.now);
      log.push(`comment ${id} on "${short(String(op.find), 40)}"`);
      return;
    }
    case 'reply': replyComment(doc, String(op.id ?? ''), String(op.text ?? ''), o.author, o.now); log.push(`replied to ${String(op.id)}`); return;
    case 'resolve': resolveComment(doc, String(op.id ?? ''), op.reopen !== true); log.push(`${op.reopen === true ? 'reopened' : 'resolved'} ${String(op.id)}`); return;
    case 'delete_comment': deleteComment(doc, String(op.id ?? '')); log.push(`deleted comment ${String(op.id)}`); return;
    case 'suggest': {
      const [r] = findRange(doc, op);
      const ids: string[] = [];
      if (typeof op.insert_after === 'string' && op.insert_after) ids.push(suggestInsert(doc, r.to, op.insert_after, o.author, o.now).id);
      if (op.delete === true || typeof op.replace === 'string') {
        const sid = suggestDelete(doc, r, o.author, o.now);
        ids.push(sid);
        if (typeof op.replace === 'string' && op.replace) ids.push(suggestInsert(doc, r.to, op.replace, o.author, o.now).id);
      }
      if (typeof op.insert_before === 'string' && op.insert_before) ids.push(suggestInsert(doc, r.from, op.insert_before, o.author, o.now).id);
      if (!ids.length) fail('say what to suggest: replace, delete:true, insert_before or insert_after');
      log.push(`suggested ${ids.join(', ')} at "${short(String(op.find), 40)}"`);
      return;
    }
    case 'accept': case 'reject': {
      const which = op.all === true ? 'all' : String(op.id ?? '');
      if (!which) fail('give id (or all: true)');
      const n = op.op === 'accept' ? acceptSuggestion(doc, which) : rejectSuggestion(doc, which);
      log.push(`${op.op}ed ${n} suggestion(s)`);
      return;
    }
    default:
      fail(`unknown op "${op.op}" (see the list of operations)`);
  }
}
export function applyOps(doc: Doc, ops: Op[], opts: OpOptions): ApplyResult {
  const next = structuredClone(doc);
  const log: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      if (!isObj(op) || typeof op.op !== 'string') fail('each op needs "op"');
      step(next, op, opts, log);
    } catch (e) {
      const msg = e instanceof DocError ? e.message : e instanceof Error ? e.message : String(e);
      return { doc, error: `op ${i + 1} (${isObj(op) ? String(op.op) : '?'}): ${msg}`, log };
    }
  }
  ensureTrailingPara(next);
  cleanupRefs(next);
  return { doc: next, log };
}
export function parseOps(value: unknown): { ops: Op[]; errors: string[] } {
  if (!Array.isArray(value)) return { ops: [], errors: ['ops must be an array of {op: …} objects'] };
  const ops: Op[] = [], errors: string[] = [];
  value.forEach((o, i) => { if (isObj(o) && typeof o.op === 'string') ops.push(o as Op); else errors.push(`op ${i + 1} is not an object with "op"`); });
  return { ops, errors };
}

/* ---------------- reading ---------------- */

/** One line about the document: page, font, counts. */
export function summarizeDoc(doc: Doc): string {
  const s = docStats(doc);
  const m = doc.page.margins;
  return `"${doc.title}" — ${PAGE_SIZES[doc.page.size].label.split(' (')[0]} ${doc.page.orientation}, margins ${m.top}/${m.right}/${m.bottom}/${m.left} in, ${doc.font.family} ${doc.font.size}pt · ${doc.blocks.length} blocks · ${s.words} words · ${s.tables} table(s) · ${s.images} image(s) · ${s.comments} open comment(s) · ${s.suggestions} suggestion(s)`;
}

/** The document for an agent: every block numbered with its id and kind, inline Markdown with {++insert++}[s1],
 * {--delete--}[s2] and {==commented==}[c1] marks, then comments, suggestions and footnotes. */
export function readDoc(doc: Doc, opts: { from?: number; to?: number; limit?: number } = {}): string {
  const fns = footnoteNumbers(doc);
  const labels = docListLabels(doc);
  const md = (p: Para) => runsToMarkdown(p.runs, fns, { critic: true, comments: true, imageRef: (src) => (src.startsWith('data:') ? `data:…(${Math.round(src.length * 0.75 / 1024)} KB)` : src) });
  const lines: string[] = [summarizeDoc(doc)];
  if (doc.header) lines.push(`Header (${doc.header.align ?? 'left'}): ${doc.header.text}`);
  if (doc.footer) lines.push(`Footer (${doc.footer.align ?? 'left'}): ${doc.footer.text}`);
  const from = Math.max(1, opts.from ?? 1), to = Math.min(doc.blocks.length, opts.to ?? doc.blocks.length);
  let chars = 0;
  const limit = opts.limit ?? 60_000;
  lines.push('', 'Blocks:');
  for (let i = from - 1; i < to; i++) {
    const b = doc.blocks[i];
    let line: string;
    if (b.type === 'p') {
      const style = b.style ?? 'normal';
      const extra = [b.align && b.align !== 'left' ? b.align : '', b.lh ? `line ${b.lh}` : '', b.ind ? `indent ${b.ind}` : ''].filter(Boolean).join(', ');
      const kind = b.list ? `${b.list}${b.lvl ? ` L${b.lvl}` : ''} ${labels.get(b) ?? ''}` : style;
      line = `[${i + 1}] ${b.id} ${kind}${extra ? ` (${extra})` : ''}: ${md(b) || '(empty)'}`;
    } else if (b.type === 'table') {
      const merged = b.rows.flat().filter((c) => c.cs || c.rs).length;
      line = `[${i + 1}] ${b.id} table ${b.rows.length}×${b.rows[0].length}${merged ? `, ${merged} merged cell(s)` : ''}:\n` + b.rows.map((row, r) => `    r${r + 1} | ${row.map((c) => (c.hidden ? '⟵merged' : `${c.paras.map(md).join(' / ')}${c.cs || c.rs ? ` ⟨span ${c.rs ?? 1}×${c.cs ?? 1}⟩` : ''}${c.bg ? ` {bg ${c.bg}}` : ''}`)).join(' | ')} |`).join('\n');
    } else line = `[${i + 1}] ${b.id} ${b.type === 'pagebreak' ? 'page break' : b.type === 'hr' ? 'horizontal line' : 'table of contents'}`;
    chars += line.length;
    if (chars > limit) { lines.push(`… cut here: read the rest with from: ${i + 1}`); break; }
    lines.push(line);
  }
  const comments = orderedComments(doc);
  if (comments.length) {
    lines.push('', 'Comments:');
    for (const c of comments) lines.push(`- ${c.id} ${c.resolved ? '(resolved)' : '(open)'} ${c.author}${c.at ? ` ${c.at.slice(0, 16)}` : ''} on "${short(c.quote, 60)}": ${c.text}${c.replies.map((r) => `\n    ↳ ${r.author}: ${r.text}`).join('')}`);
  }
  const sugg = listSuggestions(doc);
  if (sugg.length) {
    lines.push('', 'Suggestions:');
    for (const s of sugg) lines.push(`- ${s.id} ${s.kind === 'ins' ? 'insert' : 'delete'} "${short(s.text, 80)}" by ${s.author} in [${s.block + 1}]`);
  }
  const notes = doc.footnotes.filter((f) => fns.has(f.id)).sort((a, b) => (fns.get(a.id) ?? 0) - (fns.get(b.id) ?? 0));
  if (notes.length) { lines.push('', 'Footnotes:'); for (const f of notes) lines.push(`[^${fns.get(f.id)}] (${f.id}) ${f.text}`); }
  return lines.join('\n');
}

/** Things a careful editor would flag: structure, accessibility and typing slips. */
export function reviewDoc(doc: Doc): string[] {
  const out: string[] = [];
  let prevLevel = 0;
  const heads = outline(doc);
  if (!heads.length && docStats(doc).words > 300) out.push('no headings — a long document needs headings so readers (and the outline) can navigate it');
  for (const h of heads) {
    if (h.level > 1 && h.level > prevLevel + 1 && prevLevel > 0) out.push(`[${h.top + 1}] "${short(h.text, 40)}" skips a heading level (H${prevLevel} → H${h.level})`);
    if (h.level > 0) prevLevel = h.level;
  }
  if (heads.filter((h) => h.level === 0).length > 1) out.push('more than one Title paragraph');
  doc.blocks.forEach((b, i) => {
    if (b.type === 'p') {
      const text = plainText(b, true);
      if (b.style && b.style !== 'normal' && !text.trim()) out.push(`[${i + 1}] empty ${b.style} paragraph`);
      if (b.style && /^h\d$/.test(b.style) && text.length > 120) out.push(`[${i + 1}] very long heading (${text.length} characters)`);
      const words = text.split(/\s+/).filter(Boolean).length;
      if (!b.style && words > 180) out.push(`[${i + 1}] long paragraph (${words} words) — consider splitting it`);
      for (const s of text.split(/(?<=[.!?])\s+/)) { const n = s.split(/\s+/).filter(Boolean).length; if (n > 45) { out.push(`[${i + 1}] long sentence (${n} words): "${short(s, 50)}"`); break; } }
      const dup = /\b(\w+)\s+\1\b/i.exec(text);
      if (dup && !/^\d+$/.test(dup[1])) out.push(`[${i + 1}] repeated word "${dup[0]}"`);
      if (/\S {2,}\S/.test(text)) out.push(`[${i + 1}] double spaces`);
      for (const r of b.runs) {
        if ('img' in r && !r.alt) out.push(`[${i + 1}] image without alt text`);
        if (r.link !== undefined && !r.link.trim()) out.push(`[${i + 1}] empty link`);
        if (isTextRun(r) && r.link && /^(click here|here|link|this)$/i.test(r.t.trim())) out.push(`[${i + 1}] link text "${r.t.trim()}" does not say where it goes`);
      }
      const prev = doc.blocks[i - 1];
      if (prev && prev.type === 'p' && !paraLen(prev) && !paraLen(b) && !b.list && i < doc.blocks.length - 1) out.push(`[${i + 1}] several empty paragraphs used as spacing — use space before/after instead`);
    } else if (b.type === 'table') {
      if (b.rows.length > 1 && !b.rows[0].every((c) => c.hidden || c.paras.every((p) => p.runs.every((r) => !isTextRun(r) || !r.t.trim() || r.b)))) out.push(`[${i + 1}] table without a bold header row`);
    }
  });
  const open = doc.comments.filter((c) => !c.resolved).length;
  if (open) out.push(`${open} open comment(s)`);
  if (doc.suggestions.length) out.push(`${doc.suggestions.length} pending suggestion(s)`);
  return [...new Set(out)].slice(0, 60);
}
