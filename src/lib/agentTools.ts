/** Built-in agent tool registry — the app's real capabilities that the AI
 * agent may use, with per-tool toggles stored in `orbit:agent-tools`. The
 * enabled set is announced to the model on every send (see AiAgentPanel),
 * and MCP servers add their own tools on top (see mcpServers.ts).
 */

export interface AgentTool {
  id: string;
  name: string;
  group: 'Files' | 'Search' | 'Terminal' | 'Git' | 'GitHub' | 'Web';
  description: string;
}

export const AGENT_TOOLS: AgentTool[] = [
  // Files (read/write/delete/rename_worktree_file, get_file_tree)
  { id: 'files-read', name: 'read_file', group: 'Files', description: 'Read a file from the working tree' },
  { id: 'files-write', name: 'write_file', group: 'Files', description: 'Create or overwrite a file in the working tree' },
  { id: 'files-delete', name: 'delete_file', group: 'Files', description: 'Delete a file from the working tree' },
  { id: 'files-rename', name: 'rename_file', group: 'Files', description: 'Rename or move a file' },
  { id: 'files-list', name: 'list_files', group: 'Files', description: 'List the repository file tree' },
  { id: 'files-diff', name: 'read_diff', group: 'Files', description: 'Read staged/unstaged diffs of a file' },
  // Search (search_code)
  { id: 'search-code', name: 'search_code', group: 'Search', description: 'Full-text search across tracked files' },
  // Terminal (terminal_run)
  { id: 'terminal-run', name: 'run_command', group: 'Terminal', description: 'Run a shell command in the repository root' },
  // Git (stage/unstage/discard/commit/stash, commit history)
  { id: 'git-stage', name: 'stage_changes', group: 'Git', description: 'Stage or unstage working-tree changes' },
  { id: 'git-commit', name: 'commit', group: 'Git', description: 'Commit staged changes' },
  { id: 'git-stash', name: 'stash', group: 'Git', description: 'Stash, apply or pop changes' },
  { id: 'git-history', name: 'read_history', group: 'Git', description: 'Browse commit history of the repository' },
  // GitHub (gh CLI)
  { id: 'gh-pr', name: 'github_pull_requests', group: 'GitHub', description: 'List, create, review and check out pull requests' },
  { id: 'gh-issue', name: 'github_issues', group: 'GitHub', description: 'List, create and manage issues' },
  { id: 'gh-release', name: 'github_releases', group: 'GitHub', description: 'Read and publish releases' },
  { id: 'gh-actions', name: 'github_actions', group: 'GitHub', description: 'Inspect and trigger workflow runs' },
  { id: 'gh-projects', name: 'github_projects', group: 'GitHub', description: 'Read GitHub Projects boards and items' },
  { id: 'gh-security', name: 'github_security', group: 'GitHub', description: 'Read code scanning, Dependabot and secret alerts' },
  // Web (web_search + headless browser)
  { id: 'web-search', name: 'web_search', group: 'Web', description: 'Search the web (DuckDuckGo) and read top results' },
  { id: 'web-browser', name: 'playwright', group: 'Web', description: 'Open a URL in headless Edge/Chrome and read the rendered page text' },
  { id: 'gh-wiki', name: 'github_wiki', group: 'GitHub', description: 'Read and edit the repository wiki' },
];

const TOOLS_KEY = 'pigry:agent-tools';

export function loadEnabledTools(): Set<string> {
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    if (!raw) return new Set(AGENT_TOOLS.map((tool) => tool.id)); // default: all on
    const ids = JSON.parse(raw) as string[];
    return new Set(ids);
  } catch {
    return new Set(AGENT_TOOLS.map((tool) => tool.id));
  }
}

export function saveEnabledTools(enabled: Set<string>) {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify([...enabled]));
  } catch {
    // session-only
  }
}

/** Groups in display order. */
export const TOOL_GROUPS: AgentTool['group'][] = ['Files', 'Search', 'Terminal', 'Git', 'GitHub', 'Web'];

/** One-line-per-tool block announced to the model on every agent send. */
export function enabledToolsSummary(enabled: Set<string>): string {
  const lines = AGENT_TOOLS.filter((tool) => enabled.has(tool.id)).map(
    (tool) => `- ${tool.name}: ${tool.description}`,
  );
  return lines.join('\n');
}
