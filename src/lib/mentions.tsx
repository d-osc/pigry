/** @mention support — agents are tagged as @username in chat messages and
 * markdown descriptions. Typing `@` in a supported field opens a picker
 * (filtered as you type); picking inserts the full `@username` token. A
 * mention in a chat message directs the turn at that agent (its own
 * provider/model + definition ride along), and a mention inside an
 * assistant reply tags that agent into the thread — agent-to-agent. */

import { useEffect, useRef } from 'react';
import { Bot, Hash } from 'lucide-react';
import type { AgentEntry } from './agentExtras';

/** An active @token being typed: where it starts + the fragment after @. */
export interface MentionState {
  /** Index of the `@` character in the input value. */
  start: number;
  /** Lowercased fragment typed after the @ (the live filter). */
  query: string;
}

/** An @token at the caret: preceded by start-of-text or whitespace, so
 * emails (user@host) never count. */
const TOKEN_RE = /(^|\s)@([\w-]*)$/;

/** Detects an @token ending at `caret` — null when the caret isn't in one. */
export function detectMention(value: string, caret: number): MentionState | null {
  const match = value.slice(0, caret).match(TOKEN_RE);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

/** Replaces the active @token with the picked `@username ` (trailing space). */
export function applyMention(
  value: string,
  state: MentionState,
  caret: number,
  username: string,
): { value: string; caret: number } {
  const token = `@${username} `;
  return {
    value: value.slice(0, state.start) + token + value.slice(caret),
    caret: state.start + token.length,
  };
}

/** Enabled agents matching the @query (username or display name), registry
 * order, deduped by username (teams can register the same handle twice). */
export function mentionCandidates(agents: AgentEntry[], query: string): AgentEntry[] {
  const seen = new Set<string>();
  const hits: AgentEntry[] = [];
  for (const agent of agents) {
    if (!agent.enabled || !agent.username || seen.has(agent.username)) continue;
    const hay = `${agent.username} ${agent.name}`.toLowerCase();
    if (query === '' || hay.includes(query)) {
      seen.add(agent.username);
      hits.push(agent);
    }
  }
  return hits;
}

const MENTION_SCAN = /@([a-zA-Z0-9_-]+)/g;

/** All known agents @mentioned in `text` — first mention first, deduped. */
export function mentionedAgents(text: string, agents: AgentEntry[]): AgentEntry[] {
  const byUsername = new Map(agents.map((agent) => [agent.username, agent]));
  const found: AgentEntry[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_SCAN)) {
    const agent = byUsername.get(match[1]);
    if (agent?.enabled && !seen.has(match[1])) {
      seen.add(match[1]);
      found.push(agent);
    }
  }
  return found;
}

/** The agent a message is directed at (first known mention), if any. */
export function firstMentionedAgent(text: string, agents: AgentEntry[]): AgentEntry | null {
  return mentionedAgents(text, agents)[0] ?? null;
}

/** Markdown-safe splitter: mentions as chips, plain runs otherwise.
 * Used by renderInline so @username highlights everywhere markdown does. */
const MENTION_SPLIT = /((?:^|(?<=[^\w@.-]))@[a-zA-Z0-9_-]+)/g;

export function pushWithMentions(
  nodes: React.ReactNode[],
  text: string,
  keyBase: string,
): void {
  const parts = text.split(MENTION_SPLIT);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      nodes.push(
        <span key={`${keyBase}-men${i}`} className="mention">
          {part}
        </span>,
      );
    } else {
      nodes.push(part);
    }
  });
}

/** Dropdown of @mention candidates for an input/textarea. Render inside a
 * positioned wrapper next to the field; items pick on mousedown (real
 * mouse, keeps field focus) and onClick (UIA/automation invokes). Closes
 * on outside pointerdown — not on field blur, which would race the pick.
 * Keyboard: the host input handles ↑/↓ (move), Enter/Tab (pick) and
 * Escape (close). */
export function MentionMenu({
  candidates,
  highlighted,
  onHover,
  onPick,
  onOutside,
  anchorRef,
  direction = 'up',
  label,
}: {
  candidates: AgentEntry[];
  highlighted: number;
  onHover: (index: number) => void;
  onPick: (agent: AgentEntry) => void;
  /** Called when a pointer goes down outside the menu and its field. */
  onOutside?: () => void;
  /** The field's ref — part of the "inside" area for onOutside. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Opens above the field ('up', chat composer) or below ('down', forms). */
  direction?: 'up' | 'down';
  label: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Keep the highlighted row visible while navigating with arrows.
  useEffect(() => {
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);
  // Outside pointerdown closes — blur would unmount the menu before the
  // item's pick lands (real clicks are prevented from stealing focus, but
  // UIA invocations blur without mousedown semantics).
  useEffect(() => {
    if (!onOutside) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onOutside();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onOutside, anchorRef]);
  if (candidates.length === 0) return null;
  const pick = (event: React.SyntheticEvent, agent: AgentEntry) => {
    event.preventDefault(); // the field must keep focus
    onPick(agent);
  };
  return (
    <div ref={listRef} className={`mention-menu mention-menu--${direction}`} role="listbox" aria-label={label}>
      {candidates.map((agent, index) => (
        <button
          key={agent.id}
          type="button"
          role="option"
          aria-selected={index === highlighted}
          className={`mention-menu__item${index === highlighted ? ' mention-menu__item--on' : ''}`}
          onMouseDown={(event) => pick(event, agent)}
          onClick={(event) => pick(event, agent)}
          onMouseEnter={() => onHover(index)}
        >
          {agent.avatar ? (
            <img className="mention-menu__avatar" src={agent.avatar} alt="" />
          ) : (
            <span className="mention-menu__avatar">
              <Bot size={11} strokeWidth={1.5} />
            </span>
          )}
          <span className="mention-menu__name">{agent.name}</span>
          <span className="mention-menu__user">@{agent.username}</span>
          {agent.team && <span className="mention-menu__team">{agent.team}</span>}
        </button>
      ))}
    </div>
  );
}

/** ---- #skill tokens — the skill twin of @mentions ---- */

/** Metadata for one skill (.pigry/skills/<id>.md). */
export interface SkillEntry {
  /** File slug (or built-in id) — the stable identifier. */
  id: string;
  /** Human name (heading or frontmatter); falls back to the id. */
  name: string;
  /** First paragraph / frontmatter description. */
  description: string;
  /** Base skill hard-coded in the app — not stored in .pigry/skills/. */
  builtIn?: boolean;
}

/** An active #token being typed: where it starts + the fragment after #. */
export interface SkillTokenState {
  start: number;
  query: string;
}

/** An #token at the caret: preceded by start-of-text or whitespace. */
const SKILL_TOKEN_RE = /(^|\s)#([\w-]*)$/;

/** Detects an #skill token ending at `caret` — null when the caret isn't in
 * one. Markdown headings (`# Title`) trigger it too; picking nothing closes
 * it, so heading typing is only mildly noisy. */
export function detectSkillToken(value: string, caret: number): SkillTokenState | null {
  const match = value.slice(0, caret).match(SKILL_TOKEN_RE);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

/** Replaces the active #token with the picked `#<id> ` (trailing space). */
export function applySkillToken(
  value: string,
  state: SkillTokenState,
  caret: number,
  token: string,
): { value: string; caret: number } {
  const tag = `#${token} `;
  return {
    value: value.slice(0, state.start) + tag + value.slice(caret),
    caret: state.start + tag.length,
  };
}

/** Skills matching the #query (id or name). */
export function skillCandidates(skills: SkillEntry[], query: string): SkillEntry[] {
  const q = query.toLowerCase();
  if (q === '') return skills;
  return skills.filter((skill) => {
    const hay = `${skill.id} ${skill.name}`.toLowerCase();
    return hay.includes(q);
  });
}

/** The skill twin of MentionMenu — same layout, # token. */
export function SkillMenu({
  candidates,
  highlighted,
  onHover,
  onPick,
  onOutside,
  anchorRef,
  direction = 'up',
  label,
}: {
  candidates: SkillEntry[];
  highlighted: number;
  onHover: (index: number) => void;
  onPick: (skill: SkillEntry) => void;
  onOutside?: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  direction?: 'up' | 'down';
  label: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);
  useEffect(() => {
    if (!onOutside) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onOutside();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onOutside, anchorRef]);
  if (candidates.length === 0) return null;
  const pick = (event: React.SyntheticEvent, skill: SkillEntry) => {
    event.preventDefault(); // the field must keep focus
    onPick(skill);
  };
  return (
    <div ref={listRef} className={`mention-menu mention-menu--${direction}`} role="listbox" aria-label={label}>
      {candidates.map((skill, index) => (
        <button
          key={skill.id}
          type="button"
          role="option"
          aria-selected={index === highlighted}
          className={`mention-menu__item${index === highlighted ? ' mention-menu__item--on' : ''}`}
          onMouseDown={(event) => pick(event, skill)}
          onClick={(event) => pick(event, skill)}
          onMouseEnter={() => onHover(index)}
        >
          <span className="mention-menu__avatar">
            <Hash size={11} strokeWidth={1.5} />
          </span>
          <span className="mention-menu__name">{skill.name}</span>
          <span className="mention-menu__user">#{skill.id}</span>
          {skill.description && (
            <span className="mention-menu__team">{skill.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}
