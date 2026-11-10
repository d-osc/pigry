/** Team/agent-scoped storage paths inside the repo — everything the agent
 * system persists lives under `.pigry/...` so it is versionable alongside
 * the code:
 *
 *   .pigry/agents.json                                     ALL agent definitions (registry + markdown)
 *   .pigry/teams/<team>/chat/<id>.json                     team chat sessions
 *   .pigry/teams/<team>/memory.vector.json                 shared team memory
 *   .pigry/teams/<team>/agents/<username>/chat/<id>.json   private chat
 *   .pigry/teams/<team>/agents/<username>/memory.vector.json  private memory
 *
 * Legacy layout (agents.json + AGENT.md per team folder) is still read for
 * migration but new writes go to the consolidated .pigry/agents.json.
 */

/** Consolidated agent store — registry + definitions in one file. */
export const AGENTS_FILE = '.pigry/agents.json';

/** Reduces a team name / username to one safe path segment (keeps unicode). */
function segment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/]+/g, ' ')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim();
  return cleaned || 'unknown';
}

export function teamRoot(team: string): string {
  return `.pigry/teams/${segment(team)}`;
}

/** Team-wide chat sessions directory (trailing slash). */
export function teamChatDir(team: string): string {
  return `${teamRoot(team)}/chat/`;
}

/** Registry file listing the team's agents — legacy per-team location,
 * kept only for migration reads. New writes go to AGENTS_FILE. */
export function teamAgentsFile(team: string): string {
  return `${teamRoot(team)}/agents.json`;
}

/** Legacy per-agent definition file (pre-consolidation layout). */
export function agentDefinitionFile(team: string, username: string): string {
  return `${agentRoot(team, username)}/AGENT.md`;
}

/** Memory scope string for the memory_* Tauri commands. */
export function teamMemoryScope(team: string): string {
  return `teams/${segment(team)}`;
}

export function agentRoot(team: string, username: string): string {
  return `${teamRoot(team)}/agents/${segment(username)}`;
}

/** One agent's private chat sessions directory (trailing slash). */
export function agentChatDir(team: string, username: string): string {
  return `${agentRoot(team, username)}/chat/`;
}

/** One agent's private vector memory store. */
export function agentMemoryFile(team: string, username: string): string {
  return `${agentRoot(team, username)}/memory.vector.json`;
}

/** Memory scope for the memory_* Tauri commands: team store, or the agent's
 * private store when `agent` is given. Null = the project-wide store. */
export function memoryScope(team?: string, agent?: string): string | null {
  if (!team) return null;
  return agent
    ? `${teamMemoryScope(team)}/agents/${segment(agent)}`
    : teamMemoryScope(team);
}
