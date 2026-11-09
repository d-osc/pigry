/** Copilot-style chat session persistence for the AI agent panel.
 *
 * Sessions live in localStorage under `orbit:ai-sessions` (newest first,
 * capped); `orbit:ai-session-active` tracks which one the panel shows.
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

const KEY = 'orbit:ai-sessions';
const ACTIVE_KEY = 'orbit:ai-session-active';
const MAX_SESSIONS = 50;

export function loadSessions(): AiChatSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as AiChatSession[];
    return Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.messages)) : [];
  } catch {
    return [];
  }
}

function saveSessions(list: AiChatSession[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    // storage full — drop silently
  }
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

/** Upserts a session and returns the trimmed, persisted list. Sessions with
 * no messages are not kept. The original createdAt survives updates. */
export function upsertSession(session: AiChatSession): AiChatSession[] {
  if (session.messages.length === 0) return loadSessions();
  const list = loadSessions();
  const existing = list.findIndex((s) => s.id === session.id);
  if (existing >= 0) {
    session.createdAt = list[existing].createdAt;
    list[existing] = session;
  } else {
    list.unshift(session);
  }
  const kept = list.filter((s) => s.messages.length > 0).slice(0, MAX_SESSIONS);
  saveSessions(kept);
  return kept;
}

export function deleteSession(id: string): AiChatSession[] {
  const kept = loadSessions().filter((s) => s.id !== id);
  saveSessions(kept);
  return kept;
}

/** Chat title from the first user message (Copilot-style). */
export function titleFromMessages(messages: AiChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New chat';
  const line = first.text.split('\n')[0].trim();
  if (!line) return 'New chat';
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

/** Storage-friendly copy: drop image data URLs, cap length. */
export function slimMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages.slice(-100).map((m) => ({ ...m, images: undefined }));
}
