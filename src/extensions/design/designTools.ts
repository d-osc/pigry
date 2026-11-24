/** Agent tools for the Design editor. Designs are plain files
 * (.pigry/designs/<owner>/<name>.design.json, one folder per agent); these
 * tools read, create, edit, review, preview and export them, and make the
 * editor show the result. */
import type { ToolSpec } from '../../lib/agentTools';
import {
  NODE_TYPES, applyDesignOps, checkDesign, findNode, normalizeDesign, renderDesignHtml, renderDesignSvg,
  summarizeDesign, DESIGNS_DIR, type Design, type DesignOp,
} from './design';
import {
  designPath, flushDesignEditors, listDesignRefs, loadDesign, requestOpenDesign, resolveDesign, saveDesign,
} from './designStore';
import { nameSlug, ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import { svgSize, svgToPng } from './designRaster';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';

function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.design ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const fail = (message: string): string => `error: ${message}`;

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; design: Design; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see design_list)');
  await flushDesignEditors();
  const resolved = await resolveDesign(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see design_list)`);
  try {
    const { design, warnings } = await loadDesign(resolved.ref);
    return { ref: resolved.ref, design, warnings };
  } catch (error) {
    return fail(`could not read design "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const reviewText = (design: Design, limit = 8): string => {
  const issues = checkDesign(design).filter((issue) => issue.severity !== 'info');
  if (issues.length === 0) return '';
  const shown = issues.slice(0, limit).map((issue) => `- [${issue.severity}] ${issue.message}`);
  return `\nReview (${issues.length} to fix${issues.length > limit ? `, first ${limit}` : ''}):\n${shown.join('\n')}`;
};

/** A workspace path under .pigry/ with the right extension, or an error message. */
function exportPath(raw: unknown, fallback: string, ext: string): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !path.toLowerCase().endsWith(ext)) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${ext}, e.g. ${DESIGNS_DIR}uxui/home${ext}` };
  }
  return { path };
}

const NODE_SCHEMA_HELP =
  'Node fields: type (frame, rect, ellipse, text, line, image), name, x, y, w, h (children are relative to their parent frame), fill ("#hex", "$token", {from,to,angle} or null), stroke, strokeWidth, radius (number or [tl,tr,br,bl]), opacity, shadow {x,y,blur,color}, clip, ' +
  'layout {dir: "row"|"column", gap, padding (number | [v,h] | [t,r,b,l]), justify: start|center|end|between, align: start|center|end|stretch, hugW, hugH} on frames, grow and selfAlign on children of an auto layout frame, ' +
  'text {text, fontSize, fontWeight, fontFamily (sans|serif|mono), textAlign, lineHeight, autoSize (w = fit text, h = wrap in fixed width)}, image {src: data: or https: URL}, children [..].';

export const DESIGN_TOOLS: ToolSpec[] = [
  {
    id: 'design_list',
    name: 'design_list',
    description: 'List the designs saved in the workspace (.pigry/designs/<owner>/) with their size.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushDesignEditors();
      const refs = await listDesignRefs();
      if (refs.length === 0) return 'No designs yet. Create one with design_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { design } = await loadDesign(ref);
          const count = (nodes: Design['nodes']): number => nodes.reduce((n, node) => n + 1 + count(node.children ?? []), 0);
          rows.push(`- ${refKey(ref)}: "${design.title}" (${design.nodes.length} frames, ${count(design.nodes)} nodes)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'design_read',
    name: 'design_read',
    description: 'Read a design as an outline (default: every node with id, size, layout, text and fill) or full JSON. Pass node to read just one subtree. Always read a design before editing it.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        node: { type: 'string', description: 'Optional node id or unique name to read only that subtree' },
        format: { type: 'string', enum: ['summary', 'json'] },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { ref, design, warnings } = opened;
      const node = input.node ? findNode(design, input.node) : undefined;
      if (input.node && !node) return fail(`no node "${String(input.node)}" in ${refKey(ref)}`);
      if (input.format === 'json') {
        const json = JSON.stringify(node ?? design, null, 1);
        return json.length > 16_000 ? json.slice(0, 16_000) + '\n[truncated — read a subtree with node: "<id>"]' : json;
      }
      return `${refKey(ref)}\n${summarizeDesign(design, node?.id)}${warnings.length ? '\nRepaired on load:\n- ' + warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'design_write',
    name: 'design_write',
    description: `Create a new design from a node tree (or fully replace your own with overwrite: true). It is saved in your own folder and shown in the Design editor. Prefer auto layout frames (layout: {dir, gap, padding}) over absolute coordinates — positions and text sizes are computed. ${NODE_SCHEMA_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name; becomes .pigry/designs/<you>/<name>.design.json' },
        title: { type: 'string' },
        tokens: { type: 'object', description: 'Design tokens: {"colors": {"primary": "#4f46e5", ...}}; use them as "$primary" in fills' },
        nodes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: NODE_TYPES }, name: { type: 'string' } } }, description: 'Top-level nodes — usually frames such as "Mobile — Home" 390×844 (a JSON string of the array is also accepted)' },
        overwrite: { type: 'boolean', description: 'Replace an existing design of the same name in your folder (default false)' },
      },
      required: ['name', 'nodes'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('design_write needs a name');
      const nodes = asArray(input.nodes);
      if (!nodes || nodes.length === 0) return fail('design_write needs a non-empty nodes array');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.design.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create designs in your own folder (${caller}/) — change another owner's design with design_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushDesignEditors();
      const exists = (await listDesignRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug);
      if (exists && input.overwrite !== true) {
        return fail(`design "${refKey(ref)}" already exists. Read it with design_read and change it with design_edit, or pass overwrite: true to replace it.`);
      }
      const tokens = asObject(input.tokens);
      const { design, warnings } = normalizeDesign({ title: input.title ?? name, tokens: tokens ?? undefined, nodes }, name);
      const path = await saveDesign(ref, design, 'agent');
      return `saved ${path}\n${summarizeDesign(design, undefined, 90)}${warnings.length ? '\nRepaired:\n- ' + warnings.join('\n- ') : ''}${reviewText(design)}\nLook at it with design_preview; show it to the user with design_open.`;
    },
  },
  {
    id: 'design_edit',
    name: 'design_edit',
    description: 'Edit a design with a list of operations: add {parent?, index?, node:{…}}, update {id, …fields}, remove {id}, move {id, parent (a frame id or "canvas"), index?}, duplicate {id}, wrap {ids:[…], name?, layout?}, set_tokens {colors:{name: "#hex"|null}}, set_meta {title}. Nodes are addressed by id or unique name. Auto layout frames reposition their children automatically. ' + NODE_SCHEMA_HELP,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'operations'],
    },
    run: async (input) => {
      const ops = asArray(input.operations);
      if (!ops || ops.length === 0) return fail('design_edit needs a non-empty operations array');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyDesignOps(opened.design, ops as DesignOp[]);
      if (result.log.length === 0 && result.errors.length > 0) return fail(`nothing was applied\n- ${result.errors.join('\n- ')}`);
      const path = await saveDesign(opened.ref, result.design, 'agent');
      return `saved ${path}\n${result.log.map((line) => `✓ ${line}`).join('\n')}`
        + (result.errors.length ? `\nNot applied:\n- ${result.errors.join('\n- ')}` : '')
        + reviewText(result.design, 6);
    },
  },
  {
    id: 'design_check',
    name: 'design_check',
    description: 'UX/UI review of a design: text contrast (WCAG AA), text too small, touch targets below 44px (mobile) / 32px, content outside its frame, spacing off the 4px grid, default layer names. Returns a list of issues with node ids.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        node: { type: 'string', description: 'Optional frame id or name to limit the review' },
        severity: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Minimum severity to show (default all)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      let design = opened.design;
      if (input.node) {
        const node = findNode(design, input.node);
        if (!node) return fail(`no node "${String(input.node)}"`);
        design = { ...design, nodes: [node] };
      }
      const min = input.severity === 'error' ? ['error'] : input.severity === 'warn' ? ['error', 'warn'] : ['error', 'warn', 'info'];
      const issues = checkDesign(design).filter((issue) => min.includes(issue.severity));
      if (issues.length === 0) return `PASS: no ${input.severity ?? ''} issues found in ${refKey(opened.ref)}`.replace('  ', ' ');
      return `${issues.length} issue(s) in ${refKey(opened.ref)}:\n` + issues.slice(0, 60).map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n');
    },
  },
  {
    id: 'design_preview',
    name: 'design_preview',
    description: 'Render a frame (or the whole canvas) to an image and attach it to your next turn so you can SEE the design, then review spacing, hierarchy and alignment and fix what looks wrong. Optionally save the PNG with save_as (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        node: { type: 'string', description: 'Frame id or name to render (default: the first top-level frame)' },
        all: { type: 'boolean', description: 'Render the whole canvas with every frame' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { design, ref } = opened;
      if (design.nodes.length === 0) return fail('the design is empty');
      const node = input.all ? undefined : input.node ? findNode(design, input.node) : design.nodes[0];
      if (input.node && !node) return fail(`no node "${String(input.node)}"`);
      const svg = renderDesignSvg(design, { nodeId: node?.id, background: '#ffffff' });
      const { width, height } = svgSize(svg);
      const scale = Math.min(2, 1400 / Math.max(width, 1));
      try {
        const png = await svgToPng(svg, width, height, scale);
        queueImage(png.dataUrl, typeof input.agent === 'string' && input.agent ? input.agent : undefined);
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', '.png');
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, png.base64);
          saved = ` and saved to ${target.path}`;
        }
        return `preview of ${node ? `"${node.name}"` : 'the whole canvas'} from ${refKey(ref)} (${png.width}×${png.height}px) is attached to your next turn${saved}. Look at it, then fix anything off with design_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'design_export',
    name: 'design_export',
    description: 'Export a design (or one frame) as SVG, PNG or static HTML+CSS for developer hand-off. Saved under .pigry/ — by default next to the design file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        format: { type: 'string', enum: ['svg', 'png', 'html'] },
        node: { type: 'string', description: 'Optional frame id or name (default: everything)' },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .svg, .png or .html' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (!['svg', 'png', 'html'].includes(format)) return fail('format must be "svg", "png" or "html"');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { design, ref } = opened;
      const node = input.node ? findNode(design, input.node) : undefined;
      if (input.node && !node) return fail(`no node "${String(input.node)}"`);
      const suffix = node ? `--${nameSlug(node.name)}` : '';
      const fallback = designPath(ref).replace(/\.design\.json$/, `${suffix}.${format}`);
      const target = exportPath(input.path, fallback, `.${format}`);
      if ('error' in target) return fail(target.error);
      if (format === 'html') {
        const html = renderDesignHtml(design, node?.id);
        await writeWorktreeFile(target.path, html);
        return `saved ${target.path} (${html.length} bytes) — static HTML/CSS using the design's colour tokens as CSS variables.`;
      }
      const svg = renderDesignSvg(design, { nodeId: node?.id, background: format === 'png' ? '#ffffff' : null, padding: node ? 0 : 40 });
      if (format === 'svg') {
        await writeWorktreeFile(target.path, svg);
        return `saved ${target.path} (${svg.length} bytes). Embed it in a Markdown report with ![${design.title}](<path relative to the report>).`;
      }
      try {
        const { width, height } = svgSize(svg);
        const png = await svgToPng(svg, width, height, 2);
        await writeWorktreeBinary(target.path, png.base64);
        return `saved ${target.path} (${png.width}×${png.height}px). View it with read_image, or embed it in a Markdown report.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'design_open',
    name: 'design_open',
    description: 'Open a design in the Design editor so the user can see it, optionally selecting a node.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Design name, or owner/name' },
        node: { type: 'string', description: 'Optional node id or name to select' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('design_open needs a name');
      const resolved = await resolveDesign(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see design_list)`);
      let nodeId: string | undefined;
      if (input.node) {
        try {
          const { design } = await loadDesign(resolved.ref);
          nodeId = findNode(design, input.node)?.id;
        } catch { /* open without selecting */ }
      }
      requestOpenDesign(refKey(resolved.ref), nodeId);
      return `opened "${refKey(resolved.ref)}" in the Design editor${nodeId ? ` and selected ${nodeId}` : ''}`;
    },
  },
];
