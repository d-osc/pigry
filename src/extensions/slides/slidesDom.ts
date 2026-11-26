/** DOM helpers for editing text in place: the edited box (a contentEditable .sld-flow) is read back into paragraphs,
 * and paragraph formatting (alignment, lists, indent, spacing) is applied to the paragraphs in the selection. Browser-only. */
import type { Align, Para, Run } from './slides';

/** rgb(…) / #abc → #rrggbb (null for transparent or unknown). */
export function toHex(c: string | null | undefined): string | null {
  if (!c) return null;
  const v = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split('').map((x) => x + x).join('')}`.toLowerCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(v);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}
const BLOCK = /^(DIV|P|LI|H[1-6]|UL|OL|BLOCKQUOTE)$/;
type Marks = Omit<Run, 't'>;

function marksOf(el: HTMLElement, inherited: Marks, base: { bold: boolean }): Marks {
  const m: Marks = { ...inherited };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') m.b = true;
  if (tag === 'I' || tag === 'EM') m.i = true;
  if (tag === 'U') m.u = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.s = true;
  if (tag === 'SUP') m.sup = true;
  if (tag === 'SUB') m.sub = true;
  if (tag === 'A') { const href = el.getAttribute('href'); if (href) m.link = href; }
  if (tag === 'FONT') {
    const color = toHex(el.getAttribute('color'));
    if (color) m.color = color;
    const face = el.getAttribute('face');
    if (face) m.font = face.split(',')[0].replace(/['"]/g, '').trim();
  }
  const st = el.style;
  if (st.fontWeight) { const w = st.fontWeight === 'bold' ? 700 : st.fontWeight === 'normal' ? 400 : Number(st.fontWeight); if (w >= 600) m.b = true; else if (base.bold) m.b = false; else delete m.b; }
  if (st.fontStyle === 'italic') m.i = true; else if (st.fontStyle === 'normal') delete m.i;
  const deco = `${st.textDecoration} ${st.textDecorationLine}`;
  if (/underline/.test(deco) && tag !== 'A') m.u = true;
  if (/line-through/.test(deco)) m.s = true;
  if (st.verticalAlign === 'super') m.sup = true;
  if (st.verticalAlign === 'sub') m.sub = true;
  const ref = el.getAttribute('data-color');
  if (st.color) { const c = toHex(st.color); if (c) m.color = ref ?? c; }
  const hlRef = el.getAttribute('data-hl');
  const bg = st.backgroundColor ? toHex(st.backgroundColor) : null;
  if (bg) m.hl = hlRef ?? bg;
  if (st.fontFamily) m.font = st.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
  if (st.fontSize && !m.sup && !m.sub) {
    const v = parseFloat(st.fontSize);
    if (st.fontSize.endsWith('pt')) m.size = v;
    else if (st.fontSize.endsWith('px')) m.size = Math.round(v * 0.75 * 2) / 2;
  }
  return m;
}
function same(a: Run, b: Marks): boolean {
  const keys: (keyof Marks)[] = ['b', 'i', 'u', 's', 'sup', 'sub', 'color', 'hl', 'font', 'size', 'link'];
  return keys.every((k) => a[k] === b[k]);
}
function pushText(runs: Run[], t: string, m: Marks): void {
  if (!t) return;
  const last = runs[runs.length - 1];
  if (last && same(last, m)) last.t += t;
  else runs.push({ t, ...m });
}
function readPara(el: HTMLElement): Para {
  const p: Para = { runs: [] };
  const list = el.getAttribute('data-list');
  if (list === 'bullet' || list === 'number') p.list = list;
  const level = Number(el.getAttribute('data-level') ?? 0);
  if (level > 0) p.level = Math.min(4, level);
  const align = el.style.textAlign as Align;
  if (align === 'center' || align === 'right' || align === 'justify') p.align = align;
  if (el.style.lineHeight) { const lh = parseFloat(el.style.lineHeight); if (lh > 0 && lh < 5) p.lh = lh; }
  if (el.style.marginTop) { const v = parseFloat(el.style.marginTop); if (v > 0) p.sb = v; }
  if (el.style.marginBottom) { const v = parseFloat(el.style.marginBottom); if (v > 0) p.sa = v; }
  return p;
}
function textAfter(node: Node, root: Node): boolean {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  w.currentNode = node;
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.textContent ?? '').replace(/\u200b/g, '')) return true;
  return false;
}
/** The edited box → paragraphs (block children are paragraphs; a <br> with text after it splits one). */
export function domToParas(flow: HTMLElement, base: { bold: boolean } = { bold: false }): Para[] {
  const out: Para[] = [];
  let cur: Para | null = null;
  let block: HTMLElement = flow;
  const start = (from?: HTMLElement): Para => { const p: Para = from ? readPara(from) : { runs: [] }; out.push(p); cur = p; return p; };
  const walk = (node: Node, m: Marks): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\u200b/g, '').replace(/\n/g, ' ');
      if (t) pushText((cur ?? start()).runs, t, m);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      if (!textAfter(node, block)) { if (!cur) start(); return; }
      const prev: Para | null = cur;
      const next = start();
      if (prev) { if (prev.list) next.list = prev.list; if (prev.level) next.level = prev.level; if (prev.align) next.align = prev.align; }
      return;
    }
    if (BLOCK.test(node.tagName)) {
      const outer = block;
      block = node;
      start(node);
      for (const child of [...node.childNodes]) walk(child, m);
      block = outer;
      cur = null;
      return;
    }
    const mm = marksOf(node, m, base);
    for (const child of [...node.childNodes]) walk(child, mm);
  };
  for (const child of [...flow.childNodes]) walk(child, {});
  const clean = out.map((p) => { const q: Para = { ...p, runs: p.runs.filter((r) => r.t) }; if (!q.level) delete q.level; return q; });
  return clean.length ? clean : [{ runs: [] }];
}

/** Paragraph elements of the edited box that the selection touches (or the caret's paragraph). */
export function selectedParas(flow: HTMLElement): HTMLElement[] {
  const s = window.getSelection();
  const paras = [...flow.children].filter((c): c is HTMLElement => c instanceof HTMLElement);
  if (!s || !s.rangeCount) return paras;
  const r = s.getRangeAt(0);
  if (!flow.contains(r.commonAncestorContainer)) return paras;
  const hit = paras.filter((p) => r.intersectsNode(p));
  return hit.length ? hit : paras;
}
/** Puts loose text and inline nodes at the top level of the box into paragraph divs. */
export function wrapLoose(flow: HTMLElement): void {
  let pending: HTMLElement | null = null;
  for (const n of [...flow.childNodes]) {
    if (n instanceof HTMLElement && BLOCK.test(n.tagName)) { if (!n.classList.contains('sld-p')) n.classList.add('sld-p'); pending = null; continue; }
    if (!pending) { pending = document.createElement('div'); pending.className = 'sld-p'; flow.insertBefore(pending, n); }
    pending.appendChild(n);
  }
}
/** Paragraph formatting on the selected paragraphs of the edited box. */
export function formatSelectedParas(flow: HTMLElement, change: { align?: Align; list?: 'bullet' | 'number' | null; indent?: number; lh?: number }): void {
  wrapLoose(flow);
  const paras = selectedParas(flow);
  const allList = change.list ? paras.every((p) => p.getAttribute('data-list') === change.list) : false;
  for (const p of paras) {
    if (change.align) p.style.textAlign = change.align === 'left' ? '' : change.align;
    if (change.list !== undefined) { if (change.list && !allList) p.setAttribute('data-list', change.list); else { p.removeAttribute('data-list'); p.removeAttribute('data-level'); p.style.marginLeft = ''; } }
    if (change.indent) {
      const level = Math.max(0, Math.min(4, Number(p.getAttribute('data-level') ?? 0) + change.indent));
      if (level) { p.setAttribute('data-level', String(level)); p.style.marginLeft = `${level * 1.2}em`; } else { p.removeAttribute('data-level'); p.style.marginLeft = ''; }
    }
    if (change.lh !== undefined) p.style.lineHeight = change.lh ? String(change.lh) : '';
  }
}
/** execCommand('fontSize', '7') leaves <font size="7">: turn those into a span with the real size. */
export function fixFontSize(flow: HTMLElement, pt: number): void {
  for (const f of [...flow.querySelectorAll('font[size="7"]')]) {
    const span = document.createElement('span');
    span.style.fontSize = `${pt}pt`;
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
    for (const inner of span.querySelectorAll<HTMLElement>('[style*="font-size"]')) inner.style.fontSize = '';
  }
}
/** Puts the caret at a point of the screen (where the user double-clicked), or selects everything. */
export function placeCaret(flow: HTMLElement, clientX?: number, clientY?: number, selectAll = false): void {
  const s = window.getSelection();
  if (!s) return;
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const r = !selectAll && clientX !== undefined && clientY !== undefined && doc.caretRangeFromPoint ? doc.caretRangeFromPoint(clientX, clientY) : null;
  if (r && flow.contains(r.startContainer)) { s.removeAllRanges(); s.addRange(r); return; }
  const all = document.createRange();
  all.selectNodeContents(flow);
  if (!selectAll) all.collapse(false);
  s.removeAllRanges();
  s.addRange(all);
}
