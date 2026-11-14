/** MCP (Model Context Protocol) server store — shared by the MCP screen and
 * the Tools screen. Servers live in localStorage under `pigry:mcp-servers`;
 * the list exports to the standard `.mcp.json` shape used by Claude Desktop
 * and other MCP clients.
 */
import { newId } from './aiProviders';
import { readWorktreeFile, writeWorktreeFile } from './tauriClient';

export type McpTransport = 'stdio' | 'http';

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: executable to spawn. */
  command: string;
  /** stdio: whitespace-separated arguments (quotes preserved). */
  args: string;
  /** http: streamable-HTTP / SSE endpoint. */
  url: string;
  /** One VAR=value per line. */
  env: string;
  enabled: boolean;
}

const LIST_KEY = 'pigry:mcp-servers';

export function loadMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    return normalizeMcpServers(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function normalizeMcpServers(list: unknown[]): McpServer[] {
  return (list as Partial<McpServer>[])
    .map(migrateServer)
    .filter((server): server is McpServer => server !== null);
}

const MCP_FILE = '.pigry/mcp/mcp.json';

/** Reads the repo-file store (.pigry/mcp/mcp.json); null when absent. */
export async function hydrateMcpServers(): Promise<McpServer[] | null> {
  try {
    const raw = await readWorktreeFile(MCP_FILE);
    return normalizeMcpServers(JSON.parse(raw.content));
  } catch {
    return null;
  }
}

/** Mirrors the store into the repo so MCP servers are versionable. */
export async function mirrorMcpServers(list: McpServer[]): Promise<void> {
  try {
    await writeWorktreeFile(MCP_FILE, JSON.stringify(list, null, 2));
  } catch {
    // read-only repo — localStorage remains the source of truth
  }
}

function migrateServer(raw: Partial<McpServer>): McpServer | null {
  const name = String(raw?.name ?? '').trim();
  if (!name) return null;
  return {
    id: String(raw?.id ?? newId('mcp')),
    name,
    transport: raw?.transport === 'http' ? 'http' : 'stdio',
    command: String(raw?.command ?? ''),
    args: String(raw?.args ?? ''),
    url: String(raw?.url ?? ''),
    env: String(raw?.env ?? ''),
    enabled: raw?.enabled !== false,
  };
}

export function saveMcpServers(servers: McpServer[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(servers));
  } catch {
    // session-only
  }
}

/** "a "b c" d" → ['a', 'b c', 'd'] — shell-style argument splitting. */
export function parseArgs(args: string): string[] {
  const matches = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((part) => part.replace(/^"|"$/g, ''));
}

/** "FOO=1\nBAR=2" → { FOO: '1', BAR: '2' } */
export function parseEnv(env: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Standard `.mcp.json` shape (Claude Desktop / MCP clients). */
export function mcpJsonExport(servers: McpServer[]): string {
  const map: Record<string, Record<string, unknown>> = {};
  for (const server of servers.filter((s) => s.enabled)) {
    if (server.transport === 'http') {
      map[server.name] = { type: 'http', url: server.url };
    } else {
      const entry: Record<string, unknown> = { command: server.command };
      const args = parseArgs(server.args);
      if (args.length > 0) entry.args = args;
      const env = parseEnv(server.env);
      if (Object.keys(env).length > 0) entry.env = env;
      map[server.name] = entry;
    }
  }
  return JSON.stringify({ mcpServers: map }, null, 2);
}

/** Per-server JSON snippet (same shape, single entry). */
export function mcpServerSnippet(server: McpServer): string {
  return mcpJsonExport([server]).replace(/^\{\n\s*"mcpServers":\s*/, '').replace(/\n\}$/, '\n}');
}
