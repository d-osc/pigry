/** Installed extensions: install, switch on/off and remove. An extension is a pack (see extensionManifest.ts) whose
 * agents, hooks and MCP servers are added to the app's normal stores, each tagged with the extension id, so they work
 * like any other and disappear with the extension. Its skills stay inside the extension record and are read from there. */
import { newId } from './aiProviders';
import { builtinAgents, builtinAvatar, loadAgents, loadHooks, saveAgents, saveHooks, type AgentEntry, type HookEntry } from './agentExtras';
import { loadMcpServers, saveMcpServers, type McpServer } from './mcpServers';
import { listSkills } from './skills';
import {
  EXTENSIONS_STORAGE_KEY, normalizeInstalled, planInstall,
  type ExtensionManifest, type InstallPlan, type InstalledExtension,
} from './extensionManifest';

import { EXTENSIONS_CHANGED } from './builtinExtensions';

export { EXTENSIONS_CHANGED };
/** Asks the Extensions screen to show one extension (dispatched by the side bar). */
export const EXTENSION_OPEN = 'pigry:open-extension';

export function listExtensions(): InstalledExtension[] {
  try {
    const raw = localStorage.getItem(EXTENSIONS_STORAGE_KEY);
    return raw ? normalizeInstalled(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveExtensions(list: InstalledExtension[]): void {
  try {
    localStorage.setItem(EXTENSIONS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // session-only
  }
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED));
}

/** Removes everything an extension added to the agent, hook and MCP stores. */
function removeEntries(id: string): void {
  saveAgents(loadAgents().filter((agent) => agent.extensionId !== id));
  saveHooks(loadHooks().filter((hook) => hook.extensionId !== id));
  saveMcpServers(loadMcpServers().filter((server) => server.extensionId !== id));
}

export type InstallResult = { ok: true; extension: InstalledExtension } | { ok: false; errors: string[] };

/** What installing would do right now: final skill ids and any conflicts with agents, skills or servers that exist. */
export async function previewInstall(manifest: ExtensionManifest): Promise<InstallPlan> {
  const previous = listExtensions().find((extension) => extension.id === manifest.id);
  const agentNames = new Set<string>([
    ...builtinAgents().map((agent) => agent.username),
    ...loadAgents().filter((agent) => agent.extensionId !== manifest.id).map((agent) => agent.username),
  ]);
  const skillIds = new Set((await listSkills()).filter((skill) => !(skill.extension && previous?.skills.some((own) => own.id === skill.id))).map((skill) => skill.id));
  const mcpNames = new Set(loadMcpServers().filter((server) => server.extensionId !== manifest.id).map((server) => server.name));
  return planInstall(manifest, { agentUsernames: agentNames, skillIds, mcpNames });
}

/** Installs (or updates, when the same id is already installed) an extension that passed parseExtensionManifest. */
export async function installExtension(manifest: ExtensionManifest, source: InstalledExtension['source']): Promise<InstallResult> {
  const previous = listExtensions().find((extension) => extension.id === manifest.id);
  const plan = await previewInstall(manifest);
  if (plan.conflicts.length > 0) return { ok: false, errors: plan.conflicts };

  const enabled = previous ? previous.enabled : true;
  if (previous) removeEntries(manifest.id);

  const agents: AgentEntry[] = plan.agents.map((agent) => ({
    id: newId('agent'), name: agent.name, username: agent.username, role: agent.role, team: agent.team,
    description: agent.description, enabled, tools: agent.tools, skills: agent.skills, mcpServers: agent.mcpServers,
    avatar: builtinAvatar(agent.username, agent.emoji ?? '🧩'), extensionId: manifest.id,
  }));
  const hooks: HookEntry[] = manifest.hooks.map((hook) => ({ id: newId('hook'), event: hook.event, command: hook.command, enabled, extensionId: manifest.id }));
  const servers: McpServer[] = manifest.mcpServers.map((server) => ({ id: newId('mcp'), ...server, enabled, extensionId: manifest.id }));

  saveAgents([...loadAgents(), ...agents]);
  saveHooks([...loadHooks(), ...hooks]);
  saveMcpServers([...loadMcpServers(), ...servers]);

  const extension: InstalledExtension = {
    id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author,
    enabled, installedAt: Date.now(), source,
    agentIds: agents.map((agent) => agent.id), hookIds: hooks.map((hook) => hook.id), mcpIds: servers.map((server) => server.id),
    skills: plan.skills, agentNames: agents.map((agent) => `@${agent.username}`),
    hookCommands: hooks.map((hook) => hook.command), mcpNames: servers.map((server) => server.name),
  };
  saveExtensions([...listExtensions().filter((entry) => entry.id !== manifest.id), extension]);
  return { ok: true, extension };
}

/** Switches an extension on or off: its agents, hooks, MCP servers and skills all follow. */
export function setExtensionEnabled(id: string, enabled: boolean): void {
  saveAgents(loadAgents().map((agent) => (agent.extensionId === id ? { ...agent, enabled } : agent)));
  saveHooks(loadHooks().map((hook) => (hook.extensionId === id ? { ...hook, enabled } : hook)));
  saveMcpServers(loadMcpServers().map((server) => (server.extensionId === id ? { ...server, enabled } : server)));
  saveExtensions(listExtensions().map((extension) => (extension.id === id ? { ...extension, enabled } : extension)));
}

let pendingOpen: string | null = null;

/** Asks the Extensions screen to show an extension; works even before that screen has mounted. */
export function requestOpenExtension(id: string): void {
  pendingOpen = id;
  window.dispatchEvent(new CustomEvent(EXTENSION_OPEN, { detail: id }));
}

/** Reads the waiting request without consuming it — safe in a state initializer, which React may run and throw away (Suspense, StrictMode). */
export function peekPendingOpenExtension(): string | null {
  return pendingOpen;
}

export function takePendingOpenExtension(): string | null {
  const id = pendingOpen;
  pendingOpen = null;
  return id;
}

export function uninstallExtension(id: string): void {
  removeEntries(id);
  saveExtensions(listExtensions().filter((extension) => extension.id !== id));
}
