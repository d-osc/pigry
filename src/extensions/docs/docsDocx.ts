/** Word (.docx) export: WordprocessingML written by hand into a small zip (stored, no compression). Keeps paragraph
 * styles, inline formatting, links, lists, tables with merged cells and shading, images, footnotes, comments,
 * suggested edits as Word tracked changes, header / footer with page numbers, page size and margins.
 * Pure TypeScript — node tests check the output. */
import { STYLE_LOOK, docListLabels, isTextRun, outline, pageInches, textBlocks, type Block, type Doc, type Para, type ParaStyle, type Run, type Table } from './docs.ts';
import { eqToText } from './docsFormat.ts';

/* ---------------- zip ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A zip archive with the files stored as they are. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, f.data.length, true); v.setUint32(22, f.data.length, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
    w.setUint16(12, 0, true); w.setUint16(14, 0x21, true); w.setUint32(16, crc, true); w.setUint32(20, f.data.length, true); w.setUint32(24, f.data.length, true);
    w.setUint16(28, name.length, true); w.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
/** File names in a zip (read from the central directory). */
export function unzipNames(bytes: Uint8Array): string[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count && v.getUint32(p, true) === 0x02014b50; i++) {
    const n = v.getUint16(p + 28, true), x = v.getUint16(p + 30, true), c = v.getUint16(p + 32, true);
    names.push(dec.decode(bytes.subarray(p + 46, p + 46 + n)));
    p += 46 + n + x + c;
  }
  return names;
}

/* ---------------- helpers ---------------- */

const x = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const hex = (c: string): string => { const h = c.replace('#', ''); return (h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h.slice(0, 6)).toUpperCase(); };
const twips = (inches: number): number => Math.round(inches * 1440);
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLE_ID: Record<ParaStyle, string> = { normal: 'Normal', title: 'Title', subtitle: 'Subtitle', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', h4: 'Heading4', h5: 'Heading5', h6: 'Heading6' };

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Pixel size of a PNG, GIF or JPEG. */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const marker = bytes[p + 1];
      const len = v.getUint16(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: v.getUint16(p + 5), w: v.getUint16(p + 7) };
      p += 2 + len;
    }
  }
  return null;
}

/* ---------------- document ---------------- */

interface Ctx {
  doc: Doc;
  rels: { id: string; type: string; target: string; external?: boolean }[];
  media: { name: string; data: Uint8Array }[];
  rev: number;
  drawing: number;
  fnIds: Map<string, number>;
  commentIds: Map<string, number>;
  firstRun: Map<string, Run>;
  lastRun: Map<string, Run>;
  numFor: Map<Para, { numId: number; ilvl: number }>;
  nums: { numId: number; abstract: number; restart: boolean }[];
  labels: Map<Para, string>;
  contentWidthPx: number;
}
const rel = (cx: Ctx, type: string, target: string, external = false): string => {
  const found = cx.rels.find((r) => r.type === type && r.target === target);
  if (found) return found.id;
  const id = `rId${cx.rels.length + 1}`;
  cx.rels.push({ id, type, target, external });
  return id;
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function rPr(r: Run, extra = ''): string {
  const p: string[] = [];
  if (extra) p.push(extra);
  if (r.font) p.push(`<w:rFonts w:ascii="${x(r.font)}" w:hAnsi="${x(r.font)}" w:cs="${x(r.font)}"/>`);
  else if (r.code) p.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
  if (r.b) p.push('<w:b/>');
  if (r.i || 'eq' in r) p.push('<w:i/>');
  if (r.s) p.push('<w:strike/>');
  if (r.color) p.push(`<w:color w:val="${hex(r.color)}"/>`);
  if (r.size) p.push(`<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`);
  if (r.u) p.push('<w:u w:val="single"/>');
  if (r.bg) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex(r.bg)}"/>`);
  if (r.sup) p.push('<w:vertAlign w:val="superscript"/>');
  else if (r.sub) p.push('<w:vertAlign w:val="subscript"/>');
  return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
}
function textRuns(text: string, props: string, del: boolean): string {
  const tag = del ? 'w:delText' : 'w:t';
  return text.split('\n').map((line, i) => `${i ? `<w:r>${props}<w:br/></w:r>` : ''}${line ? `<w:r>${props}<${tag} xml:space="preserve">${x(line)}</${tag}></w:r>` : ''}`).join('');
}
function imageXml(cx: Ctx, r: Extract<Run, { img: string }>): string {
  const m = /^data:image\/(png|jpe?g|gif);base64,(.*)$/i.exec(r.img);
  if (!m) return `<w:r><w:t xml:space="preserve">[${x(r.alt || 'image')}]</w:t></w:r>`;
  const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
  const data = fromBase64(m[2]);
  const name = `image${cx.media.length + 1}.${ext === 'jpeg' ? 'jpeg' : ext}`;
  cx.media.push({ name: `word/media/${name}`, data });
  const rid = rel(cx, `${REL}/image`, `media/${name}`);
  const natural = imageSize(data) ?? { w: 300, h: 200 };
  let w = r.w ?? natural.w, h = r.h ?? (r.w ? Math.round((r.w * natural.h) / Math.max(1, natural.w)) : natural.h);
  if (w > cx.contentWidthPx) { h = Math.round((h * cx.contentWidthPx) / w); w = cx.contentWidthPx; }
  const cxEmu = w * 9525, cyEmu = h * 9525, id = ++cx.drawing;
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cxEmu}" cy="${cyEmu}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${x(r.alt ?? '')}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cxEmu}" cy="${cyEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
function runXml(cx: Ctx, r: Run): string {
  const del = !!r.del;
  let body: string;
  if (isTextRun(r)) body = textRuns(r.t, rPr(r, r.link && !r.link.startsWith('#') ? '<w:rStyle w:val="Hyperlink"/>' : ''), del);
  else if ('img' in r) body = imageXml(cx, r);
  else if ('fn' in r) body = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${cx.fnIds.get(r.fn) ?? 1}"/></w:r>`;
  else body = textRuns(eqToText(r.eq), rPr({ ...r, font: r.font ?? 'Cambria Math' }), del);
  if (r.link && !r.link.startsWith('#') && isTextRun(r)) body = `<w:hyperlink r:id="${rel(cx, `${REL}/hyperlink`, r.link, true)}" w:history="1">${body}</w:hyperlink>`;
  const s = r.ins ?? r.del;
  if (s) {
    const meta = cx.doc.suggestions.find((m) => m.id === s);
    const attrs = `w:id="${++cx.rev}" w:author="${x(meta?.author ?? 'user')}"${meta?.at ? ` w:date="${x(meta.at.replace(/\.\d+Z$/, 'Z'))}"` : ''}`;
    body = r.ins ? `<w:ins ${attrs}>${body}</w:ins>` : `<w:del ${attrs}>${body}</w:del>`;
  }
  let before = '', after = '';
  for (const id of r.c ?? []) {
    const n = cx.commentIds.get(id);
    if (n === undefined) continue;
    if (cx.firstRun.get(id) === r) before += `<w:commentRangeStart w:id="${n}"/>`;
    if (cx.lastRun.get(id) === r) after += `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`;
  }
  return before + body + after;
}
function paraXml(cx: Ctx, p: Para, extraPPr = ''): string {
  const ppr: string[] = [];
  const style = p.style ?? 'normal';
  if (style !== 'normal') ppr.push(`<w:pStyle w:val="${STYLE_ID[style]}"/>`);
  const num = cx.numFor.get(p);
  if (num) ppr.push(`<w:numPr><w:ilvl w:val="${num.ilvl}"/><w:numId w:val="${num.numId}"/></w:numPr>`);
  if (extraPPr) ppr.push(extraPPr);
  const sp: string[] = [];
  if (p.sb !== undefined) sp.push(`w:before="${Math.round(p.sb * 20)}"`);
  if (p.sa !== undefined) sp.push(`w:after="${Math.round(p.sa * 20)}"`);
  if (p.lh) sp.push(`w:line="${Math.round(p.lh * 240)}" w:lineRule="auto"`);
  if (sp.length) ppr.push(`<w:spacing ${sp.join(' ')}/>`);
  if (p.list === 'check') ppr.push(`<w:ind w:left="${720 + (p.lvl ?? 0) * 720}" w:hanging="360"/>`);
  else if (p.ind && !p.list) ppr.push(`<w:ind w:left="${p.ind * 720}"/>`);
  if (p.align && p.align !== 'left') ppr.push(`<w:jc w:val="${p.align === 'justify' ? 'both' : p.align}"/>`);
  const check = p.list === 'check' ? `<w:r><w:t xml:space="preserve">${p.checked ? '☑' : '☐'} </w:t></w:r>` : '';
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${check}${p.runs.map((r) => runXml(cx, r)).join('')}</w:p>`;
}
function tableXml(cx: Ctx, t: Table): string {
  const C = t.rows[0].length;
  const contentTw = Math.round(cx.contentWidthPx * 15);
  const total = (t.widths ?? []).reduce((a, b) => a + b, 0);
  const cols = Array.from({ length: C }, (_, c) => Math.round(t.widths && total > 0 ? (contentTw * t.widths[c]) / total : contentTw / C));
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const rows = t.rows.map((row, r) => {
    const cells: string[] = [];
    for (let c = 0; c < C; c++) {
      const cell = row[c];
      if (cell.hidden) {
        // A cell under a vertical merge is written once (with vMerge) at the merge's left column.
        let anchor: { r: number; c: number } | null = null;
        for (let i = r - 1; i >= 0 && !anchor; i--) { const a = t.rows[i][c]; if (!a.hidden && i + (a.rs ?? 1) > r) anchor = { r: i, c }; }
        if (!anchor) continue;
        const a = t.rows[anchor.r][anchor.c];
        const span = a.cs ?? 1;
        const w = cols.slice(c, c + span).reduce((n, v) => n + v, 0);
        cells.push(`<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}<w:vMerge/>${a.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(a.bg)}"/>` : ''}</w:tcPr><w:p/></w:tc>`);
        continue;
      }
      const span = cell.cs ?? 1;
      const w = cols.slice(c, c + span).reduce((n, v) => n + v, 0);
      const pr = `<w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${(cell.rs ?? 1) > 1 ? '<w:vMerge w:val="restart"/>' : ''}${cell.bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(cell.bg)}"/>` : ''}`;
      cells.push(`<w:tc><w:tcPr>${pr}</w:tcPr>${cell.paras.map((p) => paraXml(cx, p)).join('') || '<w:p/>'}</w:tc>`);
    }
    return `<w:tr>${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${contentTw}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}
function blockXml(cx: Ctx, b: Block): string {
  if (b.type === 'p') return paraXml(cx, b);
  if (b.type === 'table') return tableXml(cx, b) + '<w:p/>';
  if (b.type === 'hr') return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
  if (b.type === 'pagebreak') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const items = outline(cx.doc).filter((o) => o.level > 0);
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Table of contents</w:t></w:r></w:p>${items.map((o) => `<w:p><w:pPr><w:ind w:left="${(o.level - 1) * 360}"/></w:pPr><w:r><w:t xml:space="preserve">${x(o.text)}</w:t></w:r></w:p>`).join('')}`;
}
function fieldRuns(text: string, doc: Doc): string {
  const field = (instr: string, shown: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${shown}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  return text.split(/(\{(?:page|pages|title|date)\})/i).map((part) => {
    const k = /^\{(page|pages|title|date)\}$/i.exec(part)?.[1].toLowerCase();
    if (k === 'page') return field('PAGE', '1');
    if (k === 'pages') return field('NUMPAGES', '1');
    if (k === 'date') return field('DATE \\@ "yyyy-MM-dd"', '');
    const t = k === 'title' ? doc.title : part;
    return t ? `<w:r><w:t xml:space="preserve">${x(t)}</w:t></w:r>` : '';
  }).join('');
}

/** Assigns Word list numbering: one bullet definition, and a restarting numbered definition per list. */
function numbering(cx: Ctx): string {
  let current: { numId: number } | null = null;
  const walk = (paras: Para[]) => {
    current = null;
    for (const p of paras) {
      if (!p.list || p.list === 'check') { if (!p.list) current = null; continue; }
      if (p.list === 'bullet') { cx.numFor.set(p, { numId: 1, ilvl: Math.min(p.lvl ?? 0, 8) }); continue; }
      if (!current) { current = { numId: cx.nums.length + 2 }; cx.nums.push({ numId: current.numId, abstract: 2, restart: true }); }
      cx.numFor.set(p, { numId: current.numId, ilvl: Math.min(p.lvl ?? 0, 8) });
    }
  };
  const body: Para[] = [];
  for (const b of cx.doc.blocks) {
    if (b.type === 'p') { body.push(b); continue; }
    walk(body); body.length = 0;
    if (b.type === 'table') for (const row of b.rows) for (const cell of row) walk(cell.paras);
  }
  walk(body);
  const bullets = ['●', '○', '■'];
  const lvl = (i: number, fmt: string, text: string, font?: string) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 720}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : ''}</w:lvl>`;
  const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  return `${XML}<w:numbering ${W_NS}>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, 'bullet', bullets[i % 3], 'Arial')).join('')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, fmts[i % 3], `%${i + 1}.`)).join('')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>'
    + cx.nums.map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
}
function stylesXml(doc: Doc): string {
  const font = x(doc.font.family);
  const para = (id: string, name: string, s: ParaStyle, outlineLvl?: number) => {
    const look = STYLE_LOOK[s];
    return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${look.sb * 20}" w:after="${look.sa * 20}"/>${outlineLvl !== undefined ? `<w:outlineLvl w:val="${outlineLvl}"/>` : ''}</w:pPr><w:rPr>${look.bold || s === 'h4' || s === 'h5' ? '<w:b/>' : ''}${look.italic ? '<w:i/>' : ''}${look.color ? `<w:color w:val="${hex(look.color)}"/>` : ''}<w:sz w:val="${look.size * 2}"/><w:szCs w:val="${look.size * 2}"/></w:rPr></w:style>`;
  };
  return `${XML}<w:styles ${W_NS}>`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${doc.font.size * 2}"/><w:szCs w:val="${doc.font.size * 2}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + para('Title', 'Title', 'title') + para('Subtitle', 'Subtitle', 'subtitle')
    + [1, 2, 3, 4, 5, 6].map((n) => para(`Heading${n}`, `heading ${n}`, `h${n}` as ParaStyle, n - 1)).join('')
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>'
    + '</w:styles>';
}

/** The .docx file of a document. */
export function docxBytes(doc: Doc): Uint8Array {
  const { w, h } = pageInches(doc.page);
  const m = doc.page.margins;
  const cx: Ctx = {
    doc, rels: [], media: [], rev: 0, drawing: 0, fnIds: new Map(), commentIds: new Map(), firstRun: new Map(), lastRun: new Map(),
    numFor: new Map(), nums: [], labels: docListLabels(doc), contentWidthPx: Math.max(100, Math.round((w - m.left - m.right) * 96)),
  };
  rel(cx, `${REL}/styles`, 'styles.xml');
  rel(cx, `${REL}/settings`, 'settings.xml');
  rel(cx, `${REL}/numbering`, 'numbering.xml');
  rel(cx, `${REL}/footnotes`, 'footnotes.xml');
  rel(cx, `${REL}/comments`, 'comments.xml');
  let fn = 0;
  for (const { para } of textBlocks(doc)) for (const r of para.runs) {
    if ('fn' in r && !cx.fnIds.has(r.fn)) cx.fnIds.set(r.fn, ++fn);
    for (const id of r.c ?? []) { if (!cx.firstRun.has(id)) cx.firstRun.set(id, r); cx.lastRun.set(id, r); }
  }
  doc.comments.forEach((c, i) => { if (cx.firstRun.has(c.id)) cx.commentIds.set(c.id, i); });
  const numberingXml = numbering(cx);
  const body = doc.blocks.map((b) => blockXml(cx, b)).join('');
  const headerId = doc.header ? rel(cx, `${REL}/header`, 'header1.xml') : '';
  const footerId = doc.footer ? rel(cx, `${REL}/footer`, 'footer1.xml') : '';
  const landscape = doc.page.orientation === 'landscape';
  const sect = `<w:sectPr>${headerId ? `<w:headerReference w:type="default" r:id="${headerId}"/>` : ''}${footerId ? `<w:footerReference w:type="default" r:id="${footerId}"/>` : ''}<w:pgSz w:w="${twips(w)}" w:h="${twips(h)}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.right)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.left)}" w:header="720" w:footer="720" w:gutter="0"/>${doc.firstPageDifferent ? '<w:titlePg/>' : ''}</w:sectPr>`;
  const documentXml = `${XML}<w:document ${W_NS}><w:body>${body}${sect}</w:body></w:document>`;
  const notes = doc.footnotes.filter((f) => cx.fnIds.has(f.id)).sort((a, b) => (cx.fnIds.get(a.id) ?? 0) - (cx.fnIds.get(b.id) ?? 0));
  const footnotesXml = `${XML}<w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes.map((f) => `<w:footnote w:id="${cx.fnIds.get(f.id)}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${x(f.text)}</w:t></w:r></w:p></w:footnote>`).join('')}</w:footnotes>`;
  const initials = (a: string) => a.split(/[\s._-]+/).map((s) => s[0] ?? '').join('').slice(0, 3).toUpperCase() || 'U';
  const commentsXml = `${XML}<w:comments ${W_NS}>${doc.comments.filter((c) => cx.commentIds.has(c.id)).map((c) => `<w:comment w:id="${cx.commentIds.get(c.id)}" w:author="${x(c.author)}"${c.at ? ` w:date="${x(c.at.replace(/\.\d+Z$/, 'Z'))}"` : ''} w:initials="${x(initials(c.author))}"><w:p><w:r><w:t xml:space="preserve">${x(c.text)}${c.resolved ? ' (resolved)' : ''}</w:t></w:r></w:p>${c.replies.map((r) => `<w:p><w:r><w:t xml:space="preserve">${x(`${r.author}: ${r.text}`)}</w:t></w:r></w:p>`).join('')}</w:comment>`).join('')}</w:comments>`;
  const hf = (tag: 'hdr' | 'ftr', v: NonNullable<Doc['header']>) => `${XML}<w:${tag} ${W_NS}><w:p><w:pPr>${v.align && v.align !== 'left' ? `<w:jc w:val="${v.align === 'justify' ? 'both' : v.align}"/>` : ''}</w:pPr>${fieldRuns(v.text, doc)}</w:p></w:${tag}>`;
  const settingsXml = `${XML}<w:settings ${W_NS}><w:defaultTabStop w:val="720"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const exts = new Set(cx.media.map((f) => f.name.slice(f.name.lastIndexOf('.') + 1)));
  const contentTypes = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')}`
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
    + '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    + (doc.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '')
    + (doc.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rootRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${cx.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${x(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const core = `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(doc.title)}</dc:title><dc:creator>Pigry Docs</dc:creator></cp:coreProperties>`;
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'docProps/core.xml', data: enc.encode(core) },
    { name: 'word/document.xml', data: enc.encode(documentXml) },
    { name: 'word/styles.xml', data: enc.encode(stylesXml(doc)) },
    { name: 'word/settings.xml', data: enc.encode(settingsXml) },
    { name: 'word/numbering.xml', data: enc.encode(numberingXml) },
    { name: 'word/footnotes.xml', data: enc.encode(footnotesXml) },
    { name: 'word/comments.xml', data: enc.encode(commentsXml) },
    ...(doc.header ? [{ name: 'word/header1.xml', data: enc.encode(hf('hdr', doc.header)) }] : []),
    ...(doc.footer ? [{ name: 'word/footer1.xml', data: enc.encode(hf('ftr', doc.footer)) }] : []),
    { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) },
    ...cx.media,
  ];
  return zipStore(files);
}
