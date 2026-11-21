/** Built-in agent tool registry — the app's real capabilities that the AI
 * agent may use, with per-tool toggles stored in `pigry:agent-tools`. The
 * enabled set is announced to the model on every send (see AiAgentPanel),
 * and MCP servers add their own tools on top (see mcpServers.ts).
 */

export interface AgentTool {
  id: string;
  name: string;
  group: 'Files' | 'Search' | 'Terminal' | 'Git' | 'GitHub' | 'Web' | 'Diagram' | 'Design' | 'Board' | 'E2E' | 'Agents';
  description: string;
}

export interface ToolSpec {
  id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

export const AGENT_TOOLS: AgentTool[] = [
  // Files (read/write/delete/rename_worktree_file, get_file_tree)
  { id: 'files-read', name: 'read_file', group: 'Files', description: 'Read a file from the working tree' },
  { id: 'files-image', name: 'read_image', group: 'Files', description: 'Read an image from the working tree and attach it to the next model turn' },
  { id: 'files-write', name: 'write_file', group: 'Files', description: 'Create or overwrite a file in the working tree' },
  { id: 'files-delete', name: 'delete_file', group: 'Files', description: 'Delete a specific working-tree file when the user asks to remove it' },
  { id: 'files-rename', name: 'rename_file', group: 'Files', description: 'Rename or move a file' },
  { id: 'files-list', name: 'list_files', group: 'Files', description: 'List the repository file tree' },
  { id: 'files-diff', name: 'read_diff', group: 'Files', description: 'Read staged/unstaged diffs of a file' },
  // Search (search_code)
  { id: 'search-code', name: 'search_code', group: 'Search', description: 'Full-text search across tracked files' },
  // Terminal (agent_shell_run — private Pigry Bash PTY session per call)
  { id: 'terminal-run', name: 'run_command', group: 'Terminal', description: 'Run a shell command in the repository root (Pigry Bash: busybox built-ins + shell fallback) and read its captured output' },
  // Git (stage/unstage/discard/commit/stash, commit history)
  { id: 'git-stage', name: 'stage_changes', group: 'Git', description: 'Stage or unstage working-tree changes' },
  { id: 'git-commit', name: 'commit', group: 'Git', description: 'Commit staged changes' },
  { id: 'git-stash', name: 'stash', group: 'Git', description: 'Stash, apply or pop changes' },
  { id: 'git-history', name: 'read_history', group: 'Git', description: 'Browse local commit history or the history of a specific ref' },
  { id: 'git-status', name: 'git_status', group: 'Git', description: 'Inspect working changes, branch refs, upstream status and an active commit edit' },
  { id: 'git-commit-detail', name: 'read_commit', group: 'Git', description: 'Read a commit and its file changes or compare a file with its first parent' },
  { id: 'git-compare-branches', name: 'compare_branches', group: 'Git', description: 'Compare two branch tips and inspect their per-file changes' },
  { id: 'git-preview-sync', name: 'preview_sync_commits', group: 'Git', description: 'Preview fetched upstream commits or commits waiting to be pushed' },
  { id: 'git-preview-merge', name: 'preview_merge', group: 'Git', description: 'Preview the commits and files a merge into the current branch would bring in' },
  { id: 'git-preview-stash', name: 'preview_stash', group: 'Git', description: 'Inspect a stash entry and its changed files' },
  { id: 'git-check-duplicate', name: 'check_duplicate_commit', group: 'Git', description: 'Check a source commit for duplicate eligibility on a local destination branch' },
  { id: 'repo-insights', name: 'repo_insights', group: 'Git', description: 'Read repository activity, GitHub delivery metrics or traffic' },
  // GitHub (gh CLI)
  { id: 'gh-pr', name: 'github_pull_requests', group: 'GitHub', description: 'List pull requests and inspect their details, file patches or a commit diff' },
  { id: 'gh-issue', name: 'github_issues', group: 'GitHub', description: 'List issues or read an issue and its comments' },
  { id: 'gh-release', name: 'github_releases', group: 'GitHub', description: 'List releases or inspect release notes and assets' },
  { id: 'gh-actions', name: 'github_actions', group: 'GitHub', description: 'List workflow runs or read a run, job logs or artifacts' },
  { id: 'gh-projects', name: 'github_projects', group: 'GitHub', description: 'Read GitHub Projects boards and items' },
  { id: 'gh-security', name: 'github_security', group: 'GitHub', description: 'Read code scanning, Dependabot and secret alerts' },
  // Web (web_search + headless browser)
  { id: 'web-search', name: 'web_search', group: 'Web', description: 'Search the web (DuckDuckGo) and read top results' },
  { id: 'web-browser', name: 'playwright', group: 'Web', description: 'Open a URL in headless Edge/Chrome and read the rendered page text' },
  { id: 'web-devtools', name: 'browser_devtools', group: 'Web', description: 'Persistent browser session — open URLs, eval JavaScript, read console logs, screenshots and DOM' },
  { id: 'web-panel', name: 'browser_panel', group: 'Web', description: 'Open a URL in the default external browser' },
  { id: 'web-e2e', name: 'browser_e2e', group: 'Web', description: 'Run and verify E2E steps in a visible external test browser' },
  { id: 'browser-screenshot', name: 'browser_screenshot', group: 'Web', description: 'Screenshot the live page shown in the in-app browser panel (PNG, saved to disk)' },
  { id: 'browser-pdf', name: 'browser_pdf', group: 'Web', description: 'Save the live page shown in the in-app browser panel as PDF' },
  { id: 'browser-network', name: 'browser_network_requests', group: 'Web', description: 'List network requests captured from the in-app browser panel page' },
  // Documents (text extraction for the agent)
  { id: 'doc-pdf', name: 'read_pdf', group: 'Files', description: 'Extract the text of a PDF in the working tree' },
  { id: 'doc-word', name: 'read_word', group: 'Files', description: 'Extract the text of a .docx Word document' },
  { id: 'doc-excel', name: 'read_excel', group: 'Files', description: 'Extract every sheet of an .xlsx as CSV rows' },

  // Diagram (the Diagram editor — files under .pigry/diagrams/)
  { id: 'diagram_list', name: 'diagram_list', group: 'Diagram', description: 'List the diagrams saved in the workspace' },
  { id: 'diagram_read', name: 'diagram_read', group: 'Diagram', description: 'Read a diagram as a summary, JSON or Mermaid' },
  { id: 'diagram_write', name: 'diagram_write', group: 'Diagram', description: 'Create a diagram from nodes and edges with automatic layout' },
  { id: 'diagram_edit', name: 'diagram_edit', group: 'Diagram', description: 'Add, change, connect or remove nodes and edges in a diagram' },
  { id: 'diagram_export', name: 'diagram_export', group: 'Diagram', description: 'Export a diagram as SVG or Mermaid for reports' },
  { id: 'diagram_open', name: 'diagram_open', group: 'Diagram', description: 'Open a diagram in the Diagram editor' },
  // Design (the Design editor — files under .pigry/designs/<agent>/)
  { id: 'design_list', name: 'design_list', group: 'Design', description: 'List the designs saved in the workspace' },
  { id: 'design_read', name: 'design_read', group: 'Design', description: 'Read a design as an outline or JSON' },
  { id: 'design_write', name: 'design_write', group: 'Design', description: 'Create a design from a tree of frames, shapes and text with auto layout' },
  { id: 'design_edit', name: 'design_edit', group: 'Design', description: 'Add, change, move, group or remove layers in a design' },
  { id: 'design_check', name: 'design_check', group: 'Design', description: 'UX/UI review: contrast, text size, touch targets, overflow, spacing grid' },
  { id: 'design_preview', name: 'design_preview', group: 'Design', description: 'Render a frame to an image you can see on the next turn' },
  { id: 'design_export', name: 'design_export', group: 'Design', description: 'Export a design as SVG, PNG or static HTML + CSS' },
  { id: 'design_open', name: 'design_open', group: 'Design', description: 'Open a design in the Design editor' },
  // Board (the Board editor — files under .pigry/boards/<agent>/)
  { id: 'board_list', name: 'board_list', group: 'Board', description: 'List the boards saved in the workspace' },
  { id: 'board_read', name: 'board_read', group: 'Board', description: 'Read a board as an outline, Markdown or JSON' },
  { id: 'board_write', name: 'board_write', group: 'Board', description: 'Create a board of sections, sticky notes, shapes and connectors with automatic placement' },
  { id: 'board_edit', name: 'board_edit', group: 'Board', description: 'Add, change, move, group, connect, vote on or remove items on a board' },
  { id: 'board_preview', name: 'board_preview', group: 'Board', description: 'Render a board to an image you can see on the next turn' },
  { id: 'board_export', name: 'board_export', group: 'Board', description: 'Export a board as Markdown, SVG or PNG' },
  { id: 'board_open', name: 'board_open', group: 'Board', description: 'Open a board in the Board editor' },
  // E2E (the E2E Testing menu — Cypress-style specs under .pigry/e2e/specs/<agent>/)
  { id: 'e2e_list', name: 'e2e_list', group: 'E2E', description: 'List E2E specs with their last result, fixtures and settings' },
  { id: 'e2e_read', name: 'e2e_read', group: 'E2E', description: 'Read a spec with line numbers (optionally with its last run)' },
  { id: 'e2e_write', name: 'e2e_write', group: 'E2E', description: 'Create a Cypress-style spec (cy.visit/get/click/type/intercept…) in your own folder' },
  { id: 'e2e_edit', name: 'e2e_edit', group: 'E2E', description: 'Change a spec by exact text replacement' },
  { id: 'e2e_run', name: 'e2e_run', group: 'E2E', description: 'Run a spec or all specs in the test browser: PASS/FAIL per test with errors, code frames and evidence' },
  { id: 'e2e_results', name: 'e2e_results', group: 'E2E', description: 'Last run of a spec: summary, command log of one test, or JSON' },
  { id: 'e2e_stats', name: 'e2e_stats', group: 'E2E', description: 'Analytics over stored runs: failing, flaky and slowest tests' },
  { id: 'e2e_selector', name: 'e2e_selector', group: 'E2E', description: 'Selector playground: count matches in the open page and suggest a stable selector' },
  { id: 'e2e_fixture', name: 'e2e_fixture', group: 'E2E', description: 'Write a JSON fixture for cy.fixture() and cy.intercept()' },
  { id: 'e2e_config', name: 'e2e_config', group: 'E2E', description: 'Read or change E2E settings: baseUrl, viewport, timeouts, retries, video, env' },
  { id: 'e2e_open', name: 'e2e_open', group: 'E2E', description: 'Open a spec in the E2E editor, optionally starting the run' },
  // Agents (agent_lookup — registry introspection for the agent itself)
  { id: 'agents-lookup', name: 'agent_lookup', group: 'Agents', description: "Look up agent profiles — list every agent or read one agent's full details by @username" },
  { id: 'agents-contacts', name: 'agent_contacts', group: 'Agents', description: 'The workspace contact book — every enabled agent grouped by team, one line each' },
  { id: 'gh-wiki', name: 'github_wiki', group: 'GitHub', description: 'List wiki pages or read a page and its history' },
];

const toolIdsByName = new Map(AGENT_TOOLS.map(({ name, id }) => [name, id]));

/** Existing agent profiles may store callable names or settings IDs. */
export function agentToolId(key: string): string {
  return toolIdsByName.get(key) ?? key;
}

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
export const TOOL_GROUPS: AgentTool['group'][] = ['Files', 'Search', 'Terminal', 'Git', 'GitHub', 'Web', 'Diagram', 'Design', 'Board', 'E2E', 'Agents'];

export function selectAgentTools(
  tools: ToolSpec[],
  allowlist: string[],
  team?: string,
): ToolSpec[] {
  const enabled = loadEnabledTools();
  const allowed = new Set(allowlist.map(agentToolId));
  return tools.filter(tool => {
    const registeredId = toolIdsByName.get(tool.name);
    return (!registeredId || enabled.has(registeredId))
      && (allowed.size === 0 || allowed.has(registeredId ?? tool.id))
      && (team !== 'Browser' || (tool.name !== 'playwright' && tool.name !== 'browser'));
  });
}
