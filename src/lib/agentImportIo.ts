/** The I/O side of "Import from other agents": reads the agent's files (backend), the current project state, and writes the result. */
import { agentImportRead, getFileTree, readWorktreeFile, writeWorktreeFile } from './tauriClient';
import { readInstructions, saveInstructions } from './agentExtras';
import { loadMcpServers, mirrorMcpServers, saveMcpServers, type McpServer } from './mcpServers';
import { newId } from './aiProviders';
import {
  AGENT_LABEL, applyPlan, buildPlan, digestOf, statusOf,
  type AgentId, type ApplyResult, type ImportPlan, type ItemStatus, type SyncRecord, type TargetState,
} from './agentImport';

export const IMPORT_AGENTS: AgentId[] = ['claude-code', 'codex', 'antigravity'];
const RECORD_KEY = 'pigry:agent-import-sync-v1';

export function loadSyncRecords(): Partial<Record<AgentId, SyncRecord>> {
  try { return JSON.parse(localStorage.getItem(RECORD_KEY) ?? '{}') as Partial<Record<AgentId, SyncRecord>>; } catch { return {}; }
}
function saveSyncRecord(agent: AgentId, record: SyncRecord): void {
  try { localStorage.setItem(RECORD_KEY, JSON.stringify({ ...loadSyncRecords(), [agent]: record })); } catch { /* session-only */ }
}

/** What the project already has: instructions text, the skills the plan would write, the MCP list. */
async function readTarget(skillIds: string[]): Promise<TargetState> {
  const skills: Record<string, string> = {};
  let paths = new Set<string>();
  try { paths = new Set((await getFileTree()).entries); } catch { /* no project open */ }
  for (const id of skillIds) {
    const path = `.pigry/skills/${id}.md`;
    if (!paths.has(path)) continue;
    try { const f = await readWorktreeFile(path); if (!f.binary && !f.tooLarge) skills[id] = f.content; } catch { /* unreadable: treated as absent */ }
  }
  return { instructions: await readInstructions(), skills, mcp: loadMcpServers() };
}

export interface Preview {
  agent: AgentId; label: string; root: string; found: boolean; plan: ImportPlan; digest: string;
  statuses: ItemStatus[]; record: SyncRecord | undefined; changedSinceImport: boolean;
}

export async function previewAgent(agent: AgentId): Promise<Preview> {
  const read = await agentImportRead(agent);
  const plan = buildPlan(agent, read.files, read.skipped);
  const digest = digestOf(read.files);
  const record = loadSyncRecords()[agent];
  const target = await readTarget(plan.items.filter((i) => i.kind === 'skill').map((i) => (i as { id: string }).id));
  return {
    agent, label: AGENT_LABEL[agent], root: read.root, found: read.found, plan, digest,
    statuses: plan.items.map((item) => statusOf(agent, item, target, record)), record, changedSinceImport: !!record && record.digest !== digest,
  };
}

/** Writes the plan into the project and remembers what was imported. */
export async function importAgent(agent: AgentId, overwrite: boolean, preview?: Preview): Promise<ApplyResult> {
  const p = preview ?? await previewAgent(agent);
  const target = await readTarget(p.plan.items.filter((i) => i.kind === 'skill').map((i) => (i as { id: string }).id));
  const result = applyPlan(p.plan, target, p.digest, loadSyncRecords()[agent], { overwrite, makeId: () => newId('mcp'), now: Date.now() });
  for (const w of result.skillWrites) await writeWorktreeFile(w.path, w.content);
  if (result.instructions !== null) await saveInstructions(result.instructions);
  if (result.mcp !== null) { const list = result.mcp as McpServer[]; saveMcpServers(list); await mirrorMcpServers(list); }
  saveSyncRecord(agent, result.record);
  return result;
}

/** Re-imports every agent that was imported before and whose files changed (unchanged ones are skipped by their digest). */
export async function syncImports(): Promise<Array<{ agent: AgentId; result: ApplyResult | null }>> {
  const out: Array<{ agent: AgentId; result: ApplyResult | null }> = [];
  for (const agent of IMPORT_AGENTS) {
    const record = loadSyncRecords()[agent];
    if (!record) continue;
    const p = await previewAgent(agent);
    out.push({ agent, result: p.changedSinceImport ? await importAgent(agent, false, p) : null });
  }
  return out;
}
