/** Reads a Cypress project's own cypress.config.js / .ts (defineConfig({ e2e: { baseUrl, setupNodeEvents, … } }))
 * so an existing Cypress setup works here unchanged. Pure — the caller supplies how files are read. */
import { loadModuleGraph, makeRequire, type ModuleHost } from './modules';
import type { E2eConfig } from './runner';

export const CYPRESS_CONFIG_FILES = ['cypress.config.js', 'cypress.config.ts', 'cypress.config.mjs', 'cypress.config.cjs'];

export interface CypressConfigFile {
  path: string;
  settings: Partial<E2eConfig>;
  /** `setupNodeEvents(on, config)` — tasks and run events. */
  setupNodeEvents?: (on: (event: string, handler: unknown) => void, config: Record<string, unknown>) => unknown;
  specPattern?: string[];
  excludeSpecPattern?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] | undefined => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/** Evaluates the config file and maps its (e2e) options onto the runner's settings. */
export async function loadCypressConfig(host: ModuleHost, path: string, source: string): Promise<CypressConfigFile> {
  const shimHost: ModuleHost = { ...host, shims: { ...host.shims, cypress: { defineConfig: (c: unknown) => c }, 'cypress/react': {}, 'cypress/vue': {} } };
  const graph = await loadModuleGraph(shimHost, path, source);
  const module = { exports: {} as unknown };
  const req = makeRequire(graph, shimHost, { names: [], values: [] }, path);
  new Function('module', 'exports', 'require', `"use strict";\n${graph.entryCode}`)(module, module.exports, req);
  const exp = module.exports as unknown;
  const raw = isObj(exp) && isObj(exp.default) ? exp.default : exp;
  if (!isObj(raw)) throw new Error(`${path} must export the configuration (defineConfig({ e2e: { … } }))`);
  const e2e = isObj(raw.e2e) ? raw.e2e : {};
  const pick = (key: string): unknown => (e2e[key] !== undefined ? e2e[key] : raw[key]);
  const settings: Partial<E2eConfig> = {};
  const num = (key: string, into: keyof E2eConfig) => { const v = pick(key); if (typeof v === 'number') (settings as Record<string, unknown>)[into] = v; };
  const bool = (key: string, into: keyof E2eConfig) => { const v = pick(key); if (typeof v === 'boolean') (settings as Record<string, unknown>)[into] = v; };
  if (typeof pick('baseUrl') === 'string') settings.baseUrl = String(pick('baseUrl'));
  num('viewportWidth', 'viewportWidth'); num('viewportHeight', 'viewportHeight'); num('defaultCommandTimeout', 'defaultCommandTimeout'); num('pageLoadTimeout', 'pageLoadTimeout');
  num('responseTimeout', 'responseTimeout'); num('animationDistanceThreshold', 'animationDistanceThreshold');
  bool('video', 'video'); bool('screenshotOnRunFailure', 'screenshotOnRunFailure'); bool('chromeWebSecurity', 'chromeWebSecurity'); bool('includeShadowDom', 'includeShadowDom');
  bool('waitForAnimations', 'waitForAnimations'); bool('testIsolation', 'testIsolation');
  const retries = pick('retries');
  if (typeof retries === 'number') settings.retries = retries; else if (isObj(retries) && typeof retries.runMode === 'number') settings.retries = retries.runMode;
  const env = pick('env');
  if (isObj(env)) settings.env = env;
  const support = pick('supportFile');
  if (typeof support === 'string') settings.supportFile = support;
  const sb = pick('scrollBehavior');
  if (sb === 'top' || sb === 'bottom' || sb === 'nearest' || sb === 'center') settings.scrollBehavior = sb;
  const setup = typeof e2e.setupNodeEvents === 'function' ? e2e.setupNodeEvents : typeof raw.setupNodeEvents === 'function' ? raw.setupNodeEvents : undefined;
  return {
    path, settings, specPattern: strList(pick('specPattern')), excludeSpecPattern: strList(pick('excludeSpecPattern')),
    setupNodeEvents: setup as CypressConfigFile['setupNodeEvents'],
  };
}
