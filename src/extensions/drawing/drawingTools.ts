/** Agent tools for the Drawing editor. Drawings are plain files (.pigry/drawings/<owner>/<name>.drawing.json, one
 * folder per agent). The tools create them, apply drawing operations (brush strokes, shapes, text, fills, gradients,
 * filters, selections, layers), preview them as an image the agent can see, export PNG/JPEG/WebP, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  BLEND_MODES, BRUSHES, DEFAULT_HEIGHT, DEFAULT_WIDTH, DRAWINGS_DIR, MAX_SIDE, OP_HELP, clampSide, emptyDrawing, parseOps, summarizeDrawing, type Drawing,
} from './drawing';
import { DrawingSession } from './drawingEngine';
import { FILTERS, parseColor } from './drawingPixels';
import {
  drawingPath, flushDrawingEditors, listDrawingRefs, loadDrawing, requestOpenDrawing, resolveDrawing, saveDrawing,
} from './drawingStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.drawing ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;

function asList(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; drawing: Drawing; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see drawing_list)');
  await flushDrawingEditors();
  const resolved = await resolveDrawing(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see drawing_list)`);
  try {
    const { drawing, warnings } = await loadDrawing(resolved.ref);
    return { ref: resolved.ref, drawing, warnings };
  } catch (error) {
    return fail(`could not read drawing "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A workspace path under .pigry/ with one of the allowed extensions, or an error message. */
function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${DRAWINGS_DIR}sketch/final${exts[0]}` };
  }
  return { path };
}

/** Applies operations in order to an in-memory session. Stops at the first operation that fails. */
function runOps(session: DrawingSession, ops: ReturnType<typeof parseOps>['ops']): { log: string[]; error?: string } {
  const log: string[] = [];
  for (const [i, op] of ops.entries()) {
    try { log.push(`✓ ${op.op}: ${session.apply(op)}`); } catch (error) { return { log, error: `op ${i + 1} (${op.op}): ${error instanceof Error ? error.message : String(error)}` }; }
  }
  return { log };
}

const OPS_HELP = `Operations (coordinates are canvas pixels from the top-left, colours are "#rrggbb", "rgba(r,g,b,a)" or names; "layer" is an id, a name or a 1-based position, default = the top layer):\n${OP_HELP}\nBlend modes: ${BLEND_MODES.map((m) => m.id).join(', ')}.`;
const PREVIEW_MAX = 1400;

export const DRAWING_TOOLS: ToolSpec[] = [
  {
    id: 'drawing_list',
    name: 'drawing_list',
    description: 'List the drawings saved in the workspace (.pigry/drawings/<owner>/) with their size and layer count.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushDrawingEditors();
      const refs = await listDrawingRefs();
      if (refs.length === 0) return 'No drawings yet. Create one with drawing_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { drawing } = await loadDrawing(ref);
          rows.push(`- ${refKey(ref)}: "${drawing.title}" (${drawing.width}×${drawing.height}, ${drawing.layers.length} layers)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'drawing_read',
    name: 'drawing_read',
    description: 'Read a drawing as text: its size, background and every layer (id, name, blend mode, opacity, locked/hidden). To SEE the pixels use drawing_preview.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Drawing name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      return `${refKey(opened.ref)}\n${summarizeDrawing(opened.drawing)}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'drawing_write',
    name: 'drawing_write',
    description: `Create a new drawing (or replace your own with overwrite: true), optionally drawing on it straight away with ops. It is saved in your own folder and shown in the Drawing editor. Width/height are 1–${MAX_SIDE} px (default ${DEFAULT_WIDTH}×${DEFAULT_HEIGHT}). The first layer is empty and sits on the background colour. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drawing name; becomes .pigry/drawings/<you>/<name>.drawing.json' },
        title: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        background: { type: 'string', description: 'Colour behind the layers, or "transparent" (default white)' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations to apply to the new drawing (a JSON string of the array is also accepted)' },
        overwrite: { type: 'boolean', description: 'Replace an existing drawing of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('drawing_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.drawing.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create drawings in your own folder (${caller}/) — change another owner's drawing with drawing_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushDrawingEditors();
      if ((await listDrawingRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`drawing "${refKey(ref)}" already exists. Read it with drawing_read and change it with drawing_edit, or pass overwrite: true to replace it.`);
      }
      const bg = input.background === undefined ? '#ffffff' : String(input.background).toLowerCase() === 'transparent' ? null : parseColor(input.background) ? String(input.background) : undefined;
      if (bg === undefined) return fail('background must be a colour or "transparent"');
      const { ops, errors } = input.ops === undefined ? { ops: [], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const base = emptyDrawing(String(input.title ?? name).slice(0, 80), clampSide(input.width ?? DEFAULT_WIDTH), clampSide(input.height ?? DEFAULT_HEIGHT), bg);
      try {
        const session = await DrawingSession.from(base);
        session.recording = false;
        const result = runOps(session, ops);
        if (result.error) return fail(`${result.error}\nnothing was saved`);
        const drawing = session.toDrawing();
        const path = await saveDrawing(ref, drawing, 'agent');
        return `saved ${path}\n${summarizeDrawing(drawing)}${result.log.length ? '\n' + result.log.join('\n') : ''}\nLook at it with drawing_preview; show it to the user with drawing_open.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'drawing_edit',
    name: 'drawing_edit',
    description: `Draw on an existing drawing with a list of operations, applied in order and saved only if all of them work. Typical order: layer_add → shapes/strokes/gradients → filters. Selections limit fills, strokes and filters until you select none. ${OPS_HELP}\nBrush presets for "stroke": ${BRUSHES.map((b) => b.id).join(', ')}. Filters: ${FILTERS.map((f) => f.id).join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drawing name, or owner/name' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'ops'],
    },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('drawing_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      try {
        const session = await DrawingSession.from(opened.drawing);
        session.recording = false;
        const result = runOps(session, ops);
        if (result.error) return fail(`${result.error}\nnothing was saved${result.log.length ? ' (these worked: ' + result.log.length + ')' : ''}`);
        const drawing = session.toDrawing();
        const path = await saveDrawing(opened.ref, drawing, 'agent');
        return `saved ${path}\n${result.log.join('\n')}\n${summarizeDrawing(drawing)}`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'drawing_preview',
    name: 'drawing_preview',
    description: 'Render the drawing (all visible layers on its background) to an image and attach it to your next turn so you can SEE it, then fix what looks wrong with drawing_edit. Pass layer to see one layer alone. Optionally keep the PNG with save_as (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drawing name, or owner/name' },
        layer: { type: 'string', description: 'Optional layer id, name or position to render alone' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      try {
        const session = await DrawingSession.from(opened.drawing);
        if (input.layer) {
          const only = session.layerOf(input.layer);
          if (!only) return fail(`no layer "${String(input.layer)}" (see drawing_read)`);
          for (const l of session.layers) l.meta.visible = l === only;
        }
        const k = Math.min(1, PREVIEW_MAX / Math.max(session.width, session.height));
        const flat = session.compose(true);
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(session.width * k)); out.height = Math.max(1, Math.round(session.height * k));
        const c = out.getContext('2d')!;
        if (!session.background) { c.fillStyle = '#ffffff'; c.fillRect(0, 0, out.width, out.height); }
        c.imageSmoothingQuality = 'high';
        c.drawImage(flat, 0, 0, out.width, out.height);
        const dataUrl = out.toDataURL('image/png');
        queueImage(dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', ['.png']);
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, dataUrl.slice(dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${target.path}`;
        }
        return `preview of ${refKey(opened.ref)} (${out.width}×${out.height}px${input.layer ? `, layer ${String(input.layer)} only` : ''}) is attached to your next turn${saved}. Look at it, then fix anything off with drawing_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'drawing_export',
    name: 'drawing_export',
    description: 'Export the finished drawing as PNG, JPEG or WebP. Saved under .pigry/ — by default next to the drawing file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drawing name, or owner/name' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .png, .jpg or .webp' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      const types = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
      if (!(format in types)) return fail('format must be "png", "jpeg" or "webp"');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const ext = format === 'jpeg' ? '.jpg' : `.${format}`;
      const target = exportPath(input.path, drawingPath(opened.ref).replace(/\.drawing\.json$/, ext), [ext]);
      if ('error' in target) return fail(target.error);
      try {
        const session = await DrawingSession.from(opened.drawing);
        const dataUrl = session.exportDataUrl(types[format as keyof typeof types]);
        await writeWorktreeBinary(target.path, dataUrl.slice(dataUrl.indexOf(',') + 1));
        return `saved ${target.path} (${session.width}×${session.height}px). View it with read_image, or embed it in a Markdown report.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'drawing_open',
    name: 'drawing_open',
    description: 'Open a drawing in the Drawing editor so the user can see it and keep painting.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Drawing name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('drawing_open needs a name');
      const resolved = await resolveDrawing(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see drawing_list)`);
      requestOpenDrawing(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the Drawing editor`;
    },
  },
];
