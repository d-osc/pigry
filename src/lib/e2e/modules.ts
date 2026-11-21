/** A tiny CommonJS module system for specs: `import x from './helpers'`, `require('./data.json')`, TypeScript
 * helpers, page objects. Relative files are read from the workspace up front (so `require` stays synchronous at
 * run time) and ES-module syntax is compiled to CommonJS by the host's transpiler. Pure — no Tauri, no DOM. */

export interface ModuleHost {
  /** Reads a workspace file (null when it does not exist). */
  readFile(path: string): Promise<string | null>;
  /** Compiles ES modules / TypeScript to CommonJS JavaScript. */
  transpile?: (source: string) => Promise<string>;
  /** Real Node `require` for built-ins and packages (the headless CLI only). */
  nodeRequire?: (name: string) => unknown;
  /** Packages available everywhere ({ lodash: Cypress._ … }). */
  shims?: Record<string, unknown>;
}

export interface ModuleGraph {
  entryCode: string;
  /** compiled code (or JSON text) of every relative file reachable from the entry, by normalized path */
  files: Map<string, { code: string; json: boolean }>;
}

const EXTENSIONS = ['', '.js', '.ts', '.mjs', '.cjs', '.json', '.cy.js', '/index.js', '/index.ts'];
const hasEsm = (src: string): boolean => /^\s*(import\s|import\{|export\s|export\{)/m.test(src);
const IMPORT_RE = /(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

export const dirname = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

export function joinPath(base: string, rel: string): string {
  const out = base ? base.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

export async function resolveFile(host: ModuleHost, from: string, spec: string): Promise<{ path: string; text: string } | null> {
  const base = joinPath(dirname(from), spec);
  for (const ext of EXTENSIONS) {
    const text = await host.readFile(base + ext);
    if (text !== null) return { path: base + ext, text };
  }
  return null;
}

/** Reads the entry's relative imports (recursively) and compiles what needs compiling. */
export async function loadModuleGraph(host: ModuleHost, entryPath: string, entrySource: string): Promise<ModuleGraph> {
  const compile = async (path: string, text: string): Promise<{ code: string; json: boolean }> => {
    if (/\.json$/i.test(path)) return { code: text, json: true };
    if (/\.(ts|mts|cts)$/.test(path) || hasEsm(text)) {
      if (!host.transpile) throw new Error(`${path} uses TypeScript or import/export, but this run has no compiler`);
      return { code: await host.transpile(text), json: false };
    }
    return { code: text, json: false };
  };
  const graph: ModuleGraph = { entryCode: (/\.(ts|mts|cts)$/.test(entryPath) || hasEsm(entrySource)) && host.transpile ? await host.transpile(entrySource) : entrySource, files: new Map() };
  const queue: Array<{ path: string; code: string }> = [{ path: entryPath, code: graph.entryCode }];
  while (queue.length) {
    const { path, code } = queue.shift()!;
    for (const m of code.matchAll(IMPORT_RE)) {
      const spec = m[2];
      const found = await resolveFile(host, path, spec);
      if (!found) continue; // reported by require() when (and if) the code actually runs it
      if (graph.files.has(found.path)) continue;
      const compiled = await compile(found.path, found.text);
      graph.files.set(found.path, compiled);
      if (!compiled.json) queue.push({ path: found.path, code: compiled.code });
    }
  }
  return graph;
}

export type ModuleScope = { names: string[]; values: unknown[] };

/** `require` for code living at `fromPath`: relative files from the graph, shims, and Node packages when available. */
export function makeRequire(graph: ModuleGraph, host: ModuleHost, scope: ModuleScope, fromPath: string): (name: string) => unknown {
  const cache = new Map<string, { exports: unknown }>();
  const requireFrom = (from: string) => (name: string): unknown => {
    if (!/^\.{1,2}\//.test(name)) {
      if (host.shims && name in host.shims) return host.shims[name];
      if (host.nodeRequire) return host.nodeRequire(name);
      throw new Error(`Cannot find module '${name}'. Specs can import relative files (./helpers), JSON and TypeScript, and lodash — other packages need the headless CLI (npm run e2e), which runs in Node.`);
    }
    const base = joinPath(dirname(from), name);
    const path = EXTENSIONS.map((e) => base + e).find((p) => graph.files.has(p));
    if (!path) throw new Error(`Cannot find module '${name}' imported from ${from}`);
    const cached = cache.get(path);
    if (cached) return cached.exports;
    const file = graph.files.get(path)!;
    const module = { exports: {} as unknown };
    cache.set(path, module);
    if (file.json) { module.exports = JSON.parse(file.code); return module.exports; }
    const fn = new Function('module', 'exports', 'require', ...scope.names, `"use strict";\n${file.code}\n//# sourceURL=pigry-module-${path.replace(/[^\w.-]+/g, '_')}`);
    fn(module, module.exports, requireFrom(path), ...scope.values);
    return module.exports;
  };
  return requireFrom(fromPath);
}
