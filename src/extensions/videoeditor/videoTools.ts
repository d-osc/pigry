/** Agent tools for the Video Editor. Projects are plain files (.pigry/videos/<owner>/<name>.video.json, one folder per
 * agent). The tools create them, apply editing operations (clips, text, shapes, synthesised sound, transitions, animation,
 * keyframes, captions, ducking), show contact-sheet previews the agent can look at, export WebM / PNG, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  ASPECTS, EFFECTS, FILTERS, OP_HELP, TEXT_STYLES, TRANSITIONS, VIDEOS_DIR, applyOps, checkProject, emptyProject, parseOps, projectDuration, summarizeProject, templateProject, type Project,
} from './video';
import { VideoEngine, blobToBase64, contactSheet } from './videoEngine';
import { flushVideoEditors, listVideoRefs, loadVideo, requestOpenVideo, resolveVideo, saveVideo, videoPath } from './videoStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.video ?? '').trim();
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;
const asList = (value: unknown): unknown => { if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } } return value; };

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; project: Project; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see video_list)');
  await flushVideoEditors();
  const resolved = await resolveVideo(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see video_list)`);
  try {
    const { project, warnings } = await loadVideo(resolved.ref);
    return { ref: resolved.ref, project, warnings };
  } catch (error) {
    return fail(`could not read video "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${VIDEOS_DIR}promo/final${exts[0]}` };
  }
  return { path };
}

const OPS_HELP = `Operations (times are seconds on the timeline; track and clip ids come from video_read):\n${OP_HELP}\nText styles: ${Object.keys(TEXT_STYLES).join(', ')}. Filters: ${Object.keys(FILTERS).join(', ')}. Effects: ${Object.keys(EFFECTS).join(', ')}. Transitions: ${Object.keys(TRANSITIONS).join(', ')}. Aspect ratios: ${Object.entries(ASPECTS).map(([k, a]) => `${k} (${a.label})`).join(', ')}. "last" stands for the clip or asset the previous op created.`;
const opsSchema = { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order, all-or-nothing (a JSON string of the array is also accepted)' };

export const VIDEO_TOOLS: ToolSpec[] = [
  {
    id: 'video_list',
    name: 'video_list',
    description: 'List the video projects saved in the workspace (.pigry/videos/<owner>/) with their format and length.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushVideoEditors();
      const refs = await listVideoRefs();
      if (refs.length === 0) return 'No video projects yet. Create one with video_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try { const { project } = await loadVideo(ref); rows.push(`- ${refKey(ref)}: "${project.title}" (${project.width}×${project.height}, ${projectDuration(project)}s, ${project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips)`); }
        catch { rows.push(`- ${refKey(ref)}: (unreadable file)`); }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'video_read',
    name: 'video_read',
    description: 'Read a video project as text: canvas format, media, every track and clip (ids, times, text, effects) plus review warnings (overlaps, unreadable captions, loud music…). To SEE frames use video_preview.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Video name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const warnings = checkProject(opened.project);
      return `${refKey(opened.ref)}\n${summarizeProject(opened.project)}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : '\nReview: nothing to flag.'}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'video_write',
    name: 'video_write',
    description: `Create a new video project (or replace your own with overwrite: true), optionally editing it straight away with ops. It is saved in your own folder and shown in the Video Editor. aspect: ${Object.keys(ASPECTS).join(', ')} (default 9:16 vertical). template: "blank" (default), "promo" (vertical 12 s motion promo with beat), "title" (16:9 title card). You can build complete videos without any media file using text, shapes, stickers and synthesised sound; to use footage, images or audio that are already in the workspace register them with asset_add. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Video name; becomes .pigry/videos/<you>/<name>.video.json' },
        title: { type: 'string' },
        aspect: { type: 'string', enum: Object.keys(ASPECTS) },
        template: { type: 'string', enum: ['blank', 'promo', 'title'] },
        ops: opsSchema,
        overwrite: { type: 'boolean', description: 'Replace an existing video of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('video_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.video.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create videos in your own folder (${caller}/) — change another owner's video with video_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushVideoEditors();
      if ((await listVideoRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`video "${refKey(ref)}" already exists. Read it with video_read and change it with video_edit, or pass overwrite: true to replace it.`);
      }
      if (input.aspect !== undefined && !(String(input.aspect) in ASPECTS)) return fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}`);
      const { ops, errors } = input.ops === undefined ? { ops: [], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const title = String(input.title ?? name).slice(0, 120);
      const template = String(input.template ?? 'blank');
      if (!['blank', 'promo', 'title'].includes(template)) return fail('template must be blank, promo or title');
      let base = template === 'blank' ? emptyProject(title, String(input.aspect ?? '9:16')) : templateProject(template as 'promo' | 'title', title);
      if (template !== 'blank' && input.aspect) { const a = ASPECTS[String(input.aspect)]; base = { ...base, width: a.w, height: a.h }; }
      const result = applyOps(base, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveVideo(ref, result.project, 'agent');
      const warnings = checkProject(result.project);
      return `saved ${path}\n${summarizeProject(result.project)}${result.log.length ? '\n' + result.log.join('\n') : ''}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}\nLook at it with video_preview; show it to the user with video_open.`;
    },
  },
  {
    id: 'video_edit',
    name: 'video_edit',
    description: `Edit an existing video project with a list of operations, applied in order and saved only if all of them work. Typical order: asset_add → clip_add → arrange → transition_set/anim_set → filters/keyframes → captions → duck. ${OPS_HELP}`,
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Video name, or owner/name' }, ops: opsSchema }, required: ['name', 'ops'] },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('video_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyOps(opened.project, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ' (these worked: ' + result.log.length + ')' : ''}`);
      const path = await saveVideo(opened.ref, result.project, 'agent');
      const warnings = checkProject(result.project);
      return `saved ${path}\n${result.log.join('\n')}\n${summarizeProject(result.project)}${warnings.length ? '\nReview:\n- ' + warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'video_preview',
    name: 'video_preview',
    description: 'Render frames of the video to a contact sheet (a grid of stills with their timestamps) and attach it to your next turn so you can SEE the edit, then fix what looks wrong with video_edit. Default: 8 frames spread over the video; pass at: [seconds…] to look at specific moments (e.g. just before and after a cut or transition), or at: "0.5" for one big frame. Optionally keep the PNG with save_as (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Video name, or owner/name' },
        at: { description: 'Times in seconds: an array, or a single number', anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'number' }] },
        frames: { type: 'number', description: 'How many evenly spread frames when "at" is not given (2–16, default 8)' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const dur = projectDuration(opened.project);
      if (dur <= 0) return fail('the video is empty — add clips first');
      const at = asList(input.at);
      let times: number[];
      if (Array.isArray(at) || typeof at === 'number') times = (Array.isArray(at) ? at : [at]).map(Number).filter((n) => Number.isFinite(n)).map((n) => Math.min(Math.max(0, n), Math.max(0, dur - 0.01))).slice(0, 16);
      else { const n = Math.round(Math.min(16, Math.max(2, Number(input.frames) || 8))); times = Array.from({ length: n }, (_, i) => Math.min(dur - 0.01, (dur * (i + 0.5)) / n)); }
      if (times.length === 0) return fail('"at" needs at least one number of seconds');
      try {
        const cell = times.length === 1 ? 900 : times.length <= 4 ? 520 : 360;
        const sheet = await contactSheet(opened.project, times, opened.project.height > opened.project.width && times.length > 1 ? Math.round(cell * 0.55) : cell);
        queueImage(sheet.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', ['.png']);
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, sheet.dataUrl.slice(sheet.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${target.path}`;
        }
        return `contact sheet of ${refKey(opened.ref)} (${times.length} frame(s) at ${times.map((t) => t.toFixed(2)).join(', ')} s, ${sheet.width}×${sheet.height}px) is attached to your next turn${saved}. Look at it, then fix anything off with video_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'video_export',
    name: 'video_export',
    description: 'Export the finished project. format "webm" records the whole video in real time (takes as long as the video itself; keep it under ~60 s) with its sound; "png" saves one frame at the time given in "at". Saved under .pigry/ — by default next to the project file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Video name, or owner/name' },
        format: { type: 'string', enum: ['webm', 'png'] },
        at: { type: 'number', description: 'png only: the time in seconds (default 0)' },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .webm or .png' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (format !== 'webm' && format !== 'png') return fail('format must be "webm" or "png"');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const dur = projectDuration(opened.project);
      if (dur <= 0) return fail('the video is empty — add clips first');
      if (format === 'webm' && dur > 120) return fail(`exporting records in real time and this video is ${Math.round(dur)} s long — export a shorter project or ask the user to export from the editor`);
      const ext = `.${format}`;
      const target = exportPath(input.path, videoPath(opened.ref).replace(/\.video\.json$/, ext), [ext]);
      if ('error' in target) return fail(target.error);
      const engine = new VideoEngine(opened.project);
      try {
        await engine.loadAssets();
        if (format === 'png') {
          const url = await engine.still(Math.min(Math.max(0, Number(input.at) || 0), Math.max(0, dur - 0.01)));
          await writeWorktreeBinary(target.path, url.slice(url.indexOf(',') + 1));
          return `saved ${target.path} (${opened.project.width}×${opened.project.height}). View it with read_image.`;
        }
        const blob = await engine.exportWebM(undefined, { maxSide: 1920 });
        await writeWorktreeBinary(target.path, await blobToBase64(blob));
        return `saved ${target.path} (${(blob.size / 1_000_000).toFixed(1)} MB, ${Math.round(dur)} s, ${opened.project.width}×${opened.project.height}, WebM VP9 + Opus). Tell the user where it is; to get an MP4 they can convert it with ffmpeg.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      } finally { engine.dispose(); }
    },
  },
  {
    id: 'video_open',
    name: 'video_open',
    description: 'Open a video project in the Video Editor so the user can see it, play it and keep editing.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Video name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('video_open needs a name');
      const resolved = await resolveVideo(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see video_list)`);
      requestOpenVideo(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the Video Editor`;
    },
  },
];
