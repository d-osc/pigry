/** Import from other coding agents (Claude Code, Codex, Antigravity) — pure planning and conversion, no I/O.
 *
 * What is imported (user-level files, the same idea as Hermes Agent's importers):
 *  - instructions (CLAUDE.md, AGENTS.md, GEMINI.md, rules, Codex memories) → blocks in `.pigry/instructions.md`
 *  - skills (`<name>/SKILL.md`) → `.pigry/skills/<agent>-<name>.md`
 *  - MCP servers → Pigry's MCP list, switched OFF (they start programs: review, then enable)
 * Never imported: credentials, permission rules, slash commands, custom agents (reported instead). MCP env entries and headers that look
 * like secrets are dropped and listed so the user can add them again on purpose. */

export type AgentId = 'claude-code' | 'codex' | 'antigravity';
export interface ImportFile { path: string; text: string }

export const AGENT_LABEL: Record<AgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

export interface InstructionItem { kind: 'instructions'; key: string; title: string; text: string }
export interface SkillItem { kind: 'skill'; key: string; id: string; name: string; description: string; markdown: string }
export interface McpItem { kind: 'mcp'; key: string; name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; env: string; stripped: string[] }
export type ImportItem = InstructionItem | SkillItem | McpItem;
export interface ImportPlan { agent: AgentId; items: ImportItem[]; notes: string[] }

/* ---------------------------------------------------------------- small helpers */

export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const digestOf = (files: ImportFile[]): string => hashText([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\n${f.text}`).join('\u0000'));

const slug = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

export function parseFrontmatter(markdown: string): { data: Record<string, string>; body: string } {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, '') };
}

const SECRET_NAME = /(token|secret|api[_-]?key|apikey|password|passwd|credential|auth|bearer|private[_-]?key)/i;
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name) || /^(key|sig|signature|pwd|pass)$/i.test(name.trim());

/* ---------------------------------------------------------------- a small TOML reader (tables, strings, arrays, inline tables) */

type Toml = { [key: string]: TomlValue };
type TomlValue = string | number | boolean | TomlValue[] | Toml;

function splitTop(text: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, quote = '', cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === '\\' && quote === '"') { cur += text[++i] ?? ''; } else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseKeyPath(text: string): string[] {
  return splitTop(text.trim(), '.').map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
}
function parseTomlValue(raw: string): TomlValue {
  const v = raw.trim();
  if (v.startsWith('"')) return v.slice(1, v.lastIndexOf('"')).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[')) return splitTop(v.slice(1, v.lastIndexOf(']')), ',').map((x) => x.trim()).filter(Boolean).map(parseTomlValue);
  if (v.startsWith('{')) {
    const obj: Toml = {};
    for (const part of splitTop(v.slice(1, v.lastIndexOf('}')), ',')) {
      const eq = part.indexOf('=');
      if (eq > 0) obj[parseKeyPath(part.slice(0, eq)).join('.')] = parseTomlValue(part.slice(eq + 1));
    }
    return obj;
  }
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : v;
}
/** Parses the parts of a TOML file that matter here; anything it cannot read is skipped rather than failing the import. */
export function parseToml(text: string): Toml {
  const root: Toml = {};
  let table: Toml = root;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header && !line.includes('=')) {
      table = root;
      for (const part of parseKeyPath(header[1])) { const next = table[part]; table = (next && typeof next === 'object' && !Array.isArray(next) ? next : (table[part] = {})) as Toml; }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = parseKeyPath(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();
    // multi-line arrays / inline tables
    const open = (s: string): number => [...s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '')].reduce((n, c) => n + (c === '[' || c === '{' ? 1 : c === ']' || c === '}' ? -1 : 0), 0);
    while (open(value) > 0 && i + 1 < lines.length) { i++; line = lines[i].trim(); if (!line.startsWith('#')) value += ' ' + line; }
    value = value.replace(/\s+#[^"']*$/, '');
    let target = table;
    for (const part of key.slice(0, -1)) { const next = target[part]; target = (next && typeof next === 'object' && !Array.isArray(next) ? next : (target[part] = {})) as Toml; }
    target[key[key.length - 1]] = parseTomlValue(value);
  }
  return root;
}

/* ---------------------------------------------------------------- MCP servers */

const quoteArg = (a: string): string => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function mcpFrom(name: string, raw: unknown, key: string): McpItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const url = String(o.url ?? o.serverUrl ?? o.httpUrl ?? '');
  const stripped: string[] = [];
  const envObj = (o.env && typeof o.env === 'object' ? o.env : {}) as Record<string, unknown>;
  const envLines: string[] = [];
  for (const [k, v] of Object.entries(envObj)) {
    if (looksSecret(k)) stripped.push(k);
    else envLines.push(`${k}=${String(v)}`);
  }
  const headers = (o.headers ?? o.http_headers ?? o.httpHeaders) as Record<string, unknown> | undefined;
  for (const k of Object.keys(headers ?? {})) stripped.push(`header ${k}`);
  for (const k of Object.keys((o.env_http_headers ?? {}) as Record<string, unknown>)) stripped.push(`header ${k}`);
  if (url) {
    let clean = url;
    try {
      const u = new URL(url);
      for (const q of [...u.searchParams.keys()]) if (looksSecret(q)) { stripped.push(`url parameter ${q}`); u.searchParams.delete(q); }
      clean = u.toString();
    } catch { /* keep the text as it is */ }
    return { kind: 'mcp', key, name, transport: 'http', command: '', args: '', url: clean, env: '', stripped };
  }
  const command = String(o.command ?? '');
  if (!command) return null;
  const args = Array.isArray(o.args) ? o.args.map(String).map(quoteArg).join(' ') : '';
  return { kind: 'mcp', key, name, transport: 'stdio', command, args, url: '', env: envLines.join('\n'), stripped };
}

function mcpFromJson(text: string, path: string, pick: (json: Record<string, unknown>) => unknown): McpItem[] {
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { return []; }
  const map = pick(json);
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map as Record<string, unknown>).map(([name, raw]) => mcpFrom(name, raw, `mcp:${path}:${name}`)).filter((x): x is McpItem => x !== null);
}

/* ---------------------------------------------------------------- planning */

const INSTRUCTION_FILES = /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$/;

export function buildPlan(agent: AgentId, files: ImportFile[], skipped: string[] = []): ImportPlan {
  const items: ImportItem[] = [];
  const notes: string[] = [...skipped];
  const prefix = agent;
  for (const file of files) {
    const path = file.path;
    if (/(^|\/)SKILL\.md$/.test(path)) {
      const folder = path.split('/').slice(-2, -1)[0] ?? 'skill';
      const { data, body } = parseFrontmatter(file.text);
      const skillName = data.name || folder;
      const first = body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
      const description = (data.description || first).replace(/\s+/g, ' ').slice(0, 300);
      const id = `${prefix}-${slug(folder)}`;
      const markdown = `---\nname: ${skillName.replace(/\n/g, ' ')}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
      items.push({ kind: 'skill', key: `skill:${path}`, id, name: skillName, description, markdown });
    } else if (INSTRUCTION_FILES.test(path) || /\/(rules|memories)\/[^/]+\.md$/i.test(path)) {
      const { body } = parseFrontmatter(file.text); // rule frontmatter (trigger / globs) is dropped: Pigry has no per-rule triggers
      const text = body.trim();
      if (text) items.push({ kind: 'instructions', key: `instructions:${path}`, title: path.replace(/^\./, '~/.'), text });
    } else if (path === '.claude/settings.json' || path === '.claude.json') {
      items.push(...mcpFromJson(file.text, path, (j) => j.mcpServers));
      if (path === '.claude/settings.json') countPermissions(file.text, 'permissions', notes);
    } else if (path === '.gemini/config/mcp_config.json') {
      items.push(...mcpFromJson(file.text, path, (j) => j.mcpServers));
    } else if (path === '.gemini/antigravity-cli/settings.json') {
      countPermissions(file.text, 'permissions', notes);
    } else if (path === '.codex/config.toml') {
      let servers: unknown;
      try { servers = parseToml(file.text).mcp_servers; } catch { notes.push('.codex/config.toml could not be read'); }
      if (servers && typeof servers === 'object') for (const [n, raw] of Object.entries(servers as Record<string, unknown>)) { const m = mcpFrom(n, raw, `mcp:${path}:${n}`); if (m) items.push(m); }
    }
  }
  const stripped = items.filter((i): i is McpItem => i.kind === 'mcp').flatMap((m) => m.stripped.map((s) => `${m.name}: ${s}`));
  if (stripped.length) notes.push(`Left out because they look like secrets (add them again yourself if needed): ${stripped.join(', ')}`);
  if (items.some((i) => i.kind === 'mcp')) notes.push('MCP servers are imported switched off — they start programs, so check each one before turning it on.');
  return { agent, items, notes };
}

function countPermissions(text: string, key: string, notes: string[]): void {
  try {
    const perms = (JSON.parse(text) as Record<string, { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] }>)[key];
    const n = (perms?.allow?.length ?? 0) + (perms?.deny?.length ?? 0) + (perms?.ask?.length ?? 0);
    if (n > 0) notes.push(`${n} permission rule(s) were not imported (Pigry runs its own tool guards).`);
  } catch { /* unreadable settings: nothing to report */ }
}

/* ---------------------------------------------------------------- what is already there, and what changed since the last import */

export interface McpLike { id: string; name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; env: string; enabled: boolean; extensionId?: string }
export interface TargetState { instructions: string; skills: Record<string, string>; mcp: McpLike[] }
export interface SyncRecord { digest: string; at: number; items: Record<string, string> }
export type ItemStatus = 'new' | 'same' | 'update' | 'conflict';

const blockStart = (agent: AgentId, key: string): string => `<!-- pigry-import:${agent}:${key} -->`;
const BLOCK_END = '<!-- /pigry-import -->';
export const instructionBlock = (agent: AgentId, item: InstructionItem): string => `${blockStart(agent, item.key)}\n## Imported from ${AGENT_LABEL[agent]} — ${item.title}\n\n${item.text}\n${BLOCK_END}`;

function findBlock(text: string, agent: AgentId, key: string): { start: number; end: number } | null {
  const start = text.indexOf(blockStart(agent, key));
  if (start < 0) return null;
  const end = text.indexOf(BLOCK_END, start);
  return end < 0 ? null : { start, end: end + BLOCK_END.length };
}
const mcpSignature = (m: { transport: string; command: string; args: string; url: string; env: string }): string => hashText(`${m.transport}|${m.command}|${m.args}|${m.url}|${m.env}`);
const existingMcp = (target: TargetState, name: string): McpLike | undefined => target.mcp.find((s) => s.name === name && !s.extensionId);

/** The signature that identifies an item's content (what the sync record stores). */
export function itemHash(agent: AgentId, item: ImportItem): string {
  return item.kind === 'skill' ? hashText(item.markdown) : item.kind === 'instructions' ? hashText(instructionBlock(agent, item)) : mcpSignature(item);
}
function currentHash(agent: AgentId, item: ImportItem, target: TargetState): string | null {
  if (item.kind === 'skill') { const t = target.skills[item.id]; return t === undefined ? null : hashText(t); }
  if (item.kind === 'instructions') { const b = findBlock(target.instructions, agent, item.key); return b ? hashText(target.instructions.slice(b.start, b.end)) : null; }
  const m = existingMcp(target, item.name);
  return m ? mcpSignature(m) : null;
}

/** new = not there yet · same = identical · update = the source changed and the copy is untouched since the last import · conflict = the copy differs and was not made by an import (or was edited). */
export function statusOf(agent: AgentId, item: ImportItem, target: TargetState, record?: SyncRecord): ItemStatus {
  const now = currentHash(agent, item, target);
  if (now === null) return 'new';
  if (now === itemHash(agent, item)) return 'same';
  return record?.items[item.key] === now ? 'update' : 'conflict';
}

export interface ApplyOptions { overwrite: boolean; makeId: () => string; now: number }
export interface ApplyResult {
  skillWrites: Array<{ path: string; content: string }>;
  instructions: string | null;
  mcp: McpLike[] | null;
  record: SyncRecord;
  imported: number; updated: number; skipped: number; unchanged: number;
  lines: string[];
}

export function applyPlan(plan: ImportPlan, target: TargetState, digest: string, previous: SyncRecord | undefined, opts: ApplyOptions): ApplyResult {
  const { agent } = plan;
  const result: ApplyResult = { skillWrites: [], instructions: null, mcp: null, record: { digest, at: opts.now, items: { ...(previous?.items ?? {}) } }, imported: 0, updated: 0, skipped: 0, unchanged: 0, lines: [] };
  let instructions = target.instructions;
  let mcp = [...target.mcp];
  let changedInstructions = false, changedMcp = false;
  for (const item of plan.items) {
    const status = statusOf(agent, item, target, previous);
    const label = item.kind === 'skill' ? `skill ${item.id}` : item.kind === 'mcp' ? `MCP server ${item.name}` : `instructions ${item.title}`;
    if (status === 'same') { result.unchanged++; result.record.items[item.key] = itemHash(agent, item); continue; }
    if (status === 'conflict' && !opts.overwrite) { result.skipped++; result.lines.push(`Skipped ${label}: it already exists and differs (turn on "replace existing" to overwrite it).`); continue; }
    if (item.kind === 'skill') result.skillWrites.push({ path: `.pigry/skills/${item.id}.md`, content: item.markdown });
    else if (item.kind === 'instructions') {
      const block = instructionBlock(agent, item), at = findBlock(instructions, agent, item.key);
      instructions = at ? instructions.slice(0, at.start) + block + instructions.slice(at.end) : (instructions.trimEnd() ? instructions.trimEnd() + '\n\n' : '') + block + '\n';
      changedInstructions = true;
    } else {
      const entry: McpLike = { id: existingMcp({ ...target, mcp }, item.name)?.id ?? opts.makeId(), name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, enabled: existingMcp({ ...target, mcp }, item.name)?.enabled ?? false };
      mcp = mcp.some((s) => s.name === item.name && !s.extensionId) ? mcp.map((s) => (s.name === item.name && !s.extensionId ? entry : s)) : [...mcp, entry];
      changedMcp = true;
    }
    result.record.items[item.key] = itemHash(agent, item);
    if (status === 'new') result.imported++; else result.updated++;
    result.lines.push(`${status === 'new' ? 'Imported' : 'Updated'} ${label}`);
  }
  if (changedInstructions) result.instructions = instructions;
  if (changedMcp) result.mcp = mcp;
  return result;
}
