/** Slides → HTML. One renderer for the editor canvas, the filmstrip, present mode, pictures and the HTML export,
 * so a slide looks the same everywhere. Pure string building (no DOM) — node tests import it. */
import {
  BULLETS, PLACEHOLDER_HINT, animSteps, animTimes, hasText, paraText, resolveColor, roleLook, shrinkScale,
  type Anim, type Background, type ChartEl, type Deck, type El, type LineEl, type Para, type Run, type ShapeEl, type ShapeKind, type Slide, type TextEl, type Theme,
} from './slides.ts';

export const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (v: number): string => String(Math.round(v * 10) / 10);
const cssFont = (f: string): string => `'${f.replace(/'/g, '')}', Arial, sans-serif`;

/** CSS shared by every place a slide is drawn (scoped under .sld). */
export const SLIDE_CSS = `
.sld{position:relative;overflow:hidden;box-sizing:border-box;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.sld *{box-sizing:border-box}
.sld-el{position:absolute;transform-origin:50% 50%}
.sld-box{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden}
.sld-v-top{justify-content:flex-start}.sld-v-middle{justify-content:center}.sld-v-bottom{justify-content:flex-end}
.sld-flow{counter-reset:n0 n1 n2 n3 n4;outline:none;overflow-wrap:break-word;word-break:normal;white-space:pre-wrap;min-height:1em}
.sld-p{position:relative;margin:0;padding:0;min-height:1em}
.sld-p[data-list]{padding-left:1.35em}
.sld-p[data-list]::before{position:absolute;left:0;width:1.35em;text-align:left}
.sld-p[data-list=bullet]::before{content:"${BULLETS[0]}";font-size:.75em;line-height:1.6}
.sld-p[data-list=bullet][data-level="1"]::before{content:"${BULLETS[1]}"}
.sld-p[data-list=bullet][data-level="2"]::before{content:"${BULLETS[2]}"}
.sld-p[data-list=bullet][data-level="3"]::before{content:"${BULLETS[3]}"}
.sld-p[data-list=bullet][data-level="4"]::before{content:"${BULLETS[4]}"}
.sld-p:not([data-list]){counter-reset:n0 n1 n2 n3 n4}
.sld-p[data-list=number]:not([data-level]){counter-increment:n0}.sld-p[data-list=number]:not([data-level])::before{content:counter(n0) "."}
.sld-p[data-list=number][data-level="1"]{counter-increment:n1}.sld-p[data-list=number][data-level="1"]::before{content:counter(n1,lower-alpha) "."}
.sld-p[data-list=number][data-level="2"]{counter-increment:n2}.sld-p[data-list=number][data-level="2"]::before{content:counter(n2,lower-roman) "."}
.sld-p[data-list=number][data-level="3"]{counter-increment:n3}.sld-p[data-list=number][data-level="3"]::before{content:counter(n3) "."}
.sld-p[data-list=number][data-level="4"]{counter-increment:n4}.sld-p[data-list=number][data-level="4"]::before{content:counter(n4,lower-alpha) "."}
.sld-p:not([data-level])[data-list]+.sld-p[data-list=bullet]:not([data-level]){counter-reset:n1 n2 n3 n4}
.sld-p a{color:inherit;text-decoration:underline}
.sld-ph{opacity:.55}
.sld-geom,.sld-line{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sld-img{position:absolute;inset:0;width:100%;height:100%;display:block}
.sld-table{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}
.sld-table td{padding:.25em .5em;vertical-align:middle;overflow:hidden;overflow-wrap:break-word}
.sld-icon{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;line-height:1}
.sld-embed{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4em;border-radius:8px;text-align:center;padding:8px;overflow:hidden;font-size:14px;text-decoration:none}
.sld-embed b{font-size:1.15em}
.sld-embed i{font-style:normal;font-size:2.4em;line-height:1}
.sld-embed small{opacity:.7;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

/** Keyframes for transitions (.sld-tr-<kind>) and object animations (.sld-a-<effect>). */
export const MOTION_CSS = `
@keyframes sld-t-fade{from{opacity:0}to{opacity:1}}
@keyframes sld-t-slide-left{from{transform:translateX(100%)}to{transform:none}}
@keyframes sld-t-slide-right{from{transform:translateX(-100%)}to{transform:none}}
@keyframes sld-t-slide-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes sld-t-zoom{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}
@keyframes sld-t-flip{from{transform:perspective(1600px) rotateY(80deg);opacity:0}to{transform:none;opacity:1}}
@keyframes sld-a-appear{from{opacity:0}to{opacity:1}}
@keyframes sld-a-fade-in{from{opacity:0}to{opacity:1}}
@keyframes sld-a-fly-left{from{translate:-120vw 0}to{translate:0 0}}
@keyframes sld-a-fly-right{from{translate:120vw 0}to{translate:0 0}}
@keyframes sld-a-fly-up{from{translate:0 120vh}to{translate:0 0}}
@keyframes sld-a-fly-down{from{translate:0 -120vh}to{translate:0 0}}
@keyframes sld-a-zoom-in{from{scale:.2;opacity:0}to{scale:1;opacity:1}}
@keyframes sld-a-spin{from{rotate:-360deg;opacity:0}to{rotate:0deg;opacity:1}}
@keyframes sld-a-fade-out{from{opacity:1}to{opacity:0}}
@keyframes sld-a-disappear{from{opacity:1}to{opacity:0}}
`;

export function backgroundCss(theme: Theme, bg: Background | undefined): string {
  if (!bg) return `background:${theme.colors.background}`;
  if (bg.type === 'color') return `background:${resolveColor(theme, bg.color, theme.colors.background)}`;
  if (bg.type === 'gradient') return `background:linear-gradient(${bg.angle ?? 180}deg,${resolveColor(theme, bg.from)},${resolveColor(theme, bg.to)})`;
  return `background:${theme.colors.background} url("${bg.src.replace(/"/g, '%22')}") center/${bg.fit === 'contain' ? 'contain' : 'cover'} no-repeat`;
}

/* ---------------- text ---------------- */

function runHtml(r: Run, theme: Theme, refs: boolean): string {
  const st: string[] = [];
  if (r.b === true) st.push('font-weight:700'); else if (r.b === false) st.push('font-weight:400');
  if (r.i) st.push('font-style:italic');
  const deco = [r.u || r.link ? 'underline' : '', r.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) st.push(`text-decoration:${deco}`);
  if (r.color) st.push(`color:${resolveColor(theme, r.color)}`);
  if (r.hl) st.push(`background:${resolveColor(theme, r.hl)}`);
  if (r.font) st.push(`font-family:${cssFont(r.font)}`);
  if (r.size) st.push(`font-size:${n1(r.size)}pt`);
  if (r.sup) st.push('vertical-align:super;font-size:.65em');
  if (r.sub) st.push('vertical-align:sub;font-size:.65em');
  const text = esc(r.t);
  const data = refs ? `${r.color?.startsWith('$') ? ` data-color="${r.color}"` : ''}${r.hl?.startsWith('$') ? ` data-hl="${r.hl}"` : ''}` : '';
  const span = st.length ? `<span${data} style="${st.join(';')}">${text}</span>` : `<span>${text}</span>`;
  return r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noreferrer">${span}</a>` : span;
}
/** Paragraphs as HTML; refs keeps theme colour references (data-color) so the editor can read them back. */
export function parasHtml(paras: Para[], theme: Theme, refs = false, hidePara?: Set<number>): string {
  return paras.map((p, i) => {
    const attrs = [p.list ? ` data-list="${p.list}"` : '', p.level ? ` data-level="${p.level}"` : ''].join('');
    const st: string[] = [];
    if (p.align && p.align !== 'left') st.push(`text-align:${p.align}`);
    if (p.lh) st.push(`line-height:${p.lh}`);
    if (p.level) st.push(`margin-left:${n1(p.level * 1.2)}em`);
    if (p.sb) st.push(`margin-top:${p.sb}px`);
    if (p.sa) st.push(`margin-bottom:${p.sa}px`);
    if (hidePara?.has(i)) st.push('visibility:hidden');
    const inner = p.runs.length ? p.runs.map((r) => runHtml(r, theme, refs)).join('') : '<br>';
    return `<div class="sld-p"${attrs}${st.length ? ` style="${st.join(';')}"` : ''}>${inner}</div>`;
  }).join('');
}
const isEmpty = (paras: Para[]): boolean => paras.every((p) => !paraText(p).trim());
export const boxPad = (el: TextEl | ShapeEl): number => (el.type === 'text' ? el.pad ?? 8 : Math.max(6, Math.min(el.w, el.h) * 0.08));
/** The inherited text style of a box (theme font, size and colour by role; shapes centre their text). */
export function flowStyle(deck: Deck, slide: Slide, el: TextEl | ShapeEl): string {
  const look = roleLook(deck.theme, el.type === 'text' ? el.role : undefined, slide.layout);
  const align = el.type === 'shape' ? 'center' : look.align;
  return `font-family:${cssFont(look.font)};font-size:${look.size}pt;color:${look.color};font-weight:${look.b ? 700 : 400};line-height:1.2;text-align:${align}`;
}

export interface RenderOpts {
  /** Editor canvas: show placeholder hints and keep empty placeholders. */
  editor?: boolean;
  /** Elements to leave out (the one being edited is drawn by the editor itself). */
  skip?: Set<string>;
  /** Elements not shown yet at this animation step. */
  hidden?: Set<string>;
  /** Per-element CSS animation (present mode / export). */
  animate?: Map<string, string>;
}

function textBoxHtml(deck: Deck, slide: Slide, el: TextEl | ShapeEl, opts: RenderOpts): string {
  const theme = deck.theme;
  const role = el.type === 'text' ? el.role : undefined;
  const look = roleLook(theme, role, slide.layout);
  const empty = isEmpty(el.paras);
  const placeholder = el.type === 'text' && el.placeholder && empty;
  if (placeholder && !opts.editor) return '';
  const scale = el.type === 'text' ? shrinkScale(el, look) : 1;
  const valign = el.valign ?? (el.type === 'shape' ? 'middle' : 'top');
  const flow = flowStyle(deck, slide, el) + (scale < 1 ? `;zoom:${scale}` : '');
  const paras = placeholder
    ? `<div class="sld-p sld-ph"${role === 'body' ? ' data-list="bullet"' : ''}><span>${esc(PLACEHOLDER_HINT[role ?? 'body'])}</span></div>`
    : parasHtml(el.paras, theme);
  const boxSt = [`padding:${n1(boxPad(el))}px`];
  if (el.type === 'text') {
    if (el.fill) boxSt.push(`background:${resolveColor(theme, el.fill)}`);
    if (el.stroke && el.strokeW !== 0) boxSt.push(`border:${el.strokeW ?? 1}px solid ${resolveColor(theme, el.stroke)}`);
  }
  return `<div class="sld-box sld-v-${valign}" style="${boxSt.join(';')}"><div class="sld-flow" style="${flow}">${paras}</div></div>`;
}

/* ---------------- shapes ---------------- */

const pts = (list: [number, number][]): string => `M${list.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' L')} Z`;
function polygon(n: number, w: number, h: number, rot = -90, inner = 0): [number, number][] {
  const out: [number, number][] = [];
  const count = inner ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = ((rot + (360 / count) * i) * Math.PI) / 180;
    const r = inner && i % 2 ? inner : 1;
    out.push([w / 2 + (Math.cos(a) * w * r) / 2, h / 2 + (Math.sin(a) * h * r) / 2]);
  }
  return out;
}
/** SVG path of a shape in a w × h box. */
export function shapePath(kind: ShapeKind, w: number, h: number): string {
  const m = Math.min(w, h);
  switch (kind) {
    case 'rect': return pts([[0, 0], [w, 0], [w, h], [0, h]]);
    case 'roundRect': { const r = Math.min(m * 0.18, 24); return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`; }
    case 'ellipse': return `M0,${h / 2} A${w / 2},${h / 2} 0 1 0 ${w},${h / 2} A${w / 2},${h / 2} 0 1 0 0,${h / 2} Z`;
    case 'triangle': return pts([[w / 2, 0], [w, h], [0, h]]);
    case 'rightTriangle': return pts([[0, 0], [w, h], [0, h]]);
    case 'diamond': return pts([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'pentagon': return pts(polygon(5, w, h));
    case 'hexagon': return pts([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
    case 'octagon': { const a = m * 0.29; return pts([[a, 0], [w - a, 0], [w, a], [w, h - a], [w - a, h], [a, h], [0, h - a], [0, a]]); }
    case 'star': return pts(polygon(5, w, h, -90, 0.42));
    case 'plus': { const a = w / 3, b = h / 3; return pts([[a, 0], [w - a, 0], [w - a, b], [w, b], [w, h - b], [w - a, h - b], [w - a, h], [a, h], [a, h - b], [0, h - b], [0, b], [a, b]]); }
    case 'chevron': { const a = Math.min(w * 0.4, h * 0.5); return pts([[0, 0], [w - a, 0], [w, h / 2], [w - a, h], [0, h], [a, h / 2]]); }
    case 'parallelogram': { const a = w * 0.22; return pts([[a, 0], [w, 0], [w - a, h], [0, h]]); }
    case 'trapezoid': { const a = w * 0.2; return pts([[a, 0], [w - a, 0], [w, h], [0, h]]); }
    case 'arrowRight': { const a = Math.min(w * 0.45, h * 0.6), t = h * 0.25; return pts([[0, t], [w - a, t], [w - a, 0], [w, h / 2], [w - a, h], [w - a, h - t], [0, h - t]]); }
    case 'arrowLeft': { const a = Math.min(w * 0.45, h * 0.6), t = h * 0.25; return pts([[w, t], [a, t], [a, 0], [0, h / 2], [a, h], [a, h - t], [w, h - t]]); }
    case 'arrowUp': { const a = Math.min(h * 0.45, w * 0.6), t = w * 0.25; return pts([[t, h], [t, a], [0, a], [w / 2, 0], [w, a], [w - t, a], [w - t, h]]); }
    case 'arrowDown': { const a = Math.min(h * 0.45, w * 0.6), t = w * 0.25; return pts([[t, 0], [t, h - a], [0, h - a], [w / 2, h], [w, h - a], [w - t, h - a], [w - t, 0]]); }
    case 'arrowLeftRight': { const a = Math.min(w * 0.3, h * 0.6), t = h * 0.25; return pts([[0, h / 2], [a, 0], [a, t], [w - a, t], [w - a, 0], [w, h / 2], [w - a, h], [w - a, h - t], [a, h - t], [a, h]]); }
    case 'callout': { const r = Math.min(m * 0.12, 16), b = h * 0.78; return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${b - r} Q${w},${b} ${w - r},${b} H${w * 0.42} L${w * 0.22},${h} L${w * 0.26},${b} H${r} Q0,${b} 0,${b - r} V${r} Q0,0 ${r},0 Z`; }
    case 'cloudCallout': { const b = h * 0.8; return `M${w * 0.2},${b * 0.95} C${-w * 0.05},${b * 0.95} ${-w * 0.02},${b * 0.45} ${w * 0.15},${b * 0.42} C${w * 0.12},${b * 0.05} ${w * 0.45},${-b * 0.02} ${w * 0.52},${b * 0.18} C${w * 0.62},${-b * 0.04} ${w * 0.95},${b * 0.05} ${w * 0.88},${b * 0.4} C${w * 1.05},${b * 0.5} ${w * 1.02},${b * 0.98} ${w * 0.78},${b * 0.95} C${w * 0.7},${b * 1.08} ${w * 0.32},${b * 1.08} ${w * 0.2},${b * 0.95} Z M${w * 0.16},${h * 0.9} a${w * 0.04},${h * 0.04} 0 1 0 0.1,0 Z M${w * 0.08},${h * 0.98} a${w * 0.02},${h * 0.02} 0 1 0 0.1,0 Z`; }
    case 'heart': return `M${w / 2},${h * 0.95} C${w * 0.1},${h * 0.65} 0,${h * 0.45} 0,${h * 0.28} C0,${h * 0.08} ${w * 0.18},0 ${w * 0.3},0 C${w * 0.42},0 ${w / 2},${h * 0.12} ${w / 2},${h * 0.22} C${w / 2},${h * 0.12} ${w * 0.58},0 ${w * 0.7},0 C${w * 0.82},0 ${w},${h * 0.08} ${w},${h * 0.28} C${w},${h * 0.45} ${w * 0.9},${h * 0.65} ${w / 2},${h * 0.95} Z`;
    case 'cloud': return `M${w * 0.22},${h * 0.92} C${-w * 0.04},${h * 0.92} ${-w * 0.02},${h * 0.48} ${w * 0.16},${h * 0.44} C${w * 0.12},${h * 0.06} ${w * 0.46},${-h * 0.02} ${w * 0.53},${h * 0.2} C${w * 0.64},${-h * 0.03} ${w * 0.96},${h * 0.07} ${w * 0.88},${h * 0.42} C${w * 1.05},${h * 0.52} ${w * 1.02},${h * 0.95} ${w * 0.78},${h * 0.92} Z`;
    default: return pts([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}
function shapeHtml(deck: Deck, slide: Slide, el: ShapeEl, opts: RenderOpts): string {
  const t = deck.theme;
  const sw = el.strokeW ?? (el.stroke ? 2 : 0);
  const fill = resolveColor(t, el.fill ?? '$accent');
  const stroke = el.stroke ? resolveColor(t, el.stroke) : 'none';
  const filter = el.shadow ? ' style="filter:drop-shadow(0 3px 6px rgba(0,0,0,.28))"' : '';
  const geom = `<svg class="sld-geom" viewBox="0 0 ${n1(el.w)} ${n1(el.h)}" preserveAspectRatio="none"${filter}><path d="${shapePath(el.shape, el.w, el.h)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${el.dash ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : ''} vector-effect="non-scaling-stroke"/></svg>`;
  return geom + (isEmpty(el.paras) ? '' : textBoxHtml(deck, slide, el, opts));
}
function lineHtml(theme: Theme, el: LineEl): string {
  const sw = el.strokeW ?? 3;
  const color = resolveColor(theme, el.stroke ?? '$text');
  const [x1, y1, x2, y2] = el.dir === 'up' ? [0, el.h, el.w, 0] : [0, 0, el.w, el.h];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = (x: number, y: number, a: number, kind: LineEl['end']): string => {
    if (!kind || kind === 'none') return '';
    if (kind === 'dot') return `<circle cx="${n1(x)}" cy="${n1(y)}" r="${n1(sw * 1.8)}" fill="${color}"/>`;
    const L = sw * 4.5, W = sw * 2.6;
    const bx = x - Math.cos(a) * L, by = y - Math.sin(a) * L;
    return `<path d="M${n1(x)},${n1(y)} L${n1(bx - Math.sin(a) * W)},${n1(by + Math.cos(a) * W)} L${n1(bx + Math.sin(a) * W)},${n1(by - Math.cos(a) * W)} Z" fill="${color}"/>`;
  };
  // Shorten the line under an arrow head so the tip stays sharp.
  const cut = (k: LineEl['end']) => (k === 'arrow' ? sw * 3.5 : 0);
  const sx = x1 + Math.cos(ang) * cut(el.start), sy = y1 + Math.sin(ang) * cut(el.start);
  const ex = x2 - Math.cos(ang) * cut(el.end), ey = y2 - Math.sin(ang) * cut(el.end);
  return `<svg class="sld-line" viewBox="0 0 ${n1(Math.max(1, el.w))} ${n1(Math.max(1, el.h))}" preserveAspectRatio="none"><line x1="${n1(sx)}" y1="${n1(sy)}" x2="${n1(ex)}" y2="${n1(ey)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"${el.dash ? ` stroke-dasharray="${sw * 3} ${sw * 2.5}"` : ''}/>${head(x2, y2, ang, el.end)}${head(x1, y1, ang + Math.PI, el.start)}</svg>`;
}

/* ---------------- charts ---------------- */

export const seriesColor = (theme: Theme, i: number): string => [theme.colors.accent, theme.colors.accent2, theme.colors.accent3, theme.colors.accent4, theme.colors.muted][i % 5];
const fmtNum = (v: number): string => (Math.abs(v) >= 1e6 ? `${n1(v / 1e6)}M` : Math.abs(v) >= 1e4 ? `${n1(v / 1e3)}k` : String(Math.round(v * 100) / 100));
function niceMax(v: number): number { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

/** An SVG chart drawn into a w × h box (column, bar, line, pie, doughnut). */
export function chartSvg(el: ChartEl, theme: Theme, w = el.w, h = el.h): string {
  const font = cssFont(theme.fonts.body).replace(/"/g, '');
  const text = theme.colors.text, muted = theme.colors.muted;
  const fs = Math.max(10, Math.min(16, h / 22));
  const series = el.series.length ? el.series : [{ name: 'Series 1', values: [] }];
  const labels = el.labels.length ? el.labels : series[0].values.map((_, i) => String(i + 1));
  const color = (si: number, ci: number): string => {
    if (el.highlight !== undefined && el.highlight >= 0) return ci === el.highlight ? (series[si].color ? resolveColor(theme, series[si].color) : theme.colors.accent) : '#c3c7cc';
    return series[si].color ? resolveColor(theme, series[si].color) : seriesColor(theme, el.chart === 'pie' || el.chart === 'doughnut' ? ci : si);
  };
  const parts: string[] = [];
  let top = 6;
  if (el.title) { parts.push(`<text x="${n1(w / 2)}" y="${n1(fs * 1.3)}" text-anchor="middle" font-size="${n1(fs * 1.15)}" font-weight="700" fill="${text}">${esc(el.title)}</text>`); top += fs * 1.8; }
  const showLegend = el.legend ?? (series.length > 1 || el.chart === 'pie' || el.chart === 'doughnut');
  const legendItems = el.chart === 'pie' || el.chart === 'doughnut' ? labels.map((l, i) => ({ name: l, color: color(0, i) })) : series.map((s, i) => ({ name: s.name, color: s.color ? resolveColor(theme, s.color) : seriesColor(theme, i) }));
  const legendH = showLegend ? fs * 1.8 : 0;
  if (showLegend) {
    let lx = 0;
    const items = legendItems.map((it) => { const x = lx; lx += 18 + it.name.length * fs * 0.55 + 14; return { ...it, x }; });
    const offset = Math.max(4, (w - lx) / 2);
    for (const it of items) parts.push(`<rect x="${n1(offset + it.x)}" y="${n1(h - legendH + fs * 0.35)}" width="${n1(fs * 0.8)}" height="${n1(fs * 0.8)}" rx="2" fill="${it.color}"/><text x="${n1(offset + it.x + fs * 1.1)}" y="${n1(h - legendH + fs * 1.05)}" font-size="${n1(fs * 0.9)}" fill="${muted}">${esc(it.name)}</text>`);
  }
  const plotH = h - top - legendH - 4;
  if (el.chart === 'pie' || el.chart === 'doughnut') {
    const vals = series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const r = Math.max(4, Math.min(w, plotH) / 2 - 4), cx = w / 2, cy = top + plotH / 2;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a: number, rr: number) => `${n1(cx + Math.cos(a) * rr)},${n1(cy + Math.sin(a) * rr)}`;
      if (v / total >= 0.9999) parts.push(`<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="${color(0, i)}"/>`);
      else parts.push(`<path d="M${n1(cx)},${n1(cy)} L${p(a0, r)} A${n1(r)},${n1(r)} 0 ${large} 1 ${p(a1, r)} Z" fill="${color(0, i)}" stroke="${theme.colors.background}" stroke-width="1.5"/>`);
      if (el.values !== false && v / total > 0.05) { const mid = (a0 + a1) / 2, rr = el.chart === 'doughnut' ? r * 0.78 : r * 0.62; parts.push(`<text x="${n1(cx + Math.cos(mid) * rr)}" y="${n1(cy + Math.sin(mid) * rr + fs * 0.35)}" text-anchor="middle" font-size="${n1(fs * 0.9)}" font-weight="700" fill="#fff">${Math.round((v / total) * 100)}%</text>`); }
      a0 = a1;
    });
    if (el.chart === 'doughnut') parts.push(`<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r * 0.55)}" fill="${theme.colors.background}"/>`);
  } else {
    const all = series.flatMap((s) => s.values);
    const max = niceMax(Math.max(0, ...all)), min = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(0, ...all)) : 0;
    const horiz = el.chart === 'bar';
    const axisW = horiz ? Math.min(w * 0.3, Math.max(...labels.map((l) => l.length)) * fs * 0.55 + 8) : fmtNum(max).length * fs * 0.6 + 8;
    const x0 = axisW, y0 = top, pw = w - axisW - 8, ph = plotH - (horiz ? fs * 1.4 : fs * 1.8);
    const scale = (v: number) => (v - min) / (max - min || 1);
    for (let k = 0; k <= 4; k++) {
      const v = min + ((max - min) * k) / 4;
      if (horiz) { const x = x0 + scale(v) * pw; parts.push(`<line x1="${n1(x)}" y1="${n1(y0)}" x2="${n1(x)}" y2="${n1(y0 + ph)}" stroke="${muted}" stroke-opacity=".25"/><text x="${n1(x)}" y="${n1(y0 + ph + fs * 1.1)}" text-anchor="middle" font-size="${n1(fs * 0.8)}" fill="${muted}">${fmtNum(v)}</text>`); }
      else { const y = y0 + ph - scale(v) * ph; parts.push(`<line x1="${n1(x0)}" y1="${n1(y)}" x2="${n1(x0 + pw)}" y2="${n1(y)}" stroke="${muted}" stroke-opacity=".25"/><text x="${n1(x0 - 6)}" y="${n1(y + fs * 0.3)}" text-anchor="end" font-size="${n1(fs * 0.8)}" fill="${muted}">${fmtNum(v)}</text>`); }
    }
    const nCat = Math.max(1, labels.length);
    const band = (horiz ? ph : pw) / nCat;
    labels.forEach((l, ci) => {
      const c = (horiz ? y0 : x0) + band * (ci + 0.5);
      if (horiz) parts.push(`<text x="${n1(x0 - 6)}" y="${n1(c + fs * 0.3)}" text-anchor="end" font-size="${n1(fs * 0.85)}" fill="${text}">${esc(l)}</text>`);
      else parts.push(`<text x="${n1(c)}" y="${n1(y0 + ph + fs * 1.3)}" text-anchor="middle" font-size="${n1(fs * 0.85)}" fill="${text}">${esc(l.length > 14 ? `${l.slice(0, 13)}…` : l)}</text>`);
    });
    if (el.chart === 'line') {
      series.forEach((s, si) => {
        const p = s.values.map((v, ci) => `${n1(x0 + band * (ci + 0.5))},${n1(y0 + ph - scale(v) * ph)}`);
        const col = s.color ? resolveColor(theme, s.color) : seriesColor(theme, si);
        parts.push(`<polyline points="${p.join(' ')}" fill="none" stroke="${col}" stroke-width="${n1(Math.max(2, fs / 5))}" stroke-linejoin="round" stroke-linecap="round"/>`);
        s.values.forEach((v, ci) => {
          const cx = x0 + band * (ci + 0.5), cy = y0 + ph - scale(v) * ph;
          parts.push(`<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(Math.max(3, fs / 4))}" fill="${el.highlight === ci ? theme.colors.accent4 : col}"/>`);
          if (el.values) parts.push(`<text x="${n1(cx)}" y="${n1(cy - fs * 0.6)}" text-anchor="middle" font-size="${n1(fs * 0.8)}" fill="${text}">${fmtNum(v)}</text>`);
        });
      });
    } else {
      const ns = series.length, gap = band * 0.22, bw = (band - gap) / ns;
      series.forEach((s, si) => s.values.slice(0, nCat).forEach((v, ci) => {
        const from = scale(0), to = scale(v);
        const lo = Math.min(from, to), hi = Math.max(from, to);
        const off = (horiz ? y0 : x0) + band * ci + gap / 2 + bw * si;
        const col = color(si, ci);
        if (horiz) parts.push(`<rect x="${n1(x0 + lo * pw)}" y="${n1(off)}" width="${n1(Math.max(0.5, (hi - lo) * pw))}" height="${n1(bw * 0.92)}" rx="2" fill="${col}"/>`);
        else parts.push(`<rect x="${n1(off)}" y="${n1(y0 + ph - hi * ph)}" width="${n1(bw * 0.92)}" height="${n1(Math.max(0.5, (hi - lo) * ph))}" rx="2" fill="${col}"/>`);
        if (el.values) {
          if (horiz) parts.push(`<text x="${n1(x0 + hi * pw + 4)}" y="${n1(off + bw * 0.46 + fs * 0.3)}" font-size="${n1(fs * 0.8)}" fill="${text}">${fmtNum(v)}</text>`);
          else parts.push(`<text x="${n1(off + bw * 0.46)}" y="${n1(y0 + ph - hi * ph - 4)}" text-anchor="middle" font-size="${n1(fs * 0.8)}" fill="${text}">${fmtNum(v)}</text>`);
        }
      }));
    }
  }
  return `<svg class="sld-geom" viewBox="0 0 ${n1(w)} ${n1(h)}" font-family="${font}" role="img" aria-label="${esc(el.alt ?? el.title ?? 'Chart')}">${parts.join('')}</svg>`;
}

/* ---------------- elements and slides ---------------- */

export function elementInner(deck: Deck, slide: Slide, el: El, opts: RenderOpts = {}): string {
  const t = deck.theme;
  switch (el.type) {
    case 'text': return textBoxHtml(deck, slide, el, opts);
    case 'shape': return shapeHtml(deck, slide, el, opts);
    case 'line': return lineHtml(t, el);
    case 'image': return `<img class="sld-img" src="${esc(el.src)}" alt="${esc(el.alt ?? '')}" draggable="false" style="object-fit:${el.fit ?? 'cover'}${el.radius ? `;border-radius:${el.radius}px` : ''}">`;
    case 'table': {
      const size = el.size ?? 14;
      const border = resolveColor(t, el.border ?? '$muted');
      const rows = el.rows.map((r, ri) => `<tr>${r.map((c) => {
        const head = el.header !== false && ri === 0;
        const bg = c.fill ? resolveColor(t, c.fill) : head ? resolveColor(t, el.headerFill ?? '$accent') : el.band && ri % 2 === 0 ? t.colors.surface : 'transparent';
        const fg = c.color ? resolveColor(t, c.color) : head ? '#ffffff' : t.colors.text;
        return `<td style="border:1px solid ${border};background:${bg};color:${fg};text-align:${c.align ?? 'left'};font-weight:${c.b || head ? 700 : 400}">${esc(c.text) || '&nbsp;'}</td>`;
      }).join('')}</tr>`).join('');
      return `<table class="sld-table" style="font-family:${cssFont(t.fonts.body)};font-size:${size}pt"><tbody>${rows}</tbody></table>`;
    }
    case 'chart': return chartSvg(el, t);
    case 'icon': return `<div class="sld-icon" style="font-size:${n1(Math.min(el.w, el.h) * 0.82)}px${el.color ? `;color:${resolveColor(t, el.color)}` : ''}">${esc(el.glyph)}</div>`;
    case 'embed': {
      const host = /^https?:\/\/([^/]+)/i.exec(el.url)?.[1] ?? el.url;
      const body = `<i>${el.kind === 'video' ? '▶' : '🔗'}</i><b>${esc(el.title || (el.kind === 'video' ? 'Video' : 'Link'))}</b><small>${esc(host)}</small>`;
      const style = `background:${t.colors.surface};color:${t.colors.text};border:1px solid ${t.colors.muted}55`;
      return el.url && !opts.editor ? `<a class="sld-embed" href="${esc(el.url)}" target="_blank" rel="noreferrer" style="${style}">${body}</a>` : `<div class="sld-embed" style="${style}">${body}</div>`;
    }
  }
}
export function elementStyle(el: El): string {
  const st = [`left:${n1(el.x)}px`, `top:${n1(el.y)}px`, `width:${n1(el.w)}px`, `height:${n1(el.h)}px`];
  if (el.rot) st.push(`transform:rotate(${n1(el.rot)}deg)`);
  if (el.opacity !== undefined && el.opacity < 1) st.push(`opacity:${el.opacity}`);
  return st.join(';');
}
/** One slide as HTML (a .sld block of the deck's size). */
export function slideHtml(deck: Deck, slide: Slide, opts: RenderOpts = {}): string {
  const els = slide.elements.filter((e) => !opts.skip?.has(e.id)).map((el) => {
    const inner = elementInner(deck, slide, el, opts);
    if (!inner) return '';
    let style = elementStyle(el);
    if (opts.hidden?.has(el.id)) style += ';visibility:hidden';
    const anim = opts.animate?.get(el.id);
    if (anim) style += `;animation:${anim}`;
    const wrapped = el.link && hasText(el) === false && el.type !== 'embed' && !opts.editor ? `<a href="${esc(el.link)}" target="_blank" rel="noreferrer">${inner}</a>` : inner;
    return `<div class="sld-el sld-${el.type}" data-id="${esc(el.id)}" style="${style}">${wrapped}</div>`;
  }).join('');
  return `<div class="sld" style="width:${deck.size.w}px;height:${deck.size.h}px;${backgroundCss(deck.theme, slide.background)};font-family:${cssFont(deck.theme.fonts.body)};color:${deck.theme.colors.text}">${els}</div>`;
}
/** CSS animation value for each animation that runs at a step (present mode / export). */
export function stepAnimations(slide: Slide, step: number): Map<string, string> {
  const out = new Map<string, string>();
  const st = animSteps(slide)[step] ?? [];
  const times = animTimes(st);
  for (const a of st) out.set(a.el, animCss(a, times.get(a.id) ?? 0));
  return out;
}
export const animCss = (a: Anim, start: number): string => `sld-a-${a.effect} ${a.effect === 'appear' || a.effect === 'disappear' ? 0.01 : a.duration}s ${a.effect.startsWith('fly') ? 'cubic-bezier(.2,.8,.3,1)' : 'ease'} ${n1(start)}s both`;
