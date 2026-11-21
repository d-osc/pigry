/** Agent tools for the Board editor (a FigJam-style whiteboard). Boards are
 * plain files (.pigry/boards/<owner>/<name>.board.json, one folder per agent);
 * these tools read, create, edit, preview and export them, and make the editor
 * show the result. */
import type { ToolSpec } from './agentTools';
import {
  ITEM_TYPES, BOARD_COLORS, BOARD_EXT, SHAPE_KINDS, STAMPS, applyBoardOps, boardToMarkdown, checkBoard, findItem,
  normalizeBoard, renderBoardSvg, summarizeBoard, type Board, type BoardOp,
} from './board';
import {
  boardPath, flushBoardEditors, listBoardRefs, loadBoard, requestOpenBoard, resolveBoard, saveBoard,
} from './boardStore';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from './ownedFiles';
import { svgSize, svgToPng } from './designRaster';
import { canonicalizeEmbeds, collectEmbeds } from './boardEmbeds';
import { checkCodes, collectCodes } from './boardCode';
import { queueImage } from './pendingImages';
import { writeWorktreeBinary, writeWorktreeFile } from './tauriClient';

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

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.board ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name and note author). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const fail = (message: string): string => `error: ${message}`;

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; board: Board; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see board_list)');
  await flushBoardEditors();
  const resolved = await resolveBoard(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see board_list)`);
  try {
    const { board, warnings } = await loadBoard(resolved.ref);
    return { ref: resolved.ref, board, warnings };
  } catch (error) {
    return fail(`could not read board "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const reviewText = (board: Board, limit = 6): string => {
  const issues = checkBoard(board).filter((issue) => issue.severity === 'warn');
  if (issues.length === 0) return '';
  return `\nReview (${issues.length}):\n${issues.slice(0, limit).map((issue) => `- ${issue.message}`).join('\n')}`;
};

function exportPath(raw: unknown, fallback: string, ext: string): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !path.toLowerCase().endsWith(ext)) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${ext}, e.g. .pigry/boards/sa/retro${ext}` };
  }
  return { path };
}

const ITEM_HELP =
  'Item types: sticky (text, color: yellow|orange|pink|red|green|teal|blue|purple|gray|white, votes), text (free text; fontSize, bold), shape (shape: rect|round|ellipse|diamond|triangle, text, color), ' +
  'section (text = title, color, and notes: ["idea 1", {text, color, votes}, …] which are laid out in a grid inside it), connector (from, to — item ids or exact text — with text label, arrow end|both|none, dashed, route straight|elbow|curve), ' +
  `stamp (emoji, e.g. ${STAMPS.join(' ')}), and embed — show an existing diagram or design on the board: {type: "diagram", ref: "sa/login-flow", text: "Login flow"} or {type: "design", ref: "uxui/home", node: "Mobile — Home"} (ref = owner/name from diagram_list / design_list; node = one top-level frame, omit for the whole design; it stays live when the source changes). Show repository code with {type: "code", path: "src/App.tsx", start: 1, end: 10} (just those lines, with their real line numbers; optional rev: commit/branch to show the file as it was), {type: "compare", base: "main", head: "feature/x", path?: "src/App.tsx"} (a diff of one file, or the list of changed files when path is omitted) or {type: "commit", oid: "1a2b3c4", path?: "src/App.tsx"} (the commit's message and files, or its diff of one file); code cards read the repository live and give a text label with text. Omit x/y and items are placed automatically: sections side by side, notes in a grid inside their section.`;

export const BOARD_TOOLS: ToolSpec[] = [
  {
    id: 'board_list',
    name: 'board_list',
    description: 'List the boards saved in the workspace (.pigry/boards/<owner>/) with their size.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushBoardEditors();
      const refs = await listBoardRefs();
      if (refs.length === 0) return 'No boards yet. Create one with board_write.';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { board } = await loadBoard(ref);
          rows.push(`- ${refKey(ref)}: "${board.title}" (${board.items.filter((i) => i.type === 'sticky').length} stickies, ${board.items.filter((i) => i.type === 'section').length} sections, ${board.items.length} items)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'board_read',
    name: 'board_read',
    description: 'Read a board: "summary" (default) lists sections with their notes, votes, free items and connections with ids; "markdown" returns a clean outline; "json" the full file. Always read a board before editing it.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name, or owner/name' },
        format: { type: 'string', enum: ['summary', 'markdown', 'json'] },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { ref, board, warnings } = opened;
      if (input.format === 'markdown') return boardToMarkdown(board);
      if (input.format === 'json') {
        const json = JSON.stringify(board, null, 1);
        return json.length > 16_000 ? json.slice(0, 16_000) + '\n[truncated — use the summary]' : json;
      }
      return `${refKey(ref)}\n${summarizeBoard(board)}${warnings.length ? '\nRepaired on load:\n- ' + warnings.join('\n- ') : ''}`;
    },
  },
  {
    id: 'board_write',
    name: 'board_write',
    description: `Create a new board from items (or fully replace your own with overwrite: true). It is saved in your own folder and shown in the Board editor. Put related notes in sections: {type: "section", text: "Went well", color: "green", notes: ["…", "…"]}. ${ITEM_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name; becomes .pigry/boards/<you>/<name>.board.json' },
        title: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ITEM_TYPES }, text: { type: 'string' }, color: { type: 'string', enum: BOARD_COLORS }, shape: { type: 'string', enum: SHAPE_KINDS } } }, description: 'Items (a JSON string of the array is also accepted)' },
        overwrite: { type: 'boolean', description: 'Replace an existing board of the same name in your folder (default false)' },
      },
      required: ['name', 'items'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('board_write needs a name');
      const items = asArray(input.items);
      if (!items || items.length === 0) return fail('board_write needs a non-empty items array');
      const caller = callerOf(input);
      const parsed = parseRefName(name, [BOARD_EXT]);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create boards in your own folder (${caller}/) — change another owner's board with board_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushBoardEditors();
      const exists = (await listBoardRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug);
      if (exists && input.overwrite !== true) return fail(`board "${refKey(ref)}" already exists. Read it with board_read and change it with board_edit, or pass overwrite: true to replace it.`);
      const { board, warnings } = normalizeBoard({ title: input.title ?? name, items, author: caller }, parsed.slug);
      const embedWarnings = await canonicalizeEmbeds(board, caller, (item) => !asArray(items)?.some((raw) => raw && typeof raw === 'object' && (raw as Record<string, unknown>).w !== undefined && (raw as Record<string, unknown>).ref === item.embed?.ref));
      warnings.push(...embedWarnings);
      const rawKey = (raw: Record<string, unknown>) => String(raw.path ?? raw.file ?? raw.oid ?? raw.commit ?? raw.sha ?? raw.base ?? '');
      warnings.push(...(await checkCodes(board, (item) => !asArray(items)?.some((raw) => raw && typeof raw === 'object' && (raw as Record<string, unknown>).w !== undefined && rawKey(raw as Record<string, unknown>) === (item.code?.path ?? item.code?.oid ?? item.code?.base)))).map((w) => `code ${w}`));
      const path = await saveBoard(ref, board, 'agent');
      return `saved ${path}\n${summarizeBoard(board, 90)}${warnings.length ? '\nRepaired:\n- ' + warnings.join('\n- ') : ''}${reviewText(board)}\nLook at it with board_preview; show it to the user with board_open.`;
    },
  },
  {
    id: 'board_edit',
    name: 'board_edit',
    description: 'Edit a board with operations: add {type?, text, color?, section?: section id/title, …} (a note added to a section is laid out inside it), update {id, text?, color?, …}, remove {id}, move {id, x,y | dx,dy} (moving a section moves its notes; dropping a note onto a section adopts it), connect {from, to, label?, route?, dashed?, arrow?}, group {ids, section: id or new title, color?, arrange?}, ungroup {ids}, arrange {section | ids, mode: grid|row|column, columns?}, vote {id, by?, remove?}, duplicate {id}, set_meta {title}. Items are addressed by id or exact text. ' + ITEM_HELP,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name, or owner/name' },
        operations: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'operations'],
    },
    run: async (input) => {
      const ops = asArray(input.operations);
      if (!ops || ops.length === 0) return fail('board_edit needs a non-empty operations array');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyBoardOps(opened.board, ops as BoardOp[], callerOf(input));
      if (result.log.length === 0 && result.errors.length > 0) return fail(`nothing was applied\n- ${result.errors.join('\n- ')}`);
      const known = new Set(opened.board.items.map((i) => i.id));
      const embedWarnings = await canonicalizeEmbeds(result.board, callerOf(input), (item) => !known.has(item.id));
      const codeWarnings = await checkCodes(result.board, (item) => !known.has(item.id));
      const path = await saveBoard(opened.ref, result.board, 'agent');
      result.errors.push(...codeWarnings.map((w) => `code ${w}`));
      if (embedWarnings.length) result.errors.push(...embedWarnings.map((w) => `embed ${w}`));
      return `saved ${path}\n${result.log.map((line) => `✓ ${line}`).join('\n')}`
        + (result.errors.length ? `\nNot applied:\n- ${result.errors.join('\n- ')}` : '')
        + reviewText(result.board);
    },
  },
  {
    id: 'board_preview',
    name: 'board_preview',
    description: 'Render the board (or the given sections/items) to an image and attach it to your next turn so you can SEE the layout, then fix overlaps, empty sections or clutter. Optionally save the PNG with save_as (under .pigry/).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name, or owner/name' },
        only: { type: 'array', items: { type: 'string' }, description: 'Optional item or section ids/text to render alone' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { board, ref } = opened;
      if (board.items.length === 0) return fail('the board is empty');
      const only = asArray(input.only)?.map((r) => findItem(board, r)?.id).filter((id): id is string => !!id);
      const svg = renderBoardSvg(board, { background: '#f7f8fb', only: only?.length ? only : undefined, embeds: await collectEmbeds(board, callerOf(input), { refresh: true }), codes: await collectCodes(board, { refresh: true }) });
      const { width, height } = svgSize(svg);
      try {
        const png = await svgToPng(svg, width, height, Math.min(2, 1400 / Math.max(width, 1)));
        queueImage(png.dataUrl, typeof input.agent === 'string' && input.agent ? input.agent : undefined);
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', '.png');
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, png.base64);
          saved = ` and saved to ${target.path}`;
        }
        return `preview of ${refKey(ref)} (${png.width}×${png.height}px) is attached to your next turn${saved}. Look at it, then fix anything off with board_edit.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'board_export',
    name: 'board_export',
    description: 'Export a board as Markdown (sections → headings, notes → bullets sorted by votes, relations), SVG or PNG. Saved under .pigry/ — by default next to the board file.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name, or owner/name' },
        format: { type: 'string', enum: ['markdown', 'svg', 'png'] },
        path: { type: 'string', description: 'Optional output path under .pigry/ ending in .md, .svg or .png' },
      },
      required: ['name', 'format'],
    },
    run: async (input) => {
      const format = String(input.format ?? '');
      if (!['markdown', 'svg', 'png'].includes(format)) return fail('format must be "markdown", "svg" or "png"');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { board, ref } = opened;
      const ext = format === 'markdown' ? '.md' : `.${format}`;
      const target = exportPath(input.path, boardPath(ref).replace(/\.board\.json$/, ext), ext);
      if ('error' in target) return fail(target.error);
      if (format === 'markdown') {
        const md = boardToMarkdown(board);
        await writeWorktreeFile(target.path, md);
        return `saved ${target.path}\n${md.slice(0, 1500)}${md.length > 1500 ? '\n…' : ''}`;
      }
      const svg = renderBoardSvg(board, { background: format === 'png' ? '#f7f8fb' : null, embeds: await collectEmbeds(board, callerOf(input), { refresh: true }), codes: await collectCodes(board, { refresh: true }) });
      if (format === 'svg') {
        await writeWorktreeFile(target.path, svg);
        return `saved ${target.path} (${svg.length} bytes). Embed it in a Markdown report with ![${board.title}](<path relative to the report>).`;
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
    id: 'board_open',
    name: 'board_open',
    description: 'Open a board in the Board editor so the user can see it, optionally selecting an item.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name, or owner/name' },
        item: { type: 'string', description: 'Optional item id or exact text to select' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('board_open needs a name');
      const resolved = await resolveBoard(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see board_list)`);
      let itemId: string | undefined;
      if (input.item) {
        try { itemId = findItem((await loadBoard(resolved.ref)).board, input.item)?.id; } catch { /* open without selecting */ }
      }
      requestOpenBoard(refKey(resolved.ref), itemId);
      return `opened "${refKey(resolved.ref)}" in the Board editor${itemId ? ` and selected ${itemId}` : ''}`;
    },
  },
];

