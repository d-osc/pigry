/** Renders a document as HTML (for the editor surface and for export), Markdown and plain text, reads Markdown,
 * and builds the templates. Pure TypeScript — node tests and agent tools use it as well as the editor. */
import {
  ATOM, STYLE_LOOK, docListLabels, emptyDoc, emptyPara, footnoteNumbers, isTextRun, newId, normalizeRuns, outline, pageInches, paraLen, plainText,
  type Align, type Block, type Doc, type Marks, type Para, type ParaStyle, type Run, type Table,
} from './docs.ts';

export const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------------- equations (a small TeX subset) ---------------- */

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', propto: '∝', infty: '∞', sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', degree: '°', circ: '∘', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵', ldots: '…', cdots: '⋯',
  sqrt: '√', neg: '¬', land: '∧', lor: '∨', hbar: 'ħ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
};
/** Reads one argument: {…} or a single character / command. */
function eqArg(src: string, i: number): { text: string; next: number } {
  if (src[i] === '{') {
    let depth = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    return { text: src.slice(i + 1, j), next: j + 1 };
  }
  if (src[i] === '\\') { const m = /^\\[A-Za-z]+/.exec(src.slice(i)); if (m) return { text: m[0], next: i + m[0].length }; }
  return { text: src[i] ?? '', next: i + 1 };
}
function eqRender(src: string, html: boolean): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      const name = m ? m[1] : '';
      i += m ? m[0].length : 1;
      if (name === 'frac') {
        const a = eqArg(src, i); const b = eqArg(src, a.next); i = b.next;
        out += html ? `<span class="dc-frac"><span>${eqRender(a.text, true)}</span><span>${eqRender(b.text, true)}</span></span>` : `(${eqRender(a.text, false)})/(${eqRender(b.text, false)})`;
      } else if (name === 'sqrt') {
        const a = eqArg(src, i); i = a.next;
        out += html ? `√<span class="dc-sqrt">${eqRender(a.text, true)}</span>` : `√(${eqRender(a.text, false)})`;
      } else if (name === 'text' || name === 'mathrm') { const a = eqArg(src, i); i = a.next; out += html ? esc(a.text) : a.text; }
      else if (SYMBOLS[name]) out += SYMBOLS[name];
      else if (name === ' ' || name === ',') out += ' ';
      else out += html ? esc(name) : name;
    } else if (ch === '^' || ch === '_') {
      const a = eqArg(src, i + 1); i = a.next;
      const inner = eqRender(a.text, html);
      out += html ? (ch === '^' ? `<sup>${inner}</sup>` : `<sub>${inner}</sub>`) : `${ch}${a.text.length > 1 ? `(${inner})` : inner}`;
    } else if (ch === '{' || ch === '}') i++;
    else { out += html ? esc(ch) : ch; i++; }
  }
  return out;
}
export const eqToHtml = (tex: string): string => eqRender(tex, true);
export const eqToText = (tex: string): string => eqRender(tex, false);

/* ---------------- HTML ---------------- */

export interface HtmlOptions {
  /** Editor surface: data attributes, non-editable atoms, comments and suggestions as markup. */
  editor?: boolean;
  /** Export view: suggested insertions kept, suggested deletions dropped, comments not shown. */
  final?: boolean;
}

const TAG: Record<ParaStyle, string> = { normal: 'p', title: 'p', subtitle: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };
function textHtml(t: string): string {
  const parts = t.split('\n').map(esc);
  return parts.join('<br>');
}
function lookStyle(r: Marks): string {
  const css: string[] = [];
  if (r.color) css.push(`color:${r.color}`);
  if (r.bg) css.push(`background-color:${r.bg}`);
  if (r.font) css.push(`font-family:${cssFont(r.font)}`);
  if (r.size) css.push(`font-size:${r.size}pt`);
  return css.join(';');
}
export const cssFont = (f: string): string => (/^[\w -]+$/.test(f) ? `'${f}'` : `'${f.replace(/['"\\]/g, '')}'`);

function runHtml(r: Run, ctx: { opts: HtmlOptions; doc: Doc; fns: Map<string, number>; resolved: Set<string>; suggestion: Map<string, { author: string; at: string }> }): string {
  const { opts } = ctx;
  if (opts.final && r.del) return '';
  let inner: string;
  if (isTextRun(r)) inner = textHtml(r.t);
  else if ('img' in r) {
    const size = `${r.w ? ` width="${r.w}"` : ''}${r.h ? ` height="${r.h}"` : ''}`;
    inner = `<img src="${esc(r.img)}" alt="${esc(r.alt ?? '')}"${size}${opts.editor ? ' class="dc-img"' : ' style="max-width:100%;height:auto"'}>`;
  } else if ('fn' in r) {
    const n = ctx.fns.get(r.fn) ?? 0;
    inner = opts.editor ? `<sup class="dc-fn" contenteditable="false" data-fn="${esc(r.fn)}">${n}</sup>` : `<sup class="fn"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
  } else {
    inner = opts.editor ? `<span class="dc-eq" contenteditable="false" data-eq="${esc(r.eq)}">${eqToHtml(r.eq)}</span>` : `<span class="eq">${eqToHtml(r.eq)}</span>`;
  }
  if (r.b) inner = `<b>${inner}</b>`;
  if (r.i) inner = `<i>${inner}</i>`;
  if (r.u) inner = `<u>${inner}</u>`;
  if (r.s) inner = `<s>${inner}</s>`;
  if (r.code) inner = `<code>${inner}</code>`;
  if (r.sup) inner = `<sup>${inner}</sup>`;
  if (r.sub) inner = `<sub>${inner}</sub>`;
  const look = lookStyle(r);
  if (look) inner = `<span style="${look}">${inner}</span>`;
  if (r.link) inner = `<a href="${esc(r.link)}"${opts.editor ? '' : ' rel="noopener"'}>${inner}</a>`;
  if (opts.editor) {
    if (r.c?.length) {
      const open = r.c.filter((id) => !ctx.resolved.has(id));
      inner = `<span class="dc-c${open.length ? '' : ' dc-c--resolved'}" data-c="${esc(r.c.join(' '))}">${inner}</span>`;
    }
    const sid = r.ins ?? r.del;
    if (sid) {
      const s = ctx.suggestion.get(sid);
      const tag = r.ins ? 'ins' : 'del';
      inner = `<${tag} data-s="${esc(sid)}" data-a="${esc(s?.author ?? 'user')}" data-t="${esc(s?.at ?? '')}">${inner}</${tag}>`;
    }
  }
  return inner;
}

function paraHtml(p: Para, ctx: Parameters<typeof runHtml>[1] & { labels: Map<Para, string> }): string {
  const style = p.style ?? 'normal';
  const tag = TAG[style];
  const css: string[] = [];
  if (p.align) css.push(`text-align:${p.align}`);
  if (p.lh) css.push(`line-height:${p.lh}`);
  if (p.sb !== undefined) css.push(`margin-top:${p.sb}pt`);
  if (p.sa !== undefined) css.push(`margin-bottom:${p.sa}pt`);
  if (p.ind && !p.list) css.push(`margin-left:${p.ind * 0.5}in`);
  const attrs: string[] = [];
  if (ctx.opts.editor) attrs.push(`data-id="${esc(p.id)}"`);
  else if (style !== 'normal' && style !== 'subtitle') attrs.push(`id="${esc(p.id)}"`);
  if (style !== 'normal') attrs.push(ctx.opts.editor ? `data-style="${style}"` : `class="${style}"`);
  if (p.list) {
    attrs.push(`data-list="${p.list}"`, `data-lvl="${p.lvl ?? 0}"`, `data-label="${esc(ctx.labels.get(p) ?? '')}"`);
    if (p.checked) attrs.push('data-checked="true"');
  }
  if (css.length) attrs.push(`style="${css.join(';')}"`);
  let body = p.runs.map((r) => runHtml(r, ctx)).join('');
  const last = p.runs[p.runs.length - 1];
  if (!body || (last && isTextRun(last) && last.t.endsWith('\n') && !(ctx.opts.final && last.del))) body += '<br>';
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${body}</${tag}>`;
}

function tableHtml(t: Table, ctx: Parameters<typeof paraHtml>[1]): string {
  const cols = t.rows[0]?.length ?? 0;
  const total = (t.widths ?? []).reduce((a, b) => a + b, 0);
  const colgroup = t.widths && total > 0 ? `<colgroup>${t.widths.map((w) => `<col style="width:${((w / total) * 100).toFixed(2)}%">`).join('')}</colgroup>` : '';
  const rows = t.rows.map((row) => `<tr>${row.map((cell) => {
    if (cell.hidden) return '';
    const a: string[] = [];
    if (cell.cs) a.push(`colspan="${cell.cs}"`);
    if (cell.rs) a.push(`rowspan="${cell.rs}"`);
    if (cell.bg) a.push(`style="background-color:${cell.bg}"`);
    return `<td${a.length ? ' ' + a.join(' ') : ''}>${cell.paras.map((p) => paraHtml(p, ctx)).join('')}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="dc-table"${ctx.opts.editor ? ` data-id="${esc(t.id)}"` : ''} data-cols="${cols}">${colgroup}<tbody>${rows}</tbody></table>`;
}

function tocHtml(doc: Doc, editor: boolean): string {
  const items = outline(doc).filter((o) => o.level > 0);
  const body = items.length
    ? items.map((o) => `<div class="dc-toc__item" style="padding-left:${(o.level - 1) * 18}px">${editor ? `<a data-goto="${esc(o.id)}">` : `<a href="#${esc(o.id)}">`}${esc(o.text)}</a></div>`).join('')
    : '<div class="dc-toc__empty">Add headings (Format ▸ Paragraph styles) to build the table of contents.</div>';
  return body;
}

/** The blocks of a document as HTML (the editor's content, or the body of an export). */
export function blocksHtml(doc: Doc, opts: HtmlOptions = {}): string {
  const ctx = {
    opts, doc, fns: footnoteNumbers(doc), labels: docListLabels(doc),
    resolved: new Set(doc.comments.filter((c) => c.resolved).map((c) => c.id)),
    suggestion: new Map(doc.suggestions.map((s) => [s.id, s])),
  };
  return doc.blocks.map((b) => {
    if (b.type === 'p') return paraHtml(b, ctx);
    if (b.type === 'table') return tableHtml(b, ctx);
    const id = opts.editor ? ` data-id="${esc(b.id)}"` : '';
    if (b.type === 'hr') return opts.editor ? `<div class="dc-hr" contenteditable="false" data-block="hr"${id}><hr></div>` : '<hr>';
    if (b.type === 'pagebreak') return opts.editor ? `<div class="dc-pb" contenteditable="false" data-block="pagebreak"${id}><span>Page break</span></div>` : '<div class="page-break"></div>';
    return opts.editor ? `<div class="dc-toc" contenteditable="false" data-block="toc"${id}><div class="dc-toc__title">Table of contents</div>${tocHtml(doc, true)}</div>` : `<nav class="toc">${tocHtml(doc, false)}</nav>`;
  }).join('');
}

/** CSS shared by the export and the print page (the editor has its own stylesheet with the same values). */
function exportCss(doc: Doc): string {
  const { w, h } = pageInches(doc.page);
  const m = doc.page.margins;
  const heads = (Object.keys(STYLE_LOOK) as ParaStyle[]).filter((s) => s !== 'normal').map((s) => {
    const look = STYLE_LOOK[s];
    const sel = s === 'title' || s === 'subtitle' ? `.${s}` : s;
    return `${sel}{font-size:${look.size}pt;margin:${look.sb}pt 0 ${look.sa}pt;font-weight:${s === 'subtitle' || s === 'title' ? 400 : s === 'h1' || s === 'h2' || s === 'h3' ? 400 : 700};${look.color ? `color:${look.color};` : ''}${look.italic ? 'font-style:italic;' : ''}}`;
  }).join('\n');
  return `@page{size:${w}in ${h}in;margin:${m.top}in ${m.right}in ${m.bottom}in ${m.left}in}
body{font-family:${cssFont(doc.font.family)},Arial,sans-serif;font-size:${doc.font.size}pt;line-height:1.15;color:#000;max-width:${(w - m.left - m.right).toFixed(2)}in;margin:24px auto;padding:0 16px;${doc.page.color ? `background:${doc.page.color};` : ''}}
@media print{body{margin:0;padding:0;max-width:none}}
p{margin:0}
${heads}
[data-list]{position:relative}
[data-list]::before{content:attr(data-label);position:absolute;left:-1.6em;width:1.4em;text-align:right}
${Array.from({ length: 9 }, (_, i) => `[data-lvl="${i}"]{margin-left:${0.5 + i * 0.5}in}`).join('')}
table{border-collapse:collapse;width:100%;margin:6pt 0}td{border:1px solid #000;padding:5pt;vertical-align:top}
code{font-family:'Courier New',monospace}
img{max-width:100%}
.page-break{break-after:page}
.eq{font-family:'Cambria Math','Times New Roman',serif;font-style:italic}
.dc-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:.85em}.dc-frac>span:first-child{border-bottom:1px solid currentColor}
.toc a{color:#1155cc}
.fn a{text-decoration:none}
.footnotes{border-top:1px solid #999;margin-top:24pt;padding-top:6pt;font-size:10pt}
.hf{color:#555;font-size:9pt}`;
}

/** A complete web page of the document (print it to get a PDF). Pending suggestions are shown as accepted. */
export function docToHtml(doc: Doc): string {
  const fns = footnoteNumbers(doc);
  const notes = doc.footnotes.filter((f) => fns.has(f.id)).sort((a, b) => (fns.get(a.id) ?? 0) - (fns.get(b.id) ?? 0));
  const hf = (x: Doc['header'], cls: string) => (x ? `<div class="hf ${cls}" style="text-align:${x.align ?? 'left'}">${esc(x.text.replace(/\{page\}|\{pages\}/gi, '').replace(/\{title\}/gi, doc.title).replace(/\{date\}/gi, ''))}</div>` : '');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${exportCss(doc)}</style></head>
<body>
${hf(doc.header, 'header')}
${blocksHtml(doc, { final: true })}
${notes.length ? `<ol class="footnotes">${notes.map((f) => `<li id="fn-${fns.get(f.id)}">${esc(f.text)} <a href="#fnref-${fns.get(f.id)}">↩</a></li>`).join('')}</ol>` : ''}
${hf(doc.footer, 'footer')}
</body></html>
`;
}

/* ---------------- plain text ---------------- */

export function docToText(doc: Doc): string {
  const labels = docListLabels(doc);
  const fns = footnoteNumbers(doc);
  const paraLine = (p: Para): string => {
    const text = p.runs.map((r) => (r.del ? '' : isTextRun(r) ? r.t : 'eq' in r ? eqToText(r.eq) : 'fn' in r ? `[${fns.get(r.fn) ?? '?'}]` : r.alt ? `[${r.alt}]` : '[image]')).join('');
    const label = labels.get(p);
    return `${p.list ? '    '.repeat(p.lvl ?? 0) + label + ' ' : ''}${text}`;
  };
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.type === 'p') out.push(paraLine(b));
    else if (b.type === 'table') { for (const row of b.rows) out.push(row.map((c) => (c.hidden ? '' : c.paras.map(paraLine).join(' '))).join('\t')); }
    else if (b.type === 'hr') out.push('―'.repeat(20));
    else if (b.type === 'pagebreak') out.push('\f');
    else out.push(outline(doc).filter((o) => o.level > 0).map((o) => `${'  '.repeat(o.level - 1)}${o.text}`).join('\n'));
  }
  const notes = doc.footnotes.filter((f) => fns.has(f.id)).sort((a, b) => (fns.get(a.id) ?? 0) - (fns.get(b.id) ?? 0));
  if (notes.length) out.push('', '____', ...notes.map((f) => `[${fns.get(f.id)}] ${f.text}`));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ---------------- Markdown out ---------------- */

const mdEscape = (t: string): string => t.replace(/([\\`*_[\]<>|~$])/g, '\\$1');
export interface MarkdownOptions {
  /** Where an image's data goes; returns the URL / path written into the Markdown (default: the data URL). */
  imageRef?: (src: string, index: number) => string;
  /** Show pending suggestions as {++insert++} / {--delete--} (CriticMarkup) instead of the final text. */
  critic?: boolean;
  /** Mark comment anchors as {==text==}[c1]. */
  comments?: boolean;
}
export function runsToMarkdown(runs: Run[], fns: Map<string, number>, opts: MarkdownOptions = {}, img = { n: 0 }): string {
  let out = '';
  const groups: { key: string; runs: Run[] }[] = [];
  for (const r of opts.critic ? runs : runs.filter((x) => !x.del)) {
    const key = `${opts.critic ? `${r.ins ?? ''}|${r.del ?? ''}` : ''}|${opts.comments ? (r.c ?? []).join(',') : ''}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.runs.push(r); else groups.push({ key, runs: [r] });
  }
  for (const g of groups) {
    const first = g.runs[0];
    if (!opts.critic && first.del) continue;
    let text = '';
    for (const r of g.runs) {
      let s: string;
      if (isTextRun(r)) {
        const lead = /^\s*/.exec(r.t)![0], trail = /\s*$/.exec(r.t)![0];
        const core = r.t.slice(lead.length, r.t.length - trail.length);
        if (!core) { text += r.t.replace(/\n/g, '  \n'); continue; }
        s = r.code ? `\`${core}\`` : mdEscape(core).replace(/\n/g, '  \n');
        if (!r.code) {
          if (r.b && r.i) s = `***${s}***`; else if (r.b) s = `**${s}**`; else if (r.i) s = `*${s}*`;
          if (r.s) s = `~~${s}~~`;
          if (r.u) s = `<u>${s}</u>`;
          if (r.sup) s = `<sup>${s}</sup>`;
          if (r.sub) s = `<sub>${s}</sub>`;
        }
        if (r.link) s = `[${s}](${r.link.replace(/[()\s]/g, encodeURIComponent)})`;
        s = lead + s + trail;
      } else if ('img' in r) s = `![${mdEscape(r.alt ?? '')}](${opts.imageRef ? opts.imageRef(r.img, ++img.n) : r.img})`;
      else if ('fn' in r) s = `[^${fns.get(r.fn) ?? r.fn}]`;
      else s = `$${r.eq}$`;
      text += s;
    }
    if (opts.critic && first.ins) text = `{++${text}++}[${first.ins}]`;
    else if (opts.critic && first.del) text = `{--${text}--}[${first.del}]`;
    if (opts.comments && first.c?.length) text = `{==${text}==}[${first.c.join(',')}]`;
    out += text;
  }
  return out;
}
export function docToMarkdown(doc: Doc, opts: MarkdownOptions = {}): string {
  const fns = footnoteNumbers(doc);
  const labels = docListLabels(doc);
  const img = { n: 0 };
  const lines: string[] = [];
  const inline = (p: Para) => runsToMarkdown(p.runs, fns, opts, img);
  let prevList = false;
  for (const b of doc.blocks) {
    if (b.type === 'p') {
      const text = inline(b);
      if (b.list) {
        const pad = '    '.repeat(b.lvl ?? 0);
        const marker = b.list === 'number' ? `${/^\d+/.exec(labels.get(b) ?? '1')?.[0] ?? '1'}.` : b.list === 'check' ? `- [${b.checked ? 'x' : ' '}]` : '-';
        if (!prevList) lines.push('');
        lines.push(`${pad}${marker} ${text}`);
        prevList = true;
        continue;
      }
      prevList = false;
      const style = b.style ?? 'normal';
      if (!text.trim() && style === 'normal') continue;
      const prefix = style === 'title' ? '# ' : style.startsWith('h') ? `${'#'.repeat(Number(style[1]))} ` : '';
      lines.push('', style === 'subtitle' ? `*${text.trim()}*` : `${prefix}${text}`);
      if (b.align === 'center' && !prefix && style === 'normal') lines[lines.length - 1] = `<p align="center">${text}</p>`;
    } else {
      prevList = false;
      if (b.type === 'hr') lines.push('', '---');
      else if (b.type === 'pagebreak') lines.push('', '<div style="page-break-after: always"></div>');
      else if (b.type === 'toc') lines.push('', ...outline(doc).filter((o) => o.level > 0).map((o) => `${'    '.repeat(o.level - 1)}- ${mdEscape(o.text)}`));
      else {
        const cell = (c: Table['rows'][number][number]) => (c.hidden ? '' : c.paras.map((p) => inline(p)).filter(Boolean).join('<br>').replace(/\|/g, '\\|'));
        const [head, ...rest] = b.rows;
        lines.push('', `| ${head.map(cell).join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rest.map((row) => `| ${row.map(cell).join(' | ')} |`));
      }
    }
  }
  const notes = doc.footnotes.filter((f) => fns.has(f.id)).sort((a, b) => (fns.get(a.id) ?? 0) - (fns.get(b.id) ?? 0));
  if (notes.length) lines.push('', ...notes.map((f) => `[^${fns.get(f.id)}]: ${f.text.replace(/\n/g, ' ')}`));
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ---------------- Markdown in ---------------- */

/** Inline Markdown → runs: **bold**, *italic*, ~~strike~~, `code`, [links](url), ![images](src), [^notes], $equations$,
 * <u>, <sup>, <sub>, <br> and backslash escapes. */
export function parseInline(text: string, base: Marks = {}, notes?: (label: string) => string): Run[] {
  const runs: Run[] = [];
  let buf = '';
  const flush = () => { if (buf) { runs.push({ ...base, t: buf }); buf = ''; } };
  const sub = (inner: string, extra: Marks) => { flush(); runs.push(...parseInline(inner, { ...base, ...extra }, notes)); };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    let m: RegExpExecArray | null;
    if (ch === '\\' && i + 1 < text.length && /[\\`*_[\]{}()#+\-.!|~<>$]/.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
    if (ch === '\\' && text[i + 1] === '\n') { buf += '\n'; i += 2; continue; }
    if (ch === '`' && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); runs.push({ ...base, code: true, t: m[2].replace(/^ (.*) $/, '$1') }); i += m[0].length; continue; }
    if (ch === '!' && (m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) { flush(); runs.push({ img: m[2], ...(m[1] ? { alt: m[1] } : {}) }); i += m[0].length; continue; }
    if (ch === '[' && notes && (m = /^\[\^([^\]\s]+)\]/.exec(rest))) { flush(); runs.push({ fn: notes(m[1]) }); i += m[0].length; continue; }
    if (ch === '[' && (m = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) { sub(m[1], { link: m[2] }); i += m[0].length; continue; }
    if (ch === '<' && (m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) { flush(); runs.push({ ...base, link: m[1], t: m[1] }); i += m[0].length; continue; }
    if (ch === '<' && (m = /^<br\s*\/?>/i.exec(rest))) { buf += '\n'; i += m[0].length; continue; }
    if (ch === '<' && (m = /^<(u|ins|sup|sub|b|strong|i|em|s|del|code)>([\s\S]*?)<\/\1>/i.exec(rest))) {
      const tag = m[1].toLowerCase();
      const mark: Marks = tag === 'u' || tag === 'ins' ? { u: true } : tag === 'sup' ? { sup: true } : tag === 'sub' ? { sub: true } : tag === 'b' || tag === 'strong' ? { b: true } : tag === 'i' || tag === 'em' ? { i: true } : tag === 'code' ? { code: true } : { s: true };
      sub(m[2], mark); i += m[0].length; continue;
    }
    if ((ch === '*' || ch === '_') && text.startsWith(ch.repeat(3), i) && (m = new RegExp(`^\\${ch}{3}(?=\\S)([\\s\\S]*?\\S)\\${ch}{3}`).exec(rest))) { sub(m[1], { b: true, i: true }); i += m[0].length; continue; }
    if ((ch === '*' || ch === '_') && text[i + 1] === ch && (m = new RegExp(`^\\${ch}{2}(?=\\S)([\\s\\S]*?\\S)\\${ch}{2}`).exec(rest))) { sub(m[1], { b: true }); i += m[0].length; continue; }
    if (ch === '~' && text[i + 1] === '~' && (m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { sub(m[1], { s: true }); i += m[0].length; continue; }
    if ((ch === '*' || (ch === '_' && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) && (m = new RegExp(`^\\${ch}(?=[^\\s${ch}])([\\s\\S]*?[^\\s\\\\])\\${ch}(?!\\${ch})`).exec(rest)) && (ch === '*' || !/[\p{L}\p{N}]/u.test(text[i + m[0].length] ?? ''))) { sub(m[1], { i: true }); i += m[0].length; continue; }
    if (ch === '$' && (m = /^\$(?=\S)([^$\n]*?\S)\$(?!\d)/.exec(rest))) { flush(); runs.push({ ...base, eq: m[1] }); i += m[0].length; continue; }
    if (ch === '$' && (m = /^\$\$([^$]+)\$\$/.exec(rest))) { flush(); runs.push({ ...base, eq: m[1].trim() }); i += m[0].length; continue; }
    buf += ch; i++;
  }
  flush();
  return normalizeRuns(runs);
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const splitRow = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
};

/** Markdown (CommonMark + GFM tables, task lists and footnotes) → blocks. Footnotes are added to the document. */
export function markdownToBlocks(doc: Doc, markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks: Block[] = [];
  const noteIds = new Map<string, string>();
  const noteText = new Map<string, string>();
  const notes = (label: string): string => { let id = noteIds.get(label); if (!id) { id = newId(doc, 'f'); noteIds.set(label, id); } return id; };
  const para = (text: string, patch: Partial<Para> = {}): Para => ({ ...emptyPara(newId(doc, 'b')), ...patch, runs: parseInline(text, {}, notes) });
  const listIndents: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (!line.trim()) { i++; listIndents.length = 0; continue; }
    if ((m = /^\[\^([^\]]+)\]:\s?(.*)$/.exec(line))) {
      let text = m[2];
      while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      noteText.set(m[1], text.trim()); i++; continue;
    }
    if ((m = /^\s{0,3}(```+|~~~+)\s*([\w-]*)\s*$/.exec(line))) {
      const fence = m[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      blocks.push({ ...emptyPara(newId(doc, 'b')), runs: body.length ? [{ t: body.join('\n'), code: true, font: 'Courier New' }] : [] });
      continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { blocks.push(para(m[2], { style: `h${m[1].length}` as ParaStyle })); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'hr', id: newId(doc, 'b') }); i++; continue; }
    if (/page-break-(after|before)\s*:\s*always/i.test(line) && /^\s*<div/i.test(line)) { blocks.push({ type: 'pagebreak', id: newId(doc, 'b') }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows: string[][] = [head];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cols = Math.max(...rows.map((r) => r.length));
      const t: Table = {
        type: 'table', id: newId(doc, 'b'),
        rows: rows.map((r, ri) => Array.from({ length: cols }, (_, c) => ({
          paras: (r[c] ?? '').split(/<br\s*\/?>/i).map((part) => para(part, {})).map((p) => (ri === 0 ? { ...p, runs: p.runs.map((x) => ({ ...x, b: true })) } : p)),
        }))),
      };
      blocks.push(t);
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      const indent = m[1].length;
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (!listIndents.length || indent > listIndents[listIndents.length - 1]) listIndents.push(indent);
      const lvl = Math.min(listIndents.length - 1, 8);
      let text = m[4];
      while (i + 1 < lines.length && lines[i + 1].trim() && !LIST_RE.test(lines[i + 1]) && /^\s+/.test(lines[i + 1]) && !/^\s*(#{1,6}\s|>|```)/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      const kind = m[3] !== undefined ? 'check' : /^\d/.test(m[2]) ? 'number' : 'bullet';
      blocks.push(para(text, { list: kind, ...(lvl ? { lvl } : {}), ...(m[3] && m[3].toLowerCase() === 'x' ? { checked: true } : {}) }));
      i++; continue;
    }
    listIndents.length = 0;
    if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      const body: string[] = [m[1]];
      while (i + 1 < lines.length && (m = /^\s{0,3}>\s?(.*)$/.exec(lines[i + 1]))) { body.push(m[1]); i++; }
      for (const chunk of body.join('\n').split(/\n\s*\n/)) blocks.push(para(chunk.replace(/\n/g, ' '), { ind: 1 }));
      i++; continue;
    }
    // Paragraph: lines until a blank line or another block starts; setext underline makes it a heading.
    const body: string[] = [line.trim()];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s{0,3}(#{1,6}\s|>|```|~~~|[-*_](\s*[-*_]){2,}\s*$)/.test(lines[i + 1]) && !LIST_RE.test(lines[i + 1]) && !/^\[\^[^\]]+\]:/.test(lines[i + 1])) {
      if (/^\s*=+\s*$/.test(lines[i + 1]) || /^\s*-+\s*$/.test(lines[i + 1])) break;
      body.push(lines[++i]);
    }
    let style: ParaStyle | undefined;
    if (i + 1 < lines.length && /^\s*=+\s*$/.test(lines[i + 1])) { style = 'h1'; i++; }
    else if (i + 1 < lines.length && /^\s*-{2,}\s*$/.test(lines[i + 1])) { style = 'h2'; i++; }
    const joined = body.map((l, k) => (k < body.length - 1 ? (/ {2,}$/.test(l) ? l.replace(/ +$/, '') + '\n' : l.replace(/\\$/, '\n').trimEnd() + (l.endsWith('\\') ? '' : ' ')) : l.trim())).join('').trim();
    const centered = /^<p align="center">([\s\S]*)<\/p>$/i.exec(joined);
    blocks.push(para(centered ? centered[1] : joined, { ...(style ? { style } : {}), ...(centered ? { align: 'center' as Align } : {}) }));
    i++;
  }
  for (const [label, id] of noteIds) doc.footnotes.push({ id, text: noteText.get(label) ?? '' });
  return blocks.filter((b) => b.type !== 'p' || paraLen(b) > 0 || b.style);
}

/** A new document from Markdown (the first "# " heading becomes the title when there is no title). */
export function markdownToDoc(markdown: string, title: string): Doc {
  const doc = emptyDoc(title);
  doc.blocks = [];
  const blocks = markdownToBlocks(doc, markdown);
  doc.blocks = blocks.length ? blocks : [emptyPara(newId(doc, 'b'))];
  if (doc.blocks[doc.blocks.length - 1].type !== 'p') doc.blocks.push(emptyPara(newId(doc, 'b')));
  return doc;
}

/* ---------------- templates ---------------- */

export type TemplateId = 'blank' | 'meeting' | 'proposal' | 'report';
export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: 'blank', label: 'Blank', hint: 'An empty page.' },
  { id: 'meeting', label: 'Meeting notes', hint: 'Date, attendees, agenda, notes and an action-item checklist.' },
  { id: 'proposal', label: 'Project proposal', hint: 'Title page block, summary, goals, scope, timeline table, budget and risks.' },
  { id: 'report', label: 'Report', hint: 'Title, table of contents, executive summary, findings with a table, recommendations and references.' },
];
/** Builds a template; `date` is shown where the template asks for today's date. */
export function templateDoc(id: TemplateId, title: string, date: string): Doc {
  const doc = emptyDoc(title);
  doc.blocks = [];
  const P = (text: string, patch: Partial<Para> = {}): Para => ({ ...emptyPara(newId(doc, 'b')), ...patch, runs: parseInline(text) });
  const table = (rows: string[][], headerBg = '#f3f3f3'): Table => ({
    type: 'table', id: newId(doc, 'b'),
    rows: rows.map((r, ri) => r.map((text) => ({ paras: [P(ri === 0 ? `**${text}**` : text)], ...(ri === 0 ? { bg: headerBg } : {}) }))),
  });
  const add = (...b: Block[]) => doc.blocks.push(...b);
  if (id === 'meeting') {
    add(P(title, { style: 'title' }), P(`${date} · Meeting notes`, { style: 'subtitle' }),
      P('Attendees', { style: 'h2' }), P('Name, name, name'),
      P('Agenda', { style: 'h2' }), P('Topic one', { list: 'number' }), P('Topic two', { list: 'number' }), P('Topic three', { list: 'number' }),
      P('Notes', { style: 'h2' }), P('Key points discussed', { list: 'bullet' }), P('Decisions made', { list: 'bullet' }),
      P('Action items', { style: 'h2' }), P('**Owner** — task — due date', { list: 'check' }), P('**Owner** — task — due date', { list: 'check' }));
  } else if (id === 'proposal') {
    add(P(title, { style: 'title' }), P(`Project proposal · ${date}`, { style: 'subtitle' }),
      P('Summary', { style: 'h1' }), P('One paragraph: the problem, the proposed solution and the expected outcome.'),
      P('Goals', { style: 'h1' }), P('Goal one — how it will be measured', { list: 'bullet' }), P('Goal two — how it will be measured', { list: 'bullet' }),
      P('Scope', { style: 'h1' }), P('In scope', { style: 'h2' }), P('…', { list: 'bullet' }), P('Out of scope', { style: 'h2' }), P('…', { list: 'bullet' }),
      P('Timeline', { style: 'h1' }),
      table([['Milestone', 'Description', 'Date'], ['Kick-off', 'Team and plan agreed', ''], ['Prototype', 'First working version', ''], ['Launch', 'Available to users', '']]),
      P('Budget', { style: 'h1' }), P('Estimated cost and what it pays for.'),
      P('Risks', { style: 'h1' }), P('Risk — likelihood — mitigation', { list: 'bullet' }));
  } else if (id === 'report') {
    add(P(title, { style: 'title' }), P(`Report · ${date}`, { style: 'subtitle' }), { type: 'toc', id: newId(doc, 'b') },
      P('Executive summary', { style: 'h1' }), P('The main finding and recommendation in three or four sentences.'),
      P('Background', { style: 'h1' }), P('Why this report was written and what question it answers.'),
      P('Findings', { style: 'h1' }), P('Finding one', { style: 'h2' }), P('Evidence and what it means.'),
      table([['Measure', 'Before', 'After', 'Change'], ['', '', '', ''], ['', '', '', '']]),
      P('Finding two', { style: 'h2' }), P('Evidence and what it means.'),
      P('Recommendations', { style: 'h1' }), P('Recommendation — owner — date', { list: 'number' }), P('Recommendation — owner — date', { list: 'number' }),
      P('References', { style: 'h1' }), P('Source, title, date.', { list: 'number' }));
    doc.footer = { text: '{page}', align: 'right' };
  }
  doc.blocks.push(emptyPara(newId(doc, 'b')));
  return doc;
}

/** Plain text (one paragraph per line) → paragraphs. */
export function textToBlocks(doc: Doc, text: string): Para[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => ({ ...emptyPara(newId(doc, 'b')), runs: line ? [{ t: line }] : [] }));
}
export { ATOM, plainText };
