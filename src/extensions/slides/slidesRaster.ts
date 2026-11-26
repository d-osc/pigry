/** Pictures of slides in the webview: one slide → PNG/JPEG (SVG foreignObject drawn on a canvas), a contact sheet of
 * several slides for the agent, chart pictures for PowerPoint, and the PDF export. Browser-only. */
import { hiddenAt, type Deck, type Slide } from './slides';
import { SLIDE_CSS, chartSvg, slideHtml } from './slidesRender';
import { fromBase64, needsRaster, pdfFromJpegs, pptxBytes } from './slidesExport';

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('the slide could not be drawn'));
  img.src = src;
});

/** A slide as well-formed XHTML inside an SVG (what canvas can draw). */
async function slideSvg(deck: Deck, slide: Slide, step?: number): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-30000px;top:0;visibility:hidden;pointer-events:none';
  const hidden = step === undefined ? undefined : hiddenAt(slide, step);
  // Drawn through an SVG image, which may not load outside resources: drop non-data images.
  host.innerHTML = slideHtml(deck, slide, { hidden }).replace(/<img([^>]*?) src="(?!data:)[^"]*"/g, '<img$1 src=""').replace(/url\("(?!data:)[^"]*"\)/g, 'none');
  document.body.appendChild(host);
  try {
    await Promise.all([...host.querySelectorAll('img')].map((img) => (img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); }))));
    const xhtml = new XMLSerializer().serializeToString(host.firstElementChild as Element);
    const css = SLIDE_CSS.replace(/</g, '&lt;');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${deck.size.w}" height="${deck.size.h}"><foreignObject x="0" y="0" width="${deck.size.w}" height="${deck.size.h}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${xhtml.includes('xmlns=') ? xhtml : xhtml.replace(/^<div /, '<div xmlns="http://www.w3.org/1999/xhtml" ')}</div></foreignObject></svg>`;
  } finally { host.remove(); }
}

export async function slideCanvas(deck: Deck, slide: Slide, scale = 1, step?: number): Promise<HTMLCanvasElement> {
  const svg = await slideSvg(deck, slide, step);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(deck.size.w * scale); canvas.height = Math.round(deck.size.h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
export async function slidePng(deck: Deck, slide: Slide, scale = 1): Promise<string> {
  return (await slideCanvas(deck, slide, scale)).toDataURL('image/png');
}

/** Several slides side by side with their numbers (what the agent looks at). */
export async function slidesSheet(deck: Deck, numbers: number[], opts: { scale?: number; columns?: number } = {}): Promise<{ dataUrl: string; width: number; height: number }> {
  const scale = opts.scale ?? (numbers.length > 4 ? 0.42 : numbers.length > 1 ? 0.55 : 0.9);
  const cols = opts.columns ?? Math.min(numbers.length, numbers.length > 4 ? 3 : 2);
  const rows = Math.ceil(numbers.length / cols);
  const W = Math.round(deck.size.w * scale), H = Math.round(deck.size.h * scale), GAP = 14, LABEL = 18;
  const canvas = document.createElement('canvas');
  canvas.width = cols * W + (cols + 1) * GAP; canvas.height = rows * (H + LABEL) + (rows + 1) * GAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.fillStyle = '#dadce0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let k = 0; k < numbers.length; k++) {
    const n = numbers[k];
    const slide = deck.slides[n - 1];
    if (!slide) continue;
    const c = await slideCanvas(deck, slide, scale);
    const x = GAP + (k % cols) * (W + GAP), y = GAP + Math.floor(k / cols) * (H + LABEL + GAP);
    ctx.fillStyle = '#3c4043';
    ctx.font = '600 12px Arial';
    ctx.fillText(`Slide ${n}${slide.hidden ? ' (skipped)' : ''}`, x, y + 12);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fillRect(x + 2, y + LABEL + 2, W, H);
    ctx.drawImage(c, x, y + LABEL, W, H);
  }
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

async function svgPng(svg: string, w: number, h: number, scale = 2): Promise<string> {
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** PowerPoint bytes, with charts and SVG/WebP images drawn as PNG pictures first. */
export async function pptxWithPictures(deck: Deck): Promise<Uint8Array> {
  const rasters = new Map<string, string>();
  for (const s of deck.slides) for (const e of s.elements) {
    if (!needsRaster(e)) continue;
    try {
      if (e.type === 'chart') rasters.set(e.id, await svgPng(chartSvg(e, deck.theme).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), e.w, e.h));
      else if (e.type === 'image') { const img = await loadImage(e.src); const c = document.createElement('canvas'); c.width = img.naturalWidth || Math.round(e.w); c.height = img.naturalHeight || Math.round(e.h); c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height); rasters.set(e.id, c.toDataURL('image/png')); }
    } catch { /* left as a placeholder */ }
  }
  return pptxBytes(deck, { rasters });
}

/** A PDF with one page per slide (skipped slides left out). */
export async function slidesPdf(deck: Deck, scale = 2): Promise<Uint8Array> {
  const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
  for (const s of deck.slides) {
    if (s.hidden) continue;
    const c = await slideCanvas(deck, s, scale);
    const url = c.toDataURL('image/jpeg', 0.92);
    pages.push({ jpeg: fromBase64(url.slice(url.indexOf(',') + 1)), w: c.width, h: c.height });
  }
  if (!pages.length) throw new Error('every slide is skipped — there is nothing to print');
  return pdfFromJpegs(pages, Math.round(deck.size.w * 0.75), Math.round(deck.size.h * 0.75), deck.title);
}
