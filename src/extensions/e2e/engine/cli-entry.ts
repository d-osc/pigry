/** Entry of the headless E2E CLI bundle (scripts/e2e-cli.mjs): the same runner and report code the app uses,
 * without Tauri or the DOM. */
export { runSpec, DEFAULT_CONFIG } from './runner';
export type { Driver, E2eConfig, RunEvent, SpecResult } from './runner';
export { analyticsOf, checkSpecSource, mergeConfig, resultSummary, resultToJUnit, resultToMarkdown, runToHtml, shardOf, buildReplay, mergeResults, runPointOf } from './report';
export { CYPRESS_CONFIG_FILES, loadCypressConfig } from './configFile';
export { globToRegex } from './runner';
