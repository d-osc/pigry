/** Built-in agent tool registry — the app's real capabilities that the AI
 * agent may use, with per-tool toggles stored in `pigry:agent-tools`. The
 * enabled set is announced to the model on every send (see AiAgentPanel),
 * and MCP servers add their own tools on top (see mcpServers.ts).
 */

export interface AgentTool {
  id: string;
  name: string;
  group: 'Files' | 'Search' | 'Terminal' | 'Git' | 'GitHub' | 'Web' | 'Agents';
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
  { id: 'web-devtools', name: 'browser_devtools', group: 'Web', description: 'Persistent browser session — open URLs, eval JavaScript, read console logs, screenshots and DOM' },
  { id: 'web-panel', name: 'browser_panel', group: 'Web', description: 'Open the in-app floating browser panel and navigate its active tab to a URL' },
  { id: 'web-e2e', name: 'browser_e2e', group: 'Web', description: 'E2E-test the page shown in the in-app browser panel — goto / fill / click / assert URL & title / read live text with PASS-FAIL results' },
  { id: 'browser-screenshot', name: 'browser_screenshot', group: 'Web', description: 'Screenshot the live page shown in the in-app browser panel (PNG, saved to disk)' },
  { id: 'browser-pdf', name: 'browser_pdf', group: 'Web', description: 'Save the live page shown in the in-app browser panel as PDF' },
  { id: 'browser-network', name: 'browser_network_requests', group: 'Web', description: 'List network requests captured from the in-app browser panel page' },
  // Documents (text extraction for the agent)
  { id: 'doc-pdf', name: 'read_pdf', group: 'Files', description: 'Extract the text of a PDF in the working tree' },
  { id: 'doc-word', name: 'read_word', group: 'Files', description: 'Extract the text of a .docx Word document' },
  { id: 'doc-excel', name: 'read_excel', group: 'Files', description: 'Extract every sheet of an .xlsx as CSV rows' },

  // Agents (agent_lookup — registry introspection for the agent itself)
  { id: 'agents-lookup', name: 'agent_lookup', group: 'Agents', description: "Look up agent profiles — list every agent or read one agent's full details by @username" },
  { id: 'agents-contacts', name: 'agent_contacts', group: 'Agents', description: 'The workspace contact book — every enabled agent grouped by team, one line each' },
  { id: 'gh-wiki', name: 'github_wiki', group: 'GitHub', description: 'Read and edit the repository wiki' },
];

const TOOLS_KEY = 'pigry:agent-tools';

/** Stored as the DISABLED list (not the enabled one) so the announced tool
 * surface can never drift stale: tools added to the registry later default
 * ON, removed tools vanish on their own, and the user's explicit toggles
 * still persist. */
interface StoredTools {
  version: 2;
  disabled: string[];
}

export function loadEnabledTools(): Set<string> {
  const all = new Set(AGENT_TOOLS.map((tool) => tool.id));
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    if (!raw) return all; // default: all on
    const parsed: unknown = JSON.parse(raw);
    // Legacy format (a plain array of enabled ids): ignore it and start
    // from all-on — old sets can reference tools that no longer exist and
    // miss ones added since, which confuses the model's tool summary.
    if (Array.isArray(parsed)) return all;
    const disabled = ((parsed as StoredTools)?.disabled ?? []).filter((id) =>
      AGENT_TOOLS.some((tool) => tool.id === id),
    );
    for (const id of disabled) all.delete(id);
    return all;
  } catch {
    return all;
  }
}

export function saveEnabledTools(enabled: Set<string>) {
  try {
    const disabled: StoredTools['disabled'] = AGENT_TOOLS.map((tool) => tool.id).filter(
      (id) => !enabled.has(id),
    );
    const payload: StoredTools = { version: 2, disabled };
    localStorage.setItem(TOOLS_KEY, JSON.stringify(payload));
  } catch {
    // session-only
  }
}

/** Groups in display order. */
export const TOOL_GROUPS: AgentTool['group'][] = ['Files', 'Search', 'Terminal', 'Git', 'GitHub', 'Web', 'Agents'];

/** One-line-per-tool block announced to the model on every agent send. */
export function enabledToolsSummary(enabled: Set<string>): string {
  const lines = AGENT_TOOLS.filter((tool) => enabled.has(tool.id)).map(
    (tool) => `- ${tool.name}: ${tool.description}`,
  );
  return lines.join('\n');
}
