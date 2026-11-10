/** Copilot-style chat sessions — stored IN the working repo, scoped per
 * team (and per agent) under `.orbit/teams/...` so conversations are
 * versionable alongside the code. The active-session pointer stays in
 * localStorage (per-machine UI preference); sessions themselves travel
 * with the repo.
 */

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
  /** Agent username that produced this message (assistant side). */
  agent?: string;
  /** Repo-owner username that wrote this message (user side). */
  owner?: string;
  /** Tool calls the agent made this turn (display only). */
  toolEvents?: string[];
}

export interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiChatMessage[];
  /** True once the user renames the group — the auto-title stops applying. */
  titleCustom?: boolean;
  /** Team this chat belongs to. */
  team?: string;
  /** Username of the agent handling this chat. */
  agentUsername?: string;
  /** Repo owner the chat belongs to. */
  owner?: string;
}

const CHAT_DIR = '.orbit/chat/';
const ACTIVE_KEY = 'orbit:ai-session-active';
const MAX_MESSAGES = 100;

/** Which store a chat belongs to. `team` tags the session so each team's
 * menu only shows its own chats — files all live in one .orbit/chat/ dir. */
export interface ChatScope {
  /** Team name — sessions are tagged and filtered by this team. */
  team?: string;
  /** Agent username — tags the acting agent on the session. */
  agent?: string;
}

function chatDir(): string {
  return CHAT_DIR;
}

function activeKeyFor(scope?: ChatScope): string {
  const suffix = scope?.team
    ? `:${scope.team}${scope.agent ? `/${scope.agent}` : ''}`
    : '';
  return `${ACTIVE_KEY}${suffix}`;
}

/** Lists sessions in .orbit/chat/, newest first. When a team scope is given
 * only that team's chats are returned — groups never leak into other menus. */
export async function listSessions(scope?: ChatScope): Promise<AiChatSession[]> {
  const tree = await getFileTree();
  const dir = chatDir();
  const paths = tree.entries.filter((p) => p.startsWith(dir) && p.endsWith('.json'));
  const sessions: AiChatSession[] = [];
  for (const path of paths) {
    try {
      const raw = await readWorktreeFile(path);
      const session = JSON.parse(raw.content) as AiChatSession;
      if (session && Array.isArray(session.messages)) {
        if (scope?.team && (session.team ?? '') !== scope.team) continue;
        sessions.push(session);
      }
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/** Writes one session file into .orbit/chat/ (images dropped, last 100
 * messages kept). The session's `team` field drives menu filtering. */
export async function saveSession(session: AiChatSession): Promise<void> {
  const slim: AiChatSession = {
    ...session,
    messages: session.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, images: undefined })),
  };
  await writeWorktreeFile(`${chatDir()}${session.id}.json`, JSON.stringify(slim));
}

export async function deleteSessionFile(id: string): Promise<void> {
  await deleteWorktreeFile(`${chatDir()}${id}.json`);
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
export async function migrateLocalSessions(): Promise<void> {
  try {
    const raw = localStorage.getItem('orbit:ai-sessions');
    if (!raw) return;
    const list = JSON.parse(raw) as AiChatSession[];
    for (const session of list) {
      if (session && Array.isArray(session.messages) && session.messages.length > 0) {
        await saveSession(session);
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

export async function renameSessionFile(id: string, title: string): Promise<void> {
  const sessions = await listSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) throw new Error('Group not found');
  await saveSession({ ...session, title, titleCustom: true, updatedAt: Date.now() });
}
