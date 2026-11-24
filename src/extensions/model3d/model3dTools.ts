/** Agent tools for the 3D Model editor. Models are plain files (.pigry/models/<owner>/<name>.model.json, one folder per
 * agent): a scene of primitives, lights and cameras. The tools create and edit them with operations, render a preview
 * image the agent can look at, export GLB/OBJ/STL, and make the editor show the result. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  MAX_OBJECTS, MODELS_DIR, OP_HELP, SHADING, applyModelOps, checkModel, emptyModel, normalizeColor, parseOps, starterModel, summarizeModel, triangleCount, type Model3D,
} from './model3d';
import { arrayBufferToBase64, exportModel, renderModel, textToBase64, type ExportFormat } from './modelScene';
import {
  flushModelEditors, listModelRefs, loadModel, modelPath, requestOpenModel, resolveModel, saveModel,
} from './model3dStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.model ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;

function asList(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; model: Model3D; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see model_list)');
  await flushModelEditors();
  const resolved = await resolveModel(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see model_list)`);
  try {
    const { model, warnings } = await loadModel(resolved.ref);
    return { ref: resolved.ref, model, warnings };
  } catch (error) {
    return fail(`could not read model "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A workspace path under .pigry/ with one of the allowed extensions, or an error message. */
function exportPath(raw: unknown, fallback: string, exts: string[]): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !exts.some((e) => path.toLowerCase().endsWith(e))) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${exts.join(' or ')}, e.g. ${MODELS_DIR}robot/final${exts[0]}` };
  }
  return { path };
}

const reviewText = (model: Model3D, limit = 6): string => {
  const issues = checkModel(model).filter((i) => i.severity !== 'info');
  if (issues.length === 0) return '';
  return `\nReview (${issues.length}${issues.length > limit ? `, first ${limit}` : ''}):\n${issues.slice(0, limit).map((i) => `- [${i.severity}] ${i.message}`).join('\n')}`;
};

const OPS_HELP = `Units are metres, +Y is up, rotations are degrees. "target" is an object id, a name or a 1-based position. Operations:\n${OP_HELP}`;

export const MODEL_TOOLS: ToolSpec[] = [
  {
    id: 'model_list',
    name: 'model_list',
    description: 'List the 3D models saved in the workspace (.pigry/models/<owner>/) with their object count.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushModelEditors();
      const refs = await listModelRefs();
      if (refs.length === 0) return 'No 3D models yet. Create one with model_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { model } = await loadModel(ref);
          rows.push(`- ${refKey(ref)}: "${model.title}" (${model.objects.length} objects, ~${triangleCount(model).toLocaleString('en-US')} triangles)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'model_read',
    name: 'model_read',
    description: 'Read a 3D model as an outline: every object with its id, kind, position, rotation, scale, size, material, modifiers and parent. Always read a model before editing it. To SEE it use model_preview.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Model name, or owner/name' }, format: { type: 'string', enum: ['summary', 'json'] } },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      if (input.format === 'json') {
        const json = JSON.stringify(opened.model);
        return json.length > 16_000 ? json.slice(0, 16_000) + '\n[truncated — read the summary instead]' : json;
      }
      return `${refKey(opened.ref)}\n${summarizeModel(opened.model)}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}${reviewText(opened.model)}`;
    },
  },
  {
    id: 'model_write',
    name: 'model_write',
    description: `Create a new 3D model (or replace your own with overwrite: true), optionally building it straight away with ops. It is saved in your own folder and shown in the 3D Model editor. With starter: true the scene starts with a ground plane, a cube, a sun and a camera (like Blender's default scene); otherwise it is empty. Up to ${MAX_OBJECTS} objects. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name; becomes .pigry/models/<you>/<name>.model.json' },
        title: { type: 'string' },
        background: { type: 'string', description: 'Background colour (default dark grey)' },
        starter: { type: 'boolean', description: 'Start from the default scene (ground, cube, sun, camera)' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations to build the scene (a JSON string of the array is also accepted)' },
        overwrite: { type: 'boolean', description: 'Replace an existing model of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('model_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.model.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create models in your own folder (${caller}/) — change another owner's model with model_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushModelEditors();
      if ((await listModelRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`model "${refKey(ref)}" already exists. Read it with model_read and change it with model_edit, or pass overwrite: true to replace it.`);
      }
      if (input.background !== undefined && normalizeColor(input.background) === null) return fail('background must be a colour like "#223344"');
      const { ops, errors } = input.ops === undefined ? { ops: [], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const model = input.starter === true ? starterModel(String(input.title ?? name).slice(0, 80)) : emptyModel(String(input.title ?? name).slice(0, 80));
      if (input.background !== undefined) model.world.background = normalizeColor(input.background)!;
      const result = applyModelOps(model, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveModel(ref, model, 'agent');
      return `saved ${path}\n${summarizeModel(model)}${result.log.length ? '\n' + result.log.join('\n') : ''}${reviewText(model)}\nLook at it with model_preview; show it to the user with model_open.`;
    },
  },
  {
    id: 'model_edit',
    name: 'model_edit',
    description: `Change an existing 3D model with a list of operations, applied in order and saved only if all of them work. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name, or owner/name' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'ops'],
    },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('model_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyModelOps(opened.model, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveModel(opened.ref, opened.model, 'agent');
      return `saved ${path}\n${result.log.join('\n')}${reviewText(opened.model)}`;
    },
  },
  {
    id: 'model_preview',
    name: 'model_preview',
    description: 'Render the 3D model to an image and attach it to your next turn so you can SEE it, then fix what looks wrong with model_edit. By default it is framed automatically; pass position and target to choose the viewpoint, a camera object to render through it, or shading "solid" / "wireframe" to check the shapes. Optionally keep the PNG with save_as (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name, or owner/name' },
        position: { type: 'array', items: { type: 'number' }, description: 'Viewpoint [x, y, z]' },
        target: { type: 'array', items: { type: 'number' }, description: 'Point to look at [x, y, z]' },
        camera: { type: 'string', description: 'Render through this camera object (id or name)' },
        shading: { type: 'string', enum: [...SHADING] },
        width: { type: 'number' },
        height: { type: 'number' },
        grid: { type: 'boolean', description: 'Draw the ground grid' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      if (opened.model.objects.length === 0) return fail('the scene is empty');
      try {
        const vec = (v: unknown): [number, number, number] | undefined => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number') ? [v[0], v[1], v[2]] : undefined);
        const shot = renderModel(opened.model, {
          width: typeof input.width === 'number' ? input.width : 1000, height: typeof input.height === 'number' ? input.height : 640, position: vec(input.position), target: vec(input.target),
          camera: typeof input.camera === 'string' ? input.camera : undefined, shading: (SHADING as readonly string[]).includes(String(input.shading)) ? (input.shading as 'solid') : 'material', grid: input.grid === true,
        });
        queueImage(shot.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', ['.png']);
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${target.path}`;
        }
        return `preview of ${refKey(opened.ref)} (${shot.width}×${shot.height}px) is attached to your next turn${saved}. Look at it, then fix anything off with model_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'model_export',
    name: 'model_export',
    description: 'Export the 3D model as a GLB (glTF binary, for the web, games and Blender), OBJ or STL (for 3D printing). Only visible meshes are exported (no lights or cameras). Saved under .pigry/ — by default next to the model file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name, or owner/name' },
        format: { type: 'string', enum: ['glb', 'obj', 'stl'] },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .glb, .obj or .stl' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '') as ExportFormat;
      if (!['glb', 'obj', 'stl'].includes(format)) return fail('format must be "glb", "obj" or "stl"');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const target = exportPath(input.path, modelPath(opened.ref).replace(/\.model\.json$/, `.${format}`), [`.${format}`]);
      if ('error' in target) return fail(target.error);
      try {
        const out = await exportModel(opened.model, format);
        const base64 = typeof out.data === 'string' ? textToBase64(out.data) : arrayBufferToBase64(out.data);
        await writeWorktreeBinary(target.path, base64);
        return `saved ${target.path} (${Math.round((base64.length * 3) / 4 / 1024)} KB, ${triangleCount(opened.model).toLocaleString('en-US')} triangles)${format === 'stl' ? '. For printing check the scale (1 unit = 1 m in the model; slicers usually expect millimetres).' : ''}`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'model_open',
    name: 'model_open',
    description: 'Open a 3D model in the 3D Model editor so the user can see it, orbit around it and keep editing.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Model name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('model_open needs a name');
      const resolved = await resolveModel(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see model_list)`);
      requestOpenModel(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the 3D Model editor`;
    },
  },
];
