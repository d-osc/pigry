/** Agents / Hooks / Plugins stores and the project instructions file —
 * backing the AI Agent panel tabs. Everything here feeds the agent context
 * (lib consumers in AiAgentPanel.send) and runs real hook commands through
 * the integrated terminal.
 */
import { newId } from './aiProviders';
import {
  deleteWorktreeFile,
  getFileTree,
  readWorktreeFile,
  writeWorktreeFile,
  terminalRun,
} from './tauriClient';
import { AGENTS_FILE, agentDefinitionFile } from './teamStore';

/* ---- Project instructions (.pigry/instructions.md) ---- */

export const INSTRUCTIONS_PATH = '.pigry/instructions.md';

export async function readInstructions(): Promise<string> {
  try {
    const file = await readWorktreeFile(INSTRUCTIONS_PATH);
    return file.binary || file.tooLarge ? '' : file.content;
  } catch {
    return '';
  }
}

export async function saveInstructions(content: string): Promise<void> {
  await writeWorktreeFile(INSTRUCTIONS_PATH, content);
}

/* ---- Agents (sub-agent definitions announced to the model) ---- */

export interface AgentEntry {
  id: string;
  name: string;
  /** @handle shown next to the name. */
  username: string;
  /** Job title / role (e.g. "Senior QA Engineer"). */
  role: string;
  /** Team the agent belongs to (optional). */
  team?: string;
  /** Provider whose model this agent chats through (optional). */
  providerId?: string;
  /** Model id the agent uses (optional — falls back to the global active). */
  model?: string;
  /** Avatar image (data URL) — optional. */
  avatar?: string;
  description: string;
  enabled: boolean;
  /** Tool ids (lib/agentTools) this agent may use; empty = inherits all. */
  tools: string[];
  /** Skill names (.pigry/skills/*.md) this agent uses. */
  skills: string[];
  /** MCP server names this agent may talk to. */
  mcpServers: string[];
  /** Seeded by the app as a menu's default agent (not user-created). */
  builtIn?: boolean;
  /** Built-in tier: 'default' = per-menu main agent (answers untagged
   * turns), 'base' = pigry-provided specialist (@tag to use). Extension
   * (user-created/imported) agents have no tier. */
  tier?: 'default' | 'base';
}

const AGENTS_KEY = 'pigry:agents';

/** The workspace agent teams — offered in the Add agent form. */
export const AGENT_TEAMS = [
  'Explorer',
  'Commit graph',
  'Merge branch',
  'Push Commits',
  'Stashes Code',
  'Cherry Pick',
  'Branches',
  'Working changes',
  'Copilot',
  'Pull requests',
  'Releases',
  'Issues',
  'Actions',
  'Projects',
  'Wiki',
  'Security and quality',
  'Insights',
  'Browser',
  'Container',
] as const;

/** Workspace screen id -> the team agents created there belong to. */
const SCREEN_TEAM: Record<string, string> = {
  explorer: 'Explorer',
  'commit-graph': 'Commit graph',
  'working-changes': 'Working changes',
  'merge-branch': 'Merge branch',
  'push-commits': 'Push Commits',
  stashes: 'Stashes Code',
  'cherry-pick': 'Cherry Pick',
  branches: 'Branches',
  'ai-agent': 'Copilot',
  'pull-requests': 'Pull requests',
  releases: 'Releases',
  issues: 'Issues',
  actions: 'Actions',
  projects: 'Projects',
  wiki: 'Wiki',
  security: 'Security and quality',
  insights: 'Insights',
};

/** Default team for an agent created while `screen` is the active menu. */
export function teamForScreen(screen: string | null | undefined): string | undefined {
  if (!screen) return undefined;
  return SCREEN_TEAM[screen];
}

export function normalizeAgents(list: unknown[]): AgentEntry[] {
  return (list as Partial<AgentEntry>[])
    .filter((entry) => String(entry?.name ?? '').trim())
    .map((entry) => ({
      id: String(entry.id ?? newId('agent')),
      name: String(entry.name),
      username: String(entry.username ?? ''),
      role: String(entry.role ?? ''),
      team: typeof entry.team === 'string' && entry.team ? entry.team : undefined,
      providerId: typeof entry.providerId === 'string' && entry.providerId ? entry.providerId : undefined,
      model: typeof entry.model === 'string' && entry.model ? entry.model : undefined,
      avatar: typeof entry.avatar === 'string' ? entry.avatar : undefined,
      description: String(entry.description ?? ''),
      enabled: entry.enabled !== false,
      tools: Array.isArray(entry.tools) ? entry.tools.map(String) : [],
      skills: Array.isArray(entry.skills) ? entry.skills.map(String) : [],
      mcpServers: Array.isArray(entry.mcpServers) ? entry.mcpServers.map(String) : [],
      builtIn: entry.builtIn === true,
      tier: entry.tier === 'default' || entry.tier === 'base' ? entry.tier : undefined,
    }));
}

export function loadAgents(): AgentEntry[] {
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    if (!raw) return [];
    // Built-in agents (tiers 1-2) are hard-coded and never stored here.
    return normalizeAgents(JSON.parse(raw)).filter((agent) => !agent.builtIn);
  } catch {
    return [];
  }
}

/** Human-readable agent definition written as AGENT.md next to the
 * agent's private store. */
function agentMarkdown(agent: AgentEntry): string {
  const lines = [
    `# ${agent.name}${agent.username ? ` (@${agent.username})` : ''}`,
    '',
    agent.role ? `**Job title:** ${agent.role}\n` : '',
    agent.team ? `**Team:** ${agent.team}\n` : '',
    agent.providerId && agent.model ? `**Model:** ${agent.providerId} · ${agent.model}\n` : '',
    '',
    '## Description',
    '',
    agent.description || '_(no description)_',
    '',
    '## Tools',
    '',
    agent.tools.length > 0 ? agent.tools.map((t) => `- ${t}`).join('\n') : '_inherits all tools_',
    '',
    '## Skills',
    '',
    agent.skills.length > 0 ? agent.skills.map((sk) => `- ${sk}`).join('\n') : '_none_',
    '',
    '## MCP servers',
    '',
    agent.mcpServers.length > 0 ? agent.mcpServers.map((m) => `- ${m}`).join('\n') : '_none_',
    '',
  ];
  return lines.join('\n');
}

/** Reads ALL agent definitions from the consolidated .pigry/agents.json,
 * falling back to the legacy per-team layout (.pigry/teams/<team>/agents.json)
 * when the consolidated file does not exist yet. */
async function readAllStoredAgents(): Promise<Array<Partial<AgentEntry> & { definition?: string }>> {
  try {
    const raw = await readWorktreeFile(AGENTS_FILE);
    return JSON.parse(raw.content);
  } catch {
    // Legacy fallback: merge every .pigry/teams/*/agents.json found.
    try {
      const tree = await getFileTree();
      const legacyPaths = tree.entries.filter(
        (p) => p.startsWith('.pigry/teams/') && p.endsWith('/agents.json'),
      );
      const merged: Array<Partial<AgentEntry> & { definition?: string }> = [];
      for (const path of legacyPaths) {
        try {
          const raw = await readWorktreeFile(path);
          merged.push(...(JSON.parse(raw.content) as Array<Partial<AgentEntry>>));
        } catch {
          // skip unreadable legacy file
        }
      }
      return merged;
    } catch {
      return [];
    }
  }
}

/** Reads the team's agents from the consolidated .pigry/agents.json;
 * null when the store has no agents for this team yet. */
export async function hydrateTeamAgents(team: string): Promise<AgentEntry[] | null> {
  const all = await readAllStoredAgents();
  const mine = all.filter((agent) => (agent.team ?? '') === team);
  return mine.length > 0 ? normalizeAgents(all.filter((agent) => agent.team === team)) : null;
}

/** Consolidated repo mirror: every agent (all teams) with its AGENT.md
 * definition embedded as a `definition` field — one file, nothing scattered.
 * Agents from other teams already in the file stay untouched. */
export async function mirrorAgentsToRepo(agents: AgentEntry[]): Promise<void> {
  try {
    const existing = await readAllStoredAgents();
    const updatedIds = new Set(agents.map((agent) => String(agent.id)));
    const kept = existing.filter((a) => !updatedIds.has(String(a.id)));
    const merged = agents.map((agent) => ({
      ...agent,
      definition: agentMarkdown(agent),
    }));
    await writeWorktreeFile(AGENTS_FILE, JSON.stringify([...kept, ...merged], null, 2));
  } catch {
    // read-only repo — localStorage remains the source of truth
  }
}

/** Reads the consolidated .pigry/agents.json. Empty when absent. */
export async function hydrateAgentsFromRepo(): Promise<AgentEntry[]> {
  try {
    const raw = await readWorktreeFile(AGENTS_FILE);
    return normalizeAgents(JSON.parse(raw.content));
  } catch {
    return [];
  }
}

/** Seeds localStorage from the consolidated repo file when empty (migrates
 * the legacy per-team layout too), then returns the active list. */
export async function hydrateAgentsIfEmpty(): Promise<AgentEntry[]> {
  const local = loadAgents();
  if (local.length > 0) return local;
  let fromRepo = await hydrateAgentsFromRepo();
  if (fromRepo.length === 0) {
    const legacy = await readAllStoredAgents();
    if (legacy.length === 0) return [];
    fromRepo = normalizeAgents(legacy);
    await mirrorAgentsToRepo(fromRepo);
  }
  saveAgents(fromRepo);
  return fromRepo;
}

/** Consolidates the team's agents into .pigry/agents.json — registry and
 * AGENT.md definition live together as a `definition` field per agent, so
 * nothing is scattered across per-agent folders anymore. Existing agents of
 * OTHER teams in the file are preserved. */
export async function saveTeamAgents(team: string, agents: AgentEntry[]): Promise<void> {
  const all = await readAllStoredAgents();
  const others = all.filter((agent) => (agent.team ?? '') !== team);
  const consolidated = [
    ...others,
    ...agents.map((agent) => ({ ...agent, definition: agentMarkdown(agent) })),
  ];
  await writeWorktreeFile(AGENTS_FILE, JSON.stringify(consolidated, null, 2));
}

/** Legacy cleanup: removes AGENT.md files left in the old per-agent folders. */
export async function deleteTeamAgentDefinitions(
  team: string,
  handles: string[],
): Promise<void> {
  for (const handle of handles) {
    try {
      await deleteWorktreeFile(agentDefinitionFile(team, handle));
    } catch {
      // already absent
    }
  }
}

/** One call the Agents tab uses to persist: mirrors agents.json + AGENT.md
 * files, and removes definitions of agents deleted from the list. */
export async function syncTeamAgents(
  team: string,
  removedHandles: string[],
  agents: AgentEntry[],
): Promise<void> {
  await saveTeamAgents(team, agents);
  await deleteTeamAgentDefinitions(team, removedHandles);
}

export function saveAgents(agents: AgentEntry[]) {
  try {
    localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
  } catch {
    // session-only
  }
  // Consolidated repo mirror — agents.json now holds registry + definitions.
  void mirrorAgentsToRepo(agents);
}

/* ---- Built-in agents, hard-coded in tiers (never stored in agents.json,
 * never editable or deletable) ---- */

interface BuiltinSpec {
  username: string;
  name: string;
  team?: string;
  role: string;
  description: string;
  tier: 'default' | 'base';
  /** Emoji shown in the agent's avatar. */
  emoji: string;
  /** Tool allowlist (empty/omitted = all enabled tools). */
  tools?: string[];
  /** Base-skill ids always active for this agent. */
  skills?: string[];
}

/** Tier 1 — one default agent per workspace menu/team. Answers every
 * untagged turn in that menu. */
const DEFAULT_AGENT_SPECS: BuiltinSpec[] = [
  {
    username: 'explorer',
    name: 'Explorer',
    team: 'Explorer',
    role: 'Code explorer',
    description: 'Helps browse files, edit code and understand the workspace.',
    tier: 'default',
    emoji: '🔍',
    tools: ['read_file', 'write_file', 'delete_file', 'rename_file', 'list_files', 'read_diff', 'read_image', 'read_pdf', 'read_word', 'read_excel', 'search_code', 'run_command', 'web_search', 'playwright', 'browser', 'agent_lookup', 'agent_contacts'],
    skills: ['file-navigation'],
  },
  {
    username: 'commit-graph',
    name: 'Commit graph',
    team: 'Commit graph',
    role: 'History analyst',
    description: 'Reads the commit graph and explains history and relationships.',
    tier: 'default',
    emoji: '📈',
    tools: ['read_history', 'read_diff', 'read_file', 'list_files', 'search_code', 'read_image', 'web_search', 'playwright', 'browser', 'agent_lookup', 'agent_contacts'],
    skills: ['history-analysis', 'bug-triage'],
  },
  {
    username: 'merge-branch',
    name: 'Merge branch',
    team: 'Merge branch',
    role: 'Merge planner',
    description: 'Plans merges and walks through conflicts and resolution.',
    tier: 'default',
    emoji: '🌿',
    tools: ['read_diff', 'read_file', 'list_files', 'read_history', 'search_code', 'stage_changes', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['merge-conflict', 'git-commit-style'],
  },
  {
    username: 'push-commits',
    name: 'Push Commits',
    team: 'Push Commits',
    role: 'Push reviewer',
    description: 'Reviews unpushed commits and prepares pushes.',
    tier: 'default',
    emoji: '🚀',
    tools: ['stage_changes', 'commit', 'read_diff', 'read_history', 'list_files', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['push-review', 'git-commit-style'],
  },
  {
    username: 'stashes-code',
    name: 'Stashes Code',
    team: 'Stashes Code',
    role: 'Stash keeper',
    description: 'Manages stashes — view, apply, pop and drop.',
    tier: 'default',
    emoji: '📦',
    tools: ['stash', 'list_files', 'read_diff', 'read_file', 'agent_lookup', 'agent_contacts'],
    skills: ['stash-management'],
  },
  {
    username: 'cherry-pick',
    name: 'Cherry Pick',
    team: 'Cherry Pick',
    role: 'Commit picker',
    description: 'Cherry-picks commits between branches.',
    tier: 'default',
    emoji: '🍒',
    tools: ['read_history', 'read_diff', 'read_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['cherry-pick-flow'],
  },
  {
    username: 'branches',
    name: 'Branches',
    team: 'Branches',
    role: 'Branch navigator',
    description: 'Oversees local and remote branches and checkouts.',
    tier: 'default',
    emoji: '🌳',
    tools: ['list_files', 'read_history', 'read_file', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['branch-ops'],
  },
  {
    username: 'working-changes',
    name: 'Working changes',
    team: 'Working changes',
    role: 'Staging assistant',
    description: 'Stages, commits and reviews working changes.',
    tier: 'default',
    emoji: '✏️',
    tools: ['stage_changes', 'commit', 'read_diff', 'read_file', 'list_files', 'read_image', 'search_code', 'agent_lookup', 'agent_contacts'],
    skills: ['git-commit-style', 'code-review'],
  },
  {
    username: 'copilot',
    name: 'Copilot',
    team: 'Copilot',
    role: 'General assistant',
    description: 'General-purpose assistant for the Copilot chat.',
    tier: 'default',
    emoji: '✨',
    skills: ['web-research', 'docs-writing'],
  },
  {
    username: 'pull-requests',
    name: 'Pull requests',
    team: 'Pull requests',
    role: 'PR assistant',
    description: 'Drafts and reviews pull requests.',
    tier: 'default',
    emoji: '🔀',
    tools: ['github_pull_requests', 'github_issues', 'read_diff', 'read_file', 'list_files', 'web_search', 'browser', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['pr-writing', 'code-review'],
  },
  {
    username: 'releases',
    name: 'Releases',
    team: 'Releases',
    role: 'Release manager',
    description: 'Prepares releases and release notes.',
    tier: 'default',
    emoji: '🏷️',
    tools: ['github_releases', 'github_actions', 'read_file', 'list_files', 'read_pdf', 'agent_lookup', 'agent_contacts'],
    skills: ['release-notes'],
  },
  {
    username: 'issues',
    name: 'Issues',
    team: 'Issues',
    role: 'Issue triage',
    description: 'Triages and drafts issues.',
    tier: 'default',
    emoji: '🎯',
    tools: ['github_issues', 'github_projects', 'search_code', 'read_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['issue-triage'],
  },
  {
    username: 'actions',
    name: 'Actions',
    team: 'Actions',
    role: 'CI assistant',
    description: 'Watches and explains GitHub Actions runs.',
    tier: 'default',
    emoji: '⚙️',
    tools: ['github_actions', 'read_file', 'run_command', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['ci-debugging'],
  },
  {
    username: 'projects',
    name: 'Projects',
    team: 'Projects',
    role: 'Board assistant',
    description: 'Manages project boards.',
    tier: 'default',
    emoji: '📋',
    tools: ['github_projects', 'github_issues', 'agent_lookup', 'agent_contacts'],
    skills: ['project-board'],
  },
  {
    username: 'wiki',
    name: 'Wiki',
    team: 'Wiki',
    role: 'Docs writer',
    description: 'Maintains the repository wiki.',
    tier: 'default',
    emoji: '📚',
    tools: ['github_wiki', 'read_file', 'write_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['docs-writing'],
  },
  {
    username: 'security-and-quality',
    name: 'Security and quality',
    team: 'Security and quality',
    role: 'Security analyst',
    description: 'Reviews security and code quality.',
    tier: 'default',
    emoji: '🛡️',
    tools: ['github_security', 'search_code', 'read_file', 'list_files', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['security-review'],
  },
  {
    username: 'insights',
    name: 'Insights',
    team: 'Insights',
    role: 'Analytics',
    description: 'Explains repository insights and stats.',
    tier: 'default',
    emoji: '📊',
    tools: ['read_history', 'list_files', 'search_code', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['repo-insights'],
  },
  {
    username: 'code-reviewer',
    name: 'Code Reviewer',
    team: 'Working changes',
    role: 'Code reviewer',
    description: 'Reviews the working changes for bugs, edge cases and style.',
    tier: 'base',
    emoji: '🧐',
    tools: ['read_diff', 'read_file', 'list_files', 'search_code', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['code-review'],
  },
  {
    username: 'test-writer',
    name: 'Test Writer',
    team: 'Working changes',
    role: 'Test engineer',
    description: 'Writes unit tests for the changes and features you stage.',
    tier: 'base',
    emoji: '🧪',
    tools: ['read_file', 'write_file', 'list_files', 'search_code', 'run_command', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['run-tests'],
  },
  {
    username: 'docs-writer',
    name: 'Docs Writer',
    team: 'Wiki',
    role: 'Technical writer',
    description: 'Writes and updates documentation and the wiki.',
    tier: 'base',
    emoji: '📝',
    tools: ['read_file', 'write_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['docs-writing'],
  },
  {
    username: 'refactorer',
    name: 'Refactorer',
    team: 'Explorer',
    role: 'Refactoring specialist',
    description: 'Suggests and applies safe, behaviour-preserving refactors in the file you are editing.',
    tier: 'base',
    emoji: '🛠️',
    tools: ['read_file', 'write_file', 'search_code', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['refactor-safety'],
  },
  {
    username: 'bug-hunter',
    name: 'Bug Hunter',
    team: 'Commit graph',
    role: 'Debugger',
    description: 'Root-causes bugs from history, logs and code reading.',
    tier: 'base',
    emoji: '🐞',
    tools: ['read_file', 'search_code', 'read_diff', 'read_history', 'run_command', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['bug-triage'],
  },
  {
    username: 'git-expert',
    name: 'Git Expert',
    team: 'Commit graph',
    role: 'Git specialist',
    description: 'Git workflows — history, rebase, merge and recovery.',
    tier: 'base',
    emoji: '🔧',
    tools: ['read_history', 'read_diff', 'list_files', 'read_file', 'run_command', 'agent_lookup', 'agent_contacts'],
    skills: ['git-commit-style', 'history-analysis'],
  },
  {
    username: 'security-auditor',
    name: 'Security Auditor',
    team: 'Security and quality',
    role: 'Security reviewer',
    description: 'Security and vulnerability review of code and configs.',
    tier: 'base',
    emoji: '🛡️',
    tools: ['read_file', 'search_code', 'list_files', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['security-review'],
  },
];

const AVATAR_GRADIENTS: Array<[string, string]> = [
  ['#8b9dff', '#5f7adb'],
  ['#6dd6ad', '#3ea982'],
  ['#edb675', '#d9974e'],
  ['#e79098', '#c96f77'],
  ['#62cee7', '#3aa3bd'],
  ['#b59aff', '#8f6fe0'],
];

function builtinAvatar(username: string, emoji: string): string {
  const hash = [...username].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const [from, to] = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    '</linearGradient></defs>' +
    '<rect width="96" height="96" rx="22" fill="url(#g)"/>' +
    `<text x="48" y="63" font-size="42" text-anchor="middle">${emoji}</text>` +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function builtinFromSpec(spec: BuiltinSpec): AgentEntry {
  return {
    id: `agent-builtin-${spec.username}`,
    name: spec.name,
    username: spec.username,
    role: spec.role,
    team: spec.team,
    description: spec.description,
    enabled: true,
    mcpServers: [],
    builtIn: true,
    tier: spec.tier,
    avatar: builtinAvatar(spec.username, spec.emoji),
    tools: spec.tools ?? [],
    skills: spec.skills ?? [],
  };
}

/** Tier 1 + 2 agents, computed fresh — never stored in agents.json. */
export function builtinAgents(): AgentEntry[] {
  return DEFAULT_AGENT_SPECS.map(builtinFromSpec);
}

/** Every agent: built-in (tiers 1-2) first, then the user's extension
 * agents (tier 3). Usernames colliding with a built-in are hidden. */
export function allAgents(): AgentEntry[] {
  const builtins = builtinAgents();
  const users = loadAgents().filter(
    (agent) =>
      !agent.builtIn && !builtins.some((b) => b.username === agent.username),
  );
  return [...builtins, ...users];
}

/** Removes previously-seeded default agents from the store — tiers 1-2 are
 * hard-coded in the app now and must not live in agents.json. */
export function purgeSeededDefaults(): void {
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    if (!raw) return;
    const stored = normalizeAgents(JSON.parse(raw));
    const kept = stored.filter((agent) => !agent.builtIn);
    if (kept.length !== stored.length) saveAgents(kept);
  } catch {
    // nothing to purge
  }
}

/* ---- Hooks (lifecycle commands run around agent sends) ---- */

export type HookEvent = 'before-send' | 'after-reply';

export interface HookEntry {
  id: string;
  event: HookEvent;
  /** Shell command run in the repository root when the event fires. */
  command: string;
  enabled: boolean;
}

const HOOKS_KEY = 'pigry:hooks';

export function normalizeHooks(list: unknown[]): HookEntry[] {
  return (list as Partial<HookEntry>[])
    .filter((entry) => String(entry?.command ?? '').trim())
    .map((entry) => ({
      id: String(entry.id ?? newId('hook')),
      event: entry.event === 'after-reply' ? 'after-reply' : 'before-send',
      command: String(entry.command),
      enabled: entry.enabled !== false,
    }));
}

export function loadHooks(): HookEntry[] {
  try {
    const raw = localStorage.getItem(HOOKS_KEY);
    if (!raw) return [];
    return normalizeHooks(JSON.parse(raw));
  } catch {
    return [];
  }
}

const HOOKS_FILE = '.pigry/hooks/hooks.json';

export async function hydrateHooks(): Promise<HookEntry[] | null> {
  try {
    const raw = await readWorktreeFile(HOOKS_FILE);
    return normalizeHooks(JSON.parse(raw.content));
  } catch {
    return null;
  }
}

export async function mirrorHooks(list: HookEntry[]): Promise<void> {
  try {
    await writeWorktreeFile(HOOKS_FILE, JSON.stringify(list, null, 2));
  } catch {
    // read-only repo — localStorage remains the source of truth
  }
}

export function saveHooks(hooks: HookEntry[]) {
  try {
    localStorage.setItem(HOOKS_KEY, JSON.stringify(hooks));
  } catch {
    // session-only
  }
}

/** Runs every enabled hook for `event` in the repository root. Failures are
 * swallowed per-hook — a broken hook must not break the chat. */
export async function runEventHooks(event: HookEvent, cwd: string): Promise<void> {
  const hooks = loadHooks().filter((hook) => hook.enabled && hook.event === event);
  for (const hook of hooks) {
    try {
      await terminalRun(hook.command, cwd);
    } catch {
      // skip failing hook
    }
  }
}

/* ---- Plugins (named bundles that toggle agents + hooks together) ---- */

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Member ids applied when the plugin is toggled on. */
  agentIds: string[];
  hookIds: string[];
}

const PLUGINS_KEY = 'pigry:plugins';

export function normalizePlugins(list: unknown[]): PluginEntry[] {
  return (list as Partial<PluginEntry>[])
    .filter((entry) => String(entry?.name ?? '').trim())
    .map((entry) => ({
      id: String(entry.id ?? newId('plugin')),
      name: String(entry.name),
      description: String(entry.description ?? ''),
      enabled: entry.enabled !== false,
      agentIds: Array.isArray(entry.agentIds) ? entry.agentIds.map(String) : [],
      hookIds: Array.isArray(entry.hookIds) ? entry.hookIds.map(String) : [],
    }));
}

export function loadPlugins(): PluginEntry[] {
  try {
    const raw = localStorage.getItem(PLUGINS_KEY);
    if (!raw) return [];
    return normalizePlugins(JSON.parse(raw));
  } catch {
    return [];
  }
}

const PLUGINS_FILE = '.pigry/plugins/plugins.json';

export async function hydratePlugins(): Promise<PluginEntry[] | null> {
  try {
    const raw = await readWorktreeFile(PLUGINS_FILE);
    return normalizePlugins(JSON.parse(raw.content));
  } catch {
    return null;
  }
}

export async function mirrorPlugins(list: PluginEntry[]): Promise<void> {
  try {
    await writeWorktreeFile(PLUGINS_FILE, JSON.stringify(list, null, 2));
  } catch {
    // read-only repo — localStorage remains the source of truth
  }
}

export function savePlugins(plugins: PluginEntry[]) {
  try {
    localStorage.setItem(PLUGINS_KEY, JSON.stringify(plugins));
  } catch {
    // session-only
  }
}

/** Applies a plugin toggle to its member agents and hooks (existing values
 * of non-member entries stay untouched). */
export function applyPlugin(plugin: PluginEntry, on: boolean) {
  const agents = loadAgents().map((agent) =>
    plugin.agentIds.includes(agent.id) ? { ...agent, enabled: on } : agent,
  );
  saveAgents(agents);
  const hooks = loadHooks().map((hook) =>
    plugin.hookIds.includes(hook.id) ? { ...hook, enabled: on } : hook,
  );
  saveHooks(hooks);
}
