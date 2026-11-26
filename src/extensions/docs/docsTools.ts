/** Agent tools for the Docs menu. Documents are plain files (.pigry/docs/<owner>/<name>.doc.json, one folder per
 * agent). The tools create them (blank, from a template, from Markdown / HTML / text or by importing a file), apply
 * editing operations (all-or-nothing, with a log), read them compactly with a writing review, show a picture of
 * the pages, export Markdown / HTML / text / Word, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { readBinaryFile, readWorktreeFile, writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { DOCS_DIR, DOCS_EXT, emptyDoc, emptyPara, newId, outline, type Doc } from './docs';
import { TEMPLATES, docToHtml, docToMarkdown, docToText, markdownToDoc, templateDoc, textToBlocks, type TemplateId } from './docsFormat';
import { OP_HELP, applyOps, parseOps, readDoc, reviewDoc, summarizeDoc, type Op } from './docsOps';
import { docxBytes } from './docsDocx';
import { htmlToBlocks } from './docsDom';
import { renderPages } from './docsRender';
import { docsPath, flushDocsEditors, listDocRefs, loadDoc, requestOpenDoc, resolveDocRef, saveDoc } from './docsStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.doc ?? input.document ?? '').trim();
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const callerOf = (input: Record<string, unknown>): string => ownerSlug(agentOf(input) ?? 'agent');
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };
const nowIso = (): string => new Date().toISOString();
const today = (): string => new Date().toISOString().slice(0, 10);

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; doc: Doc; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see docs_list)');
  await flushDocsEditors();
  const resolved = await resolveDocRef(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see docs_list)`);
  try {
    const { doc, warnings } = await loadDoc(resolved.ref);
    return { ref: resolved.ref, doc, warnings };
  } catch (error) {
    return fail(`could not read document "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${DOCS_DIR}exports/report${exts[0]}` };
  }
  return { path };
}
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const safePath = (p: string): string | null => { const x = p.replace(/\\/g, '/').trim(); return !x || x.split('/').includes('..') || /^[A-Za-z]:/.test(x) || x.startsWith('/') ? null : x; };

/** A workspace image → data URL (for image ops). */
async function imageDataUrl(path: string): Promise<string> {
  const p = safePath(path);
  if (!p) throw new Error('image path must be inside the workspace');
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error('images must be .png, .jpg, .gif, .webp or .svg');
  const file = await readBinaryFile(p);
  return `data:${mime};base64,${file.data}`;
}
/** Resolves `path:` on image ops into `src:` data URLs. */
async function resolveImages(ops: Op[]): Promise<Op[] | string> {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === 'image' && typeof op.path === 'string' && !op.src) {
      try { out.push({ ...op, src: await imageDataUrl(op.path) }); } catch (error) { return fail(`could not read image ${op.path}: ${error instanceof Error ? error.message : String(error)}`); }
    } else out.push(op);
  }
  return out;
}

async function importFile(path: string, title: string): Promise<{ doc: Doc; note: string } | string> {
  const p = safePath(path);
  if (!p) return fail('import must be a path inside the workspace');
  const lower = p.toLowerCase();
  if (lower.endsWith('.docx')) {
    const file = await readBinaryFile(p);
    const bin = atob(file.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const { default: mammoth } = await import('mammoth');
    const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
    const doc = emptyDoc(title);
    doc.blocks = htmlToBlocks(doc, res.value);
    if (!doc.blocks.length) doc.blocks = [emptyPara(newId(doc, 'b'))];
    return { doc, note: `imported ${p} (Word: text, headings, lists, tables, links and images; page setup, colours, comments and tracked changes are not read)` };
  }
  const file = await readWorktreeFile(p);
  if (file.binary || file.tooLarge) return fail(`${p} is not a readable text file`);
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return { doc: markdownToDoc(file.content, title), note: `imported ${p} (Markdown)` };
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const doc = emptyDoc(title);
    doc.blocks = htmlToBlocks(doc, file.content);
    if (!doc.blocks.length) doc.blocks = [emptyPara(newId(doc, 'b'))];
    return { doc, note: `imported ${p} (HTML)` };
  }
  if (lower.endsWith('.txt')) { const doc = emptyDoc(title); doc.blocks = textToBlocks(doc, file.content); return { doc, note: `imported ${p} (plain text)` }; }
  return fail('import supports .md, .markdown, .html, .htm, .txt and .docx files');
}

const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };
const OPS_HELP = `Operations:\n${OP_HELP}`;

export const DOCS_TOOLS: ToolSpec[] = [
  {
    id: 'docs_list',
    name: 'docs_list',
    description: 'List the documents saved in the workspace (.pigry/docs/<owner>/) with their titles, headings and word counts.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushDocsEditors();
      const refs = await listDocRefs();
      if (refs.length === 0) return 'No documents yet. Create one with docs_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try { const { doc } = await loadDoc(ref); rows.push(`- ${refKey(ref)}: ${summarizeDoc(doc)}${outline(doc).length ? `\n    headings: ${outline(doc).slice(0, 8).map((o) => o.text).join(' · ')}` : ''}`); }
        catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'docs_read',
    name: 'docs_read',
    description: 'Read a document compactly: page setup and counts, then every block numbered [n] with its id and kind (title, h1…h6, normal, bullet/number/check list items, tables cell by cell, lines, page breaks, contents) as inline Markdown — {++inserted++}[s1] / {--deleted--}[s2] mark suggestions and {==text==}[c1] commented text — then comments with replies, suggestions, footnotes and a writing review. from/to read part of a long document; format: "markdown" gives clean Markdown instead, "outline" only the headings.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name, or owner/name' },
        from: { type: 'number', description: 'First block number to show' },
        to: { type: 'number', description: 'Last block number to show' },
        format: { type: 'string', enum: ['blocks', 'markdown', 'outline'] },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { doc, ref } = opened;
      if (input.format === 'markdown') return `${refKey(ref)} — ${summarizeDoc(doc)}\n\n${docToMarkdown(doc, { imageRef: (src) => (src.startsWith('data:') ? 'image' : src) })}`;
      if (input.format === 'outline') return `${refKey(ref)} — ${summarizeDoc(doc)}\n${outline(doc).map((o) => `${'  '.repeat(Math.max(0, o.level - 1))}[${o.top + 1}] ${o.style}: ${o.text}`).join('\n') || '(no headings)'}`;
      const review = reviewDoc(doc);
      return `${refKey(ref)}\n${readDoc(doc, { from: typeof input.from === 'number' ? input.from : undefined, to: typeof input.to === 'number' ? input.to : undefined })}${review.length ? '\n\nReview:\n- ' + review.join('\n- ') : '\n\nReview: nothing to flag.'}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'docs_write',
    name: 'docs_write',
    description: `Create a new document in your own folder (or replace your own with overwrite: true). Start from template ${TEMPLATES.map((t) => `"${t.id}" (${t.hint.replace(/\.$/, '')})`).join(', ')}; or give markdown (headings, **bold**, lists, - [ ] checklists, | tables |, [^1] footnotes, ![alt](data:…) images, $equations$), html or text; or import: a workspace .md/.html/.txt/.docx file. Then optional ops edit it straight away. It is shown in the Docs menu.\n${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name; becomes .pigry/docs/<you>/<name>.doc.json' },
        title: { type: 'string' },
        template: { type: 'string', enum: TEMPLATES.map((t) => t.id) },
        markdown: { type: 'string' },
        html: { type: 'string' },
        text: { type: 'string' },
        import: { type: 'string', description: 'Workspace path of a .md, .html, .txt or .docx file to start from' },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing document of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('docs_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, [DOCS_EXT]);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create documents in your own folder (${caller}/) — change another owner's document with docs_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushDocsEditors();
      if ((await listDocRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`document "${refKey(ref)}" already exists. Read it with docs_read and change it with docs_edit, or pass overwrite: true to replace it.`);
      }
      const { ops, errors } = input.ops === undefined ? { ops: [] as Op[], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const title = String(input.title ?? name).trim().slice(0, 300) || name;
      const template = String(input.template ?? 'blank') as TemplateId;
      if (!TEMPLATES.some((t) => t.id === template)) return fail(`template must be ${TEMPLATES.map((t) => t.id).join(', ')}`);
      let base: Doc;
      const notes: string[] = [];
      try {
        if (typeof input.import === 'string' && input.import.trim()) {
          const imp = await importFile(input.import.trim(), title);
          if (typeof imp === 'string') return imp;
          base = imp.doc; notes.push(imp.note);
        } else if (typeof input.markdown === 'string') base = markdownToDoc(input.markdown, title);
        else if (typeof input.html === 'string') { base = emptyDoc(title); base.blocks = htmlToBlocks(base, input.html); if (!base.blocks.length) base.blocks = [emptyPara(newId(base, 'b'))]; }
        else if (typeof input.text === 'string') { base = emptyDoc(title); base.blocks = textToBlocks(base, input.text); }
        else base = templateDoc(template, title, today());
      } catch (error) { return fail(`could not build the document: ${error instanceof Error ? error.message : String(error)}`); }
      const resolved = await resolveImages(ops);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(base, resolved, { author: caller, now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveDoc(ref, result.doc, 'agent');
      const review = reviewDoc(result.doc);
      return `saved ${path}\n${notes.length ? notes.join('\n') + '\n' : ''}${summarizeDoc(result.doc)}${result.log.length ? '\n' + result.log.slice(0, 40).join('\n') : ''}${review.length ? '\nReview:\n- ' + review.join('\n- ') : ''}\nCheck it with docs_read and the layout with docs_preview; show it to the user with docs_open.`;
    },
  },
  {
    id: 'docs_edit',
    name: 'docs_edit',
    description: `Edit an existing document with a list of operations, applied in order and saved only if all of them work; returns a log of what each did. Comments and suggestions are written under your name. To propose changes for the user to review, use suggest (a tracked change) and comment instead of editing the text directly. ${OPS_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Document name, or owner/name' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('docs_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const resolved = await resolveImages(ops);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(opened.doc, resolved, { author: callerOf(input), now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ` (the ops before it worked: ${result.log.join('; ')})` : ''}`);
      const path = await saveDoc(opened.ref, result.doc, 'agent');
      const review = reviewDoc(result.doc);
      return `saved ${path}\n${result.log.slice(0, 60).join('\n')}${result.log.length > 60 ? `\n…${result.log.length - 60} more` : ''}\n${summarizeDoc(result.doc)}${review.length ? '\nReview:\n- ' + review.join('\n- ') : ''}`;
    },
  },
  {
    id: 'docs_preview',
    name: 'docs_preview',
    description: 'Render pictures of document pages as the editor lays them out (page size, margins, header and footer, fonts, lists, tables, images, suggestion and comment marks) and attach them to your next turn so you can SEE the result. pages: page numbers to show (default the first 4, at most 6). save_as: a .png path under .pigry/.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Document name, or owner/name' }, pages: { type: 'array', items: { type: 'number' } }, save_as: { type: 'string' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      try {
        const want = Array.isArray(input.pages) ? input.pages.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 6) : undefined;
        const img = await renderPages(opened.doc, { pages: want });
        queueImage(img.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const t = exportPath(input.save_as, '', ['.png']);
          if ('error' in t) return fail(t.error);
          await writeWorktreeBinary(t.path, img.dataUrl.slice(img.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${t.path}`;
        }
        return `picture of ${refKey(opened.ref)} page(s) ${img.shown.join(', ')} of ${img.pages} (${img.width}×${img.height}px) is attached to your next turn${saved}. Look at it: headings, spacing, list indents, tables that run over a page, images, header and footer; fix with docs_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'docs_export',
    name: 'docs_export',
    description: 'Export a document. md: Markdown (images saved as files next to it); html: a print-friendly web page (open it and print to PDF); txt: plain text; docx: Microsoft Word with styles, lists, tables with merged cells, images, links, footnotes, header/footer with page numbers, comments, and pending suggestions as Word tracked changes. Pending suggestions appear accepted in md/html/txt. Saved under .pigry/ — by default next to the document.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Document name, or owner/name' }, format: { type: 'string', enum: ['md', 'html', 'txt', 'docx'] }, path: { type: 'string', description: 'Output path under .pigry/' } },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '').replace(/^markdown$/, 'md').replace(/^text$/, 'txt').replace(/^word$/, 'docx');
      if (!['md', 'html', 'txt', 'docx'].includes(format)) return fail('format must be md, html, txt or docx (PDF: export html and print it)');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const base = docsPath(opened.ref).replace(/\.doc\.json$/, '');
      const dest = exportPath(input.path, `${base}.${format}`, [`.${format}`]);
      if ('error' in dest) return fail(dest.error);
      try {
        if (format === 'docx') {
          const bytes = docxBytes(opened.doc);
          await writeWorktreeBinary(dest.path, toBase64(bytes));
          return `saved ${dest.path} (${(bytes.length / 1024).toFixed(1)} KB). Word keeps styles, lists, tables, images, links, footnotes, header/footer, comments and suggestions (as tracked changes); equations are plain text and the table of contents is a static list.`;
        }
        if (format === 'md') {
          const stem = dest.path.replace(/\.md$/i, '');
          const images: { path: string; data: string }[] = [];
          const text = docToMarkdown(opened.doc, {
            imageRef: (src, n) => {
              const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(src);
              if (!m) return src;
              const ext = m[1] === 'jpeg' ? 'jpg' : m[1] === 'svg+xml' ? 'svg' : m[1];
              const path = `${stem}-img${n}.${ext}`;
              images.push({ path, data: m[2] });
              return path.slice(path.lastIndexOf('/') + 1);
            },
          });
          for (const img of images) await writeWorktreeBinary(img.path, img.data);
          await writeWorktreeFile(dest.path, text);
          return `saved ${dest.path}${images.length ? ` and ${images.length} image file(s) next to it` : ''}.`;
        }
        await writeWorktreeFile(dest.path, format === 'html' ? docToHtml(opened.doc) : docToText(opened.doc));
        return `saved ${dest.path}${format === 'html' ? ' — a print-friendly page; open it in a browser and print or save as PDF' : ''}.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'docs_open',
    name: 'docs_open',
    description: 'Open a document in the Docs menu so the user can see it and keep editing; optionally scroll to a block (number, id or heading text).',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Document name, or owner/name' }, block: { type: 'string', description: 'Block number, id or heading text to scroll to' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('docs_open needs a name');
      const resolved = await resolveDocRef(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see docs_list)`);
      requestOpenDoc(refKey(resolved.ref), input.block === undefined ? undefined : String(input.block));
      return `opened "${refKey(resolved.ref)}" in the Docs menu`;
    },
  },
];
