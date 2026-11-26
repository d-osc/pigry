/** Features that are built but switched off for now. Flip a flag back to true to bring the feature back:
 * the code, its tests (skipped while off) and its stored settings are all kept. */

/** "Provider CLI": chat through installed coding-agent CLIs (Claude Code, Codex, Antigravity, …).
 * Off: no CLI scan runs, and the model picker and Settings → AI Provider list API providers only. */
export const CLI_PROVIDERS_ENABLED = false;

/** Settings → "Import agents": copy skills, instructions and MCP servers from Claude Code, Codex and Antigravity. */
export const IMPORT_AGENTS_ENABLED = false;
