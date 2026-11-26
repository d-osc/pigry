/** Slides: the presentation model (a deck of slides with positioned elements), themes, layouts and the pure
 * editing helpers shared by the editor and the agent tools. No DOM and no I/O here — node tests import it. */

export const SLIDES_DIR = '.pigry/slides/';
export const SLIDES_EXT = '.slides.json';

/* ---------------- types ---------------- */

export type Align = 'left' | 'center' | 'right' | 'justify';
export type VAlign = 'top' | 'middle' | 'bottom';
export interface Run { t: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; sup?: boolean; sub?: boolean; color?: string; hl?: string; font?: string; size?: number; link?: string }
export interface Para { runs: Run[]; align?: Align; list?: 'bullet' | 'number'; level?: number; lh?: number; sb?: number; sa?: number }
export type TextRole = 'title' | 'subtitle' | 'body' | 'caption' | 'number';
export type Autofit = 'none' | 'shrink' | 'resize';

export type ShapeKind =
  | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'rightTriangle' | 'diamond' | 'pentagon' | 'hexagon' | 'octagon' | 'star' | 'plus' | 'chevron' | 'parallelogram' | 'trapezoid'
  | 'arrowRight' | 'arrowLeft' | 'arrowUp' | 'arrowDown' | 'arrowLeftRight' | 'callout' | 'cloudCallout' | 'heart' | 'cloud';
export const SHAPES: { id: ShapeKind; label: string; group: 'Shapes' | 'Arrows' | 'Callouts' }[] = [
  { id: 'rect', label: 'Rectangle', group: 'Shapes' }, { id: 'roundRect', label: 'Rounded rectangle', group: 'Shapes' }, { id: 'ellipse', label: 'Oval', group: 'Shapes' },
  { id: 'triangle', label: 'Triangle', group: 'Shapes' }, { id: 'rightTriangle', label: 'Right triangle', group: 'Shapes' }, { id: 'diamond', label: 'Diamond', group: 'Shapes' },
  { id: 'pentagon', label: 'Pentagon', group: 'Shapes' }, { id: 'hexagon', label: 'Hexagon', group: 'Shapes' }, { id: 'octagon', label: 'Octagon', group: 'Shapes' },
  { id: 'star', label: 'Star', group: 'Shapes' }, { id: 'plus', label: 'Plus', group: 'Shapes' }, { id: 'heart', label: 'Heart', group: 'Shapes' }, { id: 'cloud', label: 'Cloud', group: 'Shapes' },
  { id: 'parallelogram', label: 'Parallelogram', group: 'Shapes' }, { id: 'trapezoid', label: 'Trapezoid', group: 'Shapes' }, { id: 'chevron', label: 'Chevron', group: 'Arrows' },
  { id: 'arrowRight', label: 'Right arrow', group: 'Arrows' }, { id: 'arrowLeft', label: 'Left arrow', group: 'Arrows' }, { id: 'arrowUp', label: 'Up arrow', group: 'Arrows' },
  { id: 'arrowDown', label: 'Down arrow', group: 'Arrows' }, { id: 'arrowLeftRight', label: 'Left-right arrow', group: 'Arrows' },
  { id: 'callout', label: 'Speech callout', group: 'Callouts' }, { id: 'cloudCallout', label: 'Thought callout', group: 'Callouts' },
];
export type ChartKind = 'column' | 'bar' | 'line' | 'pie' | 'doughnut';
export interface ChartSeries { name: string; values: number[]; color?: string }
export interface Cell { text: string; b?: boolean; align?: Align; fill?: string; color?: string }

interface Base { id: string; x: number; y: number; w: number; h: number; rot?: number; locked?: boolean; group?: string; name?: string; opacity?: number; link?: string; alt?: string }
export interface TextEl extends Base { type: 'text'; role?: TextRole; placeholder?: boolean; paras: Para[]; fill?: string; stroke?: string; strokeW?: number; pad?: number; valign?: VAlign; autofit?: Autofit }
export interface ShapeEl extends Base { type: 'shape'; shape: ShapeKind; fill?: string; stroke?: string; strokeW?: number; dash?: boolean; paras: Para[]; valign?: VAlign; shadow?: boolean }
export interface LineEl extends Base { type: 'line'; dir?: 'down' | 'up'; stroke?: string; strokeW?: number; dash?: boolean; start?: 'none' | 'arrow' | 'dot'; end?: 'none' | 'arrow' | 'dot' }
export interface ImageEl extends Base { type: 'image'; src: string; fit?: 'cover' | 'contain' | 'fill'; radius?: number }
export interface TableEl extends Base { type: 'table'; rows: Cell[][]; header?: boolean; size?: number; border?: string; headerFill?: string; band?: boolean }
export interface ChartEl extends Base { type: 'chart'; chart: ChartKind; labels: string[]; series: ChartSeries[]; title?: string; legend?: boolean; values?: boolean; highlight?: number }
export interface IconEl extends Base { type: 'icon'; glyph: string; color?: string }
export interface EmbedEl extends Base { type: 'embed'; kind: 'video' | 'link'; url: string; title?: string }
export type El = TextEl | ShapeEl | LineEl | ImageEl | TableEl | ChartEl | IconEl | EmbedEl;
export type ElType = El['type'];

export type Background = { type: 'color'; color: string } | { type: 'gradient'; from: string; to: string; angle?: number } | { type: 'image'; src: string; fit?: 'cover' | 'contain' };
export type TransitionKind = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'zoom' | 'flip';
export const TRANSITIONS: { id: TransitionKind; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'fade', label: 'Dissolve / fade' }, { id: 'slide-left', label: 'Slide from right' }, { id: 'slide-right', label: 'Slide from left' },
  { id: 'slide-up', label: 'Slide from bottom' }, { id: 'zoom', label: 'Zoom' }, { id: 'flip', label: 'Flip' },
];
export type AnimEffect = 'appear' | 'fade-in' | 'fly-left' | 'fly-right' | 'fly-up' | 'fly-down' | 'zoom-in' | 'spin' | 'fade-out' | 'disappear';
export const ANIM_EFFECTS: { id: AnimEffect; label: string }[] = [
  { id: 'appear', label: 'Appear' }, { id: 'fade-in', label: 'Fade in' }, { id: 'fly-left', label: 'Fly in from left' }, { id: 'fly-right', label: 'Fly in from right' },
  { id: 'fly-up', label: 'Fly in from bottom' }, { id: 'fly-down', label: 'Fly in from top' }, { id: 'zoom-in', label: 'Zoom in' }, { id: 'spin', label: 'Spin' },
  { id: 'fade-out', label: 'Fade out' }, { id: 'disappear', label: 'Disappear' },
];
export type AnimStart = 'click' | 'with' | 'after';
export interface Anim { id: string; el: string; effect: AnimEffect; start: AnimStart; duration: number; delay?: number; byPara?: boolean }
export interface Reply { author: string; at: string; text: string }
export interface Comment { id: string; author: string; at: string; text: string; el?: string; resolved?: boolean; replies: Reply[] }
export type LayoutId = 'title' | 'title-body' | 'section' | 'two-columns' | 'big-number' | 'title-only' | 'caption' | 'blank';
export interface Slide {
  id: string; layout: LayoutId; elements: El[]; notes: string; background?: Background; hidden?: boolean;
  transition?: { type: TransitionKind; duration: number }; anims: Anim[]; comments: Comment[];
}
export interface ThemeColors { background: string; surface: string; text: string; title: string; muted: string; accent: string; accent2: string; accent3: string; accent4: string }
export interface Theme { id: string; name: string; colors: ThemeColors; fonts: { title: string; body: string }; titleSize?: number; bodySize?: number }
export interface Deck { version: 1; title: string; size: { w: number; h: number }; theme: Theme; slides: Slide[]; seq: number }

export class SlidesError extends Error {}

/* ---------------- constants ---------------- */

/** Slide sizes in CSS pixels (96 per inch): Google Slides' 16:9 is 10 × 5.625 inches. */
export const SIZES: Record<'16:9' | '4:3' | '16:10' | 'A4', { w: number; h: number }> = { '16:9': { w: 960, h: 540 }, '4:3': { w: 960, h: 720 }, '16:10': { w: 960, h: 600 }, A4: { w: 1123, h: 794 } };
export const aspectOf = (size: { w: number; h: number }): string => (Object.entries(SIZES).find(([, s]) => s.w === size.w && s.h === size.h)?.[0] ?? `${size.w}×${size.h}`);
export const PT = 96 / 72;
export const FONTS = ['Arial', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins', 'Inter', 'Georgia', 'Merriweather', 'Playfair Display', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New', 'Sarabun', 'Noto Sans Thai', 'Prompt', 'Kanit'];
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const ICONS = ['⭐', '✅', '❌', '⚠️', '💡', '🚀', '🎯', '📈', '📉', '📊', '💰', '🔒', '⚙️', '🧠', '👥', '🤝', '🗓️', '⏱️', '📌', '🔍', '❤️', '🌍', '📱', '💻', '☁️', '🔥', '🏆', '✏️', '📚', '🎓', '➡️', '✔️', '❓', '❗', '1️⃣', '2️⃣', '3️⃣', '🙂'];

const T = (id: string, name: string, colors: ThemeColors, title: string, body: string): Theme => ({ id, name, colors, fonts: { title, body } });
export const THEMES: Theme[] = [
  T('simple-light', 'Simple Light', { background: '#ffffff', surface: '#f1f3f4', text: '#3c4043', title: '#202124', muted: '#80868b', accent: '#1a73e8', accent2: '#34a853', accent3: '#fbbc04', accent4: '#ea4335' }, 'Arial', 'Arial'),
  T('simple-dark', 'Simple Dark', { background: '#202124', surface: '#303134', text: '#e8eaed', title: '#ffffff', muted: '#9aa0a6', accent: '#8ab4f8', accent2: '#81c995', accent3: '#fdd663', accent4: '#f28b82' }, 'Arial', 'Arial'),
  T('focus', 'Focus', { background: '#0b2545', surface: '#13315c', text: '#dfe7f2', title: '#ffffff', muted: '#8da9c4', accent: '#f4a259', accent2: '#5bc0be', accent3: '#eef4ed', accent4: '#e76f51' }, 'Montserrat', 'Open Sans'),
  T('coral', 'Coral', { background: '#fff8f3', surface: '#ffe8dc', text: '#4a3b35', title: '#2b1d18', muted: '#9b8178', accent: '#ff6f59', accent2: '#2a9d8f', accent3: '#f4a261', accent4: '#264653' }, 'Poppins', 'Lato'),
  T('forest', 'Forest', { background: '#f4f1e8', surface: '#e3ddcb', text: '#33402f', title: '#1e2b1b', muted: '#7b8571', accent: '#2d6a4f', accent2: '#95b46a', accent3: '#d4a373', accent4: '#9c6644' }, 'Merriweather', 'Lato'),
  T('paper', 'Paper', { background: '#fbfaf7', surface: '#efece4', text: '#2f2f2f', title: '#111111', muted: '#8a8577', accent: '#b23a48', accent2: '#3d5a80', accent3: '#c9a227', accent4: '#5c946e' }, 'Playfair Display', 'Georgia'),
  T('spearmint', 'Spearmint', { background: '#effaf6', surface: '#d4f1e6', text: '#28433a', title: '#123329', muted: '#6c8c80', accent: '#14a38b', accent2: '#ff8552', accent3: '#4062bb', accent4: '#f2c14e' }, 'Inter', 'Inter'),
  T('midnight', 'Midnight', { background: '#111827', surface: '#1f2937', text: '#d1d5db', title: '#f9fafb', muted: '#9ca3af', accent: '#a78bfa', accent2: '#34d399', accent3: '#fbbf24', accent4: '#f472b6' }, 'Poppins', 'Inter'),
];
export const THEME_COLOR_KEYS: (keyof ThemeColors)[] = ['background', 'surface', 'text', 'title', 'muted', 'accent', 'accent2', 'accent3', 'accent4'];

export const LAYOUTS: { id: LayoutId; label: string }[] = [
  { id: 'title', label: 'Title slide' }, { id: 'title-body', label: 'Title and body' }, { id: 'section', label: 'Section header' }, { id: 'two-columns', label: 'Title and two columns' },
  { id: 'big-number', label: 'Big number' }, { id: 'title-only', label: 'Title only' }, { id: 'caption', label: 'Caption' }, { id: 'blank', label: 'Blank' },
];
export const isLayout = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);

/* ---------------- small helpers ---------------- */

export const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;
export function newId(deck: Deck, prefix: string): string { deck.seq = (deck.seq || 0) + 1; return `${prefix}${deck.seq}`; }
export const para = (text = '', props: Partial<Para> = {}): Para => ({ runs: text ? [{ t: text }] : [], ...props });
export const paraText = (p: Para): string => p.runs.map((r) => r.t).join('');
export const parasText = (paras: Para[]): string => paras.map(paraText).join('\n');
export const hasText = (el: El): el is TextEl | ShapeEl => el.type === 'text' || el.type === 'shape';
export const elText = (el: El): string => (hasText(el) ? parasText(el.paras) : el.type === 'table' ? el.rows.map((r) => r.map((c) => c.text).join(' | ')).join('\n') : el.type === 'chart' ? [el.title ?? '', ...el.labels].join(' ') : el.type === 'embed' ? el.title ?? el.url : '');
export const wordCount = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isColor = (v: unknown): v is string => typeof v === 'string' && (HEX.test(v) || /^\$(background|surface|text|title|muted|accent[234]?)$/.test(v) || /^rgba?\([\d\s.,%]+\)$/.test(v) || v === 'transparent' || v === 'none');

/** Theme references ("$accent") → the colour of the deck's theme. */
export function resolveColor(theme: Theme, c: string | undefined, fallback = 'transparent'): string {
  if (!c) return fallback;
  if (c.startsWith('$')) return theme.colors[c.slice(1) as keyof ThemeColors] ?? fallback;
  return c === 'none' ? 'transparent' : c;
}
export function hexRgb(c: string): [number, number, number] | null {
  const m = HEX.exec(c.trim());
  if (m) { const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  const r = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null;
}
export function luminance(c: string): number | null {
  const rgb = hexRgb(c);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colours (1 … 21), or null when one is not a solid colour. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ---------------- text defaults from the theme ---------------- */

export interface TextLook { font: string; size: number; color: string; b: boolean; align: Align }
/** The look a text element inherits from the theme by its role (runs override it). */
export function roleLook(theme: Theme, role: TextRole | undefined, layout?: LayoutId): TextLook {
  const tsize = theme.titleSize ?? 36, bsize = theme.bodySize ?? 18;
  switch (role) {
    case 'title': return { font: theme.fonts.title, size: layout === 'title' ? Math.round(tsize * 1.25) : layout === 'section' ? Math.round(tsize * 1.1) : tsize, color: theme.colors.title, b: true, align: layout === 'title' || layout === 'section' ? 'center' : 'left' };
    case 'subtitle': return { font: theme.fonts.body, size: Math.round(bsize * 1.15), color: theme.colors.muted, b: false, align: layout === 'title' || layout === 'section' ? 'center' : 'left' };
    case 'number': return { font: theme.fonts.title, size: 96, color: theme.colors.accent, b: true, align: 'center' };
    case 'caption': return { font: theme.fonts.body, size: 14, color: theme.colors.muted, b: false, align: 'left' };
    default: return { font: theme.fonts.body, size: bsize, color: theme.colors.text, b: false, align: layout === 'big-number' ? 'center' : 'left' };
  }
}

/* ---------------- layouts ---------------- */

/** Placeholder text boxes for a layout on a slide of the given size. */
export function layoutElements(deck: Deck, layout: LayoutId): El[] {
  const { w, h } = deck.size;
  const m = Math.round(w * 0.06);
  const tb = (role: TextRole, x: number, y: number, bw: number, bh: number, valign: VAlign = 'top', name?: string): TextEl =>
    ({ id: newId(deck, 'e'), type: 'text', role, placeholder: true, x: Math.round(x), y: Math.round(y), w: Math.round(bw), h: Math.round(bh), paras: [para()], valign, autofit: 'shrink', ...(name ? { name } : {}) });
  switch (layout) {
    case 'title': return [tb('title', m, h * 0.28, w - 2 * m, h * 0.26, 'bottom'), tb('subtitle', m, h * 0.57, w - 2 * m, h * 0.14)];
    case 'section': return [tb('title', m, h * 0.36, w - 2 * m, h * 0.2, 'middle'), tb('subtitle', m, h * 0.58, w - 2 * m, h * 0.12)];
    case 'title-body': return [tb('title', m, h * 0.07, w - 2 * m, h * 0.15, 'bottom'), tb('body', m, h * 0.26, w - 2 * m, h * 0.64)];
    case 'two-columns': return [tb('title', m, h * 0.07, w - 2 * m, h * 0.15, 'bottom'), tb('body', m, h * 0.26, (w - 3 * m) / 2, h * 0.64, 'top', 'Left column'), tb('body', w / 2 + m / 2, h * 0.26, (w - 3 * m) / 2, h * 0.64, 'top', 'Right column')];
    case 'big-number': return [tb('number', m, h * 0.2, w - 2 * m, h * 0.4, 'bottom'), tb('body', m * 2, h * 0.62, w - 4 * m, h * 0.2)];
    case 'title-only': return [tb('title', m, h * 0.07, w - 2 * m, h * 0.15, 'bottom')];
    case 'caption': return [tb('caption', m, h * 0.82, w - 2 * m, h * 0.11, 'middle')];
    default: return [];
  }
}
export const PLACEHOLDER_HINT: Record<TextRole, string> = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text', caption: 'Click to add caption', number: 'XX%' };

/* ---------------- creating ---------------- */

export function emptyDeck(title = 'Untitled presentation', themeId = 'simple-light'): Deck {
  const theme = clone(THEMES.find((t) => t.id === themeId) ?? THEMES[0]);
  return { version: 1, title, size: { ...SIZES['16:9'] }, theme, slides: [], seq: 0 };
}
export interface SlideContent { title?: string; subtitle?: string; body?: string | string[]; left?: string | string[]; right?: string | string[]; number?: string; caption?: string; notes?: string }
/** A new slide from a layout, with its placeholders filled from content (text uses the light Markdown of textToParas). */
export function makeSlide(deck: Deck, layout: LayoutId = 'title-body', content: SlideContent = {}): Slide {
  const slide: Slide = { id: newId(deck, 's'), layout, elements: layoutElements(deck, layout), notes: content.notes ?? '', anims: [], comments: [] };
  const fill = (el: El | undefined, v: string | string[] | undefined) => { if (el && el.type === 'text' && v !== undefined) el.paras = textToParas(Array.isArray(v) ? v.map((x) => (/^\s*([-*•]|\d+[.)])\s/.test(x) ? x : `- ${x}`)).join('\n') : v); };
  const els = slide.elements as TextEl[];
  fill(els.find((e) => e.role === 'title'), content.title);
  fill(els.find((e) => e.role === 'subtitle'), content.subtitle);
  fill(els.find((e) => e.role === 'number'), content.number);
  fill(els.find((e) => e.role === 'caption'), content.caption);
  const bodies = els.filter((e) => e.role === 'body');
  if (layout === 'two-columns') { fill(bodies[0], content.left ?? content.body); fill(bodies[1], content.right); } else fill(bodies[0], content.body);
  return slide;
}

/* ---------------- light Markdown for text boxes ---------------- */

/** Inline **bold**, *italic*, __underline__, ~~strike~~, `code`-free [link](url) → runs. */
export function parseInline(text: string): Run[] {
  const out: Run[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: m[2], b: true });
    else if (m[3] !== undefined) out.push({ t: m[3], u: true });
    else if (m[4] !== undefined) out.push({ t: m[4], s: true });
    else if (m[5] !== undefined) out.push({ t: m[5], i: true });
    else if (m[6] !== undefined) out.push({ t: m[6], i: true });
    else if (m[7] !== undefined) out.push({ t: m[7], link: m[8] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out.filter((r) => r.t);
}
/** Lines → paragraphs: "- " / "* " bullets, "1. " numbers, two spaces of indent per level. */
export function textToParas(text: string): Para[] {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const paras = lines.map((line): Para => {
    const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) return { runs: parseInline(line) };
    const level = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
    return { runs: parseInline(m[3]), list: /\d/.test(m[2]) ? 'number' : 'bullet', ...(level ? { level } : {}) };
  });
  return paras.length ? paras : [para()];
}
/** Paragraphs → the same light Markdown. */
export function parasToText(paras: Para[]): string {
  let n = 0;
  return paras.map((p) => {
    const inline = p.runs.map((r) => { let t = r.t; if (r.link) t = `[${t}](${r.link})`; if (r.b) t = `**${t}**`; if (r.i) t = `*${t}*`; if (r.u) t = `__${t}__`; if (r.s) t = `~~${t}~~`; return t; }).join('');
    const pad = '  '.repeat(p.level ?? 0);
    if (p.list === 'number') { n += 1; return `${pad}${n}. ${inline}`; }
    n = 0;
    return p.list === 'bullet' ? `${pad}- ${inline}` : inline;
  }).join('\n');
}
/** Numbers for numbered paragraphs (restarting after a non-list paragraph), keyed by index. */
export function listNumbers(paras: Para[]): Map<number, number> {
  const out = new Map<number, number>();
  const counters: number[] = [];
  paras.forEach((p, i) => {
    const level = p.level ?? 0;
    if (p.list !== 'number') { if (!p.list) counters.length = 0; else counters.length = Math.min(counters.length, level); return; }
    counters.length = level + 1;
    counters[level] = (counters[level] ?? 0) + 1;
    out.set(i, counters[level]);
  });
  return out;
}
export const BULLETS = ['●', '○', '■', '●', '○'];

/* ---------------- normalize / parse ---------------- */

export interface NormalizeResult { deck: Deck; warnings: string[] }
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

function normRuns(v: unknown): Run[] {
  if (!Array.isArray(v)) return [];
  const out: Run[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const run: Run = { t: str(x.t) };
    for (const k of ['b', 'i', 'u', 's', 'sup', 'sub'] as const) if (x[k] === true) run[k] = true;
    for (const k of ['color', 'hl', 'font', 'link'] as const) if (typeof x[k] === 'string' && x[k]) run[k] = x[k] as string;
    if (typeof x.size === 'number' && x.size > 0) run.size = Math.min(400, x.size);
    if (run.t) out.push(run);
  }
  return out;
}
function normParas(v: unknown): Para[] {
  if (typeof v === 'string') return textToParas(v);
  if (!Array.isArray(v) || v.length === 0) return [para()];
  return v.map((p): Para => {
    const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const out: Para = { runs: normRuns(x.runs) };
    if (x.align === 'center' || x.align === 'right' || x.align === 'justify' || x.align === 'left') out.align = x.align;
    if (x.list === 'bullet' || x.list === 'number') out.list = x.list;
    if (typeof x.level === 'number' && x.level > 0) out.level = Math.min(4, Math.floor(x.level));
    for (const k of ['lh', 'sb', 'sa'] as const) if (typeof x[k] === 'number') out[k] = x[k] as number;
    return out;
  });
}
const EL_TYPES: ElType[] = ['text', 'shape', 'line', 'image', 'table', 'chart', 'icon', 'embed'];
export function normEl(v: unknown, warn: (m: string) => void, ids: Set<string>, mint: () => string): El | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  const type = x.type as ElType;
  if (!EL_TYPES.includes(type)) { warn(`dropped an element of unknown type "${String(x.type)}"`); return null; }
  let id = str(x.id);
  if (!id || ids.has(id)) id = mint();
  ids.add(id);
  const base = { ...x, id, x: num(x.x, 0), y: num(x.y, 0), w: Math.max(1, num(x.w, 100)), h: Math.max(1, num(x.h, 100)) } as Record<string, unknown>;
  if (typeof base.rot === 'number' && !base.rot) delete base.rot;
  if (type === 'text' || type === 'shape') base.paras = normParas(x.paras ?? x.text);
  delete base.text;
  if (type === 'shape' && !SHAPES.some((s) => s.id === x.shape)) base.shape = 'rect';
  if (type === 'image' && typeof x.src !== 'string') { warn(`dropped image ${id} without a source`); return null; }
  if (type === 'table') {
    const rows = Array.isArray(x.rows) ? x.rows : [];
    const width = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
    base.rows = (rows.length ? rows : [[]]).map((r) => Array.from({ length: width }, (_, c) => {
      const cell = Array.isArray(r) ? r[c] : undefined;
      if (typeof cell === 'string' || typeof cell === 'number') return { text: String(cell) };
      const cx = (cell && typeof cell === 'object' ? cell : {}) as Record<string, unknown>;
      const out: Cell = { text: str(cx.text) };
      if (cx.b === true) out.b = true;
      if (typeof cx.align === 'string') out.align = cx.align as Align;
      if (typeof cx.fill === 'string') out.fill = cx.fill;
      if (typeof cx.color === 'string') out.color = cx.color;
      return out;
    }));
  }
  if (type === 'chart') {
    if (!['column', 'bar', 'line', 'pie', 'doughnut'].includes(str(x.chart))) base.chart = 'column';
    base.labels = Array.isArray(x.labels) ? x.labels.map((l) => String(l)) : [];
    base.series = (Array.isArray(x.series) ? x.series : []).map((s) => { const sx = (s ?? {}) as Record<string, unknown>; return { name: str(sx.name, 'Series'), values: (Array.isArray(sx.values) ? sx.values : []).map((n) => Number(n) || 0), ...(typeof sx.color === 'string' ? { color: sx.color } : {}) }; });
  }
  if (type === 'icon') base.glyph = str(x.glyph, '⭐') || '⭐';
  if (type === 'embed') { base.kind = x.kind === 'link' ? 'link' : 'video'; base.url = str(x.url); }
  return base as unknown as El;
}
export function normalizeDeck(raw: unknown, fallbackTitle = 'Untitled presentation'): NormalizeResult {
  const warnings: string[] = [];
  const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const deck = emptyDeck(str(x.title, fallbackTitle) || fallbackTitle);
  deck.seq = Math.max(0, Math.floor(num(x.seq, 0)));
  const size = (x.size ?? {}) as Record<string, unknown>;
  deck.size = { w: Math.max(200, num(size.w, 960)), h: Math.max(100, num(size.h, 540)) };
  const th = (x.theme ?? {}) as Record<string, unknown>;
  const baseTheme = THEMES.find((t) => t.id === th.id) ?? THEMES[0];
  const colors = { ...baseTheme.colors, ...((th.colors ?? {}) as Partial<ThemeColors>) };
  for (const k of THEME_COLOR_KEYS) if (typeof colors[k] !== 'string') colors[k] = baseTheme.colors[k];
  const fonts = (th.fonts ?? {}) as Record<string, unknown>;
  deck.theme = { id: str(th.id, baseTheme.id), name: str(th.name, baseTheme.name), colors, fonts: { title: str(fonts.title, baseTheme.fonts.title), body: str(fonts.body, baseTheme.fonts.body) } };
  if (typeof th.titleSize === 'number') deck.theme.titleSize = th.titleSize;
  if (typeof th.bodySize === 'number') deck.theme.bodySize = th.bodySize;
  const ids = new Set<string>();
  const mint = () => { let id: string; do id = newId(deck, 'e'); while (ids.has(id)); return id; };
  const slideIds = new Set<string>();
  for (const s of Array.isArray(x.slides) ? x.slides : []) {
    if (!s || typeof s !== 'object') continue;
    const sx = s as Record<string, unknown>;
    let id = str(sx.id);
    if (!id || slideIds.has(id)) { do id = newId(deck, 's'); while (slideIds.has(id)); }
    slideIds.add(id);
    const elements = (Array.isArray(sx.elements) ? sx.elements : []).map((e) => normEl(e, (m) => warnings.push(`slide ${deck.slides.length + 1}: ${m}`), ids, mint)).filter((e): e is El => e !== null);
    const elIds = new Set(elements.map((e) => e.id));
    const slide: Slide = {
      id, layout: isLayout(sx.layout) ? sx.layout : 'blank', elements, notes: str(sx.notes),
      anims: (Array.isArray(sx.anims) ? sx.anims : []).filter((a) => a && typeof a === 'object' && elIds.has(String((a as Anim).el))).map((a) => {
        const ax = a as Record<string, unknown>;
        return { id: str(ax.id) || newId(deck, 'a'), el: String(ax.el), effect: ANIM_EFFECTS.some((e) => e.id === ax.effect) ? ax.effect as AnimEffect : 'fade-in', start: (['click', 'with', 'after'].includes(str(ax.start)) ? ax.start : 'click') as AnimStart, duration: Math.max(0.05, Math.min(10, num(ax.duration, 0.5))), ...(typeof ax.delay === 'number' && ax.delay > 0 ? { delay: ax.delay } : {}), ...(ax.byPara === true ? { byPara: true } : {}) };
      }),
      comments: (Array.isArray(sx.comments) ? sx.comments : []).filter((c) => c && typeof c === 'object').map((c) => {
        const cx = c as Record<string, unknown>;
        return { id: str(cx.id) || newId(deck, 'c'), author: str(cx.author, 'user'), at: str(cx.at), text: str(cx.text), ...(typeof cx.el === 'string' && elIds.has(cx.el) ? { el: cx.el } : {}), ...(cx.resolved === true ? { resolved: true } : {}), replies: (Array.isArray(cx.replies) ? cx.replies : []).map((r) => ({ author: str((r as Reply).author, 'user'), at: str((r as Reply).at), text: str((r as Reply).text) })) };
      }),
    };
    if (sx.hidden === true) slide.hidden = true;
    const bg = sx.background as Background | undefined;
    if (bg && typeof bg === 'object' && ((bg.type === 'color' && typeof bg.color === 'string') || (bg.type === 'gradient' && typeof bg.from === 'string' && typeof bg.to === 'string') || (bg.type === 'image' && typeof bg.src === 'string'))) slide.background = bg;
    const tr = sx.transition as Slide['transition'];
    if (tr && TRANSITIONS.some((t) => t.id === tr.type) && tr.type !== 'none') slide.transition = { type: tr.type, duration: Math.max(0.1, Math.min(5, num(tr.duration, 0.6))) };
    deck.slides.push(slide);
  }
  // Keep the id counter ahead of every id in the file.
  for (const s of deck.slides) for (const id of [s.id, ...s.elements.map((e) => e.id), ...s.anims.map((a) => a.id), ...s.comments.map((c) => c.id), ...s.elements.map((e) => e.group ?? '')]) {
    const m = /^[a-z](\d+)$/.exec(id);
    if (m) deck.seq = Math.max(deck.seq, Number(m[1]));
  }
  return { deck, warnings };
}
export function parseDeckJson(text: string, fallbackTitle?: string): NormalizeResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { deck: emptyDeck(fallbackTitle), warnings: ['the file was not valid JSON; started an empty presentation'] }; }
  return normalizeDeck(raw, fallbackTitle);
}
export const serializeDeck = (deck: Deck): string => JSON.stringify(deck);

/* ---------------- finding things ---------------- */

/** A slide by 1-based number, id, or (part of) its title. */
export function findSlide(deck: Deck, ref: unknown): Slide | undefined {
  if (typeof ref === 'number') return deck.slides[ref - 1];
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return deck.slides[Number(s) - 1];
  const byId = deck.slides.find((x) => x.id === s);
  if (byId) return byId;
  const lower = s.toLowerCase();
  return deck.slides.find((x) => slideTitle(x).toLowerCase() === lower) ?? deck.slides.find((x) => slideTitle(x).toLowerCase().includes(lower));
}
export const slideIndex = (deck: Deck, slide: Slide): number => deck.slides.indexOf(slide);
export function slideTitle(slide: Slide): string {
  const t = slide.elements.find((e): e is TextEl => e.type === 'text' && (e.role === 'title' || e.role === 'number'));
  return t ? parasText(t.paras).split('\n')[0].trim() : '';
}
/** An element by id, name, 1-based number on the slide, role ("title", "body", "body2"), or its text. */
export function findEl(slide: Slide, ref: unknown): El | undefined {
  if (typeof ref === 'number') return slide.elements[ref - 1];
  const s = String(ref ?? '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return slide.elements[Number(s) - 1];
  const exact = slide.elements.find((e) => e.id === s) ?? slide.elements.find((e) => e.name?.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const role = /^(title|subtitle|body|caption|number)(\d*)$/i.exec(s);
  if (role) { const all = slide.elements.filter((e) => e.type === 'text' && e.role === role[1].toLowerCase()); return all[(Number(role[2]) || 1) - 1]; }
  const lower = s.toLowerCase();
  return slide.elements.find((e) => elText(e).toLowerCase().includes(lower));
}
export const groupMembers = (slide: Slide, el: El): El[] => (el.group ? slide.elements.filter((e) => e.group === el.group) : [el]);

/* ---------------- geometry ---------------- */

export interface Box { x: number; y: number; w: number; h: number }
export const boxOf = (e: Box): Box => ({ x: e.x, y: e.y, w: e.w, h: e.h });
export function unionBox(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...boxes.map((b) => b.x)), y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)), y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
/** The axis-aligned box a rotated element covers. */
export function rotatedBounds(e: Box & { rot?: number }): Box {
  const r = ((e.rot ?? 0) * Math.PI) / 180;
  if (!r) return boxOf(e);
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = e.w * c + e.h * s, h = e.w * s + e.h * c;
  return { x: e.x + e.w / 2 - w / 2, y: e.y + e.h / 2 - h / 2, w, h };
}
export const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }
/** Snaps a moving box to the slide's edges and centre and to the other elements' edges and centres (smart guides). */
export function snapBox(box: Box, others: Box[], size: { w: number; h: number }, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs: number[] = [0, size.w / 2, size.w], ys: number[] = [0, size.h / 2, size.h];
  for (const o of others) { xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
  const mine = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]);
  const best = (axis: 'x' | 'y', targets: number[]) => {
    let d = Infinity;
    for (const m of mine(box, axis)) for (const t of targets) if (Math.abs(t - m) < Math.abs(d)) d = t - m;
    return Math.abs(d) <= threshold ? d : 0;
  };
  const dx = best('x', xs), dy = best('y', ys);
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  const guides: Guide[] = [];
  const all = [...others, { x: 0, y: 0, w: size.w, h: size.h }];
  for (const v of mine(moved, 'x')) {
    if (!xs.some((t) => Math.abs(t - v) < 0.5)) continue;
    const hits = all.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((t) => Math.abs(t - v) < 0.5));
    const span = unionBox([moved, ...hits.filter((o) => o.w !== size.w || o.x !== 0)]);
    guides.push({ axis: 'x', at: v, from: hits.some((o) => o.w === size.w && o.x === 0) ? 0 : span.y, to: hits.some((o) => o.w === size.w && o.x === 0) ? size.h : span.y + span.h });
  }
  for (const v of mine(moved, 'y')) {
    if (!ys.some((t) => Math.abs(t - v) < 0.5)) continue;
    const hits = all.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((t) => Math.abs(t - v) < 0.5));
    const span = unionBox([moved, ...hits.filter((o) => o.h !== size.h || o.y !== 0)]);
    guides.push({ axis: 'y', at: v, from: hits.some((o) => o.h === size.h && o.y === 0) ? 0 : span.x, to: hits.some((o) => o.h === size.h && o.y === 0) ? size.w : span.x + span.w });
  }
  return { dx, dy, guides };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** Resizes a (possibly rotated) box by dragging a handle; the opposite side stays put. dx/dy are in slide space. */
export function resizeBox(b: Box & { rot?: number }, handle: Handle, dx: number, dy: number, opts: { keepRatio?: boolean; min?: number } = {}): Box {
  const min = opts.min ?? 4;
  const r = ((b.rot ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  // the pointer movement in the element's own (unrotated) axes
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
  let w = b.w, h = b.h;
  const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  w = Math.max(min, b.w + hx * lx);
  h = Math.max(min, b.h + hy * ly);
  if (opts.keepRatio && b.w > 0 && b.h > 0) {
    const ratio = b.w / b.h;
    if (hx && hy) { if (Math.abs(w / b.w) > Math.abs(h / b.h)) h = w / ratio; else w = h * ratio; }
    else if (hx) h = w / ratio; else w = h * ratio;
  }
  // keep the anchor (the opposite handle) fixed in slide space
  const ax = -hx * b.w / 2, ay = -hy * b.h / 2;
  const cx0 = b.x + b.w / 2, cy0 = b.y + b.h / 2;
  const anchorX = cx0 + ax * cos - ay * sin, anchorY = cy0 + ax * sin + ay * cos;
  const nax = -hx * w / 2, nay = -hy * h / 2;
  const cx = anchorX - (nax * cos - nay * sin), cy = anchorY - (nax * sin + nay * cos);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/* ---------------- editing helpers (mutate the deck passed in) ---------------- */

export function addSlide(deck: Deck, layout: LayoutId = 'title-body', at?: number, content?: SlideContent): Slide {
  const s = makeSlide(deck, layout, content);
  const i = at === undefined ? deck.slides.length : Math.max(0, Math.min(deck.slides.length, at));
  deck.slides.splice(i, 0, s);
  return s;
}
/** A copy of an element (or slide) with fresh ids. */
export function copyEl(deck: Deck, el: El, offset = 0, groupMap?: Map<string, string>): El {
  const c = clone(el);
  c.id = newId(deck, 'e');
  c.x += offset; c.y += offset;
  if (c.group) { if (groupMap) { if (!groupMap.has(c.group)) groupMap.set(c.group, newId(deck, 'g')); c.group = groupMap.get(c.group); } else delete c.group; }
  return c;
}
export function duplicateSlide(deck: Deck, slide: Slide): Slide {
  const map = new Map<string, string>();
  const groups = new Map<string, string>();
  const copy: Slide = { ...clone(slide), id: newId(deck, 's'), comments: [] };
  copy.elements = slide.elements.map((e) => { const c = copyEl(deck, e, 0, groups); map.set(e.id, c.id); return c; });
  copy.anims = slide.anims.map((a) => ({ ...a, id: newId(deck, 'a'), el: map.get(a.el) ?? a.el }));
  deck.slides.splice(slideIndex(deck, slide) + 1, 0, copy);
  return copy;
}
export function deleteSlide(deck: Deck, slide: Slide): void { deck.slides = deck.slides.filter((s) => s !== slide); }
export function moveSlides(deck: Deck, ids: string[], to: number): void {
  const moving = deck.slides.filter((s) => ids.includes(s.id));
  const before = deck.slides.slice(0, Math.max(0, to)).filter((s) => !ids.includes(s.id)).length;
  const rest = deck.slides.filter((s) => !ids.includes(s.id));
  rest.splice(Math.max(0, Math.min(rest.length, before)), 0, ...moving);
  deck.slides = rest;
}
export function removeEls(slide: Slide, ids: string[]): void {
  slide.elements = slide.elements.filter((e) => !ids.includes(e.id));
  slide.anims = slide.anims.filter((a) => !ids.includes(a.el));
  for (const c of slide.comments) if (c.el && ids.includes(c.el)) delete c.el;
}
export type ZOrder = 'front' | 'back' | 'forward' | 'backward';
export function reorder(slide: Slide, ids: string[], z: ZOrder): void {
  const els = slide.elements;
  const sel = els.filter((e) => ids.includes(e.id));
  if (!sel.length) return;
  if (z === 'front') slide.elements = [...els.filter((e) => !ids.includes(e.id)), ...sel];
  else if (z === 'back') slide.elements = [...sel, ...els.filter((e) => !ids.includes(e.id))];
  else {
    const arr = [...els];
    const order = z === 'forward' ? [...arr.keys()].reverse() : [...arr.keys()];
    for (const i of order) {
      if (!ids.includes(arr[i].id)) continue;
      const j = z === 'forward' ? i + 1 : i - 1;
      if (j < 0 || j >= arr.length || ids.includes(arr[j].id)) continue;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    slide.elements = arr;
  }
}
export type AlignTo = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** Aligns elements to each other (2+ selected) or to the slide. */
export function alignEls(deck: Deck, slide: Slide, ids: string[], to: AlignTo, relative: 'selection' | 'slide' = ids.length > 1 ? 'selection' : 'slide'): void {
  const els = slide.elements.filter((e) => ids.includes(e.id) && !e.locked);
  if (!els.length) return;
  const ref = relative === 'slide' ? { x: 0, y: 0, w: deck.size.w, h: deck.size.h } : unionBox(els);
  for (const e of els) {
    if (to === 'left') e.x = ref.x; else if (to === 'right') e.x = ref.x + ref.w - e.w; else if (to === 'center') e.x = ref.x + (ref.w - e.w) / 2;
    else if (to === 'top') e.y = ref.y; else if (to === 'bottom') e.y = ref.y + ref.h - e.h; else e.y = ref.y + (ref.h - e.h) / 2;
    e.x = round1(e.x); e.y = round1(e.y);
  }
}
/** Spreads 3+ elements evenly between the outermost ones (equal gaps). */
export function distributeEls(slide: Slide, ids: string[], axis: 'h' | 'v'): void {
  const els = slide.elements.filter((e) => ids.includes(e.id) && !e.locked);
  if (els.length < 3) return;
  const k = axis === 'h' ? 'x' : 'y', d = axis === 'h' ? 'w' : 'h';
  els.sort((a, b) => a[k] - b[k]);
  const first = els[0], last = els[els.length - 1];
  const total = els.reduce((n, e) => n + e[d], 0);
  const gap = (last[k] + last[d] - first[k] - total) / (els.length - 1);
  let at = first[k];
  for (const e of els) { e[k] = round1(at); at += e[d] + gap; }
}
export function groupEls(deck: Deck, slide: Slide, ids: string[]): string | null {
  const els = slide.elements.filter((e) => ids.includes(e.id));
  if (els.length < 2) return null;
  const g = newId(deck, 'g');
  for (const e of els) e.group = g;
  // keep the group together in z-order, where its top member was
  const top = Math.max(...els.map((e) => slide.elements.indexOf(e)));
  const rest = slide.elements.filter((e) => !els.includes(e));
  const at = rest.filter((e) => slide.elements.indexOf(e) < top).length;
  rest.splice(at, 0, ...els);
  slide.elements = rest;
  return g;
}
export function ungroupEls(slide: Slide, ids: string[]): void {
  const groups = new Set(slide.elements.filter((e) => ids.includes(e.id) && e.group).map((e) => e.group));
  for (const e of slide.elements) if (e.group && groups.has(e.group)) delete e.group;
}

/** Applies inline marks to every run of the paragraphs (whole-box formatting when the box is selected, not edited). */
export function formatParas(paras: Para[], marks: Partial<Run> & { align?: Align; list?: 'bullet' | 'number' | null; lh?: number; indent?: number }): void {
  for (const p of paras) {
    for (const k of ['b', 'i', 'u', 's', 'sup', 'sub', 'color', 'hl', 'font', 'size', 'link'] as const) {
      if (!(k in marks)) continue;
      const v = marks[k];
      for (const r of p.runs) { if (v === undefined || v === false || v === null || v === '') delete r[k]; else (r as unknown as Record<string, unknown>)[k] = v; }
    }
    if (marks.align) { if (marks.align === 'left') delete p.align; else p.align = marks.align; }
    if ('list' in marks) { if (marks.list) p.list = marks.list; else { delete p.list; delete p.level; } }
    if (marks.lh !== undefined) { if (marks.lh) p.lh = marks.lh; else delete p.lh; }
    if (marks.indent) { const l = Math.max(0, Math.min(4, (p.level ?? 0) + marks.indent)); if (l) p.level = l; else delete p.level; }
  }
}
/** The first value a mark has across the runs (for toolbar state). */
export function marksOf(paras: Para[]): Partial<Run> & { align?: Align; list?: Para['list'] } {
  const r = paras.flatMap((p) => p.runs)[0] ?? { t: '' };
  const p = paras[0];
  return { b: r.b, i: r.i, u: r.u, s: r.s, color: r.color, font: r.font, size: r.size, align: p?.align, list: p?.list };
}

/* ---------------- find and replace ---------------- */

export interface Match { slide: string; el: string | null; where: 'text' | 'notes' | 'cell'; para?: number; row?: number; col?: number; index: number; length: number }
export function findRegex(find: string, opts: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean } = {}): RegExp | null {
  if (!find) return null;
  let src = opts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(src, `gu${opts.matchCase ? '' : 'i'}`); } catch { return null; }
}
export function findAll(deck: Deck, find: string, opts: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean; notes?: boolean } = {}): Match[] {
  const re = findRegex(find, opts);
  if (!re) return [];
  const out: Match[] = [];
  const scan = (text: string, base: Omit<Match, 'index' | 'length'>) => { re.lastIndex = 0; for (let m = re.exec(text); m; m = re.exec(text)) { if (!m[0].length) { re.lastIndex++; continue; } out.push({ ...base, index: m.index, length: m[0].length }); } };
  for (const s of deck.slides) {
    for (const e of s.elements) {
      if (hasText(e)) e.paras.forEach((p, i) => scan(paraText(p), { slide: s.id, el: e.id, where: 'text', para: i }));
      if (e.type === 'table') e.rows.forEach((r, ri) => r.forEach((c, ci) => scan(c.text, { slide: s.id, el: e.id, where: 'cell', row: ri, col: ci })));
    }
    if (opts.notes !== false) scan(s.notes, { slide: s.id, el: null, where: 'notes' });
  }
  return out;
}
/** Replaces text inside runs, keeping the formatting of the run where each match starts. */
export function replaceInPara(p: Para, re: RegExp, replace: string): number {
  const text = paraText(p);
  let count = 0;
  const pieces: { from: number; to: number; with: string }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) { if (!m[0].length) { re.lastIndex++; continue; } pieces.push({ from: m.index, to: m.index + m[0].length, with: m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replace) }); count++; }
  if (!count) return 0;
  for (const pc of pieces.reverse()) {
    let at = 0;
    let startRun = -1;
    const runs = p.runs;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i], a = at, b = at + r.t.length;
      at = b;
      if (b <= pc.from || a >= pc.to) { if (a >= pc.to && startRun < 0) break; continue; }
      const keepL = Math.max(0, pc.from - a), keepR = Math.max(0, b - pc.to);
      if (startRun < 0) { startRun = i; r.t = r.t.slice(0, keepL) + pc.with + (keepR ? r.t.slice(r.t.length - keepR) : ''); }
      else r.t = keepR ? r.t.slice(r.t.length - keepR) : '';
    }
    p.runs = runs.filter((r) => r.t);
  }
  return count;
}
export function replaceAll(deck: Deck, find: string, replace: string, opts: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean; notes?: boolean; slide?: string } = {}): number {
  const re = findRegex(find, opts);
  if (!re) return 0;
  let n = 0;
  for (const s of deck.slides) {
    if (opts.slide && s.id !== opts.slide) continue;
    for (const e of s.elements) {
      if (hasText(e)) for (const p of e.paras) n += replaceInPara(p, re, replace);
      if (e.type === 'table') for (const r of e.rows) for (const c of r) { re.lastIndex = 0; const before = c.text; c.text = c.text.replace(re, replace); if (before !== c.text) n += (before.match(re) ?? []).length; }
    }
    if (opts.notes !== false) { re.lastIndex = 0; const m = s.notes.match(re); if (m) { n += m.length; s.notes = s.notes.replace(re, replace); } }
  }
  return n;
}

/* ---------------- animation order ---------------- */

/** Click steps of a slide: step k (1-based) runs these animations; step 0 runs the "with/after" ones that start on entry. */
export function animSteps(slide: Slide): Anim[][] {
  const steps: Anim[][] = [[]];
  for (const a of slide.anims) {
    if (a.start === 'click') steps.push([a]);
    else steps[steps.length - 1].push(a);
  }
  return steps;
}
/** Start time (seconds, from the click) of each animation in its step. */
export function animTimes(step: Anim[]): Map<string, number> {
  const out = new Map<string, number>();
  let prevStart = 0, prevEnd = 0;
  for (const a of step) {
    const start = (a.start === 'after' ? prevEnd : prevStart) + (a.delay ?? 0);
    out.set(a.id, start);
    prevStart = start; prevEnd = Math.max(prevEnd, start + a.duration);
  }
  return out;
}
const ENTER: AnimEffect[] = ['appear', 'fade-in', 'fly-left', 'fly-right', 'fly-up', 'fly-down', 'zoom-in', 'spin'];
export const isEntrance = (e: AnimEffect): boolean => ENTER.includes(e);
/** Elements hidden at a given click step (an entrance animation not yet run, or an exit that has run). */
export function hiddenAt(slide: Slide, step: number): Set<string> {
  const hidden = new Set<string>();
  const seen = new Set<string>();
  // An element whose first animation is an entrance starts hidden.
  for (const a of slide.anims) { if (seen.has(a.el)) continue; seen.add(a.el); if (isEntrance(a.effect)) hidden.add(a.el); }
  animSteps(slide).forEach((st, k) => { if (k <= step) for (const a of st) { if (isEntrance(a.effect)) hidden.delete(a.el); else hidden.add(a.el); } });
  return hidden;
}

/* ---------------- deck facts ---------------- */

export function deckStats(deck: Deck): { slides: number; hidden: number; words: number; notesWords: number; images: number; animations: number; comments: number } {
  let words = 0, notesWords = 0, images = 0, animations = 0, comments = 0;
  for (const s of deck.slides) {
    for (const e of s.elements) { words += wordCount(elText(e)); if (e.type === 'image') images++; }
    notesWords += wordCount(s.notes);
    animations += s.anims.length;
    comments += s.comments.filter((c) => !c.resolved).length;
  }
  return { slides: deck.slides.length, hidden: deck.slides.filter((s) => s.hidden).length, words, notesWords, images, animations, comments };
}
export function fontsUsed(deck: Deck): string[] {
  const set = new Set<string>([deck.theme.fonts.title, deck.theme.fonts.body]);
  for (const s of deck.slides) for (const e of s.elements) if (hasText(e)) for (const p of e.paras) for (const r of p.runs) if (r.font) set.add(r.font);
  return [...set];
}
/** The colour behind an element (slide background, or the theme background for images/gradients). */
export function backgroundColor(deck: Deck, slide: Slide): string {
  const bg = slide.background;
  if (bg?.type === 'color') return resolveColor(deck.theme, bg.color, deck.theme.colors.background);
  if (bg?.type === 'gradient') return resolveColor(deck.theme, bg.from, deck.theme.colors.background);
  return deck.theme.colors.background;
}

/** A rough estimate of how tall text is at a box width (no DOM): average glyph width ≈ 0.52 em. */
export function estimateTextHeight(paras: Para[], look: TextLook, width: number): number {
  let h = 0;
  for (const p of paras) {
    const sizePt = Math.max(...(p.runs.length ? p.runs.map((r) => r.size ?? look.size) : [look.size]));
    const px = sizePt * PT;
    const indent = (p.list ? 1.4 * px : 0) + (p.level ?? 0) * 0.9 * px;
    const chars = Math.max(1, paraText(p).length);
    const perLine = Math.max(1, Math.floor((width - indent) / (px * 0.52)));
    h += Math.ceil(chars / perLine) * px * (p.lh ?? 1.2) + (p.sb ?? 0) + (p.sa ?? 0);
  }
  return h;
}
/** Scale (≤ 1) that shrinks a box's text to fit its height (Autofit ▸ Shrink text on overflow). */
export function shrinkScale(el: TextEl | ShapeEl, look: TextLook): number {
  if (el.type !== 'text' || el.autofit !== 'shrink') return 1;
  const pad = (el.pad ?? 8) * 2;
  let k = 1;
  for (let i = 0; i < 12; i++) {
    const scaled = el.paras.map((p) => ({ ...p, runs: p.runs.map((r) => (r.size ? { ...r, size: r.size * k } : r)) }));
    if (estimateTextHeight(scaled, { ...look, size: look.size * k }, el.w - pad) <= el.h - pad || k <= 0.4) break;
    k -= 0.06;
  }
  return Math.max(0.4, Math.round(k * 100) / 100);
}
