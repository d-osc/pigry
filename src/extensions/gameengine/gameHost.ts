/** Runs a Game inside a sandboxed iframe. The game's scripts (written by the user or an agent) execute in an iframe with
 * `sandbox="allow-scripts"` and no same-origin access, so they cannot reach the app, its files or the native commands;
 * the only channel is postMessage. The iframe gets three.js and the engine runtime inline. Also builds the standalone
 * HTML export and the headless simulations that the agent tools use. Browser only. */
import runtimeSource from './engineRuntime.js?raw';
import { transpileTs } from '../e2e/engine/transpile';
import type { Game } from './game';

export interface GameMessage { pigryGame: true; type: string; [key: string]: unknown }

let threeCache: Promise<{ module: string; core: string }> | null = null;
/** The three.js build as source text (loaded once, only when a game is played or exported). */
async function threeSources(): Promise<{ module: string; core: string }> {
  threeCache ??= Promise.all([
    import('../../../node_modules/three/build/three.module.js?raw'),
    import('../../../node_modules/three/build/three.core.js?raw'),
  ]).then(([m, c]) => ({ module: (m as { default: string }).default, core: (c as { default: string }).default }));
  return threeCache;
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Compiles every script to CommonJS JavaScript (types are stripped, nothing is type-checked). */
export async function compileScripts(game: Game): Promise<{ compiled: Record<string, string>; errors: string[] }> {
  const compiled: Record<string, string> = {}, errors: string[] = [];
  for (const [path, script] of Object.entries(game.scripts)) {
    try { compiled[path] = await transpileTs(script.code); } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { compiled, errors };
}

const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');

export interface PageOptions {
  /** Keep the loop idle: the parent drives the game with "simulate" messages. */
  headless?: boolean;
  debugShapes?: boolean;
  scene?: string;
  width?: number;
  height?: number;
  /** A standalone export runs by itself and has no parent to talk to. */
  standalone?: boolean;
}

const BOOTSTRAP = `
const OPTS = __OPTS__;
const post = (m) => { try { parent.postMessage({ pigryGame: true, ...m }, '*'); } catch (e) {} };
const canvas = document.getElementById('c'), ui = document.getElementById('ui'), stage = document.getElementById('stage');
let paused = false, quitting = false;
const engine = createEngine(THREE, { mode: 'play', debugShapes: OPTS.debugShapes, onLog: (level, text) => post({ type: 'log', level, text }), onQuit: () => { quitting = true; post({ type: 'quit' }); } });
const fail = (text) => post({ type: 'log', level: 'error', text });
window.addEventListener('error', (e) => fail('Uncaught: ' + e.message));
window.addEventListener('unhandledrejection', (e) => fail('Unhandled promise rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
try {
  engine.load(GAME);
  const w = OPTS.width || stage.clientWidth || GAME.settings.width, h = OPTS.height || stage.clientHeight || GAME.settings.height;
  engine.attachRenderer({ canvas, width: w, height: h, pixelRatio: OPTS.headless ? 1 : Math.min(2, window.devicePixelRatio || 1), ui });
  engine.loadScripts(SCRIPTS);
  engine.start(OPTS.scene);
  engine.render();
} catch (e) { fail('Could not start the game: ' + (e && e.message ? e.message : e)); }
const refit = () => { if (OPTS.headless) return; engine.resize(stage.clientWidth, stage.clientHeight); };
window.addEventListener('resize', refit);
const keyBlock = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
window.addEventListener('keydown', (e) => { if (keyBlock.has(e.code)) e.preventDefault(); if (e.repeat) return; engine.input._press(e.code); engine.dispatchInput({ type: 'key', code: e.code, key: e.key, pressed: true }); });
window.addEventListener('keyup', (e) => { engine.input._release(e.code); engine.dispatchInput({ type: 'key', code: e.code, key: e.key, pressed: false }); });
const mouse = (e) => { const r = canvas.getBoundingClientRect(); engine.input.mouse.set(e.clientX - r.left, e.clientY - r.top); };
canvas.addEventListener('pointermove', (e) => { mouse(e); engine.dispatchInput({ type: 'mouseMotion', x: e.clientX, y: e.clientY }); });
canvas.addEventListener('pointerdown', (e) => { canvas.focus(); mouse(e); engine.input._press('Mouse' + e.button); engine.dispatchInput({ type: 'mouseButton', button: e.button, pressed: true }); });
canvas.addEventListener('pointerup', (e) => { engine.input._release('Mouse' + e.button); engine.dispatchInput({ type: 'mouseButton', button: e.button, pressed: false }); });
window.addEventListener('blur', () => { engine.input.down.clear(); });
let last = performance.now(), fpsFrames = 0, fpsAt = last;
function loop(now) {
  if (quitting) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!paused) engine.step(dt);
  fpsFrames++;
  if (now - fpsAt >= 500) { engine.fps = Math.round((fpsFrames * 1000) / (now - fpsAt)); post({ type: 'stats', fps: engine.fps, nodes: [...engine.tree.root.walk()].length - 1, frame: engine.frame }); fpsFrames = 0; fpsAt = now; }
  requestAnimationFrame(loop);
}
if (!OPTS.headless) requestAnimationFrame(loop);
const rows = () => { try { return engine.snapshot(); } catch (e) { return []; } };
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || !m.pigryGame) return;
  if (m.type === 'pause') paused = true;
  else if (m.type === 'resume') paused = false;
  else if (m.type === 'press') engine.input.pressAction(m.action);
  else if (m.type === 'release') engine.input.releaseAction(m.action);
  else if (m.type === 'capture') post({ type: 'frame', id: m.id, dataUrl: engine.captureFrame() });
  else if (m.type === 'snapshot') post({ type: 'snapshot', id: m.id, rows: rows() });
  else if (m.type === 'simulate') {
    const dt = m.dt || 1 / 60, inputs = (m.inputs || []).slice().sort((a, b) => a.frame - b.frame);
    let k = 0; const marks = [];
    for (let f = 0; f < m.frames; f++) {
      while (k < inputs.length && inputs[k].frame <= f) { const i = inputs[k++]; if (i.pressed) engine.input.pressAction(i.action); else engine.input.releaseAction(i.action); }
      engine.step(dt);
      if (m.every && (f + 1) % m.every === 0) marks.push({ frame: f + 1, rows: rows() });
      if (engine.quit) break;
    }
    post({ type: 'sim-result', id: m.id, frames: engine.frame, time: engine.time, rows: rows(), marks, errors: engine.errors, dataUrl: m.capture ? engine.captureFrame() : null });
  }
});
post({ type: 'ready' });
`;

/** The complete HTML document of a game: three.js and the runtime inline, the game and its compiled scripts as data. */
export async function buildGameHtml(game: Game, compiled: Record<string, string>, opts: PageOptions = {}): Promise<string> {
  const three = await threeSources();
  const moduleText = three.module.split("'./three.core.js'").join("'three-core'");
  const importMap = JSON.stringify({ imports: { three: `data:text/javascript;base64,${toBase64(moduleText)}`, 'three-core': `data:text/javascript;base64,${toBase64(three.core)}` } });
  const bootstrap = BOOTSTRAP.replace('__OPTS__', safeJson({ headless: !!opts.headless, debugShapes: !!opts.debugShapes, scene: opts.scene ?? null, width: opts.width ?? null, height: opts.height ?? null, standalone: !!opts.standalone }));
  const title = game.title.replace(/[<>&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}#stage{position:relative;width:100%;height:100%}#c{width:100%;height:100%;display:block;outline:none}#ui{position:absolute;inset:0;pointer-events:none;overflow:hidden}</style></head>
<body><div id="stage"><canvas id="c" tabindex="0"></canvas><div id="ui"></div></div>
<script type="importmap">${importMap}</script>
<script type="module">
import * as THREE from 'three';
const GAME = ${safeJson(game)};
const SCRIPTS = ${safeJson(compiled)};
${runtimeSource}
${bootstrap}
</script></body></html>`;
}

export interface PlayHandle {
  iframe: HTMLIFrameElement;
  send(message: Record<string, unknown>): void;
  dispose(): void;
}

/** Starts a game in `container` and reports its messages. Rejects when the scripts cannot be compiled. */
export async function playGame(game: Game, container: HTMLElement, onMessage: (m: GameMessage) => void, opts: PageOptions = {}): Promise<PlayHandle> {
  const { compiled, errors } = await compileScripts(game);
  for (const text of errors) onMessage({ pigryGame: true, type: 'log', level: 'error', text: `Compile error in ${text}` });
  const html = await buildGameHtml(game, compiled, opts);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', 'Game');
  iframe.className = 'gm__frame';
  iframe.srcdoc = html;
  const listener = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow || !event.data || event.data.pigryGame !== true) return;
    onMessage(event.data as GameMessage);
  };
  window.addEventListener('message', listener);
  container.appendChild(iframe);
  return {
    iframe,
    send: (message) => iframe.contentWindow?.postMessage({ pigryGame: true, ...message }, '*'),
    dispose: () => { window.removeEventListener('message', listener); iframe.remove(); },
  };
}

export interface SimResult {
  frames: number;
  time: number;
  rows: Array<Record<string, unknown>>;
  marks: Array<{ frame: number; rows: Array<Record<string, unknown>> }>;
  logs: Array<{ level: string; text: string }>;
  errors: string[];
  dataUrl: string | null;
  compileErrors: string[];
}

export interface SimOptions {
  frames: number;
  dt?: number;
  inputs?: Array<{ frame: number; action: string; pressed: boolean }>;
  every?: number;
  capture?: boolean;
  scene?: string;
  width?: number;
  height?: number;
  debugShapes?: boolean;
  timeoutMs?: number;
}

/** Runs the game headlessly in a hidden sandboxed iframe for a number of fixed frames and reports what happened. */
export async function simulateGame(game: Game, opts: SimOptions): Promise<SimResult> {
  const { compiled, errors: compileErrors } = await compileScripts(game);
  const width = opts.width ?? 640, height = opts.height ?? 360;
  const html = await buildGameHtml(game, compiled, { headless: true, scene: opts.scene, width, height, debugShapes: opts.debugShapes });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0;visibility:hidden`;
  const logs: Array<{ level: string; text: string }> = [];
  return new Promise<SimResult>((resolve, reject) => {
    const cleanup = (): void => { window.removeEventListener('message', listener); window.clearTimeout(timer); iframe.remove(); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error(`the game did not respond within ${Math.round((opts.timeoutMs ?? 30000) / 1000)} s (an infinite loop in a script?)`)); }, opts.timeoutMs ?? 30000);
    const listener = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow || !event.data || event.data.pigryGame !== true) return;
      const m = event.data as GameMessage;
      if (m.type === 'log') logs.push({ level: String(m.level), text: String(m.text) });
      else if (m.type === 'ready') iframe.contentWindow?.postMessage({ pigryGame: true, type: 'simulate', id: 1, frames: opts.frames, dt: opts.dt ?? 1 / 60, inputs: opts.inputs ?? [], every: opts.every ?? 0, capture: !!opts.capture }, '*');
      else if (m.type === 'sim-result') {
        cleanup();
        resolve({ frames: m.frames as number, time: m.time as number, rows: m.rows as SimResult['rows'], marks: m.marks as SimResult['marks'], logs, errors: m.errors as string[], dataUrl: (m.dataUrl as string | null) ?? null, compileErrors });
      }
    };
    window.addEventListener('message', listener);
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

/** The game as one self-contained HTML file that runs in any browser (three.js and the engine are inlined). */
export async function exportGameHtml(game: Game): Promise<{ html: string; errors: string[] }> {
  const { compiled, errors } = await compileScripts(game);
  return { html: await buildGameHtml(game, compiled, { standalone: true }), errors };
}

