/** Copilot-style chat sessions — stored IN the working repo, scoped per
 * team (and per agent) under `.pigry/teams/...` so conversations are
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
  /** Model (+ effort) this reply actually used, e.g. "gpt-6.1-sol · high". */
  used?: string;
  /** Tool calls the agent made this turn (display only). */
  toolEvents?: string[];
  /** Prompt + completion tokens this reply consumed, when the provider
   * reported usage — feeds the context-window % badge. */
  tokens?: number;
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

const CHAT_DIR = '.pigry/chat/';
const ACTIVE_KEY = 'pigry:ai-session-active';
const MAX_MESSAGES = 100;

/** Which store a chat belongs to. When `agent` is given, sessions filter by
 * the acting agent — the same agent continues one conversation across every
 * workspace menu. `team` alone keeps the legacy per-menu filtering. */
export interface ChatScope {
  /** Team name — legacy per-menu scoping (used when no agent is given). */
  team?: string;
  /** Acting agent username — primary session identity. */
  agent?: string;
}

function chatDir(): string {
  return CHAT_DIR;
}

function activeKeyFor(scope?: ChatScope): string {
  // Agent identity wins: the same acting agent shares one active session
  // across every workspace menu; without an agent the team scopes the key.
  if (scope?.agent) return `${ACTIVE_KEY}:${scope.agent}`;
  const suffix = scope?.team ? `:${scope.team}` : '';
  return `${ACTIVE_KEY}${suffix}`;
}

/** Lists sessions in .pigry/chat/, newest first. When an agent scope is
 * given only that agent's chats are returned (same agent = same session on
 * every menu); untagged legacy sessions stay visible. With only a team
 * scope the chats filter by team as before. */
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
        if (scope?.agent) {
          if ((session.agentUsername ?? '') !== scope.agent && session.agentUsername) continue;
        } else if (scope?.team && (session.team ?? '') !== scope.team) {
          continue;
        }
        sessions.push(session);
      }
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/** Writes one session file into .pigry/chat/ (images dropped, last 100
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
    const raw = localStorage.getItem('pigry:ai-sessions');
    if (!raw) return;
    const list = JSON.parse(raw) as AiChatSession[];
    for (const session of list) {
      if (session && Array.isArray(session.messages) && session.messages.length > 0) {
        await saveSession(session);
      }
    }
    localStorage.removeItem('pigry:ai-sessions');
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
