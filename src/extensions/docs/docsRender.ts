/** How a document page looks: one stylesheet for the editor surface and for pictures of pages, plus the renderer
 * agents use to see pages (the page column laid out off-screen, paginated, and drawn through an SVG image). */
import { STYLE_LOOK, fillFields, pageInches, paginate, type Doc, type ParaStyle } from './docs';
import { blocksHtml, cssFont } from './docsFormat';

export const PX_PER_IN = 96;
export const PAGE_GAP = 16;

/** CSS for the text of a page, scoped under `scope` (e.g. ".dc-surface"). */
export function docPageCss(scope: string, doc: Doc): string {
  const S = scope;
  const heads = (Object.keys(STYLE_LOOK) as ParaStyle[]).filter((s) => s !== 'normal').map((s) => {
    const look = STYLE_LOOK[s];
    return `${S} [data-style="${s}"]{font-size:${look.size}pt;margin:${look.sb}pt 0 ${look.sa}pt;font-weight:400;${look.color ? `color:${look.color};` : ''}${look.italic ? 'font-style:italic;' : ''}}`;
  }).join('\n');
  const levels = Array.from({ length: 9 }, (_, i) => `${S} [data-list][data-lvl="${i}"]{margin-left:${0.5 + i * 0.5}in}`).join('\n');
  return `${S}{font-family:${cssFont(doc.font.family)},Arial,sans-serif;font-size:${doc.font.size}pt;line-height:1.15;color:#000;white-space:pre-wrap;overflow-wrap:break-word;outline:none;tab-size:4;caret-color:#000}
${S} p,${S} h1,${S} h2,${S} h3,${S} h4,${S} h5,${S} h6{margin:0;font-weight:400}
${heads}
${S} [data-list]{position:relative}
${S} [data-list]::before{content:attr(data-label);position:absolute;left:-0.36in;width:0.3in;text-align:right;white-space:nowrap;font-style:normal;text-decoration:none}
${S} [data-list="check"]::before{cursor:pointer;font-size:1.15em;line-height:1}
${S} [data-list="check"][data-checked="true"]{text-decoration:line-through;color:#5f6368}
${levels}
${S} b{font-weight:700}
${S} a{color:#1155cc;text-decoration:underline}
${S} code{font-family:'Courier New',monospace}
${S} img.dc-img{max-width:100%;height:auto;vertical-align:bottom}
${S} img.dc-img--on{outline:2px solid #1a73e8;outline-offset:1px}
${S} table.dc-table{border-collapse:collapse;width:100%;table-layout:fixed;margin:4pt 0;white-space:pre-wrap}
${S} table.dc-table td{border:1px solid #000;padding:5pt;vertical-align:top;min-width:1.5em}
${S} table.dc-table td.dc-cell--on{background-image:linear-gradient(rgba(26,115,232,.14),rgba(26,115,232,.14))}
${S} ins[data-s]{color:#188038;text-decoration:underline;text-decoration-color:#188038}
${S} del[data-s]{color:#c5221f;text-decoration:line-through}
${S} .dc-c{background:#fde293;border-bottom:2px solid #f6bf26}
${S} .dc-c.dc-c--resolved{background:none;border-bottom:0}
${S} .dc-c.dc-c--active{background:#fcc934}
${S} .dc-eq{font-family:'Cambria Math','Times New Roman',serif;font-style:italic;padding:0 2px;border-radius:3px;cursor:pointer}
${S} .dc-eq:hover{background:#e8f0fe}
${S} .dc-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:.85em;line-height:1.05}
${S} .dc-frac>span:first-child{border-bottom:1px solid currentColor}
${S} .dc-sqrt{border-top:1px solid currentColor}
${S} .dc-fn{color:#1155cc;cursor:pointer;font-size:.7em;padding:0 1px}
${S} .dc-hr{padding:6pt 0}
${S} .dc-hr hr{border:0;border-top:1px solid #000;margin:0}
${S} .dc-pb{margin:8pt 0;border-top:1px dashed #9aa0a6;text-align:center;line-height:0;user-select:none}
${S} .dc-pb span{background:inherit;color:#80868b;font:500 8pt Arial,sans-serif;padding:0 6px;background:#fff}
${S} .dc-toc{margin:6pt 0;padding:6pt 0;user-select:none}
${S} .dc-toc__title{font-size:9pt;color:#5f6368;margin-bottom:4pt}
${S} .dc-toc a{color:#1155cc;text-decoration:underline;cursor:pointer}
${S} .dc-toc__empty{color:#80868b;font-style:italic}`;
}

export interface PageGeometry { pageW: number; pageH: number; contentW: number; contentH: number; mt: number; ml: number; mb: number; stride: number }
export function pageGeometry(doc: Doc): PageGeometry {
  const { w, h } = pageInches(doc.page);
  const m = doc.page.margins;
  const pageW = Math.round(w * PX_PER_IN), pageH = Math.round(h * PX_PER_IN);
  return {
    pageW, pageH,
    contentW: Math.max(48, Math.round((w - m.left - m.right) * PX_PER_IN)),
    contentH: Math.max(48, Math.round((h - m.top - m.bottom) * PX_PER_IN)),
    mt: Math.round(m.top * PX_PER_IN), ml: Math.round(m.left * PX_PER_IN), mb: Math.round(m.bottom * PX_PER_IN),
    stride: pageH + PAGE_GAP,
  };
}

/** Measures the top-level blocks of a laid-out surface, then pushes the ones that do not fit to the next page.
 * Paragraphs get padding (the parser ignores it); tables get margin (tables have no padding when collapsed). */
export function layoutPages(surface: HTMLElement, g: PageGeometry): number {
  const kids = [...surface.children] as HTMLElement[];
  for (const el of kids) { if (el.dataset.push) { if (el.tagName === 'TABLE') el.style.marginTop = el.dataset.margin ?? ''; else el.style.paddingTop = ''; delete el.dataset.push; delete el.dataset.margin; } }
  const base = surface.getBoundingClientRect().top;
  const zoom = surface.offsetHeight ? surface.getBoundingClientRect().height / surface.offsetHeight : 1;
  const rects = kids.map((el) => { const r = el.getBoundingClientRect(); return { top: (r.top - base) / zoom, height: r.height / zoom }; });
  const items = kids.map((el, i) => ({ ...rects[i], pageBreak: el.getAttribute('data-block') === 'pagebreak' }));
  const { pushes, pages } = paginate(items, g.contentH, g.stride);
  kids.forEach((el, i) => {
    const push = pushes[i];
    if (!push) return;
    el.dataset.push = String(Math.round(push));
    if (el.tagName === 'TABLE') {
      el.dataset.margin = el.style.marginTop;
      const prev = rects[i - 1];
      const gap = prev ? rects[i].top - (prev.top + prev.height) : 0;
      el.style.marginTop = `${Math.max(0, gap) + push}px`;
    } else el.style.paddingTop = `${push}px`;
  });
  return pages;
}

const svgEsc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the page picture could not be drawn'));
    img.src = src;
  });
}

/** Pictures of pages side by side (PNG data URL). */
export async function renderPages(doc: Doc, opts: { pages?: number[]; scale?: number } = {}): Promise<{ dataUrl: string; width: number; height: number; pages: number; shown: number[] }> {
  const g = pageGeometry(doc);
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${g.contentW}px;visibility:hidden;pointer-events:none`;
  const style = document.createElement('style');
  style.textContent = docPageCss('.dcp', doc);
  const surface = document.createElement('div');
  surface.className = 'dcp';
  // Pictures are drawn through an SVG image, which may not load outside resources: drop non-data images.
  surface.innerHTML = blocksHtml(doc, { editor: true }).replace(/<img src="(?!data:)[^"]*"/g, '<img src=""');
  host.append(style, surface);
  document.body.appendChild(host);
  try {
    await Promise.all([...surface.querySelectorAll('img')].map((img) => (img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); }))));
    const pages = layoutPages(surface, g);
    const shown = (opts.pages?.length ? opts.pages.filter((p) => p <= pages) : Array.from({ length: Math.min(4, pages) }, (_, i) => i + 1)).slice(0, 6);
    if (!shown.length) throw new Error(`the document has ${pages} page(s)`);
    const html = new XMLSerializer().serializeToString(surface);
    const css = new XMLSerializer().serializeToString(style);
    const date = new Date().toISOString().slice(0, 10);
    const scale = opts.scale ?? (shown.length > 2 ? 0.6 : 0.8);
    const W = Math.round(g.pageW * scale), H = Math.round(g.pageH * scale), GAP = 16;
    const canvas = document.createElement('canvas');
    canvas.width = shown.length * W + (shown.length + 1) * GAP;
    canvas.height = H + 2 * GAP;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#e8eaed';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const m = doc.page.margins;
    for (let k = 0; k < shown.length; k++) {
      const n = shown[k];
      const hfText = (hf: Doc['header'], y: number) => {
        if (!hf || (doc.firstPageDifferent && n === 1)) return '';
        const anchor = hf.align === 'center' ? 'middle' : hf.align === 'right' ? 'end' : 'start';
        const x = hf.align === 'center' ? g.pageW / 2 : hf.align === 'right' ? g.pageW - m.right * PX_PER_IN : m.left * PX_PER_IN;
        return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial" font-size="12" fill="#5f6368">${svgEsc(fillFields(hf.text, { page: n, pages, title: doc.title, date }))}</text>`;
      };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${g.pageW}" height="${g.pageH}"><rect width="100%" height="100%" fill="${doc.page.color ?? '#ffffff'}"/>`
        + `<foreignObject x="${g.ml}" y="${g.mt}" width="${g.contentW}" height="${g.contentH}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${g.contentW}px;height:${g.contentH}px;overflow:hidden;position:relative">${css}<div style="position:absolute;left:0;top:${-(n - 1) * g.stride}px;width:${g.contentW}px">${html}</div></div></foreignObject>`
        + hfText(doc.header, Math.max(14, g.mt / 2)) + hfText(doc.footer, g.pageH - Math.max(10, g.mb / 2 - 6)) + '</svg>';
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const x = GAP + k * (W + GAP);
      ctx.fillStyle = 'rgba(60,64,67,.25)';
      ctx.fillRect(x + 2, GAP + 2, W, H);
      ctx.drawImage(img, x, GAP, W, H);
    }
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, pages, shown };
  } finally {
    host.remove();
  }
}
