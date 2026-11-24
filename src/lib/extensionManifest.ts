/** Extensions are installable packs: one JSON manifest that bundles agents, skills, hooks and MCP servers.
 * This module is pure (no storage, no app imports): it validates a manifest and turns it into the entries that
 * get installed. src/lib/extensions.ts applies the result to the app's stores. */

export const EXTENSION_MANIFEST_VERSION = 1;
/** localStorage key of the installed extensions (shared with the skills loader, which cannot import the store). */
export const EXTENSIONS_STORAGE_KEY = 'pigry:extensions';

export const LIMITS = {
  agents: 20, skills: 30, hooks: 10, mcpServers: 10,
  skillContent: 20_000, text: 400, file: 400_000,
} as const;

export type HookEventName = 'before-send' | 'after-reply';

export interface ExtensionAgent {
  username: string;
  name: string;
  role: string;
  description: string;
  emoji?: string;
  team?: string;
  tools: string[];
  /** Ids of this extension's skills, or of skills that already exist. */
  skills: string[];
  /** Names of this extension's MCP servers. */
  mcpServers: string[];
}

export interface ExtensionSkill { id: string; name: string; description: string; content: string; }
export interface ExtensionHook { event: HookEventName; command: string; }
export interface ExtensionMcpServer { name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; env: string; }

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  agents: ExtensionAgent[];
  skills: ExtensionSkill[];
  hooks: ExtensionHook[];
  mcpServers: ExtensionMcpServer[];
}

export type ParseResult = { ok: true; manifest: ExtensionManifest } | { ok: false; errors: string[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,58}[a-z0-9]$|^[a-z0-9]$/;

const text = (value: unknown, max: number = LIMITS.text): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).map((item) => text(item, 120)).filter(Boolean);
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Validates and normalises a manifest given as JSON text or as an already parsed value. Never throws. */
export function parseExtensionManifest(input: unknown): ParseResult {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > LIMITS.file) return { ok: false, errors: [`The file is larger than ${Math.round(LIMITS.file / 1000)} KB.`] };
    try { value = JSON.parse(input); } catch (error) { return { ok: false, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  }
  const raw = object(value);
  const errors: string[] = [];
  if (Object.keys(raw).length === 0) return { ok: false, errors: ['The manifest must be a JSON object.'] };
  if (raw.pigryExtension !== EXTENSION_MANIFEST_VERSION) errors.push(`"pigryExtension": ${EXTENSION_MANIFEST_VERSION} is required (this file is not a Pigry extension).`);

  const id = text(raw.id, 64).toLowerCase();
  if (!ID_PATTERN.test(id)) errors.push('"id" must be 3-64 characters: lowercase letters, digits, dots, dashes (for example acme.review-pack).');
  const name = text(raw.name, 60);
  if (!name) errors.push('"name" is required.');
  const version = text(raw.version, 30) || '0.0.0';

  const skills: ExtensionSkill[] = [];
  list(raw.skills).forEach((entry, index) => {
    const item = object(entry);
    const skillId = text(item.id, 60).toLowerCase();
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, LIMITS.skillContent) : '';
    if (!SKILL_ID_PATTERN.test(skillId)) errors.push(`skills[${index}]: "id" must be lowercase letters, digits, dashes or underscores.`);
    else if (skills.some((skill) => skill.id === skillId)) errors.push(`skills[${index}]: duplicate id "${skillId}".`);
    else if (!content) errors.push(`skills[${index}] ("${skillId}"): "content" is required.`);
    else skills.push({ id: skillId, name: text(item.name, 80) || skillId, description: text(item.description, 200), content });
  });

  const mcpServers: ExtensionMcpServer[] = [];
  list(raw.mcpServers).forEach((entry, index) => {
    const item = object(entry);
    const serverName = text(item.name, 60);
    const transport = item.transport === 'http' ? 'http' : 'stdio';
    const command = text(item.command, 300);
    const url = text(item.url, 300);
    if (!serverName) errors.push(`mcpServers[${index}]: "name" is required.`);
    else if (mcpServers.some((server) => server.name === serverName)) errors.push(`mcpServers[${index}]: duplicate name "${serverName}".`);
    else if (transport === 'stdio' && !command) errors.push(`mcpServers[${index}] ("${serverName}"): a stdio server needs a "command".`);
    else if (transport === 'http' && !/^https?:\/\//i.test(url)) errors.push(`mcpServers[${index}] ("${serverName}"): an http server needs an http(s) "url".`);
    else mcpServers.push({ name: serverName, transport, command, args: text(item.args, 600), url, env: typeof item.env === 'string' ? item.env.slice(0, 1000) : '' });
  });

  const hooks: ExtensionHook[] = [];
  list(raw.hooks).forEach((entry, index) => {
    const item = object(entry);
    const command = text(item.command, 500);
    if (item.event !== 'before-send' && item.event !== 'after-reply') errors.push(`hooks[${index}]: "event" must be before-send or after-reply.`);
    else if (!command) errors.push(`hooks[${index}]: "command" is required.`);
    else hooks.push({ event: item.event, command });
  });

  const agents: ExtensionAgent[] = [];
  list(raw.agents).forEach((entry, index) => {
    const item = object(entry);
    const username = text(item.username, 40).toLowerCase().replace(/^@/, '');
    const agentName = text(item.name, 60);
    if (!HANDLE_PATTERN.test(username)) errors.push(`agents[${index}]: "username" must be 3-40 characters: lowercase letters, digits, dashes.`);
    else if (agents.some((agent) => agent.username === username)) errors.push(`agents[${index}]: duplicate username "${username}".`);
    else if (!agentName) errors.push(`agents[${index}] (@${username}): "name" is required.`);
    else {
      agents.push({
        username, name: agentName, role: text(item.role, 80), description: text(item.description, 400), emoji: text(item.emoji, 8) || undefined,
        team: text(item.team, 40) || undefined, tools: strings(item.tools), skills: strings(item.skills), mcpServers: strings(item.mcpServers),
      });
    }
  });

  if (list(raw.agents).length > LIMITS.agents) errors.push(`At most ${LIMITS.agents} agents.`);
  if (list(raw.skills).length > LIMITS.skills) errors.push(`At most ${LIMITS.skills} skills.`);
  if (list(raw.hooks).length > LIMITS.hooks) errors.push(`At most ${LIMITS.hooks} hooks.`);
  if (list(raw.mcpServers).length > LIMITS.mcpServers) errors.push(`At most ${LIMITS.mcpServers} MCP servers.`);
  if (errors.length === 0 && agents.length + skills.length + hooks.length + mcpServers.length === 0) errors.push('The extension adds nothing: list at least one agent, skill, hook or MCP server.');

  for (const agent of agents) {
    for (const server of agent.mcpServers) {
      if (!mcpServers.some((candidate) => candidate.name === server)) errors.push(`@${agent.username}: MCP server "${server}" is not defined in this extension.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { id, name, version, description: text(raw.description, 300), author: text(raw.author, 80), agents, skills, hooks, mcpServers } };
}

/** What installing the extension lets it run on this computer — shown for review before anything is installed. */
export function executableParts(manifest: ExtensionManifest): { hooks: ExtensionHook[]; mcpServers: ExtensionMcpServer[] } {
  return { hooks: manifest.hooks, mcpServers: manifest.mcpServers };
}

export const needsTrust = (manifest: ExtensionManifest): boolean => manifest.hooks.length > 0 || manifest.mcpServers.length > 0;

export interface InstallContext {
  /** Handles already used by built-in or user agents. */
  agentUsernames: ReadonlySet<string>;
  /** Skill ids that already exist (built-in or project skills). */
  skillIds: ReadonlySet<string>;
  mcpNames: ReadonlySet<string>;
}

export interface InstallPlan {
  /** Problems that stop the installation (for example a handle that is already taken). */
  conflicts: string[];
  /** Skills with the ids they get once installed (an id that already exists gets the extension id as a prefix). */
  skills: ExtensionSkill[];
  agents: ExtensionAgent[];
  skillIdMap: Record<string, string>;
}

const slug = (value: string): string => value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Decides the final ids for an install and reports conflicts, without touching any store. */
export function planInstall(manifest: ExtensionManifest, context: InstallContext): InstallPlan {
  const conflicts: string[] = [];
  const skillIdMap: Record<string, string> = {};
  const taken = new Set(context.skillIds);
  const skills = manifest.skills.map((skill) => {
    let id = skill.id;
    if (taken.has(id)) id = `${slug(manifest.id)}-${skill.id}`;
    taken.add(id);
    skillIdMap[skill.id] = id;
    return { ...skill, id };
  });
  for (const agent of manifest.agents) {
    if (context.agentUsernames.has(agent.username)) conflicts.push(`The handle @${agent.username} is already used by another agent.`);
  }
  for (const server of manifest.mcpServers) {
    if (context.mcpNames.has(server.name)) conflicts.push(`An MCP server named "${server.name}" already exists.`);
  }
  const agents = manifest.agents.map((agent) => ({ ...agent, skills: agent.skills.map((id) => skillIdMap[id] ?? id) }));
  return { conflicts, skills, agents, skillIdMap };
}

/** The record kept for an installed extension. */
export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  installedAt: number;
  source: 'catalog' | 'file' | 'paste';
  /** Ids of the entries this extension added to the agent, hook and MCP stores. */
  agentIds: string[];
  hookIds: string[];
  mcpIds: string[];
  skills: ExtensionSkill[];
  /** Short labels of what it added, for the list. */
  agentNames: string[];
  hookCommands: string[];
  mcpNames: string[];
}

/** Normalises the stored list (it comes from localStorage, so treat it as untrusted). */
export function normalizeInstalled(value: unknown): InstalledExtension[] {
  return list(value).flatMap((entry) => {
    const item = object(entry);
    const id = text(item.id, 64);
    if (!id) return [];
    return [{
      id, name: text(item.name, 60) || id, version: text(item.version, 30), description: text(item.description, 300), author: text(item.author, 80),
      enabled: item.enabled !== false, installedAt: Number(item.installedAt) || 0,
      source: item.source === 'file' || item.source === 'paste' ? item.source : 'catalog',
      agentIds: strings(item.agentIds), hookIds: strings(item.hookIds), mcpIds: strings(item.mcpIds),
      skills: list(item.skills).flatMap((skill) => {
        const s = object(skill);
        const skillId = text(s.id, 80);
        const content = typeof s.content === 'string' ? s.content : '';
        return skillId && content ? [{ id: skillId, name: text(s.name, 80) || skillId, description: text(s.description, 200), content }] : [];
      }),
      agentNames: strings(item.agentNames), hookCommands: strings(item.hookCommands), mcpNames: strings(item.mcpNames),
    }];
  });
}

/** The skills of every enabled extension, read straight from storage (skills.ts cannot import the store). */
export function enabledExtensionSkills(storage: Pick<Storage, 'getItem'> | undefined): ExtensionSkill[] {
  try {
    const raw = storage?.getItem(EXTENSIONS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeInstalled(JSON.parse(raw)).filter((extension) => extension.enabled).flatMap((extension) => extension.skills);
  } catch {
    return [];
  }
}
