/** Agent operations on a deck (all-or-nothing, with a log), the compact reader and the design review. Pure — node tests import it. */
import {
  ANIM_EFFECTS, LAYOUTS, SHAPES, SIZES, THEMES, THEME_COLOR_KEYS, TRANSITIONS, addSlide, alignEls, aspectOf, backgroundColor, clone, contrast, deckStats, deleteSlide,
  distributeEls, duplicateSlide, findEl, findSlide, fontsUsed, formatParas, groupEls, hasText, intersects, isColor, isLayout, layoutElements, moveSlides, newId, normEl,
  para, parasText, removeEls, reorder, replaceAll, resolveColor, roleLook, rotatedBounds, shrinkScale, slideIndex, slideTitle, textToParas, ungroupEls, wordCount,
  type AlignTo, type Anim, type AnimEffect, type AnimStart, type Background, type Deck, type El, type ElType, type LayoutId, type Para, type ShapeKind, type Slide, type TextEl,
  type ThemeColors, type TransitionKind, type ZOrder,
} from './slides.ts';
import { markdownToSlides } from './slidesFormat.ts';

export type Op = { op: string } & Record<string, unknown>;
export interface OpCtx { author: string; now: string }
export interface OpResult { deck: Deck; log: string[]; error?: string }

export const OP_HELP = [
  'Units are pixels on the slide (16:9 is 960 × 540; 4:3 is 960 × 720); x/y is the top-left corner. Colours are #hex or theme colours: $background $surface $text $title $muted $accent $accent2 $accent3 $accent4.',
  'Slides are addressed by number (1-based), id or title text; elements by id, name, number on the slide, role (title, subtitle, body, body2, number, caption) or their text.',
  'Text is light Markdown: one paragraph per line, "- " bullets, "1. " numbers, two spaces per indent level, **bold**, *italic*, __underline__, ~~strike~~, [link](url).',
  '- add_slide {layout: title|title-body|section|two-columns|big-number|title-only|caption|blank, at?, title?, subtitle?, body? (text or list), left?, right?, number?, caption?, notes?}',
  '- duplicate_slide {slide} · delete_slide {slide} · move_slide {slide, to} · hide_slide {slide, hidden?: true}',
  '- slide {slide, layout?, background?: "#hex" | {type:"gradient", from, to, angle} | {type:"image", src|path, fit} | null, notes?, hidden?}',
  '- notes {slide, text} · transition {slide | all:true, type: none|fade|slide-left|slide-right|slide-up|zoom|flip, duration? (s)}',
  '- add {slide, type: text|shape|line|image|table|chart|icon|embed, x, y, w, h, rot?, name?, ...} text: {text, role?, size?, color?, font?, bold?, align?, valign?: top|middle|bottom, fill?, autofit?: none|shrink|resize}; shape: {shape, fill, stroke, strokeW, text, shadow?}; line: {x1,y1,x2,y2, stroke, strokeW, start/end: none|arrow|dot, dash?}; image: {path (workspace image) | src (data URL), fit: cover|contain, alt}; table: {rows: [["a","b"],…], header?, band?, size?}; chart: {chart: column|bar|line|pie|doughnut, labels, series: [{name, values}], title?, values?, highlight? (category index), legend?}; icon: {glyph (emoji)}; embed: {kind: video|link, url, title}',
  `- set {slide, el, ...same props as add} — change an element (text replaces its text) · delete {slide, el | els} · text {slide, el, text} · format {slide, el, size?, color?, font?, bold?, italic?, underline?, align?, list?: bullet|number|none, line_spacing?}`,
  '- replace_text {find, replace, slide?, match_case?, whole_word?} across the deck · arrange {slide, el | els, z: front|back|forward|backward}',
  '- align {slide, els, to: left|center|right|top|middle|bottom, relative?: slide|selection} · distribute {slide, els, axis: h|v} · group {slide, els} · ungroup {slide, el} · lock {slide, el, locked?}',
  `- animate {slide, el, effect: ${ANIM_EFFECTS.map((e) => e.id).join('|')}, start?: click|with|after, duration?, delay?} · remove_animation {slide, el}`,
  '- table_cell {slide, el, row, col (1-based), text, bold?, fill?} · chart_data {slide, el, labels?, series?}',
  `- theme {theme?: ${THEMES.map((t) => t.id).join('|')}, colors?: {${THEME_COLOR_KEYS.join(', ')}}, title_font?, body_font?, title_size?, body_size?} · size {aspect: 16:9|4:3|16:10|A4} · title {title}`,
  '- comment {slide, text, el?} · reply {slide, id, text} · resolve {slide, id} · delete_comment {slide, id}',
  '- markdown {markdown, at?} — append slides from a Markdown outline ("# "/"## " start a slide, "---" splits, "> " or "Notes:" lines are speaker notes)',
].join('\n');

const OPS = new Set(['add_slide', 'duplicate_slide', 'delete_slide', 'move_slide', 'hide_slide', 'slide', 'notes', 'transition', 'add', 'set', 'delete', 'text', 'format', 'replace_text', 'arrange', 'align', 'distribute', 'group', 'ungroup', 'lock', 'animate', 'remove_animation', 'table_cell', 'chart_data', 'theme', 'size', 'title', 'comment', 'reply', 'resolve', 'delete_comment', 'markdown']);

export function parseOps(raw: unknown): { ops: Op[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const errors: string[] = [];
  const ops: Op[] = [];
  if (!Array.isArray(raw) && !(raw && typeof raw === 'object')) errors.push('ops must be an array of {op: …} objects');
  list.forEach((o, i) => {
    if (!o || typeof o !== 'object' || typeof (o as Op).op !== 'string') { errors.push(`op ${i + 1}: needs an "op" name`); return; }
    if (!OPS.has((o as Op).op)) { errors.push(`op ${i + 1}: unknown op "${(o as Op).op}" — use ${[...OPS].join(', ')}`); return; }
    ops.push(o as Op);
  });
  return { ops, errors };
}

class OpError extends Error {}
function fail(m: string): never { throw new OpError(m); }
const numOr = (v: unknown, d?: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const textOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (/^\s*([-*•]|\d+[.)])\s/.test(String(x)) ? String(x) : `- ${String(x)}`)).join('\n') : typeof v === 'number' ? String(v) : undefined);

function needSlide(deck: Deck, ref: unknown): Slide {
  if (ref === undefined) fail('needs a slide (number, id or title)');
  return findSlide(deck, ref) ?? fail(`no slide "${String(ref)}" (the deck has ${deck.slides.length})`);
}
function needEl(slide: Slide, ref: unknown, deck: Deck): El {
  if (ref === undefined) fail('needs an el (id, name, number, role or text)');
  return findEl(slide, ref) ?? fail(`slide ${slideIndex(deck, slide) + 1} has no element "${String(ref)}" (it has ${slide.elements.map((e) => `${e.id} ${e.type}${e.type === 'text' && e.role ? `(${e.role})` : ''}`).join(', ') || 'none'})`);
}
function needEls(slide: Slide, op: Op, deck: Deck): El[] {
  const refs = Array.isArray(op.els) ? op.els : op.el !== undefined ? [op.el] : fail('needs els (a list) or el');
  return refs.map((r) => needEl(slide, r, deck));
}
const describe = (deck: Deck, s: Slide): string => `slide ${slideIndex(deck, s) + 1}${slideTitle(s) ? ` "${slideTitle(s).slice(0, 40)}"` : ''}`;
const color = (v: unknown, what: string): string | undefined => { if (v === undefined || v === null || v === '') return undefined; if (!isColor(v)) fail(`${what} must be a #hex colour or a theme colour like $accent (got ${JSON.stringify(v)})`); return v as string; };

function background(v: unknown): Background | null {
  if (v === null || v === 'none') return null;
  if (typeof v === 'string') { color(v, 'background'); return { type: 'color', color: v }; }
  if (v && typeof v === 'object') {
    const b = v as Record<string, unknown>;
    if (b.type === 'gradient' || (b.from && b.to)) { color(b.from, 'gradient from'); color(b.to, 'gradient to'); return { type: 'gradient', from: String(b.from), to: String(b.to), angle: numOr(b.angle, 180) }; }
    if (b.type === 'image' || b.src) { if (typeof b.src !== 'string' || !b.src) fail('an image background needs src (or path)'); return { type: 'image', src: String(b.src), fit: b.fit === 'contain' ? 'contain' : 'cover' }; }
    if (b.color) { color(b.color, 'background'); return { type: 'color', color: String(b.color) }; }
  }
  return fail('background must be a colour, {type:"gradient", from, to}, {type:"image", src} or null');
}

/** Applies add/set properties to an element. */
function applyProps(deck: Deck, el: El, op: Op): void {
  for (const k of ['x', 'y', 'w', 'h', 'rot', 'opacity'] as const) {
    const v = numOr(op[k]);
    if (v === undefined) continue;
    if ((k === 'w' || k === 'h') && v <= 0) fail(`${k} must be above 0`);
    (el as unknown as Record<string, number>)[k] = Math.round(v * 10) / 10;
  }
  if (el.rot !== undefined && !el.rot) delete el.rot;
  if (typeof op.name === 'string') el.name = op.name;
  if (typeof op.alt === 'string') el.alt = op.alt;
  if (typeof op.link === 'string') { if (op.link) el.link = op.link; else delete el.link; }
  if (typeof op.locked === 'boolean') { if (op.locked) el.locked = true; else delete el.locked; }
  const rec = el as unknown as Record<string, unknown>;
  const setColor = (key: string, src: string = key) => { if (op[src] === undefined) return; if (op[src] === null || op[src] === '') { delete rec[key]; return; } rec[key] = color(op[src], src); };
  switch (el.type) {
    case 'text': case 'shape': {
      const t = textOf(op.text);
      if (t !== undefined) el.paras = textToParas(t);
      setColor('fill'); setColor('stroke');
      if (op.strokeW !== undefined) el.strokeW = numOr(op.strokeW, 1);
      if (op.valign === 'top' || op.valign === 'middle' || op.valign === 'bottom') el.valign = op.valign;
      if (el.type === 'text') {
        if (['title', 'subtitle', 'body', 'caption', 'number'].includes(String(op.role))) el.role = op.role as TextEl['role'];
        if (op.autofit === 'none' || op.autofit === 'shrink' || op.autofit === 'resize') el.autofit = op.autofit;
        if (op.pad !== undefined) el.pad = numOr(op.pad, 8);
        if (t !== undefined) delete el.placeholder;
      } else {
        if (op.shape !== undefined) { if (!SHAPES.some((s) => s.id === op.shape)) fail(`shape must be ${SHAPES.map((s) => s.id).join(', ')}`); el.shape = op.shape as ShapeKind; }
        if (typeof op.dash === 'boolean') el.dash = op.dash || undefined;
        if (typeof op.shadow === 'boolean') el.shadow = op.shadow || undefined;
      }
      applyFormat(el.paras, op);
      break;
    }
    case 'line': {
      const x1 = numOr(op.x1), y1 = numOr(op.y1), x2 = numOr(op.x2), y2 = numOr(op.y2);
      if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
        el.x = Math.min(x1, x2); el.y = Math.min(y1, y2); el.w = Math.max(1, Math.abs(x2 - x1)); el.h = Math.max(1, Math.abs(y2 - y1));
        const down = (x2 - x1) * (y2 - y1) >= 0;
        el.dir = down ? 'down' : 'up';
        // keep the direction of travel for arrow heads: going right-to-left swaps start and end
        if (x2 < x1 || (x2 === x1 && y2 < y1)) { const s = op.start, e = op.end; op = { ...op, start: e, end: s }; }
      }
      setColor('stroke', op.stroke !== undefined ? 'stroke' : 'color');
      if (op.strokeW !== undefined || op.width !== undefined) el.strokeW = numOr(op.strokeW ?? op.width, 3);
      for (const k of ['start', 'end'] as const) if (op[k] !== undefined) { if (!['none', 'arrow', 'dot'].includes(String(op[k]))) fail(`${k} must be none, arrow or dot`); el[k] = op[k] as 'none'; }
      if (typeof op.dash === 'boolean') el.dash = op.dash || undefined;
      break;
    }
    case 'image':
      if (typeof op.src === 'string' && op.src) el.src = op.src;
      if (op.fit === 'cover' || op.fit === 'contain' || op.fit === 'fill') el.fit = op.fit;
      if (op.radius !== undefined) el.radius = numOr(op.radius, 0);
      break;
    case 'table': {
      if (Array.isArray(op.rows)) {
        const rows = op.rows as unknown[];
        const norm = normEl({ type: 'table', rows, x: 0, y: 0, w: 1, h: 1 }, () => undefined, new Set(), () => 'x');
        if (norm && norm.type === 'table') el.rows = norm.rows;
      }
      if (typeof op.header === 'boolean') el.header = op.header;
      if (typeof op.band === 'boolean') el.band = op.band || undefined;
      if (op.size !== undefined) el.size = numOr(op.size, 14);
      setColor('border'); setColor('headerFill', op.headerFill !== undefined ? 'headerFill' : 'header_fill');
      break;
    }
    case 'chart':
      if (op.chart !== undefined) { if (!['column', 'bar', 'line', 'pie', 'doughnut'].includes(String(op.chart))) fail('chart must be column, bar, line, pie or doughnut'); el.chart = op.chart as typeof el.chart; }
      applyChartData(el, op);
      if (typeof op.title === 'string') el.title = op.title || undefined;
      if (typeof op.legend === 'boolean') el.legend = op.legend;
      if (typeof op.values === 'boolean') el.values = op.values;
      if (op.highlight !== undefined) { const h = numOr(op.highlight); if (h === undefined || h < 0) delete el.highlight; else el.highlight = Math.floor(h); }
      break;
    case 'icon':
      if (typeof op.glyph === 'string' && op.glyph) el.glyph = op.glyph;
      setColor('color');
      break;
    case 'embed':
      if (op.kind === 'video' || op.kind === 'link') el.kind = op.kind;
      if (typeof op.url === 'string') el.url = op.url;
      if (typeof op.title === 'string') el.title = op.title;
      break;
  }
  void deck;
}
function applyChartData(el: Extract<El, { type: 'chart' }>, op: Op): void {
  if (op.labels !== undefined) { if (!Array.isArray(op.labels)) fail('labels must be a list'); el.labels = (op.labels as unknown[]).map(String); }
  if (op.series !== undefined) {
    if (!Array.isArray(op.series)) fail('series must be a list of {name, values}');
    el.series = (op.series as unknown[]).map((s, i) => {
      const x = (s ?? {}) as Record<string, unknown>;
      if (!Array.isArray(x.values)) fail(`series ${i + 1} needs values (a list of numbers)`);
      const out: { name: string; values: number[]; color?: string } = { name: String(x.name ?? `Series ${i + 1}`), values: (x.values as unknown[]).map((v) => Number(v) || 0) };
      const c = color(x.color, 'series colour');
      if (c) out.color = c;
      return out;
    });
  }
}
function applyFormat(paras: Para[], op: Op): void {
  const marks: Parameters<typeof formatParas>[1] = {};
  if (op.size !== undefined) { const s = numOr(op.size); if (!s || s <= 0 || s > 400) fail('size is in points (1–400)'); marks.size = s; }
  if (op.color !== undefined) marks.color = color(op.color, 'color');
  if (typeof op.font === 'string') marks.font = op.font || undefined;
  if (typeof op.bold === 'boolean') marks.b = op.bold;
  if (typeof op.italic === 'boolean') marks.i = op.italic;
  if (typeof op.underline === 'boolean') marks.u = op.underline;
  if (typeof op.strike === 'boolean') marks.s = op.strike;
  if (op.align !== undefined) { if (!['left', 'center', 'right', 'justify'].includes(String(op.align))) fail('align must be left, center, right or justify'); marks.align = op.align as 'left'; }
  if (op.list !== undefined) marks.list = op.list === 'bullet' || op.list === 'number' ? op.list : null;
  if (op.line_spacing !== undefined) marks.lh = numOr(op.line_spacing);
  if (Object.keys(marks).length) formatParas(paras, marks);
}

const ADD_DEFAULTS: Record<ElType, { w: number; h: number }> = { text: { w: 400, h: 80 }, shape: { w: 200, h: 140 }, line: { w: 200, h: 1 }, image: { w: 400, h: 260 }, table: { w: 600, h: 200 }, chart: { w: 560, h: 320 }, icon: { w: 90, h: 90 }, embed: { w: 400, h: 225 } };

function addEl(deck: Deck, slide: Slide, op: Op): El {
  const type = String(op.type ?? '') as ElType;
  if (!(type in ADD_DEFAULTS)) fail('type must be text, shape, line, image, table, chart, icon or embed');
  const d = ADD_DEFAULTS[type];
  const base = { id: newId(deck, 'e'), x: (deck.size.w - d.w) / 2, y: (deck.size.h - d.h) / 2, w: d.w, h: d.h };
  let el: El;
  switch (type) {
    case 'text': el = { ...base, type, paras: [para()], autofit: 'shrink' }; break;
    case 'shape': el = { ...base, type, shape: 'rect', fill: '$accent', paras: [para()] }; break;
    case 'line': el = { ...base, type, stroke: '$text', strokeW: 3 }; break;
    case 'image': if (typeof op.src !== 'string' || !op.src) fail('an image needs path (a workspace image) or src (a data URL)'); el = { ...base, type, src: String(op.src), fit: 'cover' }; break;
    case 'table': if (!Array.isArray(op.rows)) fail('a table needs rows: [["a","b"],["c","d"]]'); el = { ...base, type, rows: [], header: true }; break;
    case 'chart': if (!Array.isArray(op.series)) fail('a chart needs series: [{name, values: [..]}] and labels'); el = { ...base, type, chart: 'column', labels: [], series: [] }; break;
    case 'icon': el = { ...base, type, glyph: '⭐' }; break;
    default: if (typeof op.url !== 'string') fail('an embed needs a url'); el = { ...base, type: 'embed', kind: 'video', url: '' }; break;
  }
  applyProps(deck, el, op);
  slide.elements.push(el);
  return el;
}

function opApply(deck: Deck, op: Op, ctx: OpCtx): string {
  switch (op.op) {
    case 'add_slide': {
      const layout = (op.layout ?? 'title-body') as LayoutId;
      if (!isLayout(layout)) fail(`layout must be ${LAYOUTS.map((l) => l.id).join(', ')}`);
      const at = op.at === undefined ? undefined : (numOr(op.at) ?? fail('at is a slide number')) - 1;
      const s = addSlide(deck, layout, at, { title: textOf(op.title), subtitle: textOf(op.subtitle), body: textOf(op.body), left: textOf(op.left), right: textOf(op.right), number: textOf(op.number), caption: textOf(op.caption), notes: typeof op.notes === 'string' ? op.notes : undefined });
      return `added ${describe(deck, s)} (${s.id}, ${layout}) with ${s.elements.map((e) => e.id).join(', ') || 'no placeholders'}`;
    }
    case 'duplicate_slide': { const s = needSlide(deck, op.slide); const c = duplicateSlide(deck, s); return `duplicated ${describe(deck, s)} as slide ${slideIndex(deck, c) + 1} (${c.id})`; }
    case 'delete_slide': { const s = needSlide(deck, op.slide); const d = describe(deck, s); deleteSlide(deck, s); return `deleted ${d}`; }
    case 'move_slide': {
      const s = needSlide(deck, op.slide);
      const to = numOr(op.to) ?? fail('move_slide needs to (a slide number)');
      const target = Math.max(1, Math.min(deck.slides.length, to));
      const from = slideIndex(deck, s);
      moveSlides(deck, [s.id], target - 1 + (target - 1 > from ? 1 : 0));
      return `moved slide ${from + 1} to position ${slideIndex(deck, s) + 1}`;
    }
    case 'hide_slide': { const s = needSlide(deck, op.slide); if (op.hidden === false) delete s.hidden; else s.hidden = true; return `${s.hidden ? 'skipped' : 'showed'} ${describe(deck, s)} in the presentation`; }
    case 'slide': {
      const s = needSlide(deck, op.slide);
      const done: string[] = [];
      if (op.layout !== undefined) {
        if (!isLayout(op.layout)) fail(`layout must be ${LAYOUTS.map((l) => l.id).join(', ')}`);
        relayout(deck, s, op.layout);
        done.push(`layout ${op.layout}`);
      }
      if (op.background !== undefined) { const b = background(op.background); if (b) s.background = b; else delete s.background; done.push('background'); }
      if (typeof op.notes === 'string') { s.notes = op.notes; done.push('notes'); }
      if (typeof op.hidden === 'boolean') { if (op.hidden) s.hidden = true; else delete s.hidden; done.push(op.hidden ? 'skipped' : 'shown'); }
      if (!done.length) fail('slide needs layout, background, notes or hidden');
      return `${describe(deck, s)}: ${done.join(', ')}`;
    }
    case 'notes': { const s = needSlide(deck, op.slide); s.notes = String(op.text ?? ''); return `notes on ${describe(deck, s)} (${wordCount(s.notes)} words)`; }
    case 'transition': {
      const type = String(op.type ?? 'fade') as TransitionKind;
      if (!TRANSITIONS.some((t) => t.id === type)) fail(`type must be ${TRANSITIONS.map((t) => t.id).join(', ')}`);
      const targets = op.all === true ? deck.slides : [needSlide(deck, op.slide)];
      for (const s of targets) { if (type === 'none') delete s.transition; else s.transition = { type, duration: Math.max(0.1, Math.min(5, numOr(op.duration, 0.6) ?? 0.6)) }; }
      return `transition ${type} on ${op.all === true ? 'every slide' : describe(deck, targets[0])}`;
    }
    case 'add': { const s = needSlide(deck, op.slide); const el = addEl(deck, s, op); return `added ${el.type} ${el.id} on ${describe(deck, s)} at ${Math.round(el.x)},${Math.round(el.y)} ${Math.round(el.w)}×${Math.round(el.h)}`; }
    case 'set': {
      const s = needSlide(deck, op.slide);
      const el = needEl(s, op.el, deck);
      if (op.type !== undefined && op.type !== el.type) fail(`set cannot change an element's type (${el.id} is ${el.type}); delete it and add a new one`);
      applyProps(deck, el, op);
      return `changed ${el.type} ${el.id} on ${describe(deck, s)}`;
    }
    case 'delete': { const s = needSlide(deck, op.slide); const els = needEls(s, op, deck); removeEls(s, els.map((e) => e.id)); return `deleted ${els.map((e) => e.id).join(', ')} from ${describe(deck, s)}`; }
    case 'text': {
      const s = needSlide(deck, op.slide);
      const el = needEl(s, op.el, deck);
      if (el.type === 'table') fail('use table_cell to change a table');
      if (!hasText(el)) fail(`${el.id} is ${el.type}, which has no text`);
      el.paras = textToParas(textOf(op.text) ?? '');
      if (el.type === 'text') delete el.placeholder;
      applyFormat(el.paras, op);
      return `text of ${el.id} on ${describe(deck, s)}: "${parasText(el.paras).replace(/\n/g, ' / ').slice(0, 60)}"`;
    }
    case 'format': {
      const s = needSlide(deck, op.slide);
      const els = needEls(s, op, deck);
      for (const el of els) { if (!hasText(el)) fail(`${el.id} is ${el.type}, which has no text`); applyFormat(el.paras, op); }
      return `formatted ${els.map((e) => e.id).join(', ')} on ${describe(deck, s)}`;
    }
    case 'replace_text': {
      if (typeof op.find !== 'string' || !op.find) fail('replace_text needs find');
      const n = replaceAll(deck, String(op.find), String(op.replace ?? ''), { matchCase: op.match_case === true, wholeWord: op.whole_word === true, slide: op.slide !== undefined ? needSlide(deck, op.slide).id : undefined });
      if (!n) fail(`"${String(op.find)}" was not found`);
      return `replaced ${n} × "${String(op.find)}"`;
    }
    case 'arrange': {
      const s = needSlide(deck, op.slide);
      const els = needEls(s, op, deck);
      if (!['front', 'back', 'forward', 'backward'].includes(String(op.z))) fail('z must be front, back, forward or backward');
      reorder(s, els.map((e) => e.id), op.z as ZOrder);
      return `${els.map((e) => e.id).join(', ')} → ${String(op.z)}`;
    }
    case 'align': {
      const s = needSlide(deck, op.slide);
      const els = needEls(s, op, deck);
      if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(String(op.to))) fail('to must be left, center, right, top, middle or bottom');
      alignEls(deck, s, els.map((e) => e.id), op.to as AlignTo, op.relative === 'slide' || op.relative === 'selection' ? op.relative : undefined);
      return `aligned ${els.map((e) => e.id).join(', ')} ${String(op.to)}`;
    }
    case 'distribute': {
      const s = needSlide(deck, op.slide);
      const els = needEls(s, op, deck);
      if (els.length < 3) fail('distribute needs at least 3 elements');
      distributeEls(s, els.map((e) => e.id), op.axis === 'v' ? 'v' : 'h');
      return `distributed ${els.length} elements ${op.axis === 'v' ? 'vertically' : 'horizontally'}`;
    }
    case 'group': { const s = needSlide(deck, op.slide); const els = needEls(s, op, deck); const g = groupEls(deck, s, els.map((e) => e.id)) ?? fail('group needs at least 2 elements'); return `grouped ${els.map((e) => e.id).join(', ')} as ${g}`; }
    case 'ungroup': { const s = needSlide(deck, op.slide); const els = needEls(s, op, deck); ungroupEls(s, els.map((e) => e.id)); return `ungrouped ${els.map((e) => e.id).join(', ')}`; }
    case 'lock': { const s = needSlide(deck, op.slide); const els = needEls(s, op, deck); for (const e of els) { if (op.locked === false) delete e.locked; else e.locked = true; } return `${op.locked === false ? 'unlocked' : 'locked'} ${els.map((e) => e.id).join(', ')}`; }
    case 'animate': {
      const s = needSlide(deck, op.slide);
      const el = needEl(s, op.el, deck);
      const effect = String(op.effect ?? 'fade-in') as AnimEffect;
      if (!ANIM_EFFECTS.some((e) => e.id === effect)) fail(`effect must be ${ANIM_EFFECTS.map((e) => e.id).join(', ')}`);
      const start = String(op.start ?? 'click') as AnimStart;
      if (!['click', 'with', 'after'].includes(start)) fail('start must be click, with or after');
      const a: Anim = { id: newId(deck, 'a'), el: el.id, effect, start, duration: Math.max(0.05, Math.min(10, numOr(op.duration, 0.5) ?? 0.5)) };
      const delay = numOr(op.delay);
      if (delay) a.delay = delay;
      s.anims.push(a);
      return `animation ${a.id}: ${effect} on ${el.id} (${start === 'click' ? 'on click' : start === 'with' ? 'with previous' : 'after previous'})`;
    }
    case 'remove_animation': { const s = needSlide(deck, op.slide); const el = needEl(s, op.el, deck); const n = s.anims.length; s.anims = s.anims.filter((a) => a.el !== el.id); if (n === s.anims.length) fail(`${el.id} has no animation`); return `removed ${n - s.anims.length} animation(s) from ${el.id}`; }
    case 'table_cell': {
      const s = needSlide(deck, op.slide);
      const el = needEl(s, op.el, deck);
      if (el.type !== 'table') fail(`${el.id} is not a table`);
      const r = (numOr(op.row) ?? fail('table_cell needs row (1-based)')) - 1, c = (numOr(op.col) ?? fail('table_cell needs col (1-based)')) - 1;
      while (el.rows.length <= r) el.rows.push(el.rows[0].map(() => ({ text: '' })));
      if (c >= el.rows[0].length) for (const row of el.rows) while (row.length <= c) row.push({ text: '' });
      const cell = el.rows[r][c];
      if (op.text !== undefined) cell.text = String(op.text);
      if (typeof op.bold === 'boolean') { if (op.bold) cell.b = true; else delete cell.b; }
      if (op.fill !== undefined) { const f = color(op.fill, 'fill'); if (f) cell.fill = f; else delete cell.fill; }
      if (op.align === 'left' || op.align === 'center' || op.align === 'right') cell.align = op.align;
      return `cell ${r + 1},${c + 1} of ${el.id} = "${cell.text}"`;
    }
    case 'chart_data': { const s = needSlide(deck, op.slide); const el = needEl(s, op.el, deck); if (el.type !== 'chart') fail(`${el.id} is not a chart`); applyChartData(el, op); return `chart ${el.id}: ${el.labels.length} categories × ${el.series.length} series`; }
    case 'theme': {
      const done: string[] = [];
      if (op.theme !== undefined) {
        const t = THEMES.find((x) => x.id === op.theme || x.name.toLowerCase() === String(op.theme).toLowerCase()) ?? fail(`theme must be ${THEMES.map((x) => x.id).join(', ')}`);
        deck.theme = clone(t); done.push(t.name);
      }
      if (op.colors && typeof op.colors === 'object') {
        for (const [k, v] of Object.entries(op.colors as Record<string, unknown>)) {
          if (!THEME_COLOR_KEYS.includes(k as keyof ThemeColors)) fail(`theme colours are ${THEME_COLOR_KEYS.join(', ')}`);
          if (typeof v !== 'string' || !/^#[0-9a-f]{3,6}$/i.test(v)) fail(`theme colour ${k} must be a #hex colour`);
          deck.theme.colors[k as keyof ThemeColors] = v as string;
        }
        done.push('colours');
      }
      if (typeof op.title_font === 'string' && op.title_font) { deck.theme.fonts.title = op.title_font; done.push(`title font ${op.title_font}`); }
      if (typeof op.body_font === 'string' && op.body_font) { deck.theme.fonts.body = op.body_font; done.push(`body font ${op.body_font}`); }
      if (op.title_size !== undefined) { deck.theme.titleSize = numOr(op.title_size, 36); done.push(`title ${deck.theme.titleSize}pt`); }
      if (op.body_size !== undefined) { deck.theme.bodySize = numOr(op.body_size, 18); done.push(`body ${deck.theme.bodySize}pt`); }
      if (!done.length) fail('theme needs theme, colors, title_font, body_font, title_size or body_size');
      if (done.length > (op.theme !== undefined ? 1 : 0)) deck.theme.id = 'custom';
      return `theme: ${done.join(', ')}`;
    }
    case 'size': {
      const key = String(op.aspect ?? '') as keyof typeof SIZES;
      const size = SIZES[key] ?? fail('aspect must be 16:9, 4:3, 16:10 or A4');
      resizeDeck(deck, size);
      return `slide size ${key} (${size.w}×${size.h})`;
    }
    case 'title': { if (typeof op.title !== 'string' || !op.title.trim()) fail('title needs text'); deck.title = op.title.trim(); return `title "${deck.title}"`; }
    case 'comment': {
      const s = needSlide(deck, op.slide);
      if (typeof op.text !== 'string' || !op.text.trim()) fail('comment needs text');
      const el = op.el !== undefined ? needEl(s, op.el, deck) : undefined;
      const c = { id: newId(deck, 'c'), author: ctx.author, at: ctx.now, text: op.text.trim(), ...(el ? { el: el.id } : {}), replies: [] };
      s.comments.push(c);
      return `comment ${c.id} on ${describe(deck, s)}${el ? ` (${el.id})` : ''}`;
    }
    case 'reply': case 'resolve': case 'delete_comment': {
      const s = op.slide !== undefined ? needSlide(deck, op.slide) : deck.slides.find((x) => x.comments.some((c) => c.id === op.id));
      const c = s?.comments.find((x) => x.id === op.id) ?? fail(`no comment "${String(op.id)}"`);
      if (op.op === 'reply') { if (typeof op.text !== 'string' || !op.text.trim()) fail('reply needs text'); c.replies.push({ author: ctx.author, at: ctx.now, text: op.text.trim() }); return `replied to ${c.id}`; }
      if (op.op === 'resolve') { if (op.resolved === false) delete c.resolved; else c.resolved = true; return `${c.resolved ? 'resolved' : 'reopened'} ${c.id}`; }
      s!.comments = s!.comments.filter((x) => x !== c);
      return `deleted comment ${c.id}`;
    }
    case 'markdown': {
      if (typeof op.markdown !== 'string' || !op.markdown.trim()) fail('markdown needs text');
      const before = deck.slides.length;
      const made = markdownToSlides(deck, op.markdown);
      if (op.at !== undefined) { const at = (numOr(op.at) ?? before + 1) - 1; moveSlides(deck, made.map((s) => s.id), Math.max(0, Math.min(before, at))); }
      return `added ${made.length} slide(s) from Markdown: ${made.map((s) => `${slideIndex(deck, s) + 1} "${slideTitle(s).slice(0, 30)}"`).join(', ')}`;
    }
  }
  return fail(`unknown op ${op.op}`);
}

/** Changes a slide's layout: keeps the text of matching placeholders, adds the new ones, drops empty old ones. */
export function relayout(deck: Deck, s: Slide, layout: LayoutId): void {
  const fresh = layoutElements(deck, layout) as TextEl[];
  const old = s.elements.filter((e): e is TextEl => e.type === 'text' && !!e.placeholder || (e.type === 'text' && !!e.role));
  const used = new Set<El>();
  for (const f of fresh) {
    const match = old.find((o) => !used.has(o) && o.role === f.role);
    if (match) { used.add(match); match.x = f.x; match.y = f.y; match.w = f.w; match.h = f.h; match.valign = f.valign; f.id = match.id; f.paras = match.paras; f.placeholder = match.placeholder; }
  }
  const keep = s.elements.filter((e) => !(e.type === 'text' && e.placeholder && !used.has(e) && !parasText(e.paras).trim()));
  const kept = new Set(keep.map((e) => e.id));
  for (const f of fresh) if (!kept.has(f.id)) keep.unshift(f);
  s.elements = keep;
  s.layout = layout;
}
/** Changes the slide size and scales every element to match. */
export function resizeDeck(deck: Deck, size: { w: number; h: number }): void {
  const kx = size.w / deck.size.w, ky = size.h / deck.size.h, k = Math.min(kx, ky);
  for (const s of deck.slides) for (const e of s.elements) {
    const cx = (e.x + e.w / 2) * kx, cy = (e.y + e.h / 2) * ky;
    const w = e.w * (e.type === 'text' ? kx : k), h = e.h * (e.type === 'text' ? ky : k);
    e.x = Math.round(cx - w / 2); e.y = Math.round(cy - h / 2); e.w = Math.round(w); e.h = Math.round(h);
  }
  deck.size = { ...size };
}

export function applyOps(deck: Deck, ops: Op[], ctx: OpCtx): OpResult {
  const next = clone(deck);
  const log: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    try { log.push(opApply(next, ops[i], ctx)); }
    catch (e) {
      if (e instanceof OpError) return { deck, log, error: `op ${i + 1} (${ops[i].op}): ${e.message}` };
      throw e;
    }
  }
  return { deck: next, log };
}

/* ---------------- reading ---------------- */

export function summarizeDeck(deck: Deck): string {
  const st = deckStats(deck);
  return `"${deck.title}" — ${st.slides} slide${st.slides === 1 ? '' : 's'}${st.hidden ? ` (${st.hidden} skipped)` : ''} · ${aspectOf(deck.size)} · theme ${deck.theme.name} (${deck.theme.fonts.title} / ${deck.theme.fonts.body}) · ${st.words} words on slides, ${st.notesWords} in notes${st.images ? ` · ${st.images} image(s)` : ''}${st.animations ? ` · ${st.animations} animation(s)` : ''}${st.comments ? ` · ${st.comments} open comment(s)` : ''}`;
}
const r = (n: number) => Math.round(n);
function elLine(e: El): string {
  const pos = `@${r(e.x)},${r(e.y)} ${r(e.w)}×${r(e.h)}${e.rot ? ` rot ${r(e.rot)}°` : ''}`;
  const flags = [e.locked ? 'locked' : '', e.group ? `group ${e.group}` : '', e.name ? `"${e.name}"` : ''].filter(Boolean).join(', ');
  const head = `${e.id} ${e.type}${e.type === 'text' && e.role ? `(${e.role}${e.placeholder ? ' placeholder' : ''})` : e.type === 'shape' ? `(${e.shape})` : e.type === 'chart' ? `(${e.chart})` : ''} ${pos}${flags ? ` [${flags}]` : ''}`;
  if (hasText(e)) {
    const t = parasText(e.paras);
    const fmt = e.paras.flatMap((p) => p.runs).find((x) => x.size || x.color || x.font);
    const style = [e.type === 'shape' && e.fill ? `fill ${e.fill}` : '', e.type === 'text' && e.fill ? `fill ${e.fill}` : '', fmt?.size ? `${fmt.size}pt` : '', fmt?.color ? fmt.color : '', fmt?.font ?? ''].filter(Boolean).join(' ');
    if (!t.trim()) return `${head}${style ? ` {${style}}` : ''} (empty)`;
    const md = e.paras.map((p, i) => `${'  '.repeat(p.level ?? 0)}${p.list === 'bullet' ? '- ' : p.list === 'number' ? `${i + 1}. ` : ''}${p.runs.map((x) => (x.b ? `**${x.t}**` : x.i ? `*${x.t}*` : x.t)).join('')}`);
    return `${head}${style ? ` {${style}}` : ''}\n${md.map((l) => `      ${l}`).join('\n')}`;
  }
  if (e.type === 'image') return `${head} ${e.alt ? `alt "${e.alt}"` : 'NO ALT TEXT'} ${e.src.startsWith('data:') ? `(${e.src.slice(5, e.src.indexOf(';'))})` : e.src}`;
  if (e.type === 'table') return `${head} ${e.rows.length}×${e.rows[0]?.length ?? 0}\n${e.rows.slice(0, 8).map((row) => `      | ${row.map((c) => c.text).join(' | ')} |`).join('\n')}${e.rows.length > 8 ? `\n      …${e.rows.length - 8} more rows` : ''}`;
  if (e.type === 'chart') return `${head}${e.title ? ` "${e.title}"` : ''} labels [${e.labels.join(', ')}] ${e.series.map((s) => `${s.name}: [${s.values.join(', ')}]`).join('; ')}${e.highlight !== undefined ? ` highlight ${e.highlight}` : ''}`;
  if (e.type === 'line') return `${head} ${e.dir === 'up' ? 'bottom-left→top-right' : 'top-left→bottom-right'} ${e.stroke ?? '$text'} ${e.strokeW ?? 3}px${e.end === 'arrow' ? ' →' : ''}${e.start === 'arrow' ? ' ←' : ''}`;
  if (e.type === 'icon') return `${head} ${e.glyph}`;
  if (e.type === 'embed') return `${head} ${e.kind} ${e.url}${e.title ? ` "${e.title}"` : ''}`;
  return head;
}
/** The deck as compact text: setup, then every slide with its elements, animations, notes and comments. */
export function readDeck(deck: Deck, opts: { from?: number; to?: number } = {}): string {
  const from = Math.max(1, opts.from ?? 1), to = Math.min(deck.slides.length, opts.to ?? deck.slides.length);
  const lines = [summarizeDeck(deck), `Theme colours: ${THEME_COLOR_KEYS.map((k) => `$${k} ${deck.theme.colors[k]}`).join(' · ')}`, ''];
  for (let i = from; i <= to; i++) {
    const s = deck.slides[i - 1];
    const bg = s.background ? (s.background.type === 'color' ? `bg ${s.background.color}` : s.background.type === 'gradient' ? `bg gradient ${s.background.from}→${s.background.to}` : 'bg image') : '';
    lines.push(`[${i}] ${s.id} ${s.layout}${s.hidden ? ' SKIPPED' : ''}${bg ? ` ${bg}` : ''}${s.transition ? ` transition ${s.transition.type} ${s.transition.duration}s` : ''}`);
    for (const e of s.elements) lines.push(`    - ${elLine(e)}`);
    if (s.anims.length) lines.push(`    animations: ${s.anims.map((a) => `${a.id} ${a.effect} ${a.el} (${a.start}${a.delay ? ` +${a.delay}s` : ''})`).join(' → ')}`);
    if (s.notes.trim()) lines.push(`    notes: ${s.notes.trim().replace(/\n/g, ' ⏎ ')}`);
    for (const c of s.comments) lines.push(`    comment ${c.id}${c.resolved ? ' (resolved)' : ''} by ${c.author}${c.el ? ` on ${c.el}` : ''}: ${c.text}${c.replies.map((x) => `\n      ↳ ${x.author}: ${x.text}`).join('')}`);
  }
  if (to < deck.slides.length) lines.push(`[${deck.slides.length - to} more slides — read them with from/to]`);
  return lines.join('\n');
}

/* ---------------- review ---------------- */

/** Design and readability checks a careful presenter would run (one idea per slide, readable sizes, contrast, alt text…). */
export function reviewDeck(deck: Deck): string[] {
  const out: string[] = [];
  const titles = new Map<string, number[]>();
  deck.slides.forEach((s, i) => {
    const n = i + 1;
    const title = slideTitle(s);
    if (title) titles.set(title.toLowerCase(), [...(titles.get(title.toLowerCase()) ?? []), n]);
    if (!s.elements.length) { out.push(`slide ${n}: empty slide`); return; }
    if (!title && s.layout !== 'blank' && s.layout !== 'caption' && !s.hidden) out.push(`slide ${n}: no title — every slide should have a title (screen readers and the outline use it)`);
    const bg = backgroundColor(deck, s);
    let words = 0, bullets = 0;
    for (const e of s.elements) {
      const b = rotatedBounds(e);
      if (b.x + b.w < 1 || b.y + b.h < 1 || b.x > deck.size.w - 1 || b.y > deck.size.h - 1) out.push(`slide ${n}: ${e.id} is outside the slide`);
      else if (b.x < -2 || b.y < -2 || b.x + b.w > deck.size.w + 2 || b.y + b.h > deck.size.h + 2) { if (e.type !== 'shape' && e.type !== 'image') out.push(`slide ${n}: ${e.id} runs off the edge of the slide`); }
      if (e.type === 'image' && !e.alt) out.push(`slide ${n}: image ${e.id} has no alt text`);
      if (e.type === 'chart' && !e.title && !e.alt) out.push(`slide ${n}: chart ${e.id} has no title or alt text — say what it shows`);
      if (e.type === 'chart' && (e.chart === 'pie' || e.chart === 'doughnut') && (e.labels.length > 6)) out.push(`slide ${n}: pie chart ${e.id} has ${e.labels.length} slices — use a bar chart for more than 5–6 categories`);
      if (!hasText(e)) continue;
      const t = parasText(e.paras);
      if (!t.trim()) continue;
      if (!(e.type === 'text' && e.role === 'title')) words += wordCount(t);
      bullets += e.paras.filter((p) => p.list).length;
      const look = roleLook(deck.theme, e.type === 'text' ? e.role : undefined, s.layout);
      const scale = e.type === 'text' ? shrinkScale(e, look) : 1;
      const sizes = e.paras.flatMap((p) => p.runs.map((x) => (x.size ?? look.size) * scale));
      const min = Math.min(...sizes);
      if (min < 12) out.push(`slide ${n}: ${e.id} has ${Math.round(min)}pt text — too small to read from the back of a room (aim for 18pt or more)`);
      else if (min < 18 && !(e.type === 'text' && e.role === 'caption') && wordCount(t) > 4) out.push(`slide ${n}: ${e.id} has ${Math.round(min)}pt text${scale < 1 ? ' after shrinking to fit' : ''} — 18pt is the usual minimum; cut words or split the slide`);
      const behind = e.type === 'shape' ? resolveColor(deck.theme, e.fill ?? '$accent', bg) : e.type === 'text' && e.fill ? resolveColor(deck.theme, e.fill, bg) : bg;
      const fg = e.paras.flatMap((p) => p.runs).find((x) => x.color)?.color;
      const fgc = fg ? resolveColor(deck.theme, fg) : look.color;
      const ratio = contrast(fgc, behind);
      const large = min >= 24 || (min >= 18.5 && look.b);
      if (ratio !== null && ratio < (large ? 3 : 4.5)) out.push(`slide ${n}: ${e.id} text contrast is ${ratio.toFixed(1)}:1 on its background (needs ${large ? '3' : '4.5'}:1 or more)`);
    }
    if (words > 75) out.push(`slide ${n}: ${words} words — a slide is not a document; keep one idea per slide (move detail to the speaker notes or split it)`);
    else if (words > 50) out.push(`slide ${n}: ${words} words — consider fewer words (aim for under ~40)`);
    if (bullets > 6) out.push(`slide ${n}: ${bullets} bullet points — more than 6 is hard to follow; split the slide`);
    const texts = s.elements.filter((e) => hasText(e) && parasText(e.paras).trim() && e.type === 'text');
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      const A = rotatedBounds(texts[a]), B = rotatedBounds(texts[b]);
      const shrink = (x: typeof A) => ({ x: x.x + 6, y: x.y + 6, w: x.w - 12, h: x.h - 12 });
      if (intersects(shrink(A), shrink(B))) out.push(`slide ${n}: text boxes ${texts[a].id} and ${texts[b].id} overlap`);
    }
    if (s.anims.length > 8) out.push(`slide ${n}: ${s.anims.length} animations — use motion only to reveal points one at a time`);
  });
  for (const [t, ns] of titles) if (ns.length > 1 && t) out.push(`slides ${ns.join(', ')} share the title "${t}" — make titles unique (add "(2)" or say what is different)`);
  const fonts = fontsUsed(deck);
  if (fonts.length > 3) out.push(`the deck uses ${fonts.length} fonts (${fonts.join(', ')}) — stick to one or two`);
  if (deck.slides.length > 4 && deck.slides.filter((s) => s.notes.trim()).length === 0) out.push('no slide has speaker notes — add what you will say, so the slides can stay short');
  const trs = new Set(deck.slides.map((s) => s.transition?.type ?? 'none'));
  if (trs.size > 2) out.push(`the deck mixes ${trs.size} kinds of transitions — use one quiet transition throughout`);
  const unresolved = deck.slides.reduce((n, s) => n + s.comments.filter((c) => !c.resolved).length, 0);
  if (unresolved) out.push(`${unresolved} open comment(s)`);
  return out;
}
