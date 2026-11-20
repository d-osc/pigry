/** Agents / Hooks / Plugins stores and the project instructions file —
 * backing the AI Agent panel tabs. Everything here feeds the agent context
 * (lib consumers in AiAgentPanel.send) and runs real hook commands through
 * the integrated terminal.
 */
import { workspaceNav, type WorkspaceNavId } from '../app/navigation';
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
  /** Reasoning/effort level this agent forces on its model (optional —
   * falls back to the model entry's own selection). */
  effort?: string;
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
export const AGENT_TEAMS = [...workspaceNav.map(({ label }) => label), 'Browser'];

/** Default team for an agent created while `screen` is the active menu. */
export function teamForScreen(screen: string | null | undefined): string | undefined {
  return workspaceNav.find(({ id }) => id === screen)?.label;
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

const GIT_REVIEW_TOOLS = [
  'git_status', 'read_history', 'read_commit', 'read_diff', 'read_file', 'list_files', 'search_code', 'agent_lookup', 'agent_contacts',
];

/** Tier 1 defaults for untagged turns in every workspace menu. */
const WORKSPACE_AGENT_SPECS: Record<WorkspaceNavId, Omit<BuiltinSpec, 'name' | 'team' | 'tier'>> = {
  explorer: {
    username: 'explorer',
    role: 'Code explorer',
    description: 'Helps browse files, edit code and understand the workspace.',
    emoji: '🔍',
    tools: ['read_file', 'write_file', 'delete_file', 'rename_file', 'list_files', 'git_status', 'read_diff', 'read_image', 'read_pdf', 'read_word', 'read_excel', 'search_code', 'run_command', 'web_search', 'playwright', 'agent_lookup', 'agent_contacts'],
    skills: ['file-navigation'],
  },
  'commit-graph': {
    username: 'commit-graph',
    role: 'History analyst',
    description: 'Reads the commit graph and explains history and relationships.',
    emoji: '📈',
    tools: [...GIT_REVIEW_TOOLS, 'read_image', 'web_search', 'playwright'],
    skills: ['history-analysis', 'bug-triage'],
  },
  'merge-branch': {
    username: 'merge-branch',
    role: 'Merge planner',
    description: 'Plans merges and walks through conflicts and resolution.',
    emoji: '🌿',
    tools: [...GIT_REVIEW_TOOLS, 'preview_merge', 'stage_changes', 'read_image'],
    skills: ['merge-conflict', 'git-commit-style'],
  },
  'compare-branch': {
    username: 'compare-branch',
    role: 'Branch comparison reviewer',
    description: 'Explains differences between Base and Compare branch tips, including commits unique to each side, changed files, and Split or Unified diffs.',
    emoji: '🔎',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches'],
    skills: ['branch-comparison', 'code-review'],
  },
  'rebase-branch': {
    username: 'rebase-branch',
    role: 'Rebase planner',
    description: 'Reviews the selected rebase base and the pick, squash, and drop plan. Explains which commits will be replayed and helps resolve and stage conflicts before continuing the rebase.',
    emoji: '🔄',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches', 'stage_changes'],
    skills: ['rebase-plan', 'history-analysis'],
  },
  'push-commits': {
    username: 'push-commits',
    role: 'Push reviewer',
    description: 'Reviews unpushed commits and prepares pushes.',
    emoji: '🚀',
    tools: [...GIT_REVIEW_TOOLS, 'preview_sync_commits', 'stage_changes', 'commit', 'read_image'],
    skills: ['push-review', 'git-commit-style'],
  },
  'pull-commits': {
    username: 'pull-commits',
    role: 'Incoming commit reviewer',
    description: 'Reviews fetched upstream commits and their per-file diffs. Explains whether a fast-forward pull is possible or the branches have diverged.',
    emoji: '⬇️',
    tools: [...GIT_REVIEW_TOOLS, 'preview_sync_commits'],
    skills: ['pull-review', 'code-review'],
  },
  stashes: {
    username: 'stashes-code',
    role: 'Stash keeper',
    description: 'Manages stashes — view, apply, pop and drop.',
    emoji: '📦',
    tools: [...GIT_REVIEW_TOOLS, 'preview_stash', 'stash'],
    skills: ['stash-management'],
  },
  'cherry-pick': {
    username: 'cherry-pick',
    role: 'Commit picker',
    description: 'Reviews a selected commit and guides cherry-picking its changes into the staged files on the checked-out branch.',
    emoji: '🍒',
    tools: GIT_REVIEW_TOOLS,
    skills: ['cherry-pick-flow'],
  },
  'duplicate-commit': {
    username: 'duplicate-commit',
    role: 'Commit transfer reviewer',
    description: 'Helps choose a source commit and local destination branch. Reviews file changes and explains why commits already present by SHA or equivalent patch are marked ineligible.',
    emoji: '📑',
    tools: [...GIT_REVIEW_TOOLS, 'check_duplicate_commit', 'compare_branches'],
    skills: ['duplicate-commit', 'code-review'],
  },
  'edit-commit': {
    username: 'edit-commit',
    role: 'Commit editing assistant',
    description: 'Helps edit the selected commit on the current local branch. Guides saving files in Explorer, staging changes, and using Save and continue to replay later commits.',
    emoji: '📝',
    tools: [...GIT_REVIEW_TOOLS, 'write_file', 'stage_changes'],
    skills: ['edit-commit', 'working-changes-review'],
  },
  branches: {
    username: 'branches',
    role: 'Branch navigator',
    description: 'Oversees local and remote branches and checkouts.',
    emoji: '🌳',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches', 'read_image'],
    skills: ['branch-ops'],
  },
  'working-changes': {
    username: 'working-changes',
    role: 'Staging assistant',
    description: 'Stages, commits and reviews working changes.',
    emoji: '✏️',
    tools: [...GIT_REVIEW_TOOLS, 'stage_changes', 'commit', 'read_image'],
    skills: ['working-changes-review', 'git-commit-style', 'code-review'],
  },
  'ai-agent': {
    username: 'copilot',
    role: 'General assistant',
    description: 'General-purpose assistant for the Copilot chat.',
    emoji: '✨',
    skills: ['workspace-tool-use', 'web-research', 'docs-writing'],
  },
  'pull-requests': {
    username: 'pull-requests',
    role: 'PR assistant',
    description: 'Drafts and reviews pull requests using the overview, checks, and per-file and per-commit diffs.',
    emoji: '🔀',
    tools: ['github_pull_requests', 'github_issues', 'github_actions', 'read_diff', 'read_file', 'list_files', 'web_search', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['pr-review', 'pr-writing'],
  },
  releases: {
    username: 'releases',
    role: 'Release manager',
    description: 'Prepares releases and release notes.',
    emoji: '🏷️',
    tools: ['github_releases', 'github_actions', 'read_file', 'list_files', 'read_pdf', 'agent_lookup', 'agent_contacts'],
    skills: ['release-notes'],
  },
  issues: {
    username: 'issues',
    role: 'Issue triage',
    description: 'Triages and drafts issues.',
    emoji: '🎯',
    tools: ['github_issues', 'github_projects', 'search_code', 'read_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['issue-triage'],
  },
  actions: {
    username: 'actions',
    role: 'CI assistant',
    description: 'Watches and explains GitHub Actions runs.',
    emoji: '⚙️',
    tools: ['github_actions', 'read_file', 'run_command', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['ci-debugging'],
  },
  projects: {
    username: 'projects',
    role: 'Board assistant',
    description: 'Manages project boards.',
    emoji: '📋',
    tools: ['github_projects', 'github_issues', 'agent_lookup', 'agent_contacts'],
    skills: ['project-board'],
  },
  wiki: {
    username: 'wiki',
    role: 'Docs writer',
    description: 'Maintains the repository wiki.',
    emoji: '📚',
    tools: ['github_wiki', 'read_file', 'write_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['wiki-workflow', 'docs-writing'],
  },
  security: {
    username: 'security-and-quality',
    role: 'Security analyst',
    description: 'Reviews security and code quality.',
    emoji: '🛡️',
    tools: ['github_security', 'search_code', 'read_file', 'list_files', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['security-review'],
  },
  insights: {
    username: 'insights',
    role: 'Analytics',
    description: 'Explains repository insights and stats.',
    emoji: '📊',
    tools: ['repo_insights', 'read_history', 'list_files', 'search_code', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['repo-insights'],
  },
};

type WorkspaceBaseAgentSpec = Omit<BuiltinSpec, 'team' | 'tier'>;

const DEVELOPMENT_FILES = ['list_files', 'search_code', 'read_file', 'read_diff', 'git_status', 'write_file'];

const DEVELOPMENT_BASE_AGENTS: WorkspaceBaseAgentSpec[] = [
  {
    username: 'coder',
    name: 'Coder',
    role: 'Software developer',
    description: 'Implements features and fixes in repository code, verifies the changes, and reports what was edited.',
    emoji: '💻',
    tools: [...DEVELOPMENT_FILES, 'run_command'],
    skills: ['code-implementation'],
  },
  {
    username: 'debugger',
    name: 'Debugger',
    role: 'Unit testing and bug diagnosis',
    description: 'Writes and runs unit tests, traces bugs to their source, and saves a detailed Markdown bug report.',
    emoji: '🔍',
    tools: [...DEVELOPMENT_FILES, 'run_command'],
    skills: ['unit-testing-and-bug-reporting', 'run-tests'],
  },
  {
    username: 'qa',
    name: 'QA',
    role: 'Software tester',
    description: 'Verifies software against its requirements, writes Markdown test cases, and runs end-to-end tests.',
    emoji: '🧪',
    tools: [...DEVELOPMENT_FILES, 'run_command', 'browser_e2e'],
    skills: ['qa-test-cases-and-e2e', 'run-tests'],
  },
  {
    username: 'white-hat',
    name: 'White Hat Hacker',
    role: 'Defensive security reviewer',
    description: 'Reviews the current repository for vulnerabilities and saves a Markdown report with evidence and remediation.',
    emoji: '🛡️',
    tools: [...DEVELOPMENT_FILES, 'github_security'],
    skills: ['defensive-security-report'],
  },
];

/** Every workspace menu has at least one specialist available via @mention. */
const WORKSPACE_BASE_AGENT_SPECS: Record<WorkspaceNavId, [WorkspaceBaseAgentSpec, ...WorkspaceBaseAgentSpec[]]> = {
  explorer: [{
    username: 'refactorer',
    name: 'Refactorer',
    role: 'Refactoring specialist',
    description: 'Suggests and applies safe, behaviour-preserving refactors in the file you are editing.',
    emoji: '🛠️',
    tools: ['read_file', 'write_file', 'search_code', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['refactor-safety'],
  }, ...DEVELOPMENT_BASE_AGENTS],
  'ai-agent': [{
    username: 'workspace-guide',
    name: 'Workspace Guide',
    role: 'Repository workflow guide',
    description: 'Breaks down repository tasks and points to the relevant menu and specialist. Uses the workspace agent directory to find the right person to tag.',
    emoji: '🧭',
    tools: ['git_status', 'read_file', 'list_files', 'search_code', 'agent_lookup', 'agent_contacts'],
    skills: ['workspace-tool-use', 'file-navigation'],
  }, ...DEVELOPMENT_BASE_AGENTS.map(agent => ({ ...agent, username: `copilot-${agent.username}` }))],
  'working-changes': [{
    username: 'code-reviewer',
    name: 'Code Reviewer',
    role: 'Code reviewer',
    description: 'Reviews the working changes for bugs, edge cases and style.',
    emoji: '🧐',
    tools: ['git_status', 'read_diff', 'read_file', 'list_files', 'search_code', 'read_image', 'agent_lookup', 'agent_contacts'],
    skills: ['working-changes-review', 'code-review'],
  }, {
    username: 'test-writer',
    name: 'Test Writer',
    role: 'Test engineer',
    description: 'Writes unit tests for the changes and features you stage.',
    emoji: '🧪',
    tools: ['read_file', 'write_file', 'list_files', 'search_code', 'run_command', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['run-tests'],
  }],
  'push-commits': [{
    username: 'push-checklist',
    name: 'Push Checklist',
    role: 'Pre-push reviewer',
    description: 'Reviews outgoing commits for unintended files, missing tests and branch or upstream mismatches. Summarizes checks to run before publishing.',
    emoji: '📤',
    tools: [...GIT_REVIEW_TOOLS, 'preview_sync_commits'],
    skills: ['push-review', 'code-review'],
  }],
  'pull-commits': [{
    username: 'incoming-impact',
    name: 'Incoming Impact',
    role: 'Upstream change reviewer',
    description: 'Reviews fetched commit diffs for changes to APIs, configuration and migrations. Identifies what to test after pulling.',
    emoji: '📥',
    tools: [...GIT_REVIEW_TOOLS, 'preview_sync_commits'],
    skills: ['pull-review', 'code-review'],
  }],
  'merge-branch': [{
    username: 'merge-conflict-helper',
    name: 'Merge Conflict Helper',
    role: 'Merge conflict reviewer',
    description: 'Compares the intent of each side of a merge conflict and suggests a combined resolution with targeted tests.',
    emoji: '🔀',
    tools: [...GIT_REVIEW_TOOLS, 'preview_merge', 'compare_branches'],
    skills: ['merge-conflict', 'code-review'],
  }],
  'compare-branch': [{
    username: 'branch-diff-reviewer',
    name: 'Branch Diff Reviewer',
    role: 'Branch diff reviewer',
    description: 'Reviews selected diffs from Base to Compare and groups behavior changes, regressions and tests by file.',
    emoji: '🔍',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches'],
    skills: ['branch-comparison', 'code-review'],
  }],
  stashes: [{
    username: 'stash-inspector',
    name: 'Stash Inspector',
    role: 'Stash recovery reviewer',
    description: 'Helps identify the relevant stash and review its changed files before applying or popping it onto the current branch.',
    emoji: '📦',
    tools: [...GIT_REVIEW_TOOLS, 'preview_stash'],
    skills: ['stash-management', 'code-review'],
  }],
  'cherry-pick': [{
    username: 'pick-reviewer',
    name: 'Pick Reviewer',
    role: 'Cherry-pick dependency reviewer',
    description: 'Checks a selected commit for prerequisites, related commits and likely overlap with the checked-out branch before the changes are staged.',
    emoji: '🍒',
    tools: GIT_REVIEW_TOOLS,
    skills: ['cherry-pick-flow', 'history-analysis'],
  }],
  'duplicate-commit': [{
    username: 'transfer-check',
    name: 'Transfer Check',
    role: 'Commit transfer reviewer',
    description: 'Checks the selected source commit and destination branch for missing dependencies or equivalent changes. Reviews the intended file diff before transfer.',
    emoji: '📑',
    tools: [...GIT_REVIEW_TOOLS, 'check_duplicate_commit', 'compare_branches'],
    skills: ['duplicate-commit', 'history-analysis'],
  }],
  'edit-commit': [{
    username: 'amend-reviewer',
    name: 'Amend Reviewer',
    role: 'Commit edit reviewer',
    description: 'Reviews which files should be staged for the selected commit. Checks the staged diff before Save and continue and identifies later commits that may conflict.',
    emoji: '✏️',
    tools: GIT_REVIEW_TOOLS,
    skills: ['edit-commit', 'working-changes-review', 'code-review'],
  }],
  'rebase-branch': [{
    username: 'rebase-plan-reviewer',
    name: 'Rebase Plan Reviewer',
    role: 'Rebase sequence reviewer',
    description: 'Checks the oldest-first replay order, dependencies between commits and the effect of each pick, squash or drop on the selected branch.',
    emoji: '🔄',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches'],
    skills: ['rebase-plan', 'history-analysis'],
  }],
  'pull-requests': [{
    username: 'pr-reviewer',
    name: 'PR Reviewer',
    role: 'Pull request reviewer',
    description: 'Reviews PR files, commits and checks. Reports actionable findings with file and line references when available and identifies gaps in test coverage.',
    emoji: '🧐',
    tools: [...GIT_REVIEW_TOOLS, 'github_pull_requests', 'github_actions'],
    skills: ['pr-review', 'code-review'],
  }],
  'commit-graph': [{
    username: 'bug-hunter',
    name: 'Bug Hunter',
    role: 'Debugger',
    description: 'Root-causes bugs from history, logs and code reading.',
    emoji: '🐞',
    tools: ['read_file', 'search_code', 'read_diff', 'read_history', 'run_command', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['bug-triage'],
  }, {
    username: 'git-expert',
    name: 'Git Expert',
    role: 'Git specialist',
    description: 'Git workflows — history, rebase, merge and recovery.',
    emoji: '🔧',
    tools: ['read_history', 'read_diff', 'list_files', 'read_file', 'run_command', 'agent_lookup', 'agent_contacts'],
    skills: ['git-commit-style', 'history-analysis'],
  }],
  branches: [{
    username: 'upstream-checker',
    name: 'Upstream Checker',
    role: 'Branch tracking reviewer',
    description: 'Identifies a local branch and its tracking branch, explains ahead and behind counts and checks the intended branch before checkout.',
    emoji: '🌿',
    tools: [...GIT_REVIEW_TOOLS, 'compare_branches'],
    skills: ['branch-ops', 'history-analysis'],
  }],
  releases: [{
    username: 'release-notes-writer',
    name: 'Release Notes Writer',
    role: 'Changelog editor',
    description: 'Drafts release notes from commits and pull requests. Groups user-visible changes, migration steps and fixes and checks which artifacts are listed.',
    emoji: '📝',
    tools: ['github_releases', 'github_pull_requests', 'read_history', 'read_file', 'agent_lookup', 'agent_contacts'],
    skills: ['release-notes', 'docs-writing'],
  }],
  actions: [{
    username: 'ci-log-reviewer',
    name: 'CI Log Reviewer',
    role: 'Workflow diagnostics reviewer',
    description: 'Locates the first failing job or step in GitHub Actions logs, summarizes the relevant error and suggests the smallest check that would confirm the cause.',
    emoji: '🧪',
    tools: ['github_actions', 'read_file', 'search_code', 'agent_lookup', 'agent_contacts'],
    skills: ['ci-debugging', 'bug-triage'],
  }],
  security: [{
    username: 'security-auditor',
    name: 'Security Auditor',
    role: 'Security reviewer',
    description: 'Security and vulnerability review of code and configs.',
    emoji: '🛡️',
    tools: ['read_file', 'search_code', 'list_files', 'read_diff', 'agent_lookup', 'agent_contacts'],
    skills: ['security-review'],
  }],
  issues: [{
    username: 'issue-triage-helper',
    name: 'Issue Triage Helper',
    role: 'Issue intake reviewer',
    description: 'Turns reports into concise issues with expected and actual behavior. Finds related issues and suggests labels and missing information to request.',
    emoji: '🎯',
    tools: ['github_issues', 'github_pull_requests', 'search_code', 'read_file', 'agent_lookup', 'agent_contacts'],
    skills: ['issue-triage', 'bug-triage'],
  }],
  projects: [{
    username: 'board-planner',
    name: 'Board Planner',
    role: 'Project board planner',
    description: 'Groups related issues and pull requests, identifies blockers and dependencies, and suggests clear next actions for the project board.',
    emoji: '📋',
    tools: ['github_projects', 'github_issues', 'github_pull_requests', 'agent_lookup', 'agent_contacts'],
    skills: ['project-board', 'issue-triage'],
  }],
  wiki: [{
    username: 'docs-writer',
    name: 'Docs Writer',
    role: 'Technical writer',
    description: 'Writes and updates documentation and the wiki.',
    emoji: '📝',
    tools: ['github_wiki', 'read_file', 'write_file', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['wiki-workflow', 'docs-writing'],
  }],
  insights: [{
    username: 'activity-analyst',
    name: 'Activity Analyst',
    role: 'Repository trends analyst',
    description: 'Summarizes repository activity and contributor trends over the selected period and calls out gaps in the available data.',
    emoji: '📊',
    tools: ['repo_insights', 'read_history', 'github_pull_requests', 'github_issues', 'list_files', 'agent_lookup', 'agent_contacts'],
    skills: ['repo-insights', 'history-analysis'],
  }],
};

const BUILTIN_AGENT_SPECS: BuiltinSpec[] = [
  ...workspaceNav.map(({ id, label }): BuiltinSpec => ({
    ...WORKSPACE_AGENT_SPECS[id],
    name: label,
    team: label,
    tier: 'default',
  })),
  {
    username: 'browser',
    name: 'Browser',
    team: 'Browser',
    role: 'Web assistant',
    description: 'Assists around the page open in the floating browser — lookups, page summaries and quick web research.',
    tier: 'default',
    emoji: '🌐',
    tools: ['browser_panel', 'browser_e2e', 'browser_screenshot', 'browser_pdf', 'browser_network_requests', 'web_search', 'agent_lookup', 'agent_contacts'],
    skills: ['web-research', 'docs-writing'],
  },
  ...workspaceNav.flatMap(({ id, label }) =>
    WORKSPACE_BASE_AGENT_SPECS[id].map((spec): BuiltinSpec => ({
      ...spec,
      team: label,
      tier: 'base',
    })),
  ),
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

/** Tier 1 + 2 agents, computed fresh — never stored in agents.json. User
 * edits live in a separate override store, keyed by username. */
export function builtinAgents(): AgentEntry[] {
  purgeStaleOverridesIfNeeded();
  const overrides = loadAgentOverrides();
  return BUILTIN_AGENT_SPECS.map((spec) => {
    const base = builtinFromSpec(spec);
    const patch = overrides[spec.username];
    if (!patch) return base;
    return { ...base, ...patch, id: base.id, username: base.username, builtIn: true, tier: spec.tier };
  });
}

/* ---- Built-in agent overrides — user edits, resettable to factory ---- */

const OVERRIDES_KEY = 'pigry:agent-overrides';

/** Bump when built-in specs change in a way a stale override would
 * break (e.g. a tool id was removed from the registry) — overrides saved
 * under an older factory are dropped once, on first load. */
const FACTORY_VERSION = 3;
const FACTORY_KEY = 'pigry:agent-factory-version';

function purgeStaleOverridesIfNeeded(): void {
  try {
    if (localStorage.getItem(FACTORY_KEY) === String(FACTORY_VERSION)) return;
    localStorage.removeItem(OVERRIDES_KEY);
    localStorage.setItem(FACTORY_KEY, String(FACTORY_VERSION));
  } catch {
    // storage unavailable — nothing to purge
  }
}

/** Fields a user may customize on a built-in agent (identity/tier locked). */
const OVERRIDE_FIELDS = [
  'name',
  'role',
  'team',
  'description',
  'enabled',
  'tools',
  'skills',
  'mcpServers',
  'avatar',
  'providerId',
  'model',
  'effort',
] as const;

export function loadAgentOverrides(): Record<string, Partial<AgentEntry>> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Partial<AgentEntry>>) : {};
  } catch {
    return {};
  }
}

function saveAgentOverrides(map: Record<string, Partial<AgentEntry>>) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    // session-only
  }
}

/** Stores a user's edit of a built-in agent (keyed by its username). */
export function setAgentOverride(entry: AgentEntry): void {
  const map = loadAgentOverrides();
  const patch: Record<string, unknown> = {};
  for (const field of OVERRIDE_FIELDS) {
    const value = entry[field];
    if (value !== undefined) patch[field] = value;
  }
  map[entry.username] = patch;
  saveAgentOverrides(map);
}

/** Drops a built-in agent's overrides — back to the factory definition. */
export function resetAgentOverride(username: string): void {
  const map = loadAgentOverrides();
  if (!(username in map)) return;
  delete map[username];
  saveAgentOverrides(map);
}

export function hasAgentOverride(username: string): boolean {
  return username in loadAgentOverrides();
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
