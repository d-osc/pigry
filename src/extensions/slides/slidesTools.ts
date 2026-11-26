/** Agent tools for the Slides menu. Presentations are plain files (.pigry/slides/<owner>/<name>.slides.json, one folder per
 * agent). The tools create them (blank, from a template or a Markdown outline), apply editing operations (all-or-nothing,
 * with a log), read them compactly with a design review, show pictures of the slides, export PowerPoint / PDF / PNG /
 * HTML / Markdown, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { readBinaryFile, readWorktreeFile, writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { SIZES, THEMES, clone, findSlide, slideIndex, slideTitle, type Deck } from './slides';
import { TEMPLATES, deckToHtml, deckToMarkdown, deckToText, markdownToDeck, templateDeck, type TemplateId } from './slidesFormat';
import { OP_HELP, applyOps, parseOps, readDeck, resizeDeck, reviewDeck, summarizeDeck, type Op } from './slidesOps';
import { pptxWithPictures, slidePng, slidesPdf, slidesSheet } from './slidesRaster';
import { flushSlidesEditors, listDeckRefs, loadDeck, requestOpenDeck, resolveDeckRef, saveDeck, slidesPath } from './slidesStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.deck ?? input.presentation ?? '').trim();
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const callerOf = (input: Record<string, unknown>): string => ownerSlug(agentOf(input) ?? 'agent');
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };
const nowIso = (): string => new Date().toISOString();
const today = (): string => new Date().toISOString().slice(0, 10);

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; deck: Deck; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see slides_list)');
  await flushSlidesEditors();
  const resolved = await resolveDeckRef(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see slides_list)`);
  try {
    const { deck, warnings } = await loadDeck(resolved.ref);
    return { ref: resolved.ref, deck, warnings };
  } catch (error) {
    return fail(`could not read presentation "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. .pigry/slides/exports/talk${exts[0]}` };
  }
  return { path };
}
const toBase64 = (bytes: Uint8Array): string => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const safePath = (p: string): string | null => { const x = p.replace(/\\/g, '/').trim(); return !x || x.split('/').includes('..') || /^[A-Za-z]:/.test(x) || x.startsWith('/') ? null : x; };

async function imageDataUrl(path: string): Promise<string> {
  const p = safePath(path);
  if (!p) throw new Error('image path must be inside the workspace');
  const mime = MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()];
  if (!mime) throw new Error('images must be .png, .jpg, .gif, .webp or .svg');
  const file = await readBinaryFile(p);
  return `data:${mime};base64,${file.data}`;
}
/** Resolves `path:` on image elements and image backgrounds into data URLs. */
async function resolveImages(ops: Op[]): Promise<Op[] | string> {
  const out: Op[] = [];
  for (const op of ops) {
    try {
      if ((op.op === 'add' || op.op === 'set') && typeof op.path === 'string' && !op.src) { out.push({ ...op, src: await imageDataUrl(op.path) }); continue; }
      const bg = op.background as Record<string, unknown> | undefined;
      if (op.op === 'slide' && bg && typeof bg === 'object' && typeof bg.path === 'string' && !bg.src) { out.push({ ...op, background: { type: 'image', fit: bg.fit, src: await imageDataUrl(bg.path) } }); continue; }
    } catch (error) { return fail(`could not read image: ${error instanceof Error ? error.message : String(error)}`); }
    out.push(op);
  }
  return out;
}
const reviewText = (deck: Deck): string => { const r = reviewDeck(deck); return r.length ? `\nReview:\n- ${r.slice(0, 30).join('\n- ')}${r.length > 30 ? `\n- …${r.length - 30} more` : ''}` : '\nReview: nothing to flag.'; };

const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };

export const SLIDES_TOOLS: ToolSpec[] = [
  {
    id: 'slides_list',
    name: 'slides_list',
    description: 'List the presentations saved in the workspace (.pigry/slides/<owner>/) with their titles, slide counts and slide titles.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushSlidesEditors();
      const refs = await listDeckRefs();
      if (refs.length === 0) return 'No presentations yet. Create one with slides_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try { const { deck } = await loadDeck(ref); rows.push(`- ${refKey(ref)}: ${summarizeDeck(deck)}\n    ${deck.slides.slice(0, 12).map((s, i) => `${i + 1}. ${slideTitle(s) || '(untitled)'}`).join(' · ')}`); }
        catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'slides_read',
    name: 'slides_read',
    description: 'Read a presentation compactly: size, theme and colours, then every slide [n] with its id, layout, background and transition, each element (id, type, role, position and size in px, text as light Markdown, images with alt text, tables, chart data), animations in order, speaker notes and comments — then a design review (word count, font sizes, contrast, overlaps, alt text, titles). from/to read part of a long deck; format "outline" gives the titles and text only, "markdown" a Markdown outline.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Presentation name, or owner/name' }, from: { type: 'number' }, to: { type: 'number' }, format: { type: 'string', enum: ['slides', 'outline', 'markdown'] } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { deck, ref } = opened;
      if (input.format === 'outline') return `${refKey(ref)} — ${summarizeDeck(deck)}\n\n${deckToText(deck)}`;
      if (input.format === 'markdown') return `${refKey(ref)} — ${summarizeDeck(deck)}\n\n${deckToMarkdown(deck)}`;
      return `${refKey(ref)}\n${readDeck(deck, { from: typeof input.from === 'number' ? input.from : undefined, to: typeof input.to === 'number' ? input.to : undefined })}${reviewText(deck)}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'slides_write',
    name: 'slides_write',
    description: `Create a new presentation in your own folder (or replace your own with overwrite: true). Start from template ${TEMPLATES.map((t) => `"${t.id}" (${t.hint.replace(/\.$/, '')})`).join(', ')}; or from a Markdown outline (markdown: "# Title" / "## Slide title" start slides, "---" splits, "- " bullets, "> " or "Notes:" lines are speaker notes, ![alt](path) images, | tables |) or import: a workspace .md file. theme: ${THEMES.map((t) => t.id).join(', ')}; aspect: 16:9 (default), 4:3, 16:10, A4. Then optional ops edit it straight away. It is shown in the Slides menu.\n${OP_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Presentation name; becomes .pigry/slides/<you>/<name>.slides.json' },
        title: { type: 'string' },
        template: { type: 'string', enum: TEMPLATES.map((t) => t.id) },
        markdown: { type: 'string' },
        import: { type: 'string', description: 'Workspace path of a Markdown (.md) outline to start from' },
        theme: { type: 'string', enum: THEMES.map((t) => t.id) },
        aspect: { type: 'string', enum: Object.keys(SIZES) },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing presentation of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('slides_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.slides.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create presentations in your own folder (${caller}/) — change another owner's presentation with slides_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushSlidesEditors();
      if ((await listDeckRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`presentation "${refKey(ref)}" already exists. Read it with slides_read and change it with slides_edit, or pass overwrite: true to replace it.`);
      }
      const { ops, errors } = input.ops === undefined ? { ops: [] as Op[], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const title = String(input.title ?? name).trim().slice(0, 300) || name;
      const template = String(input.template ?? 'blank') as TemplateId;
      if (!TEMPLATES.some((t) => t.id === template)) return fail(`template must be ${TEMPLATES.map((t) => t.id).join(', ')}`);
      if (input.theme !== undefined && !THEMES.some((t) => t.id === input.theme)) return fail(`theme must be ${THEMES.map((t) => t.id).join(', ')}`);
      if (input.aspect !== undefined && !(String(input.aspect) in SIZES)) return fail(`aspect must be ${Object.keys(SIZES).join(', ')}`);
      let base: Deck;
      const notes: string[] = [];
      try {
        let md: string | undefined = typeof input.markdown === 'string' ? input.markdown : undefined;
        if (typeof input.import === 'string' && input.import.trim()) {
          const p = safePath(input.import);
          if (!p || !/\.(md|markdown|txt)$/i.test(p)) return fail('import must be a workspace .md, .markdown or .txt file');
          const file = await readWorktreeFile(p);
          if (file.binary || file.tooLarge) return fail(`${p} is not a readable text file`);
          md = file.content; notes.push(`imported ${p} (Markdown outline)`);
        }
        base = md !== undefined ? markdownToDeck(md, title, String(input.theme ?? 'simple-light')) : templateDeck(template, title, today());
        base.title = title;
        if (input.theme !== undefined && md === undefined) { const t = THEMES.find((x) => x.id === input.theme); if (t) base.theme = clone(t); }
        if (input.aspect !== undefined) resizeDeck(base, SIZES[String(input.aspect) as keyof typeof SIZES]);
        // Markdown images may point at workspace files: inline them.
        for (const s of base.slides) for (const e of s.elements) if (e.type === 'image' && !e.src.startsWith('data:') && !/^https?:/i.test(e.src)) { try { e.src = await imageDataUrl(e.src); } catch { notes.push(`could not read image ${e.src}`); } }
      } catch (error) { return fail(`could not build the presentation: ${error instanceof Error ? error.message : String(error)}`); }
      const resolved = await resolveImages(ops);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(base, resolved, { author: caller, now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveDeck(ref, result.deck, 'agent');
      return `saved ${path}\n${notes.length ? notes.join('\n') + '\n' : ''}${summarizeDeck(result.deck)}\n${result.deck.slides.map((s, i) => `${i + 1}. ${s.id} ${s.layout}: ${slideTitle(s) || '(untitled)'}`).join('\n')}${result.log.length ? '\n' + result.log.slice(0, 40).join('\n') : ''}${reviewText(result.deck)}\nRead it with slides_read and look at it with slides_preview; show it to the user with slides_open.`;
    },
  },
  {
    id: 'slides_edit',
    name: 'slides_edit',
    description: `Edit an existing presentation with a list of operations, applied in order and saved only if all of them work; returns a log of what each did. Comments are written under your name; in someone else's deck, prefer comment for judgement calls. ${OP_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Presentation name, or owner/name' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('slides_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const resolved = await resolveImages(ops);
      if (typeof resolved === 'string') return resolved;
      const result = applyOps(opened.deck, resolved, { author: callerOf(input), now: nowIso() });
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ` (the ops before it worked: ${result.log.join('; ')})` : ''}`);
      const path = await saveDeck(opened.ref, result.deck, 'agent');
      return `saved ${path}\n${result.log.slice(0, 60).join('\n')}${result.log.length > 60 ? `\n…${result.log.length - 60} more` : ''}\n${summarizeDeck(result.deck)}${reviewText(result.deck)}`;
    },
  },
  {
    id: 'slides_preview',
    name: 'slides_preview',
    description: 'Render pictures of slides exactly as the editor draws them (theme, fonts, images, shapes, charts, tables) and attach them to your next turn so you can SEE the result. slides: slide numbers to show (default the first 6, at most 9). save_as: a .png path under .pigry/.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Presentation name, or owner/name' }, slides: { type: 'array', items: { type: 'number' } }, save_as: { type: 'string' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { deck } = opened;
      if (!deck.slides.length) return fail('the presentation has no slides yet');
      try {
        const want = (Array.isArray(input.slides) ? input.slides.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= deck.slides.length) : []).slice(0, 9);
        const numbers = want.length ? want : deck.slides.slice(0, 6).map((_, i) => i + 1);
        const img = await slidesSheet(deck, numbers);
        queueImage(img.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const t = exportPath(input.save_as, '', ['.png']);
          if ('error' in t) return fail(t.error);
          await writeWorktreeBinary(t.path, img.dataUrl.slice(img.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${t.path}`;
        }
        return `picture of ${refKey(opened.ref)} slide(s) ${numbers.join(', ')} of ${deck.slides.length} (${img.width}×${img.height}px) is attached to your next turn${saved}. Look at it: hierarchy, alignment, spacing, contrast, text that is too small or overflows; fix with slides_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'slides_export',
    name: 'slides_export',
    description: 'Export a presentation. pptx: PowerPoint with text, shapes, lines, images, tables, charts (as pictures), backgrounds, transitions, skipped slides and speaker notes (animations and comments are not written); pdf: one page per slide (skipped slides left out); png: one picture per slide (slides: which ones; files named <name>-slide-<n>.png); html: a self-contained web page that plays the deck with transitions, animations, keyboard navigation, speaker notes (S) and a laser pointer (L); md: Markdown outline; txt: text outline. Saved under .pigry/ — by default next to the presentation.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Presentation name, or owner/name' }, format: { type: 'string', enum: ['pptx', 'pdf', 'png', 'html', 'md', 'txt'] }, path: { type: 'string', description: 'Output path under .pigry/ (for png: the first file, or a folder ending in /)' }, slides: { type: 'array', items: { type: 'number' } } },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '').toLowerCase().replace(/^powerpoint$/, 'pptx').replace(/^markdown$/, 'md').replace(/^text$/, 'txt');
      if (!['pptx', 'pdf', 'png', 'html', 'md', 'txt'].includes(format)) return fail('format must be pptx, pdf, png, html, md or txt');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { deck } = opened;
      const base = slidesPath(opened.ref).replace(/\.slides\.json$/, '');
      try {
        if (format === 'png') {
          const want = Array.isArray(input.slides) ? input.slides.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= deck.slides.length) : deck.slides.map((_, i) => i + 1);
          if (!want.length) return fail('no slides to export');
          const raw = typeof input.path === 'string' ? input.path.trim().replace(/\\/g, '/') : '';
          const stem = raw ? (raw.endsWith('/') ? `${raw}${opened.ref.slug}` : raw.replace(/\.png$/i, '')) : base;
          const check = exportPath(`${stem}-slide-1.png`, '', ['.png']);
          if ('error' in check) return fail(check.error);
          const written: string[] = [];
          for (const n of want) { const url = await slidePng(deck, deck.slides[n - 1], 2); const p = `${stem}-slide-${n}.png`; await writeWorktreeBinary(p, url.slice(url.indexOf(',') + 1)); written.push(p); }
          return `saved ${written.length} picture(s) at 2× (${deck.size.w * 2}×${deck.size.h * 2}px): ${written.join(', ')}`;
        }
        const dest = exportPath(input.path, `${base}.${format}`, [`.${format}`]);
        if ('error' in dest) return fail(dest.error);
        if (format === 'pptx') {
          const bytes = await pptxWithPictures(deck);
          await writeWorktreeBinary(dest.path, toBase64(bytes));
          return `saved ${dest.path} (${(bytes.length / 1024).toFixed(1)} KB, ${deck.slides.length} slides). PowerPoint keeps text, shapes, images, tables, backgrounds, transitions, skipped slides and speaker notes; charts are pictures; animations and comments are not written.`;
        }
        if (format === 'pdf') {
          const bytes = await slidesPdf(deck);
          await writeWorktreeBinary(dest.path, toBase64(bytes));
          return `saved ${dest.path} (${(bytes.length / 1024).toFixed(1)} KB, ${deck.slides.filter((s) => !s.hidden).length} pages; text is part of the pictures, so it is not selectable).`;
        }
        const text = format === 'html' ? deckToHtml(deck) : format === 'md' ? deckToMarkdown(deck) : deckToText(deck);
        await writeWorktreeFile(dest.path, text);
        return `saved ${dest.path}${format === 'html' ? ' — open it in a browser: → / Space next, ← back, F full screen, S notes, L laser pointer, B / W black / white screen' : ''}.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'slides_open',
    name: 'slides_open',
    description: 'Open a presentation in the Slides menu so the user can see it and keep editing; optionally go to a slide (number, id or title).',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Presentation name, or owner/name' }, slide: { type: 'string', description: 'Slide number, id or title to show' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('slides_open needs a name');
      const resolved = await resolveDeckRef(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see slides_list)`);
      let slide: string | undefined;
      if (input.slide !== undefined) {
        try { const { deck } = await loadDeck(resolved.ref); const s = findSlide(deck, input.slide); if (s) slide = String(slideIndex(deck, s) + 1); } catch { /* opens at the first slide */ }
      }
      requestOpenDeck(refKey(resolved.ref), slide);
      return `opened "${refKey(resolved.ref)}" in the Slides menu${slide ? ` at slide ${slide}` : ''}`;
    },
  },
];
