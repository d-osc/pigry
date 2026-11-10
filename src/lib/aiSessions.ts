/** Copilot-style chat sessions — stored IN the working repo, scoped per
 * team (and per agent) under `.orbit/teams/...` so conversations are
 * versionable alongside the code. The active-session pointer stays in
 * localStorage (per-machine UI preference); sessions themselves travel
 * with the repo.
 */

import { agentChatDir, teamChatDir } from './teamStore';
import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from './tauriClient';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  /** Clean, editable message text (context is kept separately). */
  text: string;
  /** Baked context (selection + attachments) sent with the payload. */
  context?: string;
  /** Editor selection attached at send time — shown as a code card. */
  selection?: { path: string; startLine: number; endLine: number; text: string } | null;
  images?: string[];
  error?: boolean;
  /** Wall-clock timestamp (ms) shown next to the sender name. */
  time?: number;
}

export interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiChatMessage[];
  /** True once the user renames the group — the auto-title stops applying. */
  titleCustom?: boolean;
}

const LEGACY_DIR = '.orbit/chat/';
const ACTIVE_KEY = 'orbit:ai-session-active';
const MAX_MESSAGES = 100;

/** Which store a chat belongs to: a team's shared chat, or one agent's
 * private chat. Omitted = the legacy project-wide store. */
export interface ChatScope {
  /** Team name — scopes sessions to `.orbit/teams/<team>/chat/`. */
  team?: string;
  /** Agent username — scopes to the agent's private chat directory. */
  agent?: string;
}

function dirFor(scope?: ChatScope): string {
  if (scope?.team && scope.agent) return agentChatDir(scope.team, scope.agent);
  if (scope?.team) return teamChatDir(scope.team);
  return LEGACY_DIR;
}

function activeKeyFor(scope?: ChatScope): string {
  const suffix = scope?.team
    ? `:${scope.team}${scope.agent ? `/${scope.agent}` : ''}`
    : '';
  return `${ACTIVE_KEY}${suffix}`;
}

/** Lists every session file in the scope, newest first. */
export async function listSessions(scope?: ChatScope): Promise<AiChatSession[]> {
  const tree = await getFileTree();
  const dir = dirFor(scope);
  const paths = tree.entries.filter((p) => p.startsWith(dir) && p.endsWith('.json'));
  const sessions: AiChatSession[] = [];
  for (const path of paths) {
    try {
      const raw = await readWorktreeFile(path);
      const session = JSON.parse(raw.content) as AiChatSession;
      if (session && Array.isArray(session.messages)) sessions.push(session);
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/** Writes one session file (images dropped, last 100 messages kept). */
export async function saveSession(session: AiChatSession, scope?: ChatScope): Promise<void> {
  const slim: AiChatSession = {
    ...session,
    messages: session.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, images: undefined })),
  };
  await writeWorktreeFile(`${dirFor(scope)}${session.id}.json`, JSON.stringify(slim));
}

export async function deleteSessionFile(id: string, scope?: ChatScope): Promise<void> {
  await deleteWorktreeFile(`${dirFor(scope)}${id}.json`);
}

export function activeSessionId(scope?: ChatScope): string {
  try {
    return localStorage.getItem(activeKeyFor(scope)) ?? '';
  } catch {
    return '';
  }
}

export function setActiveSessionId(id: string, scope?: ChatScope) {
  try {
    localStorage.setItem(activeKeyFor(scope), id);
  } catch {
    // session-only
  }
}

/** One-time migration: localStorage sessions → repo files. */
export async function migrateLocalSessions(scope?: ChatScope): Promise<void> {
  try {
    const raw = localStorage.getItem('orbit:ai-sessions');
    if (!raw) return;
    const list = JSON.parse(raw) as AiChatSession[];
    for (const session of list) {
      if (session && Array.isArray(session.messages) && session.messages.length > 0) {
        await saveSession(session, scope);
      }
    }
    localStorage.removeItem('orbit:ai-sessions');
  } catch {
    // corrupt legacy data — drop silently
  }
}

/** Chat title from the first user message (Copilot-style). */
export function titleFromMessages(messages: AiChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New group';
  const line = first.text.split('\n')[0].trim();
  return line.length > 0 ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : 'New group';
}

export async function renameSessionFile(
  id: string,
  title: string,
  scope?: ChatScope,
): Promise<void> {
  const sessions = await listSessions(scope);
  const session = sessions.find((s) => s.id === id);
  if (!session) throw new Error('Group not found');
  await saveSession({ ...session, title, titleCustom: true, updatedAt: Date.now() }, scope);
}
