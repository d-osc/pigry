/** Copilot-style chat sessions — stored IN the working repo under
 * `.orbit/chat/<id>.json` so conversations are versionable alongside the
 * code. The active-session pointer stays in localStorage (per-machine UI
 * preference); sessions themselves travel with the repo.
 */

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
}

export interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiChatMessage[];
}

const DIR = '.orbit/chat/';
const ACTIVE_KEY = 'orbit:ai-session-active';
const MAX_MESSAGES = 100;

import { deleteWorktreeFile, getFileTree, readWorktreeFile, writeWorktreeFile } from './tauriClient';

/** Lists every session file in the repo, newest first. */
export async function listSessions(): Promise<AiChatSession[]> {
  const tree = await getFileTree();
  const paths = tree.entries.filter((p) => p.startsWith(DIR) && p.endsWith('.json'));
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
export async function saveSession(session: AiChatSession): Promise<void> {
  const slim: AiChatSession = {
    ...session,
    messages: session.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, images: undefined })),
  };
  await writeWorktreeFile(`${DIR}${session.id}.json`, JSON.stringify(slim));
}

export async function deleteSessionFile(id: string): Promise<void> {
  await deleteWorktreeFile(`${DIR}${id}.json`);
}

export function activeSessionId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setActiveSessionId(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
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
  if (!first) return 'New chat';
  const line = first.text.split('\n')[0].trim();
  if (!line) return 'New chat';
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}
