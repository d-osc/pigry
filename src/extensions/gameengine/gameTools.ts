/** Agent tools for the Game Engine editor. Games are plain files (.pigry/games/<owner>/<name>.game.json, one folder per
 * agent): Godot-style scenes of nodes, TypeScript/JavaScript scripts and project settings. The tools create and edit
 * them with operations, run them headlessly in a sandbox and report what happened, take a screenshot the agent can
 * look at, export a standalone HTML game, and open the editor. */
import type { ToolSpec } from '../../lib/agentTools';
import { queueImage } from '../../lib/pendingImages';
import { writeWorktreeBinary, writeWorktreeFile } from '../../lib/tauriClient';
import { ownerSlug, parseRefName, refKey, type OwnedRef } from '../../lib/ownedFiles';
import {
  GAMES_DIR, NODE_TYPES, OP_HELP, applyGameOps, checkGame, countNodes, emptyGame, parseExports, parseOps, summarizeGame, type Game,
} from './game';
import { templateGame, type TemplateKind } from './gameTemplates';
import { exportGameHtml, simulateGame, type SimResult } from './gameHost';
import { flushGameEditors, gamePath, listGameRefs, loadGame, requestOpenGame, resolveGame, saveGame } from './gameStore';

const nameOf = (input: Record<string, unknown>): string => String(input.name ?? input.game ?? '').trim();
/** The calling agent's username, injected by the agent loop (owner folder name). */
const callerOf = (input: Record<string, unknown>): string => ownerSlug(typeof input.agent === 'string' && input.agent ? input.agent : 'agent');
const agentOf = (input: Record<string, unknown>): string | undefined => (typeof input.agent === 'string' && input.agent ? input.agent : undefined);
const fail = (message: string): string => `error: ${message}`;

function asList(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}

async function open(input: Record<string, unknown>): Promise<{ ref: OwnedRef; game: Game; warnings: string[] } | string> {
  const name = nameOf(input);
  if (!name) return fail('needs a name (see game_list)');
  await flushGameEditors();
  const resolved = await resolveGame(name, callerOf(input));
  if ('error' in resolved) return fail(`${resolved.error} (see game_list)`);
  try {
    const { game, warnings } = await loadGame(resolved.ref);
    return { ref: resolved.ref, game, warnings };
  } catch (error) {
    return fail(`could not read game "${name}" — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A workspace path under .pigry/ with the right extension, or an error message. */
function exportPath(raw: unknown, fallback: string, ext: string): { path: string } | { error: string } {
  const path = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/\\/g, '/');
  if (!path.startsWith('.pigry/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || !path.toLowerCase().endsWith(ext)) {
    return { error: `path must stay inside .pigry/ (no "..") and end in ${ext}, e.g. ${GAMES_DIR}platformer/game${ext}` };
  }
  return { path };
}

const reviewText = (game: Game, limit = 6): string => {
  const issues = checkGame(game).filter((i) => i.severity !== 'info');
  if (issues.length === 0) return '';
  return `\nReview (${issues.length}${issues.length > limit ? `, first ${limit}` : ''}):\n${issues.slice(0, limit).map((i) => `- [${i.severity}] ${i.message}`).join('\n')}`;
};

const OPS_HELP = `Scenes are trees of nodes addressed by path ("." = the scene root, "Player/Camera"). Scripts are TypeScript or JavaScript files: export default class Player extends CharacterBody3D { ready(){} process(delta){} physicsProcess(delta){} } — the class must extend the node's type. 3D units are metres (+Y up, gravity 9.8); 2D units are pixels with +Y UP. Node types: ${Object.keys(NODE_TYPES).join(', ')}.\nOperations:\n${OP_HELP}`;

const simText = (r: SimResult, every: boolean): string => {
  const parts: string[] = [`ran ${r.frames} frames (${Math.round(r.time * 100) / 100} s of game time)`];
  if (r.compileErrors.length) parts.push(`Script compile errors:\n- ${r.compileErrors.join('\n- ')}`);
  const logs = r.logs.slice(-40);
  if (logs.length) parts.push(`Output${r.logs.length > 40 ? ` (last 40 of ${r.logs.length})` : ''}:\n${logs.map((l) => `${l.level === 'error' ? 'ERROR ' : ''}${l.text}`).join('\n')}`);
  if (r.errors.length) parts.push(`${r.errors.length} error(s) while running — fix them with game_edit (set_script).`);
  const row = (x: Record<string, unknown>): string => `- ${String(x.path)} [${String(x.type)}]${x.position ? ` at (${(x.position as number[]).join(', ')})` : ''}${x.velocity ? ` v(${(x.velocity as number[]).join(', ')})` : ''}${x.onFloor !== undefined ? ` onFloor=${String(x.onFloor)}` : ''}${x.text !== undefined ? ` text="${String(x.text)}"` : ''}`;
  const interesting = (rows: SimResult['rows']): SimResult['rows'] => rows.filter((x) => !/Shape$|^Environment$/.test(String(x.path).split('/').pop() ?? '') && !/Body$|Mesh$/.test(String(x.path).split('/').pop() ?? '')).slice(0, 60);
  if (every) for (const m of r.marks.slice(0, 12)) parts.push(`At frame ${m.frame}:\n${interesting(m.rows).map(row).join('\n')}`);
  parts.push(`Final state:\n${interesting(r.rows).map(row).join('\n')}`);
  return parts.join('\n');
};

export const GAME_TOOLS: ToolSpec[] = [
  {
    id: 'game_list',
    name: 'game_list',
    description: 'List the games saved in the workspace (.pigry/games/<owner>/) with their scene, node and script counts.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      await flushGameEditors();
      const refs = await listGameRefs();
      if (refs.length === 0) return 'No games yet. Create one with game_write (template "3d", "2d" or "empty").';
      const rows: string[] = [];
      for (const ref of refs.slice(0, 40)) {
        try {
          const { game } = await loadGame(ref);
          const nodes = Object.values(game.scenes).reduce((n, s) => n + countNodes(s), 0);
          rows.push(`- ${refKey(ref)}: "${game.title}" (${Object.keys(game.scenes).length} scenes, ${nodes} nodes, ${Object.keys(game.scripts).length} scripts)`);
        } catch {
          rows.push(`- ${refKey(ref)}: (unreadable file)`);
        }
      }
      return rows.join('\n') + (refs.length > 40 ? `\n[${refs.length - 40} more not shown]` : '');
    },
  },
  {
    id: 'game_read',
    name: 'game_read',
    description: 'Read a game: project settings, input actions, every scene as an outline (nodes with their types, properties, scripts, groups) and the list of scripts. Pass script to read one script\'s source code (with its exported variables). Always read a game before editing it.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Game name, or owner/name' }, script: { type: 'string', description: 'Optional script path to read, e.g. "scripts/player.ts"' } },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const { game } = opened;
      if (typeof input.script === 'string' && input.script) {
        const sc = game.scripts[input.script];
        if (!sc) return fail(`no script "${input.script}" (scripts: ${Object.keys(game.scripts).join(', ') || 'none'})`);
        const exp = parseExports(sc.code);
        return `${input.script}${exp.length ? ` — exported variables: ${exp.map((e) => `${e.name}=${JSON.stringify(e.default)}`).join(', ')}` : ''}\n${sc.code}`;
      }
      return `${refKey(opened.ref)}\n${summarizeGame(game)}\nScripts: ${Object.entries(game.scripts).map(([p, s]) => `${p} (${s.code.split('\n').length} lines)`).join(', ') || 'none'}${opened.warnings.length ? '\nRepaired on load:\n- ' + opened.warnings.join('\n- ') : ''}${reviewText(game)}`;
    },
  },
  {
    id: 'game_write',
    name: 'game_write',
    description: `Create a new game (or replace your own with overwrite: true), optionally building it straight away with ops. template "3d" starts with a playable third-person scene (ground, walls, crates, a player with a movement script, HUD), "2d" with a playable platformer (platforms, coins, a player with coyote-time jumping, score HUD), "empty" with one empty scene. It is saved in your own folder and shown in the Game Engine editor. ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Game name; becomes .pigry/games/<you>/<name>.game.json' },
        title: { type: 'string' },
        template: { type: 'string', enum: ['empty', '3d', '2d'] },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations to build the game (a JSON string of the array is also accepted)' },
        overwrite: { type: 'boolean', description: 'Replace an existing game of the same name in your folder (default false)' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('game_write needs a name');
      const caller = callerOf(input);
      const parsed = parseRefName(name, ['.game.json']);
      if (parsed.owner && parsed.owner !== caller) return fail(`you can only create games in your own folder (${caller}/) — change another owner's game with game_edit`);
      const ref: OwnedRef = { owner: caller, slug: parsed.slug };
      await flushGameEditors();
      if ((await listGameRefs()).some((r) => r.owner === ref.owner && r.slug === ref.slug) && input.overwrite !== true) {
        return fail(`game "${refKey(ref)}" already exists. Read it with game_read and change it with game_edit, or pass overwrite: true to replace it.`);
      }
      const template = (['empty', '3d', '2d'] as const).includes(input.template as TemplateKind) ? (input.template as TemplateKind) : 'empty';
      const { ops, errors } = input.ops === undefined ? { ops: [], errors: [] as string[] } : parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was saved\n- ${errors.join('\n- ')}`);
      const title = String(input.title ?? name).slice(0, 80);
      const game = template === 'empty' ? emptyGame(title) : templateGame(template, title);
      const result = applyGameOps(game, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveGame(ref, game, 'agent');
      return `saved ${path}\n${summarizeGame(game)}${result.log.length ? '\n' + result.log.join('\n') : ''}${reviewText(game)}\nTest it with game_run, look at it with game_preview, show it to the user with game_open.`;
    },
  },
  {
    id: 'game_edit',
    name: 'game_edit',
    description: `Change an existing game with a list of operations, applied in order and saved only if all of them work. Use set_script to create or replace scripts (always give the complete file). ${OPS_HELP}`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Game name, or owner/name' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, description: 'Operations applied in order (a JSON string of the array is also accepted)' },
      },
      required: ['name', 'ops'],
    },
    run: async (input) => {
      const { ops, errors } = parseOps(asList(input.ops));
      if (errors.length) return fail(`nothing was applied\n- ${errors.join('\n- ')}`);
      if (ops.length === 0) return fail('game_edit needs at least one operation');
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const result = applyGameOps(opened.game, ops);
      if (result.error) return fail(`${result.error}\nnothing was saved`);
      const path = await saveGame(opened.ref, opened.game, 'agent');
      return `saved ${path}\n${result.log.join('\n')}${reviewText(opened.game)}`;
    },
  },
  {
    id: 'game_run',
    name: 'game_run',
    description: 'Run the game headlessly in a sandbox for a number of fixed frames (default 120 = 2 seconds at 60 fps) and report the script output, errors and the final position/velocity of every node. Drive the game with inputs: [{frame, action, pressed}] (for example hold "move_right" from frame 0, press "jump" at frame 30). Use it to test movement, physics, collisions, signals and scripts, and fix every ERROR line before you report the game as working.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Game name, or owner/name' },
        frames: { type: 'number', description: 'Frames to run (1–3600, default 120)' },
        dt: { type: 'number', description: 'Seconds per frame (default 1/60)' },
        inputs: { type: 'array', items: { type: 'object', properties: { frame: { type: 'number' }, action: { type: 'string' }, pressed: { type: 'boolean' } }, required: ['frame', 'action', 'pressed'] }, description: 'Scripted input: press or release an input action at a frame' },
        every: { type: 'number', description: 'Also report the node state every N frames' },
        scene: { type: 'string', description: 'Start this scene instead of the main scene' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const frames = Math.min(3600, Math.max(1, Math.round(typeof input.frames === 'number' ? input.frames : 120)));
      const inputs = Array.isArray(asList(input.inputs)) ? (asList(input.inputs) as Array<Record<string, unknown>>).filter((i) => typeof i.action === 'string').map((i) => ({ frame: Math.max(0, Math.round(Number(i.frame) || 0)), action: String(i.action), pressed: i.pressed !== false })) : [];
      try {
        const result = await simulateGame(opened.game, { frames, dt: typeof input.dt === 'number' && input.dt > 0 ? Math.min(0.25, input.dt) : undefined, inputs, every: typeof input.every === 'number' ? Math.max(1, Math.round(input.every)) : 0, scene: typeof input.scene === 'string' ? input.scene : undefined });
        return `${refKey(opened.ref)}: ${simText(result, typeof input.every === 'number')}`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'game_preview',
    name: 'game_preview',
    description: 'Run the game for a number of frames (default 30) and attach a screenshot of the last frame to your next turn so you can SEE it (3D scenes, 2D scenes and UI). Pass inputs to drive the player before the picture is taken. Optionally keep the PNG with save_as (under .pigry/). Look at it, then fix what is wrong with game_edit.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Game name, or owner/name' },
        frames: { type: 'number', description: 'Frames to run before the screenshot (default 30)' },
        inputs: { type: 'array', items: { type: 'object', properties: { frame: { type: 'number' }, action: { type: 'string' }, pressed: { type: 'boolean' } }, required: ['frame', 'action', 'pressed'] } },
        scene: { type: 'string', description: 'Start this scene instead of the main scene' },
        collisions: { type: 'boolean', description: 'Draw the collision shapes' },
        width: { type: 'number' },
        height: { type: 'number' },
        save_as: { type: 'string', description: 'Optional .png path under .pigry/ to keep the image' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const inputs = Array.isArray(asList(input.inputs)) ? (asList(input.inputs) as Array<Record<string, unknown>>).filter((i) => typeof i.action === 'string').map((i) => ({ frame: Math.max(0, Math.round(Number(i.frame) || 0)), action: String(i.action), pressed: i.pressed !== false })) : [];
      try {
        const r = await simulateGame(opened.game, { frames: Math.min(1800, Math.max(1, Math.round(typeof input.frames === 'number' ? input.frames : 30))), inputs, capture: true, scene: typeof input.scene === 'string' ? input.scene : undefined, debugShapes: input.collisions === true, width: typeof input.width === 'number' ? Math.min(1920, Math.max(160, input.width)) : opened.game.settings.width > 960 ? 960 : opened.game.settings.width, height: typeof input.height === 'number' ? Math.min(1080, Math.max(120, input.height)) : opened.game.settings.width > 960 ? Math.round((960 * opened.game.settings.height) / opened.game.settings.width) : opened.game.settings.height });
        if (!r.dataUrl) return fail('the game could not be drawn (WebGL is unavailable?)');
        queueImage(r.dataUrl, agentOf(input));
        let saved = '';
        if (input.save_as) {
          const target = exportPath(input.save_as, '', '.png');
          if ('error' in target) return fail(target.error);
          await writeWorktreeBinary(target.path, r.dataUrl.slice(r.dataUrl.indexOf(',') + 1));
          saved = ` and saved to ${target.path}`;
        }
        const errs = r.errors.length || r.compileErrors.length ? `\nProblems: ${[...r.compileErrors, ...r.errors].slice(0, 6).join(' | ')}` : '';
        return `screenshot of ${refKey(opened.ref)} after ${r.frames} frames is attached to your next turn${saved}. Look at it, then fix anything off with game_edit.${errs}`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'game_export',
    name: 'game_export',
    description: 'Export the game as one self-contained HTML file that runs in any browser (three.js and the engine are inlined; keyboard and mouse input work). Saved under .pigry/ — by default next to the game file.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Game name, or owner/name' }, path: { type: 'string', description: 'Optional output path under .pigry/ ending in .html' } },
      required: ['name'],
    },
    run: async (input) => {
      const opened = await open(input);
      if (typeof opened === 'string') return opened;
      const target = exportPath(input.path, gamePath(opened.ref).replace(/\.game\.json$/, '.html'), '.html');
      if ('error' in target) return fail(target.error);
      try {
        const { html, errors } = await exportGameHtml(opened.game);
        if (errors.length) return fail(`the scripts have errors, nothing was exported:\n- ${errors.join('\n- ')}`);
        await writeWorktreeFile(target.path, html);
        return `saved ${target.path} (${Math.round(html.length / 1024)} KB). Open it in a browser to play; arrow keys / WASD / Space are the default controls.`;
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'game_open',
    name: 'game_open',
    description: 'Open a game in the Game Engine editor so the user can see the scenes, edit them and press Play.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Game name, or owner/name' } }, required: ['name'] },
    run: async (input) => {
      const name = nameOf(input);
      if (!name) return fail('game_open needs a name');
      const resolved = await resolveGame(name, callerOf(input));
      if ('error' in resolved) return fail(`${resolved.error} (see game_list)`);
      requestOpenGame(refKey(resolved.ref));
      return `opened "${refKey(resolved.ref)}" in the Game Engine editor`;
    },
  },
];
