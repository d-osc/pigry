import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bold,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  FileText,
  Heading2,
  History,
  ImageIcon,
  Italic,
  Link2,
  List,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Plug,
  Puzzle,
  Quote,
  Sparkles,
  Strikethrough,
  Trash2,
  Webhook,
  Wrench,
  X,
} from 'lucide-react';
import { aiChat, cliAgentRun, cliDetect, getFileTree, memorySearch, readFileAtCommit, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import { allAgents, builtinAgents } from '../../lib/agentExtras';
import { detectSkillToken, applySkillToken, skillCandidates, SkillMenu, type SkillEntry, type SkillTokenState } from '../../lib/mentions';
import { listSkills } from '../../lib/skills';
import { webSearch, browserPage, readBinaryFile } from '../../lib/tauriClient';
import { browserDevtools, openInBrowser, type DevtoolsAction } from '../../lib/tauriClient';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { readPdfText } from '../../lib/tauriClient';
import { subscribeGhProfile } from '../../lib/ghProfile';
import { detectZcodeGlm } from '../../lib/zcode';
import { enabledToolsSummary, loadEnabledTools } from '../../lib/agentTools';
import { loadMcpServers } from '../../lib/mcpServers';
import { loadAgents, readInstructions, runEventHooks, type AgentEntry } from '../../lib/agentExtras';
import {
  MentionMenu,
  applyMention,
  detectMention,
  firstMentionedAgent,
  mentionCandidates,
  mentionedAgents,
  type MentionState,
  } from '../../lib/mentions';
import { renderMarkdown } from '../../lib/markdown';
import {
  AgentToolsTab,
  AgentsTab,
  HooksTab,
  InstructionsTab,
  McpTab,
  PluginsTab,
} from './AgentPanelTabs';
import { MemoryDialog, SkillsDialog } from './RepoKnowledge';
import { AgentDetailsDialog } from './AgentPanelTabs';
import { useRepository } from '../../hooks/useRepository';
import { relativeTime } from '../../lib/relativeTime';
import {
  activeSessionId,
  deleteSessionFile,
  listSessions,
  migrateLocalSessions,
  renameSessionFile,
  saveSession,
  setActiveSessionId,
  titleFromMessages,
  type AiChatMessage,
  type AiChatSession,
} from '../../lib/aiSessions';
import {
  activeProviderId,
  anthropicEndpoint,
  isCliProvider,
  loadProviders as loadProviderStore,
  resolveEndpoint,
  saveProviders,
  type AiProviderEntry,
} from '../../lib/aiProviders';
import './AiAgentPanel.css';

interface ChatImage {
  name: string;
  dataUrl: string;
}

interface AttachedFile {
  path: string;
  content: string;
}

/** Chat message — storage shape lives in aiSessions. */
type ChatMessage = AiChatMessage;

/** "14:32" today, "Nov 8, 14:32" otherwise — shown next to the sender name. */
function fmtMsgTime(time?: number): string {
  if (!time) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  const clock = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) return clock;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day}, ${clock}`;
}

/** Identity block for a tagged agent — prepended to the payload so the
 * model answers in character as that agent. */
function agentProfileText(agent: AgentEntry): string {
  const lines = [
    `- name: ${agent.name}`,
    agent.username ? `- handle: @${agent.username}` : '',
    agent.role ? `- role: ${agent.role}` : '',
    agent.team ? `- team: ${agent.team}` : '',
    agent.description ? `- description: ${agent.description}` : '',
    agent.tools.length > 0 ? `- tools: ${agent.tools.join(', ')}` : '',
    agent.skills.length > 0 ? `- skills: ${agent.skills.join(', ')}` : '',
    agent.mcpServers.length > 0 ? `- mcp: ${agent.mcpServers.join(', ')}` : '',
  ].filter(Boolean);
  return `${lines.join('\n')}\n\nYou are @${agent.username}. Respond in character as this agent.`;
}

/* ---------- agent file tools (real tool-use loop) ---------- */

/** A file tool the model may call. `id` matches the Agents-tab checkbox so
 * each agent's allowlist gates what it can actually do. */
interface ToolSpec {
  id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

const FILE_TOOLS: ToolSpec[] = [
  {
    id: 'list_files',
    name: 'list_files',
    description: 'List file paths in the repository working tree (first 600).',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      const tree = await getFileTree();
      return tree.entries.slice(0, 600).join('\n');
    },
  },
  {
    id: 'read_file',
    name: 'read_file',
    description:
      'Read a text file from the working tree (fails on binary or huge files). Pass line to record the location you are interested in.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path' },
        line: { type: 'number', description: 'Optional line number of interest' },
      },
      required: ['path'],
    },
    run: async (input) => {
      const file = await readWorktreeFile(String(input.path));
      if (file.binary) return '(binary file)';
      if (file.tooLarge) return '(file too large to read)';
      return file.content.slice(0, 16000);
    },
  },
  {
    id: 'write_file',
    name: 'write_file',
    description:
      'Create or overwrite a text file in the working tree. Changes land in the repo and are visible/reversible through git.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
    run: async (input) => {
      const path = String(input.path);
      const content = String(input.content);
      await writeWorktreeFile(path, content);
      return `wrote ${path} (${content.length} chars)`;
    },
  },
];

/** Images the read_image tool captured this tool round — flushed into the
 * conversation as visible image blocks after the tool result. */
let pendingImages: string[] = [];

const READ_IMAGE_TOOL: ToolSpec = {
  id: 'read_image',
  name: 'read_image',
  description:
    'Read an image file (png/jpg/gif/webp) from the working tree — the image is attached and you WILL see it in the next turn. Use it to describe, review or compare visuals (UI screenshots, diagrams, photos).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repo-relative image path' },
    },
    required: ['path'],
  },
  run: async (input) => {
    const path = String(input.path ?? '');
    const img = await readBinaryFile(path);
    if (!img.mime.startsWith('image/')) {
      return `error: ${path} is not an image (${img.mime})`;
    }
    const dataUrl = `data:${img.mime};base64,${img.data}`;
    pendingImages.push(dataUrl);
    return `read_image → ${path} (${img.mime}, ${Math.round(img.size / 1024)} KB) — the image is attached to your next turn`;
  },
};

/** b64 string -> ArrayBuffer (documents arrive base64 from the backend). */
function b64ToArrayBuffer(data: string): ArrayBuffer {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

/** Word/Excel/PDF readers — extract TEXT the agent can reason about. */
const DOC_TOOLS: ToolSpec[] = [
  {
    id: 'read_pdf',
    name: 'read_pdf',
    description:
      'Extract the text of a PDF in the working tree (text-based PDFs; scanned/image PDFs have no text layer).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative .pdf path' },
        limit: { type: 'number', description: 'Max characters returned (default 12000)' },
      },
      required: ['path'],
    },
    run: async (input) => {
      const path = String(input.path ?? '');
      const text = await readPdfText(path, Number(input.limit ?? 12000) || undefined);
      return text || '(no text extracted — the PDF may be scanned images)';
    },
  },
  {
    id: 'read_word',
    name: 'read_word',
    description:
      'Extract the text of a .docx Word document in the working tree (paragraphs in document order).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative .docx path' },
      },
      required: ['path'],
    },
    run: async (input) => {
      const path = String(input.path ?? '');
      const bin = await readBinaryFile(path);
      const text = await mammoth
        .extractRawText({ arrayBuffer: b64ToArrayBuffer(bin.data) })
        .then((result: { value: string }) => result.value);
      return text.slice(0, 12000) || '(empty document)';
    },
  },
  {
    id: 'read_excel',
    name: 'read_excel',
    description:
      'Extract the content of an .xlsx spreadsheet in the working tree — every sheet as CSV rows (values only, no formatting).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative .xlsx path' },
      },
      required: ['path'],
    },
    run: async (input) => {
      const path = String(input.path ?? '');
      const bin = await readBinaryFile(path);
      const wb = XLSX.read(b64ToArrayBuffer(bin.data), { type: 'array' });
      const parts: string[] = [];
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        parts.push(`## sheet: ${name}`);
        parts.push(XLSX.utils.sheet_to_csv(sheet).slice(0, 6000));
      }
      const text = parts.join('\n').trim();
      return text.slice(0, 12000) || '(empty workbook)';
    },
  },
];

/** Formats one agent as a readable profile block for the model. */
function agentProfileBlock(agent: AgentEntry): string {
  const parts: string[] = [`@${agent.username} — ${agent.name}`];
  if (agent.role) parts.push(`role: ${agent.role}`);
  if (agent.team) parts.push(`team: ${agent.team}`);
  if (agent.tier) parts.push(`tier: ${agent.tier}`);
  if (agent.description) parts.push(`about: ${agent.description}`);
  if (agent.tools.length > 0) parts.push(`tools: ${agent.tools.join(', ')}`);
  if (agent.skills.length > 0) parts.push(`skills: ${agent.skills.join(', ')}`);
  if (agent.mcpServers.length > 0) parts.push(`mcp: ${agent.mcpServers.join(', ')}`);
  parts.push(`enabled: ${agent.enabled ? 'yes' : 'no'}`);
  return parts.join('\n');
}

/** AGENT_LOOKUP_TOOL — the agent introspects the registry itself. */
const AGENT_LOOKUP_TOOL: ToolSpec = {
  id: 'agent_lookup',
  name: 'agent_lookup',
  description:
    'Look up agents in this workspace. Without arguments: a one-line profile of every agent (all tiers). With @username: the full profile of that agent — use it to decide who to tag or hand a task to.',
  input_schema: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'Optional @username (without the @) of one agent' },
    },
  },
  run: async (input) => {
    const username = String(input.username ?? '').replace(/^@/, '').trim().toLowerCase();
    const agents = allAgents().filter((agent) => agent.enabled);
    if (username) {
      const agent = agents.find(
        (agent) => agent.username.toLowerCase() === username || agent.name.toLowerCase() === username,
      );
      if (!agent) {
        const known = agents.map((agent) => `@${agent.username}`).join(' ');
        return `no agent @${username} — known agents: ${known}`;
      }
      return agentProfileBlock(agent);
    }
    if (agents.length === 0) return '(no agents registered)';
    return agents.map((agent) => agentProfileBlock(agent)).join('\n\n');
  },
};

/** Web tools — search + headless browser (backend curls/launches, no CORS). */
const WEB_TOOLS: ToolSpec[] = [
  {
    id: 'web_search',
    name: 'web_search',
    description:
      'Search the web with DuckDuckGo. Returns the top results as title/url/snippet lines. Use playwright after this to read a specific page.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
    run: async (input) => {
      const result = await webSearch(String(input.query ?? ''));
      return result.hits
        .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
        .join('\n');
    },
  },
  {
    id: 'playwright',
    name: 'playwright',
    description:
      'Open a URL in headless Edge/Chrome and read the rendered page text (JavaScript already executed). Use after web_search to read a specific result.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to open' },
        wait_ms: { type: 'number', description: 'How long to let the page run (ms, default 1200)' },
      },
      required: ['url'],
    },
    run: async (input) => {
      const page = await browserPage(String(input.url ?? ''), Number(input.wait_ms ?? 1200) || undefined);
      return `title: ${page.title}\nurl: ${page.url}\n\n${page.text}`;
    },
  },
  {
    id: 'browser',
    name: 'browser',
    description:
      'Open a URL in the user’s visible default browser window (the user can see and interact with the page). Use this to SHOW results/pages to the user — read content yourself with playwright instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to open' },
      },
      required: ['url'],
    },
    run: async (input) => {
      const url = String(input.url ?? '');
      return openInBrowser(url);
    },
  },
];

/** Browser DevTools — a persistent headless page the agent can inspect
 * (JavaScript eval, console output, screenshots, DOM text). */
const DEVTOOLS_TOOLS: ToolSpec[] = [
  {
    id: 'web-devtools',
    name: 'browser_devtools',
    description:
      'Browser DevTools on a persistent headless page. Actions: "open" a URL (required first), "eval" JavaScript on it, read "console" logs, take a "screenshot", dump page "dom", or "close" the session. Returns a text summary for every action.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'eval', 'console', 'screenshot', 'dom', 'close'],
          description: 'The devtools action to run',
        },
        url: { type: 'string', description: 'URL — required for action "open"' },
        js: { type: 'string', description: 'JavaScript — required for action "eval"' },
        wait_ms: { type: 'number', description: 'For "open": how long to let the page run (ms, default 1200)' },
      },
      required: ['action'],
    },
    run: async (input) => {
      const action = String(input.action ?? 'open') as DevtoolsAction;
      return browserDevtools(action, {
        url: input.url ? String(input.url) : undefined,
        js: input.js ? String(input.js) : undefined,
        waitMs: input.wait_ms ? Number(input.wait_ms) : undefined,
      });
    },
  },
];

/** Short label shown as a tool-activity chip in the chat bubble. */
function toolLabel(name: string, input: Record<string, unknown>, output: string): string {
  if (name === 'write_file') return `write_file → ${String(input.path ?? '?')}`;
  if (name === 'read_file') {
    const path = String(input.path ?? '?');
    return typeof input.line === 'number' ? `read_file → ${path}:${input.line}` : `read_file → ${path}`;
  }
  if (name === 'list_files') return `list_files (${output.split('\n').length} paths)`;
  if (name === 'web_search') return `web_search: ${String(input.query ?? '?')}`;
  if (name === 'playwright') return `playwright → ${String(input.url ?? '?')}`;
  if (name === 'read_image') return `read_image → ${String(input.path ?? '?')}`;
  if (name === 'read_pdf') return `read_pdf → ${String(input.path ?? '?')}`;
  if (name === 'read_word') return `read_word → ${String(input.path ?? '?')}`;
  if (name === 'read_excel') return `read_excel → ${String(input.path ?? '?')}`;
  return name;
}

/** Extracts a clickable repo path (and optional :line) from a tool chip. */
function toolEventTarget(label: string): { path: string; line?: number } | null {
  const match = label.match(/→\s*(.+?)(?::(\d+))?$/);
  if (!match) return null;
  return { path: match[1].trim(), line: match[2] ? Number(match[2]) : undefined };
}

/** Executes one tool call, returning the tool_result text (never throws). */
async function runToolCall(
  tool: ToolSpec | undefined,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (!tool) return `error: unknown tool ${name}`;
  try {
    return await tool.run(input);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function textFromAnthropic(parsed: Record<string, unknown> | null): string {
  const blocks = parsed?.content as Array<{ type?: string; text?: string }> | undefined;
  return blocks?.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('') ?? '';
}

function textFromOpenAI(parsed: Record<string, unknown> | null): string {
  return (
    (parsed as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content ?? ''
  );
}

/** Display name for a replying agent — resolved from its @username, falling
 * back to the generic label when the handle is unknown. */
function agentDisplayName(username?: string): string {
  if (username) {
    const agent = allAgents().find((entry) => entry.username === username);
    if (agent?.name) return agent.name;
  }
  return 'AI Agent';
}

/** Deterministic avatar tint per agent handle — each agent gets its own
 * circle color (same palette family as the design tokens). */
const AVATAR_TINTS = ['#8b9dff', '#6dd6ad', '#edb675', '#62cee7', '#b59aff', '#e79098'];
function agentTint(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

/** The agent's monogram — first letter of its display name. */
function agentMonogram(username?: string): string {
  if (username) {
    const agent = allAgents().find((entry) => entry.username === username);
    if (agent?.name) return agent.name.trim().charAt(0).toUpperCase() || 'AI';
  }
  return 'AI';
}

/** Inline avatar style tinting an agent's circle with its own color. */
function agentAvatarStyle(username?: string): React.CSSProperties | undefined {
  if (!username) return undefined;
  const tint = agentTint(username);
  return {
    background: `color-mix(in srgb, ${tint} 20%, transparent)`,
    borderColor: tint,
    color: tint,
  };
}

/** Wall-clock stamp — wrapped so async send paths stay purity-clean. */
function now(): number {
  return Date.now();
}

/** Full store entry for a detected CLI agent (no HTTP config). */
function cliEntry(id: string, name: string, type: 'claude-code' | 'codex', model: string): AiProviderEntry {
  return {
    id,
    name,
    kind: 'custom',
    type,
    apiFormat: 'openai',
    baseUrl: '',
    apiKey: '',
    model,
    enabled: true,
    models: [],
  };
}

interface AiAgentPanelProps {
  /** Active worktree file path (auto-attached as context). */
  fileName: string;
  width: number;
  onCollapse: () => void;
  /** Current editor text selection (VS Code-style "add selection to chat"). */
  selection?: { path: string; text: string; startLine: number; endLine: number } | null;
  /** Team preselected in the Agents tab's "Add agent" form (from the active
   * workspace menu). */
  defaultTeam?: string;
  /** Opens a repo file (optionally at a line) — wired to tool-event chips. */
  onOpenFile?: (path: string, line?: number) => void;
  /** History commit picked in the file-history panel — attachable to chat. */
  historySelection?: { path: string; oid: string } | null;
}

/** One-click prompts shown on the empty state. */
const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Explain this file', prompt: 'Explain what this file does and walk through its key parts.' },
  { label: 'Review for bugs', prompt: 'Review this file for bugs and edge cases. Be specific.' },
  { label: 'Improve naming', prompt: 'Suggest clearer names for the identifiers in this file.' },
  { label: 'Write tests', prompt: 'Suggest focused tests for this file.' },
];

export function AiAgentPanel({ fileName, width, onCollapse, selection, defaultTeam, onOpenFile, historySelection }: AiAgentPanelProps) {
  const { repository, notify } = useRepository();
  // Chats and memories live under this team's .pigry/teams/<team>/ store.
  const team = defaultTeam ?? 'Copilot';
  const chatScope = useMemo(() => ({ team }), [team]);
  const [providers, setProviders] = useState<AiProviderEntry[]>([]);
  const [activeId, setActiveId] = useState<string>(() => activeProviderId());
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  /** Which project-knowledge dialog is open (memory / skills). */
  const [knowDialog, setKnowDialog] = useState<'memory' | 'skills' | null>(null);
  // Message being edited (index) + its draft (Copilot-style edit & resubmit).
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Dismissed selection key — reset during render when a different
  // selection arrives (adjust-state-on-change, no effect needed).
  const selectionKey = selection ? `${selection.path}:${selection.startLine}:${selection.endLine}` : '';
  const [dismissedKey, setDismissedKey] = useState('');
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (prevSelectionKey !== selectionKey) {
    setPrevSelectionKey(selectionKey);
    setDismissedKey('');
  }
  const activeSelection =
    selection && selectionKey !== dismissedKey ? selection : null;

  // File-history selection — same dismiss-and-reset pattern as the
  // editor selection so a newly picked commit re-arms the chip.
  const historyKey = historySelection
    ? `${historySelection.path}@${historySelection.oid}`
    : '';
  const [dismissedHistory, setDismissedHistory] = useState('');
  const [prevHistoryKey, setPrevHistoryKey] = useState(historyKey);
  if (prevHistoryKey !== historyKey) {
    setPrevHistoryKey(historyKey);
    setDismissedHistory('');
  }
  const activeHistory =
    historySelection && historyKey !== dismissedHistory ? historySelection : null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  /** Username of the agent currently generating a reply (typing indicator). */
  const [replyingAs, setReplyingAs] = useState('');
  /** Which section of the panel is visible — chat body or one of the tool tabs. */
  const [panelTab, setPanelTab] = useState<
    'chat' | 'tools' | 'mcp' | 'plugins' | 'agents' | 'hooks' | 'instructions'
  >('chat');
  /** Active group-chat name; custom=true once the user renames the group. */
  const [groupTitle, setGroupTitle] = useState<{ name: string; custom: boolean }>({
    name: '',
    custom: false,
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** Inline rename of the group name shown in the header. */
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  /** The signed-in GitHub account — real name + avatar on user messages. */
  const [ghUser, setGhUser] = useState<{ name: string; login: string; avatarUrl: string } | null>(null);
  // Attribution stamped into every message: agent username + repo owner.
  const actingAgent = allAgents().find((agent) => agent.enabled);
  const agentUsername = actingAgent?.username || 'ai-agent';
  const ownerName = ghUser?.name || repository?.account.name || 'local-user';
  const [images, setImages] = useState<ChatImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [attachError, setAttachError] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // @mention autocomplete — typing `@` opens the agent picker; the picked
  // @username directs the message at that agent (its provider/model reply).
  const [mention, setMention] = useState<MentionState | null>(null);
  // Clicking an agent avatar/name in the chat opens its full profile.
  const [viewingAgent, setViewingAgent] = useState<AgentEntry | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // The @ picker lists only THIS menu's agents (team members + the menu's
  // default agent) plus pigry's base agents — other teams stay out of the way.
  const teamAgents = useMemo(
    () =>
      allAgents().filter(
        (agent) =>
          agent.enabled && agent.username && agent.team === team,
      ),
    [team, repository?.headOid],
  );
  const mentionList = useMemo(
    () => (mention ? mentionCandidates(teamAgents, mention.query) : []),
    [mention, teamAgents],
  );
  const mentionPos = Math.min(mentionIdx, Math.max(0, mentionList.length - 1));

  // #skill autocomplete — typing `#` opens the skill picker; the picked
  // #name tag attaches that skill's content to the turn.
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillTok, setSkillTok] = useState<SkillTokenState | null>(null);
  const [skillIdx, setSkillIdx] = useState(0);
  const skillList = useMemo(
    () => (skillTok ? skillCandidates(skills, skillTok.query) : []),
    [skillTok, skills],
  );
  const skillPos = Math.min(skillIdx, Math.max(0, skillList.length - 1));

  const closeSkill = () => {
    setSkillTok(null);
    setSkillIdx(0);
  };

  /** Commits the picked skill into the composer text. */
  const pickSkill = (skill: SkillEntry) => {
    if (!skillTok) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const next = applySkillToken(input, skillTok, caret, skill.name || skill.id);
    setInput(next.value);
    closeSkill();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // Load skill metadata once for the picker.
  useEffect(() => {
    let cancelled = false;
    listSkills()
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        // skill listing unavailable
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeMention = () => {
    setMention(null);
    setMentionIdx(0);
  };

  /** Commits the picked agent into the composer text. */
  const pickMention = (agent: AgentEntry) => {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const next = applyMention(input, mention, caret, agent.username);
    setInput(next.value);
    closeMention();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // ZCode Cloud (GLM) — detected automatically when ZCode desktop is installed.
  const [zcodeProvider, setZcodeProvider] = useState<AiProviderEntry | null>(null);
  // CLI coding agents — detected via --version on mount.
  const [cliProviders, setCliProviders] = useState<AiProviderEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    detectZcodeGlm()
      .then((provider) => {
        if (!cancelled && provider) {
          setZcodeProvider({
            ...cliEntry('zcode-cloud', provider.name, 'claude-code', provider.model),
            type: 'zcode',
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          });
        }
      })
      .catch(() => {});
    cliDetect()
      .then((result) => {
        if (cancelled) return;
        const found: AiProviderEntry[] = [];
        if (result.claude) {
          found.push(
            cliEntry(
              'cli-claude',
              'Claude Code' + (result.claudeVersion ? ' · ' + result.claudeVersion : ''),
              'claude-code',
              'claude CLI (own subscription)',
            ),
          );
        }
        if (result.codex) {
          found.push(
            cliEntry(
              'cli-codex',
              'Codex' + (result.codexVersion ? ' · ' + result.codexVersion : ''),
              'codex',
              'codex CLI (own subscription)',
            ),
          );
        }
        setCliProviders(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allProviders = useMemo(
    () => [...cliProviders, ...(zcodeProvider ? [zcodeProvider] : []), ...providers],
    [cliProviders, zcodeProvider, providers],
  );
  const active =
    allProviders.find((provider) => provider.id === activeId) ?? allProviders[0] ?? null;

  // Mirror the Settings → AI Provider manager (localStorage-driven).
  useEffect(() => {
    const sync = () => {
      setProviders(loadProviderStore());
      const id = activeProviderId();
      if (id) setActiveId(id);
    };
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  // Chat sessions (Copilot-style) stored IN the repo under .pigry/chat/:
  // migrate legacy localStorage sessions, restore the active one on mount,
  // and save the file on every change. Sessions with no messages are not kept.
  const [sessionId, setSessionId] = useState(() => activeSessionId(chatScope));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionList, setSessionList] = useState<AiChatSession[]>([]);
  const sessionsRef = useRef<HTMLDivElement | null>(null);
  /** Creation time of the current session (preserved across saves). */
  const createdAtRef = useRef(now());

  // One-shot restore: active session, else the newest, else a fresh id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLocalSessions();
      const sessions = await listSessions(chatScope);
      if (cancelled) return;
      let id = activeSessionId(chatScope);
      let restored: AiChatSession | undefined = sessions.find((s) => s.id === id);
      if (!restored && sessions.length > 0) {
        restored = sessions[0];
        id = restored.id;
        setActiveSessionId(id, chatScope);
      }
      if (!id) {
        id = `chat-${now().toString(36)}`;
        setActiveSessionId(id, chatScope);
      }
      setSessionId(id);
      if (restored) {
        createdAtRef.current = restored.createdAt;
        setMessages(restored.messages);
      }
      setSessionList(sessions);
    })();
    return () => {
      cancelled = true;
    };
    // Restore runs once per mount — the team does not change on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (messages.length === 0 || !sessionId) return;
    let cancelled = false;
    (async () => {
      await saveSession({
        id: sessionId,
        title: groupTitle.custom ? groupTitle.name : titleFromMessages(messages),
        titleCustom: groupTitle.custom,
        createdAt: createdAtRef.current,
        updatedAt: now(),
        messages,
        team,
        agentUsername,
        owner: ownerName,
      });
      if (!cancelled) setSessionList(await listSessions(chatScope));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, sessionId, groupTitle, chatScope, team, agentUsername, ownerName]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, sending]);

  // Outside click closes the sessions popover.
  useEffect(() => {
    if (!sessionsOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (sessionsRef.current?.contains(event.target as Node)) return;
      setSessionsOpen(false);
    };
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [sessionsOpen]);

  // The signed-in GitHub account — real name + avatar on user messages.
  // Reads the shared ghProfile cache (fetched at app start, kept fresh by
  // the title bar account menu).
  useEffect(
    () =>
      subscribeGhProfile((profile) => {
        setGhUser(profile ? { name: profile.login, login: profile.name, avatarUrl: profile.avatarUrl } : null);
      }),
    [],
  );

  /** Starts a fresh conversation; the previous one stays in history. */
  const startNewChat = () => {
    const id = `chat-${now().toString(36)}`;
    setActiveSessionId(id, chatScope);
    setSessionId(id);
    createdAtRef.current = now();
    setGroupTitle({ name: '', custom: false });
    setMessages([]);
    setInput('');
    setImages([]);
    setEditingIndex(null);
    setSessionsOpen(false);
  };

  const switchSession = (session: AiChatSession) => {
    setActiveSessionId(session.id, chatScope);
    setSessionId(session.id);
    createdAtRef.current = session.createdAt;
    setGroupTitle({ name: session.title, custom: session.titleCustom === true });
    setMessages(session.messages);
    setInput('');
    setEditingIndex(null);
    setSessionsOpen(false);
  };

  /** Renames the group chat on disk and refreshes the list. */
  const commitRename = async (session: AiChatSession, name: string) => {
    const title = name.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await renameSessionFile(session.id, title);
      setSessionList(await listSessions(chatScope));
      if (session.id === sessionId) setGroupTitle({ name: title, custom: true });
    } catch (error) {
      notify(`Could not rename group: ${String(error)}`, 'error');
    }
    setRenamingId(null);
  };

  const removeSession = async (id: string) => {
    await deleteSessionFile(id);
    const kept = await listSessions(chatScope);
    setSessionList(kept);
    if (id === sessionId) startNewChat();
  };

  const attachImages = (files: FileList | null) => {
    if (!files?.length) return;
    setAttachError('');
    Array.from(files)
      .slice(0, 4)
      .forEach((file) => {
        if (!file.type.startsWith('image/')) {
          setAttachError(`${file.name} is not an image`);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setImages((current) => [...current, { name: file.name, dataUrl: String(reader.result) }]);
        };
        reader.readAsDataURL(file);
      });
  };

  /** Wraps the composer selection with markdown tokens (bold, code, link…). */
  const applyMdWrap = (before: string, after: string, placeholder: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? input.length;
    const end = ta?.selectionEnd ?? input.length;
    const selected = input.slice(start, end);
    const body = selected || placeholder;
    setInput(input.slice(0, start) + before + body + after + input.slice(end));
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const selStart = start + before.length;
      ta.setSelectionRange(selStart, selStart + body.length);
    });
  };

  /** Prefixes every selected line (lists, quotes, headings). */
  const applyMdPrefix = (prefix: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    const lineStart = input.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const block = input.slice(lineStart, end);
    const prefixed = block
      ? block.split('\n').map((line) => (line.startsWith(prefix) ? line : prefix + line)).join('\n')
      : prefix;
    setInput(input.slice(0, lineStart) + prefixed + input.slice(end));
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(lineStart, lineStart + prefixed.length);
    });
  };

  /** Inline `code`, or a fenced block when the selection spans lines. */
  const applyMdCode = () => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    const multi = input.slice(start, end).includes('\n');
    applyMdWrap(multi ? '```\n' : '`', multi ? '\n```' : '`', 'code');
  };

  /** Paste support — images from the clipboard attach as chat images. */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (files && Array.from(files).some((file) => file.type.startsWith('image/'))) {
      event.preventDefault();
      attachImages(files);
    }
  };

  const attachActiveFile = async () => {
    if (!fileName) return;
    setAttachError('');
    try {
      const file = await readWorktreeFile(fileName);
      if (file.binary || file.tooLarge) {
        setAttachError('Active file is binary or too large to attach');
        return;
      }
      setAttachedFiles((current) =>
        current.some((f) => f.path === fileName)
          ? current
          : [...current, { path: fileName, content: file.content }],
      );
    } catch {
      setAttachError('Could not read the active file');
    }
  };

  const removeAttached = (path: string) => {
    setAttachedFiles((current) => current.filter((file) => file.path !== path));
  };

  /** Tier 1: the hard-coded default agent of this menu's team — answers
   * every turn that carries no @mention, with its own private memory. */
  const defaultAgent = builtinAgents().find(
    (agent) => agent.tier === 'default' && agent.team === team,
  );

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    // An @mention directs the turn at that agent — it answers in character
    // through its own provider/model. No mention = the menu's default agent
    // (first enabled member of the panel's team) answers.
    const target =
      firstMentionedAgent(
        text,
        allAgents().filter((agent) => agent.enabled && agent.username),
      ) ?? defaultAgent ?? null;
    if (!active) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: 'No AI provider configured — add one in Settings → AI Provider.',
          error: true,
          time: now(),
          agent: agentUsername,
          owner: ownerName,
        },
      ]);
      return;
    }

    let context = '';
    // Project knowledge lives in the repo (.pigry/) — ride along every send.
    // Memory is a vector database: pick the semantically relevant entries.
    let memoryText = '';
    let skillsText = '';
    try {
      // The answering agent reads its OWN private memory when one is
      // targeted; the team store backs teamless turns.
      const hits = await memorySearch(text, 5, team, target?.username);
      if (hits.length > 0) {
        memoryText = hits.map((hit) => `- ${hit.text}`).join('\n').slice(0, 2000);
      }
    } catch {
      // vector store unavailable
    }
    try {
      const tree = await getFileTree();
      const skillPaths = tree.entries
        .filter((p) => p.startsWith('.pigry/skills/') && p.endsWith('.md'))
        .slice(0, 8);
      const parts: string[] = [];
      for (const skillPath of skillPaths) {
        try {
          parts.push(
            (await readWorktreeFile(skillPath)).content.trim().slice(0, 1200),
          );
        } catch {
          // skip unreadable skill
        }
      }
      skillsText = parts.join('\n\n').slice(0, 4000);
    } catch {
      // no skills folder yet
    }
    if (memoryText) context += `\n\n[Relevant project memories]\n${memoryText}`;
    if (skillsText) context += `\n\n[Project skills]\n${skillsText}`;
    // #tagged skills ride along in FULL — `#<id|name>` in the message calls
    // that skill explicitly.
    try {
      const tagTokens = [
        ...new Set(
          [...text.matchAll(/(?:^|\s)#([\w-]+)/g)].map((match) => match[1].toLowerCase()),
        ),
      ];
      if (tagTokens.length > 0) {
        const all = await listSkills();
        const matches = all.filter(
          (skill) =>
            tagTokens.includes(skill.id.toLowerCase()) ||
            tagTokens.includes(skill.name.toLowerCase()),
        );
        for (const skill of matches) {
          try {
            const md = (
              await readWorktreeFile(`.pigry/skills/${skill.id}.md`)
            ).content;
            context += `\n\n[Skill: ${skill.name || skill.id}]\n${md.slice(0, 4000)}`;
          } catch {
            // unreadable skill file — skip
          }
        }
      }
    } catch {
      // skill listing unavailable
    }
    // Project instructions (.pigry/instructions.md) — always ride along.
    try {
      const instructions = (await readInstructions()).trim();
      if (instructions) context += `\n\n[Project instructions]\n${instructions.slice(0, 4000)}`;
    } catch {
      // no instructions file yet
    }
    // Agents defined on the Agents tab — the model can reference them by name.
    try {
      const agents = allAgents().filter(
        (agent) => agent.enabled && agent.username && agent.team === team,
      );
      if (agents.length > 0) {
        context +=
          `\n\n[Available agents]\n` +
          agents
            .map((agent) => {
              const parts = [
                `- ${agent.username ? `@${agent.username} ` : ''}${agent.name}`,
              ];
              if (agent.role) parts.push(` (${agent.role})`);
              if (agent.team) parts.push(` [team: ${agent.team}]`);
              if (agent.tier === 'default') parts.push(' [default agent]');
              if (agent.tier === 'base') parts.push(' [base agent]');
              if (agent.description) parts.push(` — ${agent.description}`);
              if (agent.tools.length > 0) parts.push(` | tools: ${agent.tools.join(', ')}`);
              if (agent.skills.length > 0) parts.push(` | skills: ${agent.skills.join(', ')}`);
              if (agent.mcpServers.length > 0) parts.push(` | mcp: ${agent.mcpServers.join(', ')}`);
              return parts.join('');
            })
            .join('\n');
      }
    } catch {
      // agent registry unavailable
    }
    // before-send hooks (Commands tab on Hooks) run in the repository root.
    try {
      await runEventHooks('before-send', repository?.localPath ?? '.');
    } catch {
      // hook execution must never block a send
    }
    // Announce the tool surface the user allows (Settings → Tools / MCP).
    try {
      const enabled = loadEnabledTools();
      const toolsText = enabledToolsSummary(enabled);
      const mcpServers = loadMcpServers().filter((server) => server.enabled);
      const mcpNames = mcpServers.map((server) => server.name);
      const toolBlocks: string[] = [];
      if (toolsText) {
        toolBlocks.push(
          `[Available tools — you may reference these; the user runs them from the app]\n${toolsText}`,
        );
      }
      if (mcpNames.length > 0) {
        toolBlocks.push(
          `[MCP servers enabled]\n${mcpNames.map((name) => `- ${name}`).join('\n')}`,
        );
      }
      if (toolBlocks.length > 0) context += `\n\n${toolBlocks.join('\n\n')}`;
    } catch {
      // tool registry unavailable
    }
    if (activeSelection) {
      context += `\n\n[Selected code — ${activeSelection.path}:${activeSelection.startLine}-${activeSelection.endLine}]\n${activeSelection.text.slice(0, 8000)}`;
    }
    if (activeHistory) {
      // The file as it existed at the selected history commit.
      try {
        const at = await readFileAtCommit(activeHistory.path, activeHistory.oid);
        if (!at.binary && !at.tooLarge) {
          context += `\n\n[File history — ${activeHistory.path} @ ${activeHistory.oid.slice(0, 7)}]\n${at.content.slice(0, 8000)}`;
        } else {
          context += `\n\n[File history — ${activeHistory.path} @ ${activeHistory.oid.slice(0, 7)}]\n(${at.binary ? 'binary' : 'too large'} — content omitted)`;
        }
      } catch {
        // commit content unavailable — ride along without it
      }
    }
    for (const attached of attachedFiles) {
      context += `\n\n[Attached file: ${attached.path}]\n${attached.content.slice(0, 12000)}`;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      text,
      time: now(),
      owner: ownerName,
      agent: target?.username ?? agentUsername,
      context,
      selection: activeSelection
        ? {
            path: activeSelection.path,
            startLine: activeSelection.startLine,
            endLine: activeSelection.endLine,
            text: activeSelection.text.slice(0, 8000),
          }
        : null,
      images: images.map((image) => image.dataUrl),
    };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput('');
    setImages([]);
    closeMention();
    await doSend(history, target);
  };

  /** Edits a sent user message and re-runs the conversation from there
   * (VS Code Copilot style): everything after the edited message is
   * discarded and a fresh reply is generated. */
  const resendEdited = async (index: number, newText: string) => {
    if (sending || !newText.trim()) return;
    const edited: ChatMessage = { ...messages[index], text: newText.trim(), time: now() };
    const history = [...messages.slice(0, index), edited];
    setMessages(history);
    setEditingIndex(null);
    // The retargeted mention (if any) decides who answers the re-run;
    // no mention defers to the menu's default agent.
    const target =
      firstMentionedAgent(
        edited.text,
        allAgents().filter((agent) => agent.enabled && agent.username),
      ) ?? defaultAgent ?? null;
    await doSend(history, target);
  };

  /** Runs the provider for `history` (whose last entry is the user turn),
   * appending the reply — and when the reply @mentions other agents, tags
   * them into the thread (agent-to-agent; budget-capped, each agent speaks
   * at most once per chain so it always ends). Returns the updated history. */
  const doSend = async (
    history: ChatMessage[],
    target?: AgentEntry | null,
    chainLeft = 3,
  ): Promise<ChatMessage[]> => {
    setSending(true);
    try {
      return await runTurn(history, target ?? null, chainLeft);
    } finally {
      setSending(false);
      setReplyingAs('');
      // after-reply hooks (Hooks tab) run once the reply lands or fails.
      try {
        await runEventHooks('after-reply', repository?.localPath ?? '.');
      } catch {
        // never block the UI on a hook
      }
    }
  };

  const runTurn = async (
    history: ChatMessage[],
    target: AgentEntry | null,
    chainLeft: number,
  ): Promise<ChatMessage[]> => {
    const last = history[history.length - 1];
    // A tagged agent chats through its own provider/model when configured;
    // otherwise the globally active provider answers.
    const provider = (() => {
      if (target?.providerId) {
        const found = allProviders.find((p) => p.id === target.providerId);
        if (found) return { ...found, model: target.model || found.model };
      }
      return active;
    })();
    const repliedAs = target?.username ?? agentUsername;
    setReplyingAs(repliedAs);

    if (isCliProvider(provider)) {
      const cli = provider.type === 'claude-code' ? 'claude' : 'codex';
      let working = history;
      try {
        const output = await cliAgentRun(cli, last.text);
        working = [...history, { role: 'assistant', text: output || '(no output)', time: now(), agent: repliedAs, owner: ownerName }];
        setMessages(working);
      } catch (error) {
        working = [...history, { role: 'assistant', text: error instanceof Error ? error.message : String(error), error: true, time: now(), agent: repliedAs, owner: ownerName }];
        setMessages(working);
      }
      return working;
    }

    const isAnthropic = provider.apiFormat === 'anthropic';
    const rawEndpoint = resolveEndpoint(provider);
    const endpoint = isAnthropic ? anthropicEndpoint(rawEndpoint) : rawEndpoint;
    // Anthropic image blocks carry base64 without the data: URL prefix.
    const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mediaTypeOf = (dataUrl: string) =>
      dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
    // The tagged agent's identity rides along so it answers in character.
    const profile = target ? `\n\n[Your agent profile]\n${agentProfileText(target)}` : '';
    const toolNudge =
      '\n\n[Tool use]\nYou have file tools for this repository. When asked to create or change files, actually call write_file — do not only print code. Changes land in the working tree and are visible to git.';
    const fullText = last.text + (last.context ?? '') + profile + toolNudge;
    const turnImages = (last.images ?? []).map((dataUrl) => ({ dataUrl }));
    const content = isAnthropic
      ? turnImages.length > 0
        ? [
            { type: 'text', text: fullText },
            ...turnImages.map((image) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaTypeOf(image.dataUrl),
                data: base64Of(image.dataUrl),
              },
            })),
          ]
        : fullText
      : turnImages.length > 0
        ? [
            { type: 'text', text: fullText },
            ...turnImages.map((image) => ({
              type: 'image_url',
              image_url: { url: image.dataUrl },
            })),
          ]
        : fullText;
    // File tools this turn may call — the tagged agent's own allowlist wins
    // (empty list inherits everything).
    const agentAllowed = target?.tools ?? [];
    const tools = [...FILE_TOOLS, READ_IMAGE_TOOL, ...DOC_TOOLS, ...WEB_TOOLS, ...DEVTOOLS_TOOLS, AGENT_LOOKUP_TOOL].filter(
      (tool) => agentAllowed.length === 0 || agentAllowed.includes(tool.id),
    );
    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
    const openaiTools = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));

    let working = history;
    let replyError = false;
    let assistantText = '';
    const toolEvents: string[] = [];
    pendingImages.length = 0;
    try {
      if (tools.length === 0) {
        // No tools allowed — plain single-shot reply (legacy path).
        const payload = isAnthropic
          ? { model: provider.model || 'claude-sonnet', max_tokens: 4096, messages: [{ role: 'user', content }] }
          : { model: provider.model || 'glm-4.6', messages: [{ role: 'user', content }], stream: false };
        const result = await aiChat(endpoint, provider.apiKey, JSON.stringify(payload), isAnthropic ? 'anthropic' : 'bearer');
        const parsed = safeParse(result.body);
        const err = parsed as { error?: { message?: string }; message?: string; code?: string } | null;
        if (!result.ok) {
          replyError = true;
          assistantText = String(err?.error?.message ?? err?.message ?? err?.code ?? result.error ?? `HTTP ${result.status}`);
        } else {
          assistantText = isAnthropic ? textFromAnthropic(parsed) : textFromOpenAI(parsed);
          if (!assistantText) {
            replyError = true;
            assistantText = String(err?.error?.message ?? err?.message ?? result.error ?? 'Empty reply');
          }
        }
        working = [...history, { role: 'assistant', text: assistantText, time: now(), agent: repliedAs, owner: ownerName, ...(replyError ? { error: true } : {}) }];
        setMessages(working);
      } else {
        // Agentic loop: the model may call file tools; results feed back
        // until it produces a final text reply (max 8 tool rounds).
        const apiMessages: Array<Record<string, unknown>> = [{ role: 'user', content }];
        for (let iter = 0; iter < 8; iter++) {
          const payload = isAnthropic
            ? { model: provider.model || 'claude-sonnet', max_tokens: 4096, tools: anthropicTools, messages: apiMessages }
            : { model: provider.model || 'glm-4.6', tools: openaiTools, messages: apiMessages, stream: false };
          const result = await aiChat(endpoint, provider.apiKey, JSON.stringify(payload), isAnthropic ? 'anthropic' : 'bearer');
          const parsed = safeParse(result.body);
          if (!result.ok) {
            const err = parsed as { error?: { message?: string }; message?: string; code?: string } | null;
            replyError = true;
            assistantText = String(err?.error?.message ?? err?.message ?? err?.code ?? result.error ?? `HTTP ${result.status}`);
            break;
          }

          if (isAnthropic) {
            const blocks = (parsed?.content ?? []) as Array<{
              type?: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            const textPart = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            const calls = blocks.filter((b) => b.type === 'tool_use');
            if (calls.length === 0) {
              assistantText = textPart;
              break;
            }
            if (textPart) assistantText += (assistantText ? '\n\n' : '') + textPart;
            apiMessages.push({ role: 'assistant', content: blocks });
            const results: Array<Record<string, unknown>> = [];
            for (const call of calls) {
              const tool = tools.find((t) => t.name === call.name);
              const input = call.input ?? {};
              const output = await runToolCall(tool, String(call.name), input);
              toolEvents.push(toolLabel(String(call.name), input, output));
              results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
            }
            apiMessages.push({ role: 'user', content: results });
            if (pendingImages.length > 0) {
              const imgs = pendingImages.splice(0).map((dataUrl) => ({ dataUrl }));
              apiMessages.push({
                role: 'user',
                content: [
                  { type: 'text', text: '[read_image attached these images — look at them and continue]' },
                  ...imgs.map((image) => ({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaTypeOf(image.dataUrl),
                      data: base64Of(image.dataUrl),
                    },
                  })),
                ],
              });
            }
          } else {
            const message = (parsed as {
              choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
            })?.choices?.[0]?.message;
            const calls = message?.tool_calls ?? [];
            if (calls.length === 0) {
              assistantText = message?.content ?? '';
              break;
            }
            if (message?.content) assistantText += (assistantText ? '\n\n' : '') + message.content;
            apiMessages.push({ role: 'assistant', content: message?.content ?? '', tool_calls: calls });
            for (const call of calls) {
              const name = String(call.function?.name ?? '');
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(call.function?.arguments || '{}') as Record<string, unknown>;
              } catch {
                // malformed arguments — runToolCall reports the failure
              }
              const tool = tools.find((t) => t.name === name);
              const output = await runToolCall(tool, name, input);
              toolEvents.push(toolLabel(name, input, output));
              apiMessages.push({ role: 'tool', tool_call_id: call.id ?? name, content: output });
              if (pendingImages.length > 0) {
                const imgs = pendingImages.splice(0).map((dataUrl) => ({ dataUrl }));
                apiMessages.push({
                  role: 'user',
                  content: [
                    { type: 'text', text: '[read_image attached these images — look at them and continue]' },
                    ...imgs.map((image) => ({
                      type: 'image_url',
                      image_url: { url: image.dataUrl },
                    })),
                  ],
                });
              }
            }
          }
        }
        if (!replyError && !assistantText) {
          assistantText = toolEvents.length > 0 ? 'Done — see the tool activity above.' : '(empty reply)';
        }
        working = [
          ...history,
          {
            role: 'assistant',
            text: assistantText,
            time: now(),
            agent: repliedAs,
            owner: ownerName,
            ...(replyError ? { error: true } : {}),
            ...(toolEvents.length > 0 ? { toolEvents } : {}),
          },
        ];
        setMessages(working);
      }
    } catch (error) {
      replyError = true;
      working = [
        ...history,
        {
          role: 'assistant',
          text: error instanceof Error ? error.message : String(error),
          error: true,
          time: now(),
          agent: repliedAs,
          owner: ownerName,
          ...(toolEvents.length > 0 ? { toolEvents } : {}),
        },
      ];
      setMessages(working);
    }

    // Agent-to-agent: the reply's @mentions tag other agents into the
    // thread. Budget-capped and each agent speaks once per chain — no loops.
    if (!replyError && chainLeft > 0 && assistantText) {
      const registry = loadAgents().filter((agent) => agent.enabled && agent.username);
      const spoke = new Set([repliedAs]);
      for (const next of mentionedAgents(assistantText, registry)) {
        if (chainLeft <= 0) break;
        if (spoke.has(next.username)) continue;
        spoke.add(next.username);
        chainLeft -= 1;
        const trigger: ChatMessage = {
          role: 'user',
          text: `@${next.username} was tagged by @${repliedAs} — your turn to respond.`,
          time: now(),
          owner: ownerName,
          agent: next.username,
        };
        working = [...working, trigger];
        setMessages(working);
        working = await runTurn(working, next, chainLeft - 1);
      }
    }
    return working;
  };

  const clearConversation = () => {
    setMessages([]);
    try {
      localStorage.removeItem('pigry:ai-conversation');
    } catch {
      // ignore
    }
  };

  const providerLabel = active ? `${active.name || active.type}${active.model ? ' · ' + active.model : ''}` : 'No provider';

  /** The group name in the header: custom name > auto title > default. */
  const headerTitle =
    groupTitle.custom && groupTitle.name
      ? groupTitle.name
      : messages.length > 0
        ? titleFromMessages(messages)
        : 'New group';

  /** Saves the header rename — the autosave effect persists it to the session file. */
  const commitTitle = () => {
    const name = titleDraft.trim();
    if (name) setGroupTitle({ name, custom: true });
    setEditingTitle(false);
  };

  return (
    <aside className="explorer-ai" style={{ width }}>
      <header className="explorer-ai__header">
        <button
          type="button"
          className="explorer-ai__collapse"
          aria-label="Collapse AI panel"
          title="Hide AI Agent panel"
          onClick={onCollapse}
        >
          <ChevronRight size={12} strokeWidth={1.5} />
        </button>
        {editingTitle ? (
          <input
            className="explorer-ai__title-input"
            autoFocus
            value={titleDraft}
            aria-label="Group chat name"
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle();
              if (event.key === 'Escape') setEditingTitle(false);
            }}
            onBlur={commitTitle}
          />
        ) : (
          <button
            type="button"
            className="explorer-ai__title explorer-ai__title--edit"
            title="Rename group chat"
            onClick={() => {
              setTitleDraft(headerTitle);
              setEditingTitle(true);
            }}
          >
            <strong>{headerTitle}</strong>
            <Pencil size={10} strokeWidth={1.5} className="explorer-ai__title-pen" />
          </button>
        )}
        <div className="explorer-ai__header-actions">
          <div className="ai-sessions-wrap" ref={sessionsRef}>
          <button
              type="button"
              className="ai-sessions-btn"
              title="Group chat"
              aria-label="Group chat"
              onClick={() => {
                void listSessions(chatScope).then(setSessionList);
                setSessionsOpen((open) => !open);
              }}
            >
              <MessageSquarePlus size={12} strokeWidth={1.5} />
            </button>
            {sessionsOpen && (
              <div className="ai-sessions" role="menu" aria-label="Group chats">
                <div className="ai-sessions__head">
                  <span className="ai-sessions__title">Group Chat</span>
                  <button type="button" className="ai-sessions__new" onClick={startNewChat}>
                    <MessageSquarePlus size={11} strokeWidth={1.5} />
                    New group
                  </button>
                </div>
                {sessionList.length === 0 && (
                  <p className="ai-sessions__empty">No groups yet — start typing to create one.</p>
                )}
                {sessionList.map((session) =>
                  renamingId === session.id ? (
                    <div key={session.id} className="ai-sessions__item ai-sessions__item--rename">
                      <input
                        autoFocus
                        className="ai-sessions__rename"
                        value={renameDraft}
                        aria-label="Group name"
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitRename(session, renameDraft);
                          if (event.key === 'Escape') setRenamingId(null);
                        }}
                      />
                      <button
                        type="button"
                        className="ai-sessions__item-del"
                        title="Save name"
                        aria-label="Save group name"
                        onClick={() => void commitRename(session, renameDraft)}
                      >
                        <Check size={10} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        className="ai-sessions__item-del"
                        title="Cancel"
                        aria-label="Cancel rename"
                        onClick={() => setRenamingId(null)}
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={session.id}
                      className={`ai-sessions__item${session.id === sessionId ? ' ai-sessions__item--active' : ''}`}
                    >
                      <button
                        type="button"
                        className="ai-sessions__item-main"
                        onClick={() => switchSession(session)}
                      >
                        <span className="ai-sessions__item-title">{session.title}</span>
                        <span className="ai-sessions__item-meta">
                          {session.messages.length} msgs · {relativeTime(Math.floor(session.updatedAt / 1000))}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ai-sessions__item-ren"
                        title="Rename group"
                        aria-label={`Rename group ${session.title}`}
                        onClick={() => {
                          setRenamingId(session.id);
                          setRenameDraft(session.title);
                        }}
                      >
                        <Pencil size={10} strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        className="ai-sessions__item-del"
                        title="Delete group"
                        aria-label={`Delete group ${session.title}`}
                        onClick={() => removeSession(session.id)}
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
        </div>
        </div>
      </header>

      <nav className="explorer-ai__tabs" role="tablist" aria-label="AI agent sections">
        {(
          [
            { id: 'chat', label: 'Chat', Icon: MessageSquare },
            { id: 'tools', label: 'Tools', Icon: Wrench },
            { id: 'mcp', label: 'MCP', Icon: Plug },
            { id: 'plugins', label: 'Plugins', Icon: Puzzle },
            { id: 'agents', label: 'Agents', Icon: Bot },
            { id: 'hooks', label: 'Hooks', Icon: Webhook },
            { id: 'instructions', label: 'Instructions', Icon: FileText },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={panelTab === id}
            aria-label={label}
            title={label}
            className={`explorer-ai__tab${panelTab === id ? ' explorer-ai__tab--active' : ''}`}
            onClick={() => setPanelTab(id)}
          >
            <Icon size={14} strokeWidth={1.5} />
          </button>
        ))}
        <span className="explorer-ai__tabs-spacer" />
        <button
          type="button"
          className="ai-sessions-btn"
          title="Project memory (.pigry/memory.md)"
          aria-label="Project memory"
          onClick={() => setKnowDialog('memory')}
        >
          <Brain size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="ai-sessions-btn"
          title="Project skills (.pigry/skills/)"
          aria-label="Project skills"
          onClick={() => setKnowDialog('skills')}
        >
          <Puzzle size={12} strokeWidth={1.5} />
        </button>
      </nav>

      {panelTab === 'tools' && <AgentToolsTab />}
      {panelTab === 'mcp' && <McpTab />}
      {panelTab === 'plugins' && <PluginsTab />}
      {panelTab === 'agents' && <AgentsTab defaultTeam={defaultTeam} />}
      {panelTab === 'hooks' && <HooksTab />}
      {panelTab === 'instructions' && <InstructionsTab />}
      {panelTab === 'chat' && (
      <>
      <div className="explorer-ai__body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="ai-hero">
            <div className="ai-hero__icon">
              <Sparkles size={20} strokeWidth={1.5} />
            </div>
            <h3 className="ai-hero__title">
              Ask AI about <code>{fileName}</code>
            </h3>
            <p className="ai-hero__sub">Attach files or images for deeper context.</p>
            <div className="ai-hero__chips">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  className="ai-hero__chip"
                  onClick={() => {
                    setInput(suggestion.prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <section className="explorer-ai__section">
            {messages.map((message, index) => {
              const isUser = message.role === 'user';
              const editing = editingIndex === index;
              const replyAgent = !isUser && message.agent
                ? allAgents().find((entry) => entry.username === message.agent)
                : null;
              return (
                <div
                  key={index}
                  className={`explorer-ai__card explorer-ai__msg ${isUser ? 'explorer-ai__msg--user' : ''}${message.error ? ' explorer-ai__msg--error' : ''}`}
                >
                    <div className="explorer-ai__msg-meta">
                      {replyAgent && (
                        <button
                          type="button"
                          className="explorer-ai__msg-agent-btn"
                          title={`View ${replyAgent.name}'s profile`}
                          onClick={() => setViewingAgent(replyAgent)}
                        >
                          <span
                            className="explorer-ai__avatar"
                            style={agentAvatarStyle(replyAgent.username)}
                          >
                            {replyAgent?.avatar ? (
                              <img src={replyAgent.avatar} alt={replyAgent.name} />
                            ) : (
                              agentMonogram(message.agent)
                            )}
                          </span>
                          <span className="explorer-ai__msg-name">
                            {agentDisplayName(message.agent)}
                          </span>
                        </button>
                      )}
                      {!replyAgent && (
                        <>
                          <span className="explorer-ai__avatar">
                            {isUser && ghUser?.avatarUrl ? (
                              <img src={ghUser.avatarUrl} alt={ghUser.name} />
                            ) : (
                              isUser ? 'You' : 'AI'
                            )}
                          </span>
                          <span className="explorer-ai__msg-name">
                            {isUser ? ghUser?.login || 'You' : agentDisplayName(message.agent)}
                          </span>
                        </>
                      )}
                      {message.time && (
                        <span className="explorer-ai__msg-time">{fmtMsgTime(message.time)}</span>
                      )}
                      {isUser && !editing && (
                        <button
                          type="button"
                          className="explorer-ai__msg-edit-btn"
                          title="Edit message and resend"
                          aria-label="Edit message"
                          disabled={sending}
                          onClick={() => {
                            setEditingIndex(index);
                            setEditDraft(message.text);
                          }}
                        >
                          <Pencil size={11} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                    {editing ? (
                      <div className="explorer-ai__msg-editor">
                        <textarea
                          className="explorer-ai__msg-editor-input"
                          value={editDraft}
                          rows={Math.min(10, Math.max(2, editDraft.split('\n').length))}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingIndex(null);
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                              event.preventDefault();
                              void resendEdited(index, editDraft);
                            }
                          }}
                          autoFocus
                        />
                        <div className="explorer-ai__msg-editor-actions">
                          <button
                            type="button"
                            className="explorer-ai__msg-editor-btn"
                            onClick={() => setEditingIndex(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="explorer-ai__msg-editor-btn explorer-ai__msg-editor-btn--primary"
                            disabled={!editDraft.trim() || sending}
                            onClick={() => void resendEdited(index, editDraft)}
                          >
                            <Check size={11} strokeWidth={2} />
                            Save &amp; resubmit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {isUser && message.selection && (
                          <div className="explorer-ai__msg-selection" title={message.selection.path}>
                            <div className="explorer-ai__msg-selection-head">
                              <FileText size={10} strokeWidth={1.5} />
                              <span>{message.selection.path.split('/').pop()}</span>
                              <span className="explorer-ai__msg-selection-range">
                                {message.selection.startLine}–{message.selection.endLine}
                              </span>
                            </div>
                            <pre className="explorer-ai__msg-selection-code">
                              {message.selection.text}
                            </pre>
                          </div>
                        )}
                        {message.toolEvents && message.toolEvents.length > 0 && (
                          <div className="explorer-ai__msg-tools">
                            {message.toolEvents.map((event, i) => {
                              const fileTarget = toolEventTarget(event);
                              return fileTarget && onOpenFile ? (
                                <button
                                  key={i}
                                  type="button"
                                  className="explorer-ai__tool-event explorer-ai__tool-event--link"
                                  title={`Open ${fileTarget.path}${fileTarget.line ? ` at line ${fileTarget.line}` : ''} in the editor`}
                                  onClick={() => onOpenFile(fileTarget.path, fileTarget.line)}
                                >
                                  {event}
                                </button>
                              ) : (
                                <span key={i} className="explorer-ai__tool-event">
                                  {event}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <div className="explorer-ai__msg-text">
                          {renderMarkdown(message.text)}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {sending && (
                <div className="explorer-ai__card explorer-ai__msg">
                  <div className="explorer-ai__msg-meta">
                    <span className="explorer-ai__avatar" style={agentAvatarStyle(replyingAs)}>
                      {agentMonogram(replyingAs)}
                    </span>
                    <span className="explorer-ai__msg-name">{agentDisplayName(replyingAs)}</span>
                  </div>
                  <span className="ai-typing" aria-label="AI is thinking">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
          </section>
        )}
      </div>

      <footer className="explorer-ai__footer">
        <div className="ai-composer">
          <div className="ai-composer__mdtools" role="toolbar" aria-label="Markdown formatting">
            <button type="button" title="Bold **…**" onClick={() => applyMdWrap('**', '**', 'bold')}>
              <Bold size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Italic _…_" onClick={() => applyMdWrap('_', '_', 'italic')}>
              <Italic size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Strikethrough ~~…~~" onClick={() => applyMdWrap('~~', '~~', 'strike')}>
              <Strikethrough size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Code" onClick={applyMdCode}>
              <Code size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Heading ##" onClick={() => applyMdPrefix('## ')}>
              <Heading2 size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Link […](url)" onClick={() => applyMdWrap('[', '](https://)', 'link text')}>
              <Link2 size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Bullet list -" onClick={() => applyMdPrefix('- ')}>
              <List size={12} strokeWidth={1.5} />
            </button>
            <button type="button" title="Quote >" onClick={() => applyMdPrefix('> ')}>
              <Quote size={12} strokeWidth={1.5} />
            </button>
          </div>
          {(activeSelection || activeHistory || attachedFiles.length > 0 || images.length > 0) && (
            <div className="ai-composer__attachments">
              {activeHistory && (
                <span
                  className="ai-composer__sel-chip"
                  title={`File history: ${activeHistory.path} @ ${activeHistory.oid.slice(0, 7)} — the file at that commit is included with your next message`}
                >
                  <History size={10} strokeWidth={1.5} />
                  {activeHistory.path.split('/').pop()}
                  <span className="ai-composer__sel-range">@ {activeHistory.oid.slice(0, 7)}</span>
                  <button
                    type="button"
                    aria-label="Remove file history from chat"
                    onClick={() => setDismissedHistory(historyKey)}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              )}
              {activeSelection && (
                <span
                  className="ai-composer__sel-chip"
                  title={`Selected lines ${activeSelection.startLine}–${activeSelection.endLine} of ${activeSelection.path} — included with your next message`}
                >
                  <FileText size={10} strokeWidth={1.5} />
                  {activeSelection.path.split('/').pop()}
                  <span className="ai-composer__sel-range">
                    {activeSelection.startLine}–{activeSelection.endLine}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove selection from chat"
                    onClick={() => setDismissedKey(selectionKey)}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              )}
              {attachedFiles.map((file) => (
                <span key={file.path} className="explorer-ai__chip" title={file.path}>
                  <FileText size={10} strokeWidth={1.5} />
                  {file.path.split('/').pop()}
                  <button type="button" aria-label={`Remove ${file.path}`} onClick={() => removeAttached(file.path)}>
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              ))}
              {images.map((image, index) => (
                <span key={index} className="explorer-ai__thumb">
                  <img src={image.dataUrl} alt={image.name} />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="ai-composer__input-wrap">
            {mention && (
              <MentionMenu
                candidates={mentionList}
                highlighted={mentionPos}
                onHover={setMentionIdx}
                onPick={pickMention}
                onOutside={closeMention}
                anchorRef={textareaRef}
                direction="up"
                label="Mention an agent"
              />
            )}
            {skillTok && !mention && (
              <SkillMenu
                candidates={skillList}
                highlighted={skillPos}
                onHover={setSkillIdx}
                onPick={pickSkill}
                onOutside={closeSkill}
                anchorRef={textareaRef}
                direction="up"
                label="Use a skill"
              />
            )}
            <textarea
              ref={textareaRef}
              className="ai-composer__input"
              placeholder={`Ask AI to improve this file… (markdown supported, paste images, @ agent, # skill)`}
              aria-label="Ask AI"
              value={input}
              rows={2}
              onChange={(event) => {
                const { value, selectionStart } = event.target;
                setInput(value);
                const caret = selectionStart ?? value.length;
                const at = detectMention(value, caret);
                setMention(at);
                setMentionIdx(0);
                setSkillTok(at ? null : detectSkillToken(value, caret));
                setSkillIdx(0);
              }}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (mention && mentionList.length > 0) {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowUp' ? -1 : 1;
                    setMentionIdx((i) => (i + delta + mentionList.length) % mentionList.length);
                    return;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    pickMention(mentionList[mentionPos]);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMention();
                    return;
                  }
                }
                if (skillTok && skillList.length > 0) {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowUp' ? -1 : 1;
                    setSkillIdx((i) => (i + delta + skillList.length) % skillList.length);
                    return;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    pickSkill(skillList[skillPos]);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeSkill();
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          {attachError && <p className="ai-composer__error">{attachError}</p>}
          <div className="ai-composer__bar">
            <div className="ai-composer__tools">
              <button
                type="button"
                className="ai-composer__tool"
                title="Attach image (PNG/JPG)"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon size={12} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                className="ai-composer__tool"
                title={`Attach active file (${fileName})`}
                onClick={() => void attachActiveFile()}
              >
                <Paperclip size={12} strokeWidth={1.5} />
              </button>
              <button
                type="button"
                className="ai-composer__tool"
                title="Clear conversation"
                onClick={clearConversation}
              >
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  attachImages(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="ai-composer__right">
              <button
                type="button"
                className="explorer-ai__model-pill"
                title="Change provider or model"
                onClick={() => setModelDialogOpen(true)}
              >
                <span className={`explorer-ai__model-dot explorer-ai__model-dot--${active && active.apiKey && active.baseUrl ? 'ok' : 'warn'}`} />
                <span className="explorer-ai__model-pill-name">{providerLabel}</span>
                <ChevronDown size={11} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="ai-composer__send"
                aria-label="Send"
                disabled={sending || !input.trim()}
                onClick={() => void send()}
              >
                {sending ? (
                  <Loader2 size={14} strokeWidth={1.75} className="explorer-ai__send-spin" />
                ) : (
                  <ArrowRight size={14} strokeWidth={1.75} />
                )}
              </button>
            </div>
          </div>
        </div>
        <div className="ai-composer__hint">
          Context: {fileName}
          {activeSelection ? ` · lines ${activeSelection.startLine}–${activeSelection.endLine} selected` : ''}
          {attachedFiles.length > 0 ? ` +${attachedFiles.length} attached` : ''}
          {defaultAgent
            ? ` · default @${defaultAgent.username} answers — @ to tag another agent`
            : teamAgents.some((agent) => agent.enabled && agent.username)
              ? ' · @ to tag an agent'
              : ''}
        </div>
      </footer>
      </>
      )}

      {modelDialogOpen && (
        <ModelPickerDialog
          providers={providers}
          activeId={active?.id ?? ''}
          onClose={() => setModelDialogOpen(false)}
          onPick={(providerId, modelName) => {
            // Persist the chosen model as the provider's active one, then
            // switch — the panel and legacy consumers both read the mirror.
            const list = providers.map((p) =>
              p.id === providerId
                ? { ...p, model: modelName, models: p.models.map((m) => ({ ...m, enabled: m.name === modelName ? true : m.enabled })) }
                : p,
            );
            saveProviders(list, providerId);
            setProviders(list);
            setActiveId(providerId);
            setModelDialogOpen(false);
          }}
        />
      )}
      {knowDialog === 'memory' && (
        <MemoryDialog
          onClose={() => setKnowDialog(null)}
          notify={notify}
          team={team}
        />
      )}
      {knowDialog === 'skills' && (
        <SkillsDialog
          onClose={() => setKnowDialog(null)}
          notify={notify}
        />
      )}
        {viewingAgent && (
          <AgentDetailsDialog
            agent={viewingAgent}
            onClose={() => setViewingAgent(null)}
          />
        )}
    </aside>
  );
}

/** Full-screen dialog: pick a provider on the left, a model on the right. */
function ModelPickerDialog({
  providers,
  activeId,
  onClose,
  onPick,
}: {
  providers: AiProviderEntry[];
  activeId: string;
  onClose: () => void;
  onPick: (providerId: string, modelName: string) => void;
}) {
  const activeProvider = providers.find((p) => p.id === activeId) ?? null;
  const [viewId, setViewId] = useState(activeProvider?.id ?? providers[0]?.id ?? '');
  const viewed = providers.find((p) => p.id === viewId) ?? providers[0] ?? null;

  return (
    <div
      className="model-dlg-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="model-dlg" role="dialog" aria-modal="true" aria-label="Select model">
        <header className="model-dlg__head">
          <strong className="model-dlg__title">Select model</strong>
          <button type="button" className="model-dlg__close" onClick={onClose} aria-label="Close model picker">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="model-dlg__body">
          <aside className="model-dlg__providers" aria-label="Providers">
            <span className="model-dlg__group">Providers</span>
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={`model-dlg__provider${provider.id === viewId ? ' model-dlg__provider--active' : ''}`}
                onClick={() => setViewId(provider.id)}
              >
                <span className={`model-dlg__dot model-dlg__dot--${provider.apiKey && provider.baseUrl ? 'ok' : 'warn'}`} />
                <span className="model-dlg__provider-name">{provider.name}</span>
                <span className="model-dlg__provider-count">{provider.models.length}</span>
              </button>
            ))}
          </aside>
          <section className="model-dlg__models" aria-label={`Models of ${viewed?.name ?? ''}`}>
            {viewed && viewed.models.length === 0 && (
              <p className="model-dlg__empty">No models — add some in Settings → AI Provider.</p>
            )}
            {viewed?.models.map((model) => {
              const isChosen = viewed.id === activeId && model.name === viewed.model;
              return (
                <button
                  key={model.id}
                  type="button"
                  className={`model-dlg__model${isChosen ? ' model-dlg__model--chosen' : ''}${model.enabled ? '' : ' model-dlg__model--off'}`}
                  onClick={() => onPick(viewed.id, model.name)}
                  disabled={!model.enabled}
                >
                  {isChosen ? (
                    <Check size={13} strokeWidth={2} className="model-dlg__check" />
                  ) : (
                    <span className="model-dlg__check-spacer" />
                  )}
                  <span className="model-dlg__model-name">{model.name}</span>
                  {model.context && <span className="model-dlg__badge">{model.context}</span>}
                  {model.vision && <span className="model-dlg__badge">Vision</span>}
                </button>
              );
            })}
          </section>
        </div>
        <footer className="model-dlg__foot">
          <span className="model-dlg__hint">Manage providers in Settings → AI Provider.</span>
        </footer>
      </div>
    </div>
  );
}
