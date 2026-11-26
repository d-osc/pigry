/** The browser side of the Docs editor: reads the editable page back into the document model, turns pasted or
 * imported HTML into blocks, maps the DOM selection to model positions and back, and makes suggesting-mode
 * edits (insertions / deletions) as markup. Needs a DOM, so it is not imported by node tests or pure code. */
import {
  cleanupRefs, emptyPara, newId, normalizeRuns, type Align, type Block, type Cell, type Doc, type ListKind, type Marks, type Para, type ParaStyle, type Pos,
  type Range as DocRange, type Run, type Suggestion, type Table,
} from './docs';

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'ADDRESS', 'BODY', 'CENTER', 'FORM', 'UL', 'OL', 'TABLE', 'HR', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION']);
const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'META', 'TITLE', 'HEAD', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT']);
const isAtom = (el: Element): boolean => el.tagName === 'IMG' || el.hasAttribute('data-fn') || el.hasAttribute('data-eq');
const isBlockEl = (n: Node): n is HTMLElement => n.nodeType === 1 && (BLOCK_TAGS.has((n as Element).tagName) || (n as Element).hasAttribute('data-block'));
const hasBlockChild = (el: Element): boolean => [...el.childNodes].some((c) => isBlockEl(c));

type Mode = 'editor' | 'import';
interface WalkCtx {
  mode: Mode;
  doc: Doc;
  used: Set<string>;
  paraEls: HTMLElement[];
  sugg: Map<string, Suggestion>;
}

/* ---------------- colours and lengths ---------------- */

const NAMED: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500', purple: '#800080' };
export function toHex(css: string | null | undefined): string | undefined {
  if (!css) return undefined;
  const c = css.trim().toLowerCase();
  if (!c || c === 'transparent' || c === 'inherit' || c === 'initial' || c === 'currentcolor') return undefined;
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (m) {
    if (m[4] !== undefined && (m[4] === '0' || parseFloat(m[4]) === 0)) return undefined;
    return `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
  }
  return NAMED[c];
}
/** CSS length → points. */
function toPt(v: string): number | undefined {
  const m = /^(-?[\d.]+)(pt|px|in|cm|mm|em|rem)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const u = m[2] ?? 'px';
  const pt = u === 'pt' ? n : u === 'px' ? n * 0.75 : u === 'in' ? n * 72 : u === 'cm' ? n * 28.3465 : u === 'mm' ? n * 2.83465 : n * 11;
  return Math.round(pt * 2) / 2;
}
const FONT_SIZES_HTML = [0, 7.5, 10, 12, 13.5, 18, 24, 36];
function firstFamily(v: string): string | undefined {
  const f = v.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  if (!f || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit|initial|-apple-system)$/i.test(f)) return undefined;
  return f;
}

/* ---------------- inline content → runs ---------------- */

function marksFrom(el: HTMLElement, m: Marks, ctx: WalkCtx): Marks {
  const n: Marks = { ...m, ...(m.c ? { c: [...m.c] } : {}) };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') n.b = true;
  if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'VAR') n.i = true;
  if (tag === 'U') n.u = true;
  if (tag === 'S' || tag === 'STRIKE') n.s = true;
  if (tag === 'SUP' && !el.hasAttribute('data-fn')) { n.sup = true; delete n.sub; }
  if (tag === 'SUB') { n.sub = true; delete n.sup; }
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') n.code = true;
  if (tag === 'MARK') n.bg = '#ffff00';
  if (tag === 'A') { const href = el.getAttribute('href'); if (href && !href.startsWith('javascript:')) n.link = href; }
  if (tag === 'INS' || tag === 'DEL') {
    const sid = el.getAttribute('data-s');
    if (sid && ctx.mode === 'editor') {
      if (tag === 'INS') { n.ins = sid; delete n.del; } else if (!n.ins) n.del = sid;
      if (!ctx.sugg.has(sid)) ctx.sugg.set(sid, { id: sid, kind: tag === 'INS' ? 'ins' : 'del', author: el.getAttribute('data-a') || 'user', at: el.getAttribute('data-t') || '' });
    } else if (tag === 'INS') n.u = true; else n.s = true;
  }
  if (tag === 'SPAN' && ctx.mode === 'editor') { const c = el.getAttribute('data-c'); if (c) n.c = [...new Set([...(n.c ?? []), ...c.split(/\s+/).filter(Boolean)])]; }
  if (tag === 'FONT') {
    const color = toHex(el.getAttribute('color')); if (color) n.color = color;
    const face = el.getAttribute('face'); if (face) { const f = firstFamily(face); if (f) n.font = f; }
    const size = Number(el.getAttribute('size')); if (size >= 1 && size <= 7) n.size = FONT_SIZES_HTML[size];
  }
  const st = el.style;
  if (st) {
    const fw = st.fontWeight;
    if (fw) { if (fw === 'bold' || fw === 'bolder' || Number(fw) >= 600) n.b = true; else if (fw === 'normal' || fw === 'lighter' || Number(fw) < 600) delete n.b; }
    if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') n.i = true; else if (st.fontStyle === 'normal') delete n.i;
    const td = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
    if (/underline/.test(td)) n.u = true;
    if (/line-through/.test(td)) n.s = true;
    const color = toHex(st.color); if (color) n.color = color;
    const bg = toHex(st.backgroundColor); if (bg && bg !== '#ffffff') n.bg = bg;
    if (st.fontFamily) { const f = firstFamily(st.fontFamily); if (f) n.font = f; }
    if (st.fontSize) { const pt = toPt(st.fontSize); if (pt && pt >= 1 && pt <= 400) n.size = pt; }
    if (st.verticalAlign === 'super') { n.sup = true; delete n.sub; } else if (st.verticalAlign === 'sub') { n.sub = true; delete n.sup; }
  }
  if (ctx.mode === 'import' && n.color === '#000000') delete n.color;
  return n;
}
/** True when nothing visible follows `node` inside `container` (a trailing <br> is only a placeholder). */
function nothingAfter(node: Node, container: Node): boolean {
  for (let n: Node | null = node; n && n !== container; n = n.parentNode) {
    for (let s = n.nextSibling; s; s = s.nextSibling) {
      if (s.nodeType === 3 ? (s.textContent ?? '').length > 0 : s.nodeType === 1 && ((s as Element).querySelector('img,br,[data-fn],[data-eq]') || isAtom(s as Element) || (s as Element).tagName === 'BR' || (s.textContent ?? '').length > 0)) return false;
    }
  }
  return true;
}
function collectRuns(node: Node, marks: Marks, out: Run[], ctx: WalkCtx, container: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      let t = (child.textContent ?? '').replace(/ /g, ' ').replace(/​/g, '');
      if (ctx.mode === 'import') t = t.replace(/[\r\n\t ]+/g, ' ');
      if (t) out.push({ ...marks, t });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    if (SKIP_TAGS.has(el.tagName)) continue;
    if (el.tagName === 'BR') { if (!nothingAfter(el, container)) out.push({ ...marks, t: '\n' }); continue; }
    const m = { ...marks };
    delete m.code;
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src');
      if (!src) continue;
      const img = el as HTMLImageElement;
      const w = Number(el.getAttribute('width')) || (img.style.width.endsWith('px') ? parseFloat(img.style.width) : 0);
      const h = Number(el.getAttribute('height')) || (img.style.height.endsWith('px') ? parseFloat(img.style.height) : 0);
      out.push({ img: src, ...(w > 0 ? { w: Math.round(w) } : {}), ...(h > 0 ? { h: Math.round(h) } : {}), ...(el.getAttribute('alt') ? { alt: el.getAttribute('alt')! } : {}), ...pick(marks) });
      continue;
    }
    if (el.hasAttribute('data-fn')) { if (ctx.mode === 'editor') out.push({ fn: el.getAttribute('data-fn')!, ...pick(marks) }); continue; }
    if (el.hasAttribute('data-eq')) { out.push({ eq: el.getAttribute('data-eq')!, ...pick(marks) }); continue; }
    if (el.getAttribute('contenteditable') === 'false') continue;
    collectRuns(el, marksFrom(el, marks, ctx), out, ctx, container);
  }
}
/** Marks that atoms keep (links, comments, suggestions). */
const pick = (m: Marks): Marks => ({ ...(m.link ? { link: m.link } : {}), ...(m.c ? { c: m.c } : {}), ...(m.ins ? { ins: m.ins } : {}), ...(m.del ? { del: m.del } : {}) });

/* ---------------- blocks ---------------- */

const STYLE_TAGS: Record<string, ParaStyle> = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6' };
function freshId(ctx: WalkCtx, want: string | null): string {
  if (want && /^b\d+$/.test(want) && !ctx.used.has(want)) { ctx.used.add(want); return want; }
  let id: string;
  do { id = newId(ctx.doc, 'b'); } while (ctx.used.has(id));
  ctx.used.add(id);
  return id;
}
function paraFrom(source: HTMLElement | Node[], ctx: WalkCtx, extra: Partial<Para> = {}): Para {
  const el = Array.isArray(source) ? null : source;
  const p: Para = { ...emptyPara(freshId(ctx, ctx.mode === 'editor' ? el?.getAttribute('data-id') ?? null : null)), ...extra };
  const runs: Run[] = [];
  if (el) {
    const tag = el.tagName;
    const ds = el.getAttribute('data-style') as ParaStyle | null;
    const style = ds && /^(title|subtitle|h[1-6])$/.test(ds) ? ds : STYLE_TAGS[tag] ?? (el.classList.contains('title') ? 'title' : el.classList.contains('subtitle') ? 'subtitle' : undefined);
    if (style) p.style = style;
    const st = el.style;
    const align = (st.textAlign || el.getAttribute('align') || '').toLowerCase();
    if (align === 'center' || align === 'right' || align === 'justify') p.align = align as Align;
    if (st.lineHeight) { const lh = /^[\d.]+$/.test(st.lineHeight) ? parseFloat(st.lineHeight) : st.lineHeight.endsWith('%') ? parseFloat(st.lineHeight) / 100 : NaN; if (lh >= 0.5 && lh <= 5 && Math.abs(lh - 1.15) > 0.001) p.lh = Math.round(lh * 100) / 100; }
    if (ctx.mode === 'editor') {
      if (st.marginTop) { const v = toPt(st.marginTop); if (v !== undefined) p.sb = v; }
      if (st.marginBottom) { const v = toPt(st.marginBottom); if (v !== undefined) p.sa = v; }
      const list = el.getAttribute('data-list');
      if (list === 'bullet' || list === 'number' || list === 'check') {
        p.list = list;
        const lvl = Number(el.getAttribute('data-lvl')); if (lvl > 0) p.lvl = Math.min(8, Math.round(lvl));
        if (list === 'check' && el.getAttribute('data-checked') === 'true') p.checked = true;
      } else if (st.marginLeft) { const pt = toPt(st.marginLeft); if (pt && pt > 0) p.ind = Math.min(8, Math.round(pt / 36)); }
    } else if (tag === 'BLOCKQUOTE') p.ind = 1;
    if (tag === 'PRE') { collectRuns(el, { code: true, font: 'Courier New' }, runs, { ...ctx, mode: 'editor' }, el); }
    else collectRuns(el, {}, runs, ctx, el);
    ctx.paraEls.push(el);
  } else {
    const holder = document.createElement('div');
    for (const n of source as Node[]) holder.appendChild(n.cloneNode(true));
    collectRuns(holder, {}, runs, ctx, holder);
  }
  p.runs = normalizeRuns(runs);
  if (ctx.mode === 'import' && p.runs.length) {
    // Collapsed whitespace at the edges of an imported paragraph is not content.
    const first = p.runs[0], last = p.runs[p.runs.length - 1];
    if ('t' in first) first.t = first.t.replace(/^ +/, '');
    if ('t' in last) last.t = last.t.replace(/ +$/, '');
    p.runs = normalizeRuns(p.runs);
  }
  return p;
}
function tableFrom(el: HTMLTableElement, ctx: WalkCtx): Table | null {
  const trs = [...el.rows];
  if (!trs.length) return null;
  const grid: (Cell | undefined)[][] = trs.map(() => []);
  trs.forEach((tr, r) => {
    let c = 0;
    for (const td of [...tr.cells]) {
      while (grid[r][c]) c++;
      const cs = Math.max(1, Math.min(50, td.colSpan || 1)), rs = Math.max(1, Math.min(trs.length - r, td.rowSpan || 1));
      const paras: Block[] = [];
      if (hasBlockChild(td)) walk(td, ctx, paras, 0, true); else if (ctx.mode === 'editor' || (td.textContent ?? '').trim() || td.querySelector('img')) paras.push(paraFrom(td, ctx));
      const cell: Cell = { paras: paras.filter((b): b is Para => b.type === 'p') };
      if (!cell.paras.length) cell.paras = [emptyPara(freshId(ctx, null))];
      if (cs > 1) cell.cs = cs;
      if (rs > 1) cell.rs = rs;
      const bg = toHex(td.style.backgroundColor || td.getAttribute('bgcolor'));
      if (bg && bg !== '#ffffff') cell.bg = bg;
      for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) grid[i][j] = i === r && j === c ? cell : { paras: [], hidden: true };
      c += cs;
    }
  });
  const C = Math.min(50, Math.max(...grid.map((row) => row.length)));
  const rows = grid.map((row) => Array.from({ length: C }, (_, c) => row[c] ?? { paras: [emptyPara(freshId(ctx, null))] }));
  for (const row of rows) for (const cell of row) if (!cell.hidden && (cell.cs ?? 1) > C) cell.cs = C;
  const t: Table = { type: 'table', id: freshId(ctx, ctx.mode === 'editor' ? el.getAttribute('data-id') : null), rows };
  const cols = [...el.querySelectorAll(':scope > colgroup > col')] as HTMLElement[];
  if (cols.length === C) { const w = cols.map((col) => parseFloat(col.style.width) || 0); if (w.every((x) => x > 0)) t.widths = w.map((x) => Math.round(x * 100) / 100); }
  return t;
}
/** Walks the children of a container and appends blocks. `cell`: inside a table cell (no nested tables). */
function walk(container: Element, ctx: WalkCtx, out: Block[], level = 0, cell = false): void {
  let stray: Node[] = [];
  const flush = () => {
    if (stray.some((n) => (n.nodeType === 3 ? (ctx.mode === 'editor' ? (n.textContent ?? '').length > 0 : (n.textContent ?? '').trim().length > 0) : true))) out.push(paraFrom(stray, ctx));
    stray = [];
  };
  for (const child of [...container.childNodes]) {
    if (child.nodeType === 3) { stray.push(child); continue; }
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) && tag !== 'BODY') continue;
    const blockType = el.getAttribute('data-block');
    if (blockType && ctx.mode === 'editor') {
      flush();
      if (!cell && (blockType === 'hr' || blockType === 'pagebreak' || blockType === 'toc')) out.push({ type: blockType, id: freshId(ctx, el.getAttribute('data-id')) } as Block);
      continue;
    }
    if (!isBlockEl(el)) { stray.push(el); continue; }
    flush();
    if (tag === 'HR') { if (!cell) out.push({ type: 'hr', id: freshId(ctx, null) }); continue; }
    if (tag === 'TABLE') {
      if (cell) { for (const td of el.querySelectorAll('td,th')) walk(td, ctx, out, level, true); continue; }
      const t = tableFrom(el as HTMLTableElement, ctx);
      if (t) out.push(t);
      continue;
    }
    if (tag === 'UL' || tag === 'OL') { listFrom(el, ctx, out, level, cell); continue; }
    if (tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' || tag === 'TR' || tag === 'TD' || tag === 'TH') { walk(el, ctx, out, level, cell); continue; }
    if (ctx.mode === 'import' && el.style.pageBreakAfter === 'always' && !el.textContent?.trim()) { if (!cell) out.push({ type: 'pagebreak', id: freshId(ctx, null) }); continue; }
    if (hasBlockChild(el)) { walk(el, ctx, out, level, cell); continue; }
    out.push(paraFrom(el, ctx));
  }
  flush();
}
function listFrom(list: Element, ctx: WalkCtx, out: Block[], level: number, cell: boolean): void {
  const kind: ListKind = list.tagName === 'OL' ? 'number' : 'bullet';
  for (const li of [...list.children]) {
    if (li.tagName !== 'LI') { walk(li, ctx, out, level, cell); continue; }
    const inline: Node[] = [];
    const nested: Element[] = [];
    for (const n of [...li.childNodes]) {
      if (n.nodeType === 1 && ((n as Element).tagName === 'UL' || (n as Element).tagName === 'OL')) nested.push(n as Element);
      else if (n.nodeType === 1 && (n as Element).tagName === 'INPUT') continue;
      else inline.push(n);
    }
    const box = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]') as HTMLInputElement | null;
    const p = paraFrom(inline, ctx, { list: box ? 'check' : kind, ...(level ? { lvl: Math.min(8, level) } : {}), ...(box?.checked || box?.hasAttribute('checked') ? { checked: true } : {}) });
    const first = p.runs[0];
    if (!box && first && 't' in first && /^\[( |x|X)\]\s/.test(first.t)) { p.list = 'check'; if (/^\[(x|X)\]/.test(first.t)) p.checked = true; first.t = first.t.slice(4); p.runs = normalizeRuns(p.runs); }
    out.push(p);
    for (const n of nested) listFrom(n, ctx, out, level + 1, cell);
  }
}

/** Reads the editor surface back into a document (keeping the base's page setup, comments and footnote texts).
 * Also returns the element of every paragraph in text-block order, for selection mapping. */
export function domToDoc(root: HTMLElement, base: Doc): { doc: Doc; paraEls: HTMLElement[] } {
  const doc: Doc = structuredClone({ ...base, blocks: [] as Block[] });
  const ctx: WalkCtx = { mode: 'editor', doc, used: new Set(), paraEls: [], sugg: new Map(base.suggestions.map((s) => [s.id, s])) };
  walk(root, ctx, doc.blocks);
  if (!doc.blocks.length || doc.blocks[doc.blocks.length - 1].type !== 'p') doc.blocks.push(emptyPara(freshId(ctx, null)));
  doc.suggestions = [...ctx.sugg.values()];
  cleanupRefs(doc);
  return { doc, paraEls: ctx.paraEls };
}
/** Pasted or imported HTML → blocks with new ids (comments and suggestions in it are not carried over). */
export function htmlToBlocks(doc: Doc, html: string): Block[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const ctx: WalkCtx = { mode: 'import', doc, used: new Set(), paraEls: [], sugg: new Map() };
  for (const b of doc.blocks) ctx.used.add(b.id);
  const out: Block[] = [];
  walk(parsed.body, ctx, out);
  return out.filter((b, i) => b.type !== 'p' || b.runs.length > 0 || b.style || (i > 0 && i < out.length - 1));
}

/* ---------------- text blocks of the live DOM and the selection ---------------- */

/** Paragraph elements in text-block order (the same walk as domToDoc, without building runs). */
export function paraElements(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (container: Element, cell: boolean) => {
    for (const child of [...container.children] as HTMLElement[]) {
      if (child.hasAttribute('data-block') || SKIP_TAGS.has(child.tagName)) continue;
      if (!isBlockEl(child)) continue;
      const tag = child.tagName;
      if (tag === 'HR') continue;
      if (tag === 'TABLE') { if (cell) { for (const td of child.querySelectorAll('td,th')) visit(td, true); continue; } for (const tr of (child as HTMLTableElement).rows) for (const td of tr.cells) { if (hasBlockChild(td)) visit(td, true); else out.push(td); } continue; }
      if (tag === 'UL' || tag === 'OL' || tag === 'TBODY' || tag === 'TR' || tag === 'TD' || tag === 'TH' || tag === 'THEAD' || tag === 'TFOOT') { visit(child, cell); continue; }
      if (hasBlockChild(child)) { visit(child, cell); continue; }
      out.push(child);
    }
  };
  visit(root, false);
  return out;
}

/** Character offset of a DOM point inside a paragraph element (atoms count 1, a trailing <br> 0). */
export function offsetIn(para: HTMLElement, node: Node, offset: number): number {
  let count = 0;
  let done = false;
  const target = node.nodeType === 3 ? node : node.childNodes[offset] ?? null;
  const visit = (n: Node): void => {
    if (done) return;
    if (n === target && node.nodeType !== 3) { done = true; return; }
    if (n.nodeType === 3) {
      if (n === node) { count += Math.min(offset, (n.textContent ?? '').length); done = true; return; }
      count += (n.textContent ?? '').length;
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (n !== para && (isAtom(el) || el.getAttribute('contenteditable') === 'false')) { if (isAtom(el)) count += 1; return; }
    if (el.tagName === 'BR') { if (!nothingAfter(el, para)) count += 1; return; }
    for (const c of [...n.childNodes]) { visit(c); if (done) return; }
    if (n === node && node.nodeType !== 3) done = true;
  };
  if (node === para && offset >= para.childNodes.length) { visit(para); return count; }
  visit(para);
  return count;
}
/** The DOM point at a character offset of a paragraph. */
export function pointAt(para: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = offset;
  let found: { node: Node; offset: number } | null = null;
  let lastText: Text | null = null;
  const visit = (n: Node): void => {
    if (found) return;
    if (n.nodeType === 3) {
      const len = (n.textContent ?? '').length;
      lastText = n as Text;
      if (left <= len) { found = { node: n, offset: left }; return; }
      left -= len;
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (n !== para && (isAtom(el) || el.getAttribute('contenteditable') === 'false' || el.tagName === 'BR')) {
      const parent = n.parentNode!;
      const idx = [...parent.childNodes].indexOf(n as ChildNode);
      const size = el.tagName === 'BR' ? (nothingAfter(el, para) ? 0 : 1) : isAtom(el) ? 1 : 0;
      if (left === 0) { found = { node: parent, offset: idx }; return; }
      if (left <= size) { found = { node: parent, offset: idx + 1 }; return; }
      left -= size;
      return;
    }
    for (const c of [...n.childNodes]) { visit(c); if (found) return; }
  };
  visit(para);
  if (found) return found;
  const t = lastText as Text | null;
  if (t) return { node: t, offset: (t.textContent ?? '').length };
  return { node: para, offset: 0 };
}
function posOf(root: HTMLElement, els: HTMLElement[], node: Node, offset: number): Pos | null {
  if (!root.contains(node)) return null;
  for (let n: Node | null = node; n && n !== root.parentNode; n = n.parentNode) {
    const i = els.indexOf(n as HTMLElement);
    if (i >= 0) return { b: i, o: offsetIn(els[i], node, offset) };
  }
  // A point between blocks (e.g. on the root): the start of the next paragraph, or the end of the previous one.
  const probe = node.nodeType === 1 ? (node.childNodes[offset] ?? null) : node;
  if (probe) {
    const idx = els.findIndex((el) => probe === el || probe.contains(el) || !!(probe.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (idx >= 0) return { b: idx, o: 0 };
  }
  return els.length ? { b: els.length - 1, o: offsetIn(els[els.length - 1], els[els.length - 1], els[els.length - 1].childNodes.length) } : null;
}
/** The selection as model positions (anchor = from, focus = to; not ordered). */
export function readSelection(root: HTMLElement, els = paraElements(root)): DocRange | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = posOf(root, els, sel.anchorNode, sel.anchorOffset);
  const f = posOf(root, els, sel.focusNode, sel.focusOffset);
  return a && f ? { from: a, to: f } : null;
}
export function domRangeOf(root: HTMLElement, range: DocRange, els = paraElements(root)): Range | null {
  const a = els[range.from.b], z = els[range.to.b];
  if (!a || !z) return null;
  const pa = pointAt(a, range.from.o), pz = pointAt(z, range.to.o);
  const r = document.createRange();
  try { r.setStart(pa.node, pa.offset); r.setEnd(pz.node, pz.offset); } catch { return null; }
  return r;
}
export function writeSelection(root: HTMLElement, range: DocRange, els = paraElements(root)): void {
  const a = els[range.from.b], z = els[range.to.b];
  if (!a || !z) return;
  const pa = pointAt(a, range.from.o), pz = pointAt(z, range.to.o);
  const sel = window.getSelection();
  if (!sel) return;
  try { sel.setBaseAndExtent(pa.node, pa.offset, pz.node, pz.offset); } catch { /* the node went away */ }
}

/** Wraps loose inline content of the page (or of a table cell) in a paragraph so every text has a block. */
export function fixupDom(root: HTMLElement): boolean {
  let changed = false;
  const fix = (container: Element) => {
    const kids = [...container.childNodes];
    if (!kids.some((k) => isBlockEl(k))) return;
    let group: Node[] = [];
    const wrap = () => {
      if (group.some((n) => n.nodeType === 1 || (n.textContent ?? '').length > 0)) {
        const p = document.createElement('p');
        group[0].parentNode!.insertBefore(p, group[0]);
        for (const n of group) p.appendChild(n);
        changed = true;
      }
      group = [];
    };
    for (const k of kids) { if (isBlockEl(k)) wrap(); else group.push(k); }
    wrap();
  };
  fix(root);
  if (!root.firstChild) { root.innerHTML = '<p><br></p>'; changed = true; }
  else if (![...root.childNodes].some((k) => isBlockEl(k))) {
    const p = document.createElement('p');
    while (root.firstChild) p.appendChild(root.firstChild);
    root.appendChild(p);
    changed = true;
  }
  for (const td of root.querySelectorAll('td,th')) fix(td);
  return changed;
}

/* ---------------- suggesting mode ---------------- */

export interface SuggestAuthor { author: string; at: string; newId: () => string }
const closestIn = (node: Node | null, root: HTMLElement, sel: string): HTMLElement | null => {
  const el = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  const hit = el?.closest(sel) as HTMLElement | null;
  return hit && root.contains(hit) ? hit : null;
};
/** Types text as a suggested insertion at the caret. */
export function suggestTypeText(root: HTMLElement, text: string, who: SuggestAuthor): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  if (!sel.isCollapsed) suggestDeleteSelection(root, 'forward', who);
  const range = sel.getRangeAt(0);
  const own = closestIn(range.startContainer, root, 'ins[data-s]');
  if (own && own.getAttribute('data-a') === who.author) {
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
    root.normalize();
    return;
  }
  // Never type inside a suggested deletion: step out of it first.
  const inDel = closestIn(range.startContainer, root, 'del[data-s]');
  if (inDel) { range.setStartAfter(inDel); range.collapse(true); }
  const ins = document.createElement('ins');
  ins.setAttribute('data-s', who.newId()); ins.setAttribute('data-a', who.author); ins.setAttribute('data-t', who.at);
  ins.textContent = text;
  range.insertNode(ins);
  const after = document.createRange();
  after.setStart(ins.firstChild!, text.length);
  after.collapse(true);
  sel.removeAllRanges(); sel.addRange(after);
}
/** Marks the selection (or the character next to the caret) as a suggested deletion; your own suggested
 * insertions are removed for real. Returns false when there was nothing to delete in this paragraph. */
export function suggestDeleteSelection(root: HTMLElement, direction: 'backward' | 'forward', who: SuggestAuthor): boolean {
  const sel = window.getSelection() as Selection & { modify?: (alter: string, dir: string, gran: string) => void };
  if (!sel || !sel.rangeCount) return false;
  if (sel.isCollapsed) {
    const start = sel.getRangeAt(0).cloneRange();
    // Grow over characters that are already marked for deletion.
    for (let i = 0; i < 200; i++) {
      const before = sel.getRangeAt(0).cloneRange();
      sel.modify?.('extend', direction, 'character');
      const now = sel.getRangeAt(0);
      if (now.compareBoundaryPoints(Range.START_TO_START, before) === 0 && now.compareBoundaryPoints(Range.END_TO_END, before) === 0) break;
      const edge = direction === 'backward' ? now.startContainer : now.endContainer;
      if (!closestIn(edge, root, 'del[data-s]')) break;
    }
    if (sel.isCollapsed) { sel.removeAllRanges(); sel.addRange(start); return false; }
  }
  const range = sel.getRangeAt(0);
  const els = paraElements(root);
  const startPara = els.find((el) => el.contains(range.startContainer));
  const endPara = els.find((el) => el.contains(range.endContainer));
  if (!startPara || !endPara) return false;
  const sid = who.newId();
  // Collect the text pieces in the range, then wrap or remove each one.
  const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const pieces: Node[] = [];
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    if (n.nodeType === 3) pieces.push(n);
    else if (isAtom(n as Element)) pieces.push(n);
  }
  let caret: { node: Node; offset: number } | null = null;
  for (const n of pieces) {
    let node = n;
    if (n.nodeType === 3) {
      const t = n as Text;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : t.length;
      if (e <= s) continue;
      if (e < t.length) t.splitText(e);
      node = s > 0 ? t.splitText(s) : t;
    }
    if (closestIn(node, root, 'del[data-s]')) continue;
    const own = closestIn(node, root, 'ins[data-s]');
    if (own && own.getAttribute('data-a') === who.author) {
      const parent = node.parentNode!;
      const idx = [...parent.childNodes].indexOf(node as ChildNode);
      node.parentNode!.removeChild(node);
      caret = { node: parent, offset: idx };
      if (!own.textContent) { const p = own.parentNode!; const i = [...p.childNodes].indexOf(own); own.remove(); caret = { node: p, offset: i }; }
      continue;
    }
    const del = document.createElement('del');
    del.setAttribute('data-s', sid); del.setAttribute('data-a', who.author); del.setAttribute('data-t', who.at);
    node.parentNode!.insertBefore(del, node);
    del.appendChild(node);
    if (!caret || direction === 'backward') caret = direction === 'backward' ? { node: del.parentNode!, offset: [...del.parentNode!.childNodes].indexOf(del) } : { node: del.parentNode!, offset: [...del.parentNode!.childNodes].indexOf(del) + 1 };
  }
  if (caret) { const r = document.createRange(); r.setStart(caret.node, caret.offset); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
  return true;
}
/** After an IME composition in suggesting mode: wraps the just-composed text in a suggested insertion. */
export function suggestWrapComposed(root: HTMLElement, text: string, who: SuggestAuthor): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !text) return;
  const r = sel.getRangeAt(0);
  const node = r.endContainer;
  if (node.nodeType !== 3 || r.endOffset < text.length) return;
  const own = closestIn(node, root, 'ins[data-s]');
  if (own && own.getAttribute('data-a') === who.author) return;
  const t = node as Text;
  const end = r.endOffset;
  if (t.data.slice(end - text.length, end) !== text) return;
  if (end < t.length) t.splitText(end);
  const piece = t.splitText(end - text.length);
  const ins = document.createElement('ins');
  ins.setAttribute('data-s', who.newId()); ins.setAttribute('data-a', who.author); ins.setAttribute('data-t', who.at);
  piece.parentNode!.insertBefore(ins, piece);
  ins.appendChild(piece);
  const after = document.createRange();
  after.setStart(piece, piece.length);
  after.collapse(true);
  sel.removeAllRanges(); sel.addRange(after);
}

/** Puts list markers and footnote numbers right after the page was edited (before the next sync re-renders it). */
export function relabel(els: HTMLElement[], labels: (string | undefined)[]): void {
  els.forEach((el, i) => {
    const want = labels[i];
    if (want === undefined) { if (el.hasAttribute('data-label')) el.removeAttribute('data-label'); return; }
    if (el.getAttribute('data-label') !== want) el.setAttribute('data-label', want);
  });
}
