/** PowerPoint (.pptx) and PDF writers. PPTX is PresentationML written by hand into a stored zip: slides with text boxes
 * (fonts, sizes, colours, bullets, numbering, alignment, links), shapes, lines with arrow heads, images, tables,
 * backgrounds, transitions, hidden slides and speaker notes; charts and SVG images come in as pictures the caller
 * rendered. The PDF writer wraps one JPEG picture per page. Pure TypeScript — node tests check the output. */
import { imageSize, zipStore } from '../docs/docsDocx.ts';
import {
  hasText, listNumbers, resolveColor, roleLook, shrinkScale, BULLETS,
  type Background, type Deck, type El, type ImageEl, type LineEl, type Para, type ShapeKind, type Slide, type TableEl, type TextEl, type ShapeEl, type Theme,
} from './slides.ts';

/* ---------------- helpers ---------------- */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const x = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const EMU = 9525;
const emu = (px: number): number => Math.round(px * EMU);
const enc = new TextEncoder();
function hex(theme: Theme, c: string | undefined, fallback = '000000'): string | null {
  const v = resolveColor(theme, c, '');
  if (!v || v === 'transparent') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) return (m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1]).toUpperCase();
  const r = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (r) return [r[1], r[2], r[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase();
  return fallback;
}
const solid = (h: string | null): string => (h ? `<a:solidFill><a:srgbClr val="${h}"/></a:solidFill>` : '<a:noFill/>');
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const dataUrlParts = (src: string): { mime: string; bytes: Uint8Array } | null => {
  const m = /^data:([a-z/+.-]+);base64,(.*)$/i.exec(src);
  return m ? { mime: m[1].toLowerCase(), bytes: fromBase64(m[2]) } : null;
};

const PRST: Record<ShapeKind, string> = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', rightTriangle: 'rtTriangle', diamond: 'diamond', pentagon: 'pentagon', hexagon: 'hexagon',
  octagon: 'octagon', star: 'star5', plus: 'plus', chevron: 'chevron', parallelogram: 'parallelogram', trapezoid: 'trapezoid', arrowRight: 'rightArrow', arrowLeft: 'leftArrow',
  arrowUp: 'upArrow', arrowDown: 'downArrow', arrowLeftRight: 'leftRightArrow', callout: 'wedgeRoundRectCallout', cloudCallout: 'cloudCallout', heart: 'heart', cloud: 'cloud',
};

interface Media { name: string; bytes: Uint8Array }
interface SlideCtx { rels: string[]; media: Media[]; nextId: number; deck: Deck; slide: Slide; rasters: Map<string, string> }
const relId = (cx: SlideCtx, type: string, target: string, external = false): string => {
  const id = `rId${cx.rels.length + 2}`;
  cx.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ''}/>`);
  return id;
};
let mediaCount = 0;
function addMedia(cx: SlideCtx, src: string): { rid: string; w: number; h: number } | null {
  const parts = dataUrlParts(src);
  if (!parts) return null;
  const ext = parts.mime === 'image/png' ? 'png' : parts.mime === 'image/jpeg' ? 'jpeg' : parts.mime === 'image/gif' ? 'gif' : null;
  if (!ext) return null;
  mediaCount += 1;
  const name = `image${mediaCount}.${ext}`;
  cx.media.push({ name, bytes: parts.bytes });
  const size = imageSize(parts.bytes);
  return { rid: relId(cx, 'image', `../media/${name}`), w: size?.w ?? 0, h: size?.h ?? 0 };
}
const xfrm = (e: { x: number; y: number; w: number; h: number; rot?: number }, extra = '', tag = 'a:xfrm'): string =>
  `<${tag}${e.rot ? ` rot="${Math.round((((e.rot % 360) + 360) % 360) * 60000)}"` : ''}${extra}><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(Math.max(1, e.w))}" cy="${emu(Math.max(1, e.h))}"/></${tag}>`;
const nvPr = (cx: SlideCtx, e: El, name: string): string => {
  const id = cx.nextId++;
  const link = e.link ? `<a:hlinkClick r:id="${relId(cx, 'hyperlink', e.link, true)}"/>` : '';
  return `<p:cNvPr id="${id}" name="${x(e.name ?? `${name} ${id}`)}"${e.alt ? ` descr="${x(e.alt)}"` : ''}>${link}</p:cNvPr>`;
};

/* ---------------- text ---------------- */

function parasXml(cx: SlideCtx, paras: Para[], look: { font: string; size: number; color: string; b: boolean; align: string }, scale = 1, defaultAlign?: string): string {
  const theme = cx.deck.theme;
  const nums = listNumbers(paras);
  return paras.map((p, i) => {
    const level = p.level ?? 0;
    const algn = ({ left: 'l', center: 'ctr', right: 'r', justify: 'just' } as Record<string, string>)[p.align ?? defaultAlign ?? look.align] ?? 'l';
    const bullet = p.list === 'bullet' ? `<a:buFont typeface="Arial"/><a:buChar char="${x(BULLETS[level] === '●' ? '•' : BULLETS[level])}"/>` : p.list === 'number' ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="${['arabicPeriod', 'alphaLcPeriod', 'romanLcPeriod', 'arabicPeriod', 'alphaLcPeriod'][level]}"${nums.get(i) && nums.get(i)! > 1 && (i === 0 || paras[i - 1].list !== 'number') ? ` startAt="${nums.get(i)}"` : ''}/>` : '<a:buNone/>';
    const marL = p.list ? emu(level * 0.5 * 96 + 0.3 * 96) : emu(level * 0.5 * 96);
    const indent = p.list ? ` indent="${-emu(0.3 * 96)}"` : '';
    const spacing = `${p.lh ? `<a:lnSpc><a:spcPct val="${Math.round(p.lh * 100000)}"/></a:lnSpc>` : ''}${p.sb ? `<a:spcBef><a:spcPts val="${Math.round(p.sb * 75)}"/></a:spcBef>` : ''}${p.sa ? `<a:spcAft><a:spcPts val="${Math.round(p.sa * 75)}"/></a:spcAft>` : ''}`;
    const pPr = `<a:pPr marL="${marL}"${indent}${level ? ` lvl="${level}"` : ''} algn="${algn}">${spacing}${bullet}</a:pPr>`;
    const size = (s: number | undefined) => Math.round((s ?? look.size) * scale * 100);
    const runs = p.runs.map((r) => {
      const color = hex(theme, r.color ?? look.color);
      const hl = r.hl ? hex(theme, r.hl) : null;
      const link = r.link ? `<a:hlinkClick r:id="${relId(cx, 'hyperlink', r.link, true)}"/>` : '';
      const b = r.b ?? look.b;
      return `<a:r><a:rPr lang="en-US" sz="${size(r.size)}"${b ? ' b="1"' : ' b="0"'}${r.i ? ' i="1"' : ''}${r.u ? ' u="sng"' : ''}${r.s ? ' strike="sngStrike"' : ''}${r.sup ? ' baseline="30000"' : r.sub ? ' baseline="-25000"' : ''} dirty="0">${solid(color)}${hl ? `<a:highlight><a:srgbClr val="${hl}"/></a:highlight>` : ''}<a:latin typeface="${x(r.font ?? look.font)}"/><a:cs typeface="${x(r.font ?? look.font)}"/>${link}</a:rPr><a:t>${x(r.t)}</a:t></a:r>`;
    }).join('');
    return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US" sz="${size(p.runs[p.runs.length - 1]?.size)}" dirty="0"/></a:p>`;
  }).join('');
}
function bodyPr(e: TextEl | ShapeEl, scale: number, pad: number): string {
  const anchor = ({ top: 't', middle: 'ctr', bottom: 'b' } as const)[e.valign ?? (e.type === 'shape' ? 'middle' : 'top')];
  const fit = e.type === 'text' ? (e.autofit === 'resize' ? '<a:spAutoFit/>' : e.autofit === 'shrink' ? `<a:normAutofit${scale < 1 ? ` fontScale="${Math.round(scale * 100000)}"` : ''}/>` : '<a:noAutofit/>') : '<a:noAutofit/>';
  const ins = emu(pad);
  return `<a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${anchor}" rtlCol="0">${fit}</a:bodyPr>`;
}

/* ---------------- elements ---------------- */

function spXml(cx: SlideCtx, e: TextEl | ShapeEl): string {
  const theme = cx.deck.theme;
  const look = roleLook(theme, e.type === 'text' ? e.role : undefined, cx.slide.layout);
  const empty = e.paras.every((p) => !p.runs.some((r) => r.t.trim()));
  if (e.type === 'text' && e.placeholder && empty) return '';
  const scale = e.type === 'text' ? shrinkScale(e, look) : 1;
  const geom = e.type === 'shape' ? PRST[e.shape] : 'rect';
  const fill = e.type === 'shape' ? solid(hex(theme, e.fill ?? '$accent')) : e.fill ? solid(hex(theme, e.fill)) : '<a:noFill/>';
  const sw = e.type === 'shape' ? e.strokeW ?? (e.stroke ? 2 : 0) : e.strokeW ?? (e.stroke ? 1 : 0);
  const ln = e.stroke && sw ? `<a:ln w="${emu(sw)}">${solid(hex(theme, e.stroke))}${e.type === 'shape' && e.dash ? '<a:prstDash val="dash"/>' : ''}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const effect = e.type === 'shape' && e.shadow ? '<a:effectLst><a:outerShdw blurRad="76200" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="30000"/></a:srgbClr></a:outerShdw></a:effectLst>' : '';
  const pad = e.type === 'text' ? e.pad ?? 8 : Math.max(6, Math.min(e.w, e.h) * 0.08);
  const text = empty ? '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>' : parasXml(cx, e.paras, look, scale, e.type === 'shape' ? 'center' : undefined);
  return `<p:sp><p:nvSpPr>${nvPr(cx, e, e.type === 'text' ? 'TextBox' : 'Shape')}<p:cNvSpPr${e.type === 'text' ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(e)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fill}${ln}${effect}</p:spPr><p:txBody>${bodyPr(e, scale, pad)}<a:lstStyle/>${text}</p:txBody></p:sp>`;
}
function lineXml(cx: SlideCtx, e: LineEl): string {
  const theme = cx.deck.theme;
  const head = (k: LineEl['start']) => (k === 'arrow' ? 'triangle' : k === 'dot' ? 'oval' : 'none');
  const ln = `<a:ln w="${emu(e.strokeW ?? 3)}" cap="rnd">${solid(hex(theme, e.stroke ?? '$text'))}${e.dash ? '<a:prstDash val="dash"/>' : ''}<a:headEnd type="${head(e.start)}"/><a:tailEnd type="${head(e.end)}"/></a:ln>`;
  return `<p:cxnSp><p:nvCxnSpPr>${nvPr(cx, e, 'Line')}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(e, e.dir === 'up' ? ' flipV="1"' : '')}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:cxnSp>`;
}
function picXml(cx: SlideCtx, e: El, src: string, fit: ImageEl['fit'] = 'contain'): string {
  const media = addMedia(cx, src);
  if (!media) return '';
  let box = { x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot };
  let crop = '';
  if (media.w && media.h && fit !== 'fill') {
    const ri = media.w / media.h, rb = e.w / e.h;
    if (fit === 'contain') {
      if (ri > rb) { const h = e.w / ri; box = { ...box, y: e.y + (e.h - h) / 2, h }; } else { const w = e.h * ri; box = { ...box, x: e.x + (e.w - w) / 2, w }; }
    } else if (Math.abs(ri - rb) > 0.001) {
      if (ri > rb) { const c = Math.round(((1 - rb / ri) / 2) * 100000); crop = `<a:srcRect l="${c}" r="${c}"/>`; } else { const c = Math.round(((1 - ri / rb) / 2) * 100000); crop = `<a:srcRect t="${c}" b="${c}"/>`; }
    }
  }
  const geom = e.type === 'image' && e.radius ? 'roundRect' : 'rect';
  return `<p:pic><p:nvPicPr>${nvPr(cx, e, 'Picture')}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${media.rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(box)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
function tableXml(cx: SlideCtx, e: TableEl): string {
  const theme = cx.deck.theme;
  const cols = Math.max(1, e.rows[0]?.length ?? 1);
  const colW = Math.floor(emu(e.w) / cols);
  const rowH = Math.floor(emu(e.h) / Math.max(1, e.rows.length));
  const border = hex(theme, e.border ?? '$muted');
  const lnx = (tag: string) => `<a:${tag} w="12700">${solid(border)}</a:${tag}>`;
  const rows = e.rows.map((r, ri) => `<a:tr h="${rowH}">${r.map((c) => {
    const head = e.header !== false && ri === 0;
    const bg = c.fill ? hex(theme, c.fill) : head ? hex(theme, e.headerFill ?? '$accent') : e.band && ri % 2 === 0 ? hex(theme, '$surface') : null;
    const fg = c.color ? c.color : head ? '#ffffff' : '$text';
    const look = { font: theme.fonts.body, size: e.size ?? 14, color: fg, b: !!(c.b || head), align: c.align ?? 'left' };
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${parasXml(cx, [{ runs: c.text ? [{ t: c.text }] : [], align: c.align }], look)}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${lnx('lnL')}${lnx('lnR')}${lnx('lnT')}${lnx('lnB')}${bg ? solid(bg) : '<a:noFill/>'}</a:tcPr></a:tc>`;
  }).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr>${nvPr(cx, e, 'Table')}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm({ ...e, rot: undefined }, '', 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${e.header !== false ? 1 : 0}" bandRow="${e.band ? 1 : 0}"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function textBox(cx: SlideCtx, e: El, md: string, opts: Partial<TextEl> = {}): string {
  const el: TextEl = { id: e.id, type: 'text', x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, link: e.link, name: e.name, alt: e.alt, paras: md.split('\n').map((t) => ({ runs: [{ t }] })), valign: 'middle', ...opts };
  return spXml(cx, el);
}
function elXml(cx: SlideCtx, e: El): string {
  const theme = cx.deck.theme;
  switch (e.type) {
    case 'text': case 'shape': return spXml(cx, e);
    case 'line': return lineXml(cx, e);
    case 'image': { const r = cx.rasters.get(e.id) ?? e.src; return picXml(cx, e, r, e.fit ?? 'cover') || textBox(cx, e, e.alt ?? 'Image', { fill: '$surface' }); }
    case 'table': return tableXml(cx, e);
    case 'chart': { const r = cx.rasters.get(e.id); return r ? picXml(cx, { ...e, alt: e.alt ?? e.title }, r, 'fill') : textBox(cx, e, `${e.title ?? 'Chart'}\n${e.labels.map((l, i) => `${l}: ${e.series.map((s) => s.values[i] ?? '').join(' / ')}`).join('\n')}`, { fill: '$surface' }); }
    case 'icon': return textBox(cx, e, e.glyph, { paras: [{ runs: [{ t: e.glyph, size: Math.round(Math.min(e.w, e.h) * 0.6), ...(e.color ? { color: e.color } : {}) }], align: 'center' }], pad: 0 });
    case 'embed': {
      const shape: ShapeEl = { id: e.id, type: 'shape', shape: 'roundRect', x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, name: e.name, alt: e.alt, link: e.url || e.link, fill: theme.colors.surface, stroke: theme.colors.muted, strokeW: 1, paras: [{ runs: [{ t: `${e.kind === 'video' ? '▶ ' : '🔗 '}${e.title || (e.kind === 'video' ? 'Video' : 'Link')}`, b: true, color: '$text', size: 18 }] }, { runs: [{ t: e.url, color: '$muted', size: 12 }] }] };
      return spXml(cx, shape);
    }
  }
}
function bgXml(cx: SlideCtx, bg: Background | undefined): string {
  const theme = cx.deck.theme;
  if (!bg) return `<p:bg><p:bgPr>${solid(hex(theme, theme.colors.background))}<a:effectLst/></p:bgPr></p:bg>`;
  if (bg.type === 'color') return `<p:bg><p:bgPr>${solid(hex(theme, bg.color))}<a:effectLst/></p:bgPr></p:bg>`;
  if (bg.type === 'gradient') {
    const ang = ((((bg.angle ?? 180) - 90) % 360) + 360) % 360;
    return `<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${hex(theme, bg.from)}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${hex(theme, bg.to)}"/></a:gs></a:gsLst><a:lin ang="${Math.round(ang * 60000)}" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  const media = addMedia(cx, bg.src);
  return media ? `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${media.rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>` : bgXml(cx, undefined);
}
function transitionXml(s: Slide): string {
  const t = s.transition;
  if (!t || t.type === 'none') return '';
  const spd = t.duration < 0.5 ? 'fast' : t.duration < 1 ? 'med' : 'slow';
  const body = t.type === 'fade' ? '<p:fade/>' : t.type === 'slide-left' ? '<p:push dir="l"/>' : t.type === 'slide-right' ? '<p:push dir="r"/>' : t.type === 'slide-up' ? '<p:push dir="u"/>' : t.type === 'zoom' ? '<p:zoom/>' : '<p:fade/>';
  return `<p:transition spd="${spd}">${body}</p:transition>`;
}
const GROUP_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function themeXml(theme: Theme, name = 'Pigry'): string {
  const c = (v: string) => `<a:srgbClr val="${hex(theme, v) ?? '000000'}"/>`;
  const t = theme.colors;
  const fill3 = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln3 = '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${x(name)}"><a:themeElements><a:clrScheme name="${x(theme.name)}"><a:dk1>${c(t.title)}</a:dk1><a:lt1>${c(t.background)}</a:lt1><a:dk2>${c(t.text)}</a:dk2><a:lt2>${c(t.surface)}</a:lt2><a:accent1>${c(t.accent)}</a:accent1><a:accent2>${c(t.accent2)}</a:accent2><a:accent3>${c(t.accent3)}</a:accent3><a:accent4>${c(t.accent4)}</a:accent4><a:accent5>${c(t.muted)}</a:accent5><a:accent6>${c(t.text)}</a:accent6><a:hlink>${c(t.accent)}</a:hlink><a:folHlink>${c(t.muted)}</a:folHlink></a:clrScheme>`
    + `<a:fontScheme name="${x(theme.name)}"><a:majorFont><a:latin typeface="${x(theme.fonts.title)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${x(theme.fonts.body)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="Pigry"><a:fillStyleLst>${fill3}</a:fillStyleLst><a:lnStyleLst>${ln3}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

/** The presentation as a .pptx file. rasters: PNG data URLs (by element id) for charts and SVG images. */
export function pptxBytes(deck: Deck, opts: { rasters?: Map<string, string> } = {}): Uint8Array {
  mediaCount = 0;
  const rasters = opts.rasters ?? new Map<string, string>();
  const files: { name: string; data: Uint8Array }[] = [];
  const put = (name: string, text: string) => files.push({ name, data: enc.encode(text) });
  const W = emu(deck.size.w), H = emu(deck.size.h);
  const media: Media[] = [];
  const slideNames: string[] = [];
  const noteNames: string[] = [];
  deck.slides.forEach((s, i) => {
    const n = i + 1;
    const cx: SlideCtx = { rels: [], media, nextId: 2, deck, slide: s, rasters };
    const bg = bgXml(cx, s.background);
    const body = s.elements.map((e) => elXml(cx, e)).join('');
    const notesRel = s.notes.trim() ? relId(cx, 'notesSlide', `../notesSlides/notesSlide${n}.xml`) : '';
    void notesRel;
    put(`ppt/slides/slide${n}.xml`, `${XML}<p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld>${bg}<p:spTree>${GROUP_HEAD}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(s)}</p:sld>`);
    put(`ppt/slides/_rels/slide${n}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${cx.rels.join('')}</Relationships>`);
    slideNames.push(`slide${n}.xml`);
    if (s.notes.trim()) {
      const paras = s.notes.split('\n').map((l) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${x(l)}</a:t></a:r></a:p>`).join('');
      put(`ppt/notesSlides/notesSlide${n}.xml`, `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GROUP_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${n}.xml"/></Relationships>`);
      noteNames.push(`notesSlide${n}.xml`);
    }
  });
  for (const m of media) files.push({ name: `ppt/media/${m.name}`, data: m.bytes });
  const exts = new Set(media.map((m) => m.name.slice(m.name.lastIndexOf('.') + 1)));
  put('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')}`
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
    + '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
    + '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'
    + slideNames.map((n) => `<Override PartName="/ppt/slides/${n}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
    + noteNames.map((n) => `<Override PartName="/ppt/notesSlides/${n}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  put('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  put('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(deck.title)}</dc:title><dc:creator>Pigry</dc:creator></cp:coreProperties>`);
  put('docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Pigry Slides</Application><Slides>${deck.slides.length}</Slides><Notes>${noteNames.length}</Notes><HiddenSlides>${deck.slides.filter((s) => s.hidden).length}</HiddenSlides></Properties>`);
  const presRels = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`, `<Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="rId3" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`, `<Relationship Id="rId4" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="rId5" Type="${REL}/viewProps" Target="viewProps.xml"/>`, `<Relationship Id="rId6" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
    ...slideNames.map((n, i) => `<Relationship Id="rId${i + 10}" Type="${REL}/slide" Target="slides/${n}"/>`)];
  put('ppt/_rels/presentation.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join('')}</Relationships>`);
  put('ppt/presentation.xml', `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst><p:sldIdLst>${slideNames.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  put('ppt/presProps.xml', `${XML}<p:presentationPr ${NS}/>`);
  put('ppt/viewProps.xml', `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put('ppt/tableStyles.xml', `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  const lvl = (sz: number, font: string) => `<a:lvl1pPr><a:defRPr sz="${sz}"><a:latin typeface="${x(font)}"/></a:defRPr></a:lvl1pPr>`;
  put('ppt/slideMasters/slideMaster1.xml', `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_HEAD}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${lvl(3600, deck.theme.fonts.title)}</p:titleStyle><p:bodyStyle>${lvl(1800, deck.theme.fonts.body)}</p:bodyStyle><p:otherStyle>${lvl(1800, deck.theme.fonts.body)}</p:otherStyle></p:txStyles></p:sldMaster>`);
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`);
  put('ppt/slideLayouts/slideLayout1.xml', `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_HEAD}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  put('ppt/notesMasters/notesMaster1.xml', `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${lvl(1200, deck.theme.fonts.body)}</p:notesStyle></p:notesMaster>`);
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`);
  put('ppt/theme/theme1.xml', themeXml(deck.theme));
  put('ppt/theme/theme2.xml', themeXml(deck.theme, 'Notes'));
  // [Content_Types].xml first, as Office expects.
  files.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  return zipStore(files);
}

/** Elements the caller should render to PNG before pptxBytes (charts and SVG images). */
export const needsRaster = (e: El): boolean => e.type === 'chart' || (e.type === 'image' && /^data:image\/(svg\+xml|webp)/i.test(e.src));
export const textOfEl = (e: El): string => (hasText(e) ? e.paras.map((p) => p.runs.map((r) => r.t).join('')).join('\n') : '');

/* ---------------- PDF ---------------- */

/** A PDF with one JPEG picture per page (pages in points; 0.75 pt per CSS pixel). */
export function pdfFromJpegs(pages: { jpeg: Uint8Array; w: number; h: number }[], pageW: number, pageH: number, title = 'Presentation'): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array) => { chunks.push(b); size += b.length; };
  const str = (s: string) => push(enc.encode(s));
  const obj = (n: number, body: () => void) => { offsets[n] = size; str(`${n} 0 obj\n`); body(); str('\nendobj\n'); };
  str('%PDF-1.4\n%âãÏÓ\n');
  const n = pages.length;
  // 1 catalog, 2 pages, 3 info, then per page: page, image, content
  const pageObj = (i: number) => 4 + i * 3;
  obj(1, () => str('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => str(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1');
  obj(3, () => str(`<< /Title (${safeTitle}) /Producer (Pigry Slides) >>`));
  pages.forEach((p, i) => {
    const po = pageObj(i), io = po + 1, co = po + 2;
    obj(po, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im${i} ${io} 0 R >> >> /Contents ${co} 0 R >>`));
    obj(io, () => { str(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`); push(p.jpeg); str('\nendstream'); });
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im${i} Do Q`;
    obj(co, () => str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });
  const total = 4 + n * 3;
  const xref = size;
  str(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) str(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`);
  str(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
