import { useEffectEvent, useEffect, useMemo, useRef, useState } from 'react';
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
  Globe,
  GitCommitHorizontal,
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
  SearchCode,
  Sparkles,
  Strikethrough,
  Trash2,
  Webhook,
  Wrench,
  X,
} from 'lucide-react';
import { aiChat,
  openInBrowser, cliAgentRun, cliDetect, getCommitDetail, getFileTree, memoryAdd, memoryRemove, memorySearch, readFileAtCommit, readWorktreeFile, writeWorktreeFile } from '../../lib/tauriClient';
import {
  AGENT_TEAMS, allAgents, builtinAgents, setAgentOverride } from '../../lib/agentExtras';
import { effortPayloadFragment, providerStatus, resolveContextWindow } from '../../lib/aiProviders';
import { CtxRing } from '../../lib/CtxRing';
import { detectSkillToken, applySkillToken, skillCandidates, SkillMenu, type SkillEntry, type SkillTokenState } from '../../lib/mentions';
import { listSkills, getSkillContent } from '../../lib/skills';
import { webSearch, browserPage, readBinaryFile } from '../../lib/tauriClient';
import { browserDevtools, type DevtoolsAction } from '../../lib/tauriClient';
import { normalizeUrl } from '../../lib/browserWebview';
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

/* ---------- live activity indicator (per-phase animations) ---------- */

type ActivityKind = 'thinking' | 'analysis' | 'research' | 'mcp' | 'tool';

interface ActivityState {
  kind: ActivityKind;
  label: string;
}

/** Tools that hit the web — the agent is researching. */
const RESEARCH_TOOLS = new Set(['web_search', 'playwright', 'browser', 'browser_devtools', 'browser_page']);
/** Read/inspect tools — the agent is analyzing the repo. */
const ANALYSIS_TOOLS = new Set([
  'read_file',
  'read_diff',
  'read_history',
  'search_code',
  'read_image',
  'read_pdf',
  'read_word',
  'read_excel',
  'list_files',
  'agent_lookup',
  'agent_contacts',
]);

/** Classifies a tool call into the activity animation it should show. */
export function activityForTool(name: string): ActivityState {
  const lower = name.toLowerCase();
  let mcp = lower.startsWith('mcp');
  if (!mcp) {
    try {
      mcp = loadMcpServers().some(
        (server) => server.enabled && lower.includes(server.name.toLowerCase()),
      );
    } catch {
      // registry unavailable
    }
  }
  if (mcp) return { kind: 'mcp', label: name };
  if (RESEARCH_TOOLS.has(lower)) return { kind: 'research', label: name };
  if (ANALYSIS_TOOLS.has(lower)) return { kind: 'analysis', label: name };
  return { kind: 'tool', label: name };
}

/** The animated status row shown under the replying agent's name. */
function ActivityIndicator({ activity }: { activity: ActivityState | null }) {
  const kind = activity?.kind ?? 'thinking';
  const label = activity?.label
    ? {
        thinking: 'Reasoning',
        analysis: `Analyzing — ${activity.label}`,
        research: `Researching — ${activity.label}`,
        mcp: `MCP — ${activity.label}`,
        tool: `Using ${activity.label}`,
      }[kind]
    : 'Thinking';
  const Icon =
    kind === 'analysis'
      ? SearchCode
      : kind === 'research'
        ? Globe
        : kind === 'mcp'
          ? Plug
          : kind === 'tool'
            ? Wrench
            : Brain;
  return (
    <span className={`ai-activity ai-activity--${kind}`}>
      <span className="ai-activity__icon">
        <Icon size={12} strokeWidth={1.75} />
      </span>
      <span className="ai-activity__label">{label}</span>
      <span className="ai-typing" aria-label="AI is working">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
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
const pendingImages: string[] = [];

/** Whether the CURRENT turn's model accepts image input. Set per turn from
 * the active AiModelEntry — explicit inputTypes govern; entries without them
 * (legacy/built-in) keep the old always-send behavior. */
let imageGate = true;
function setImageGate(spec: { inputTypes?: string[] } | null | undefined) {
  imageGate = !spec?.inputTypes || spec.inputTypes.includes('image');
}

/** max_tokens for the current turn's model (model metadata wins over 4096). */
function maxTokensFor(spec: { maxOutputTokens?: number } | null | undefined): number {
  return spec?.maxOutputTokens ?? 4096;
}

/** Resolves the AiModelEntry matching the provider's active model name. */
function modelSpecOf(provider: {
  model?: string;
  models?: Array<{
    name?: string;
    inputTypes?: string[];
    maxOutputTokens?: number;
    effort?: string;
    reasoningMapping?: string;
  }>;
}):
  | { inputTypes?: string[]; maxOutputTokens?: number; effort?: string; reasoningMapping?: string }
  | null {
  const entry = provider.models?.find((m) => m.name === provider.model);
  return entry
    ? {
        inputTypes: entry.inputTypes,
        maxOutputTokens: entry.maxOutputTokens,
        effort: entry.effort,
        reasoningMapping: entry.reasoningMapping,
      }
    : null;
}

/** Vendor effort params for the current turn (thinking/effort/thinkingConfig). */
function effortFor(spec: { effort?: string; reasoningMapping?: string } | null | undefined): Record<string, unknown> {
  return effortPayloadFragment(spec?.effort, spec?.reasoningMapping) ?? {};
}

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
      const { default: mammoth } = await import('mammoth');
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
      const XLSX = await import('xlsx');
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

/** AGENT_CONTACTS_TOOL — the workspace contact book, grouped by team. */
const AGENT_CONTACTS_TOOL: ToolSpec = {
  id: 'agent_contacts',
  name: 'agent_contacts',
  description:
    'The workspace contact book: every enabled agent grouped by team, one line each (@handle, name, role). Use it to see who exists and who to contact; use agent_lookup for one agent\u2019s full profile.',
  input_schema: { type: 'object', properties: {} },
  run: async () => {
    const agents = allAgents().filter((agent) => agent.enabled && agent.username);
    if (agents.length === 0) return '(no agents registered)';
    const teamOrder: string[] = AGENT_TEAMS as unknown as string[];
    const grouped = new Map<string, typeof agents>();
    for (const agent of agents) {
      const key = agent.team ?? '';
      const bucket = grouped.get(key);
      if (bucket) bucket.push(agent);
      else grouped.set(key, [agent]);
    }
    const ordered = [
      ...teamOrder.filter((team) => grouped.has(team)),
      ...[...grouped.keys()].filter((team) => !teamOrder.includes(team)),
    ];
    return ordered
      .map((team) => {
        const members = grouped
          .get(team)
          ?.map(
            (agent) =>
              `  @${agent.username} — ${agent.name}${agent.role ? ` (${agent.role})` : ''}${agent.tier ? ` [${agent.tier}]` : ''}`,
          )
          .join('\n');
        return `[${team || 'no team'}]\n${members}`;
      })
      .join('\n\n');
  },
};

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
    id: 'browser_panel',
    name: 'browser_panel',
    description:
      'Open pages in the user’s EXTERNAL browser (the OS default browser — the user sees pages there; that browser cannot be scripted). Actions: "navigate" (default — open a URL; Google search via https://www.google.com/search?q=<query>), "read" (open it AND return the rendered page text via the playwright reader — open+summarize in one step), "new_tab" (open another URL in a new tab), "eval" (run JavaScript on the agent’s headless automation copy — see browser_e2e), "list_tabs" (note: the external browser manages its own tabs).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'read', 'eval', 'new_tab', 'list_tabs'],
          description: 'The action to run (default "navigate")',
        },
        url: { type: 'string', description: 'URL — for "navigate"/"read" (required) and "new_tab"' },
        wait_ms: { type: 'number', description: 'For "read": how long to let the page run before reading (ms, default 1200)' },
        js: { type: 'string', description: 'For "eval": JavaScript to run on the headless automation page' },
      },
    },
    run: async (input) => {
      const action = String(input.action ?? 'navigate');
      const url = input.url ? String(input.url) : undefined;
      if (action === 'read') {
        if (!url) return 'error: read needs a url';
        const target = normalizeUrl(url);
        await openInBrowser(target);
        const page = await browserPage(target, Number(input.wait_ms ?? 1200) || undefined);
        return 'Opened ' + (page.url || target) + ' in your default browser.\n\ntitle: ' + page.title + '\n\n' + page.text;
      }
      if (action === 'eval') {
        const js = String(input.js ?? '');
        if (!js) return 'error: eval needs a js snippet';
        return browserDevtools('eval', { js });
      }
      if (action === 'new_tab') {
        if (!url) return 'error: new_tab needs a url';
        const target = normalizeUrl(url);
        await openInBrowser(target);
        return 'Opened ' + target + ' in a new tab of your default browser.';
      }
      if (action === 'list_tabs') {
        return 'The browser runs externally — it manages its own tabs; each navigate/new_tab opens one there.';
      }
      if (!url) return 'error: navigate needs a url';
      const target = normalizeUrl(url);
      await openInBrowser(target);
      return 'Opened ' + target + ' in your default browser.';
    },
  },
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
      'Open a URL in headless Edge/Chrome and read the rendered page text (JavaScript already executed). INVISIBLE to the user — never use it to "open" a page the user asked to see (call browser_panel for that). Use after web_search or browser_panel to read/summarize a specific page.',
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

/** E2E testing against the page the in-app browser panel currently shows.
 * Results come back through the title channel (Tauri eval has no return
 * value: the page writes §-prefixed JSON into document.title, the backend
 * reads it back). */
/** E2E testing through the agent's headless automation session — the user
 * watches pages in their EXTERNAL browser; that browser cannot be scripted,
 * so interactive steps run on the headless copy instead. */
const E2E_TOOLS: ToolSpec[] = [
  {
    id: 'browser_e2e',
    name: 'browser_e2e',
    description:
      'Drive and E2E-test a page on the agent’s headless automation session (the user watches pages in their external browser — that one cannot be scripted). Workflow: goto → snapshot (assigns element refs e1,e2,…) → click/type/fill_form/select_option/press_key using the ref or a CSS selector → assert_url/assert_title/assert_text/assert_element_visible/assert_value → text/evaluate/wait_for/console_messages/storage/cookies/network_requests/screenshot. Returns PASS/FAIL and live page data.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'goto', 'back', 'forward', 'reload', 'snapshot', 'find',
            'click', 'type', 'select_option', 'press_key', 'fill_form',
            'scroll',
            'assert_url', 'assert_title', 'assert_text', 'assert_element_visible', 'assert_value',
            'text', 'evaluate', 'wait_for', 'console_messages', 'storage', 'cookies',
            'network_requests', 'screenshot',
          ],
          description: 'The browser step to run (default "goto")',
        },
        url: { type: 'string', description: 'For "goto": http(s) URL to open' },
        selector: { type: 'string', description: 'Target element: ref from snapshot (e.g. "e3") or CSS selector' },
        value: { type: 'string', description: 'For "type"/"storage set"/"assert_value": the text/value' },
        text: { type: 'string', description: 'For "type": text (alias of value); for "assert_text"/"wait_for": the text' },
        contains: { type: 'string', description: 'For "assert_url"/"assert_title"/"assert_text"/"find": substring that must appear' },
        values: { type: 'string', description: 'For "select_option": comma-separated option values/texts' },
        fields: { type: 'string', description: 'For "fill_form": JSON array [{selector,value}] filled in one pass' },
        key: { type: 'string', description: 'For "press_key": key name, e.g. "Enter", "Tab", "Escape"' },
        js: { type: 'string', description: 'For "evaluate": JavaScript to run inside the page; its return value comes back' },
        kind: { type: 'string', enum: ['local', 'session'], description: 'For "storage": which store (default local)' },
        op: { type: 'string', enum: ['list', 'get', 'set', 'delete', 'clear'], description: 'For "storage": operation (default list)' },
        submit: { type: 'boolean', description: 'For "type": press Enter / submit the form after typing' },
        wait_ms: { type: 'number', description: 'Settle time for navigation actions / fixed wait (ms, default 1500)' },
        max: { type: 'number', description: 'Truncate returned page text to this many chars (default 3000)' },
        network_idle: { type: 'boolean', description: 'For "wait_for": wait until the page has no new network activity' },
        idle_ms: { type: 'number', description: 'For wait_for network_idle: quiet period that counts as idle (ms, default 500)' },
      },
      required: ['action'],
    },
    run: async (input) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const action = String(input.action ?? 'goto');
      const wait = Number.isFinite(Number(input.wait_ms)) ? Number(input.wait_ms) : 1500;
      const max = Number.isFinite(Number(input.max)) ? Number(input.max) : 3000;
      const resolveSel = (target: string) =>
        /^e\d+$/.test(target) ? '[data-pigry-ref="' + target + '"]' : target;
      const evalJs = async (js: string) =>
        browserDevtools('eval', { js: '(function(){' + js + '})()' });
      const read = async (js: string, readMax?: number) => {
        try {
          const raw = await evalJs(js);
          return { ok: true, message: (raw || '').slice(0, readMax ?? max) };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      };
      const navInfo = () => read('return document.title + " | " + location.href;', 300);

      // ---- navigation family --------------------------------------------
      if (action === 'goto') {
        const url = normalizeUrl(String(input.url ?? ''));
        if (!url) return 'error: goto needs a url';
        const summary = await browserDevtools('open', { url, waitMs: wait });
        return 'GOTO ' + url + '\n' + summary;
      }
      if (action === 'back' || action === 'forward' || action === 'reload') {
        const js = action === 'reload' ? 'location.reload();' : 'history.' + action + '();';
        await evalJs(js);
        await sleep(wait);
        const res = await navInfo();
        return (action.toUpperCase() + ' done. ' + (res.ok ? res.message : '')).trim();
      }

      // ---- snapshot / find -------------------------------------------------
      const SNAPSHOT_CORE =
        "var sels='a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[role=radio],[onclick],[contenteditable=true]';" +
        'var out=[];var n=0;document.querySelectorAll(sels).forEach(function(el){var r=el.getBoundingClientRect();' +
        'if(r.width<1||r.height<1||out.length>=80)return;var ref="e"+(++n);el.setAttribute("data-pigry-ref",ref);' +
        "var lb=(el.getAttribute('aria-label')||el.innerText||el.value||el.getAttribute('placeholder')||el.getAttribute('title')||'');" +
        "lb=lb.trim().replace(/\\s+/g,' ').slice(0,60);var tag=el.tagName.toLowerCase();var ty=el.getAttribute('type');" +
        "out.push(ref+' <'+tag+(ty?' type='+ty:'')+'>'+(lb?' \"'+lb+'\"':'')+(tag==='a'&&el.getAttribute('href')?' href='+el.getAttribute('href').slice(0,60):''));});return out;";
      if (action === 'snapshot' || action === 'find') {
        const needle = action === 'find' ? String(input.contains ?? input.text ?? '').toLowerCase() : '';
        if (action === 'find' && !needle) return 'error: find needs a contains string';
        const js =
          SNAPSHOT_CORE +
          'var f=' + JSON.stringify(needle) + ';' +
          (action === 'find'
            ? 'out=out.filter(function(l){return l.toLowerCase().indexOf(f)!==-1;});'
            : '') +
          'return document.title+" | "+location.href+"\\n"+(out.length?out.join("\\n"):"(no matching interactive elements)");';
        const res = await read(js, max);
        return res.ok
          ? 'SNAPSHOT (interactive elements — use the refs as the selector):\n' + res.message
          : 'FAIL: ' + action + ' — ' + res.message;
      }

      // ---- interactions ----------------------------------------------------
      if (action === 'click') {
        const sel = resolveSel(String(input.selector ?? ''));
        if (!sel) return 'error: click needs a selector (run snapshot first)';
        const dbl = input.double_click === true;
        const res = await read(
          'var el=document.querySelector(' + JSON.stringify(sel) + ');' +
          'if(!el)throw new Error("no element " + ' + JSON.stringify(sel) + ');' +
          'el.scrollIntoView({block:"center"});' +
          (dbl
            ? 'el.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));'
            : 'el.click();') +
          'return "clicked";',
        );
        return res.ok ? 'CLICK ' + sel + ' — ' + res.message : 'FAIL: click — ' + res.message;
      }
      if (action === 'type') {
        const sel = resolveSel(String(input.selector ?? ''));
        if (!sel) return 'error: type needs a selector';
        const value = String(input.value ?? input.text ?? '');
        if (!value) return 'error: type needs a value/text';
        const submit = input.submit === true;
        const res = await read(
          'var el=document.querySelector(' + JSON.stringify(sel) + ');' +
          'if(!el)throw new Error("no element");el.focus();el.value=' + JSON.stringify(value) + ';' +
          'el.dispatchEvent(new Event("input",{bubbles:true}));' +
          (submit
            ? 'if(el.form){el.form.requestSubmit?el.form.requestSubmit():el.form.submit();}else{el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));}' +
              'return "typed+submitted";'
            : 'return "typed";'),
          300,
        );
        return res.ok ? 'TYPE ' + sel + ' — ' + res.message : 'FAIL: type — ' + res.message;
      }
      if (action === 'select_option') {
        const sel = resolveSel(String(input.selector ?? ''));
        const values = String(input.values ?? '').split(',').map((v) => v.trim()).filter(Boolean);
        if (!sel || values.length === 0) return 'error: select_option needs a selector and values';
        const res = await read(
          'var el=document.querySelector(' + JSON.stringify(sel) + ');' +
          'if(!el)throw new Error("no element");' +
          'var vals=' + JSON.stringify(values) + ';' +
          'Array.prototype.forEach.call(el.options,function(o){o.selected=vals.indexOf(o.value)!==-1||vals.indexOf(o.text)!==-1;});' +
          'el.dispatchEvent(new Event("change",{bubbles:true}));return "selected";',
          300,
        );
        return res.ok ? 'SELECT ' + sel + ' — ' + res.message : 'FAIL: select_option — ' + res.message;
      }
      if (action === 'press_key') {
        const key = String(input.key ?? 'Enter');
        const res = await read(
          'var el=document.activeElement||document.body;' +
          'el.dispatchEvent(new KeyboardEvent("keydown",{key:' + JSON.stringify(key) + ',bubbles:true}));' +
          'el.dispatchEvent(new KeyboardEvent("keyup",{key:' + JSON.stringify(key) + ',bubbles:true}));' +
          'return "pressed ' + key + '";',
          300,
        );
        return res.ok ? res.message : 'FAIL: press_key — ' + res.message;
      }
      if (action === 'fill_form') {
        const fields = String(input.fields ?? '');
        let parsedFields: Array<{ selector: string; value: string }> = [];
        try { parsedFields = JSON.parse(fields || '[]'); } catch { return 'error: fill_form needs fields as JSON [{selector,value}]'; }
        if (!Array.isArray(parsedFields) || parsedFields.length === 0) return 'error: fill_form needs fields as JSON [{selector,value}]';
        const res = await read(
          'var fields=' + JSON.stringify(parsedFields) + ';' +
          'var done=0;fields.forEach(function(f){var el=document.querySelector(f.selector);if(!el)return;' +
          'el.focus();el.value=f.value;el.dispatchEvent(new Event("input",{bubbles:true}));done++;});' +
          'return "filled "+done+"/"+fields.length;',
          300,
        );
        return res.ok ? 'FILL_FORM — ' + res.message : 'FAIL: fill_form — ' + res.message;
      }
      if (action === 'scroll') {
        const x = Number.isFinite(Number(input.x)) ? Number(input.x) : 0;
        const y = Number.isFinite(Number(input.y)) ? Number(input.y) : 600;
        await evalJs('window.scrollBy(' + x + ', ' + y + ');');
        return 'SCROLL by ' + x + ', ' + y;
      }

      // ---- asserts ---------------------------------------------------------
      if (action === 'assert_url') {
        const needle = String(input.contains ?? input.url ?? '').toLowerCase();
        if (!needle) return 'error: assert_url needs a contains substring';
        const res = await read('return location.href.toLowerCase();', 500);
        return res.ok && res.message.indexOf(needle) !== -1
          ? 'PASS: url contains ' + needle
          : 'FAIL: url is ' + (res.ok ? res.message : res.message) + ' — expected to contain ' + needle;
      }
      if (action === 'assert_title') {
        const needle = String(input.contains ?? '').toLowerCase();
        const res = await read('return document.title.toLowerCase();', 300);
        return res.ok && (!needle || res.message.indexOf(needle) !== -1)
          ? 'PASS: title is ' + res.message
          : 'FAIL: title is ' + res.message + (needle ? ' — expected to contain ' + needle : '');
      }
      if (action === 'assert_text') {
        const needle = String(input.contains ?? input.text ?? '');
        if (!needle) return 'error: assert_text needs a contains string';
        const res = await read('return document.body.innerText;', max);
        return res.ok && res.message.indexOf(needle) !== -1
          ? 'PASS: page text contains ' + needle
          : 'FAIL: page text does not contain ' + needle;
      }
      if (action === 'assert_element_visible') {
        const sel = resolveSel(String(input.selector ?? ''));
        if (!sel) return 'error: assert_element_visible needs a selector';
        const res = await read(
          'var el=document.querySelector(' + JSON.stringify(sel) + ');' +
          'if(!el)throw new Error("no element");' +
          'var r=el.getBoundingClientRect();' +
          'return (r.width>0&&r.height>0&&el.offsetParent!==null)?"visible":"hidden";',
          200,
        );
        return res.ok && res.message === 'visible'
          ? 'PASS: ' + sel + ' is visible'
          : 'FAIL: ' + sel + ' is not visible';
      }
      if (action === 'assert_value') {
        const sel = resolveSel(String(input.selector ?? ''));
        const expected = String(input.value ?? '');
        const res = await read(
          'var el=document.querySelector(' + JSON.stringify(sel) + ');' +
          'if(!el)throw new Error("no element");return String(el.value);',
          300,
        );
        return res.ok && res.message === expected
          ? 'PASS: value is ' + expected
          : 'FAIL: value is ' + (res.ok ? res.message : res.message) + ' — expected ' + expected;
      }

      // ---- readers ---------------------------------------------------------
      if (action === 'text') {
        const res = await read('return document.body ? document.body.innerText : "";', max);
        return res.ok ? res.message : 'FAIL: text — ' + res.message;
      }
      if (action === 'evaluate') {
        const js = String(input.js ?? '');
        if (!js) return 'error: evaluate needs a js snippet';
        try {
          const raw = await evalJs(js);
          return (raw || '(no result)').slice(0, max);
        } catch (error) {
          return 'error: ' + (error instanceof Error ? error.message : String(error));
        }
      }
      if (action === 'wait_for') {
        const needle = String(input.contains ?? input.text ?? '');
        if (!needle) return 'error: wait_for needs a contains string';
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await read('return document.body ? document.body.innerText : "";', max);
          if (res.ok && res.message.indexOf(needle) !== -1) {
            return 'PASS: page text contains ' + needle;
          }
          await sleep(Number(input.idle_ms ?? 500) + 400);
        }
        return 'FAIL: page text does not contain ' + needle + ' after waiting';
      }
      if (action === 'console_messages') {
        return browserDevtools('console', { waitMs: 60 });
      }

      // ---- storage / cookies ------------------------------------------------
      if (action === 'storage') {
        const kind = String(input.kind ?? 'local') === 'session' ? 'sessionStorage' : 'localStorage';
        const op = String(input.op ?? 'list');
        const store = kind === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
        const key = String(input.value ?? '');
        const js =
          op === 'clear' ? store + '.clear();return "cleared";' :
          op === 'set' ? store + '.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(String(input.text ?? '')) + ');return "set";' :
          op === 'delete' ? store + '.removeItem(' + JSON.stringify(key) + ');return "deleted";' :
          op === 'get' ? 'return ' + store + '.getItem(' + JSON.stringify(key) + ') || "";' :
          'return JSON.stringify(' + store + ')';
        const res = await read(js, max);
        return res.ok ? kind + ' ' + op + ': ' + res.message : 'FAIL: storage — ' + res.message;
      }
      if (action === 'cookies') {
        const res = await read('return document.cookie || "(no cookies for this origin)";', max);
        return res.ok ? 'cookies (this origin only): ' + res.message : 'FAIL: cookies — ' + res.message;
      }

      // ---- network / screenshot ---------------------------------------------
      if (action === 'network_requests') {
        const raw = await browserDevtools('network', { waitMs: 60 });
        let rows: Array<{ method: string; url: string; status: number; type?: string; size?: number; failed?: boolean }> = [];
        try { rows = JSON.parse(raw || '[]'); } catch { rows = []; }
        if (!Array.isArray(rows) || rows.length === 0) return '(no network requests captured — goto a page first)';
        return rows
          .map((n, i) =>
            (i + 1) + '. [' + (n.failed ? 'FAIL' : n.status || '…') + '] ' + n.method + ' ' + n.url +
            (n.type ? '  (' + n.type + ')' : '') + (n.size ? '  ' + Math.round(n.size) + 'B' : ''),
          )
          .join('\n');
      }
      if (action === 'screenshot') {
        return browserDevtools('screenshot');
      }

      return 'error: unknown browser_e2e action "' + action + '"';
    },
  },
];


/** Thin, self-describing tools for the high-value CDP extras — dedicated
 * names so models reliably pick them (enum actions get missed). Each
 * targets the page the browser panel currently shows. */
const BROWSER_EXTRAS: ToolSpec[] = [
  {
    id: 'browser_screenshot',
    name: 'browser_screenshot',
    description:
      'Screenshot the page on the agent’s headless automation session and save it as a PNG. Returns the file path. Run browser_e2e action "goto" first so the session shows the target page.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      try {
        const path = await browserDevtools('screenshot');
        return 'PASS: screenshot saved to: ' + path;
      } catch (error) {
        return 'FAIL: screenshot — ' + (error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    id: 'browser_pdf',
    name: 'browser_pdf',
    description:
      'Not supported in the external-browser mode — the agent’s headless session cannot print PDFs. Use browser_screenshot instead, or ask the user to print from their browser.',
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      return 'FAIL: pdf — not supported in the external-browser mode. Use browser_screenshot instead.';
    },
  },
  {
    id: 'browser_network_requests',
    name: 'browser_network_requests',
    description:
      'List the network requests (method, status, URL, type, size) captured on the agent’s headless automation session since the last goto. Recording starts at the first browser_e2e/browser_devtools call. Pass `contains` to filter by URL keyword.',
    input_schema: {
      type: 'object',
      properties: {
        contains: { type: 'string', description: 'Only show requests whose URL contains this substring' },
      },
    },
    run: async (input) => {
      try {
        const raw = await browserDevtools('network', { waitMs: 60 });
        let rows = [];
        try { rows = JSON.parse(raw || '[]'); } catch { rows = []; }
        if (!Array.isArray(rows) || rows.length === 0) return '(no network requests captured — run browser_e2e action "goto" first)';
        const filter = input.contains ? String(input.contains).toLowerCase() : '';
        return rows
          .filter(function (n) { return !filter || n.url.toLowerCase().indexOf(filter) !== -1; })
          .map(function (n, i) {
            return (i + 1) + ' [' + (n.failed ? 'FAIL' : n.status || '…') + '] ' + n.method + ' ' + n.url + (n.type ? '  (' + n.type + ' )' : '') + (n.size ? '  ' + Math.round(n.size) + 'B' : '');
          })
          .join('\n');
      } catch (error) {
        return 'FAIL: network — ' + (error instanceof Error ? error.message : String(error));
      }
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
  if (name === 'browser_panel') {
    const action = String(input.action ?? 'navigate');
    return `browser_panel ${action}${input.url ? `: ${String(input.url)}` : ''}`;
  }
  if (name === 'send_message') return 'send_message → @' + String(input.to ?? '?');
  if (name === 'browser_e2e') {
    const action = String(input.action ?? '');
    const detail = String(input.selector ?? input.url ?? input.contains ?? '');
    return `browser_e2e ${action}${detail ? `: ${detail}` : ''}`;
  }
  if (name === 'browser_screenshot') return 'browser_screenshot — live page PNG';
  if (name === 'browser_pdf') return 'browser_pdf — live page PDF';
  if (name === 'browser_network_requests') return 'browser_network_requests';
  if (name === 'read_image') return `read_image → ${String(input.path ?? '?')}`;
  if (name === 'agent_contacts') return 'agent_contacts — team directory';
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

/** Prompt + completion tokens a reply consumed (OpenAI or Anthropic usage
 * shapes) — null when the provider reported nothing. */
function usageFromParsed(parsed: Record<string, unknown> | null): number | null {
  const usage = parsed?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const total = prompt + completion;
  return total > 0 ? total : null;
}

/** Rough token estimate for messages without provider usage (~4 chars/token). */
function estimateTokens(message: ChatMessage): number {
  return Math.ceil(((message.text?.length ?? 0) + (message.context?.length ?? 0)) / 4);
}

/** Context-window % this session has consumed by the time an assistant
 * reply (at `index`) finished — the reply's own model when known, else the
 * composer's pointed model; null when no window is resolvable. */
function contextUsageAt(
  messages: ChatMessage[],
  index: number,
  fallbackWindow: number | null,
): number | null {
  const reply = messages[index];
  if (reply.role !== 'assistant') return null;
  let contextWindow: number | null = null;
  if (reply.used) contextWindow = resolveContextWindow(reply.used.split('·')[0]?.trim() ?? '');
  contextWindow = contextWindow ?? fallbackWindow;
  if (!contextWindow) return null;
  let used = 0;
  for (let i = 0; i <= index; i += 1) {
    const msg = messages[i];
    used += msg.role === 'assistant' && msg.tokens ? msg.tokens : estimateTokens(msg);
  }
  return Math.min(100, Math.max(1, Math.round((used / contextWindow) * 100)));
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

/** Floating-browser coordination: the browser's native webviews composite
 * above ALL app HTML, so while a modal overlay is open here (model picker,
 * memory/skills dialogs) the browser must hide its webviews or they paint
 * over the dialog. A module-level count spans every mounted panel instance
 * agent overlay is open (event pigry:agent-overlay). */
let openOverlays = 0;
function emitOverlayChange(open: boolean) {
  openOverlays = Math.max(0, openOverlays + (open ? 1 : -1));
  window.dispatchEvent(new CustomEvent('pigry:agent-overlay', { detail: openOverlays > 0 }));
}

/** True while any panel instance has a modal overlay open — lets late
 * mounts (e.g. the browser panel opened mid-dialog) sync immediately. */
export function agentOverlayOpen(): boolean {
  return openOverlays > 0;
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

interface MessageContextOptions {
  text: string;
  team: string;
  target: AgentEntry | null;
  repositoryPath: string;
  activeSelection: AiAgentPanelProps['selection'];
  activeHistory: AiAgentPanelProps['historySelection'];
  activeRailCommit: { oid: string; summary: string } | null;
  activeRailSelection: { text: string; source: string; path?: string } | null;
  attachedFiles: AttachedFile[];
}

/** Gather project and selection context outside React's render analysis. */
async function buildMessageContext({text, team, target, repositoryPath, activeSelection,
  activeHistory, activeRailCommit, activeRailSelection, attachedFiles}: MessageContextOptions) {
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
    // Browser rail assistant: keep "open this page" requests on the in-app
    // panel — the headless readers are invisible to the user.
    if (team === 'Browser') {
      context +=
        `\n\n[Browser tools — follow these rules exactly]\n` +
        `The app has NO embedded browser: "navigate"/"new_tab" open pages in the user’s EXTERNAL ` +
        `default browser (the user sees them there; that browser cannot be scripted).\n` +
        `RULE 1 — When the user asks to open/show/visit a URL: call browser_panel (action "navigate"). ` +
        `To open AND summarize in one step, use browser_panel action "read".\n` +
        `RULE 2 — To search Google, open https://www.google.com/search?q=<url-encoded query>.\n` +
        `RULE 3 — To interact with a page (fill/click/submit/verify), use browser_e2e — it runs on your ` +
        `headless automation session (goto first, then snapshot → click/type → asserts).\n` +
        `RULE 4 — browser_screenshot captures YOUR headless session (invisible to the user), not their browser.\n` +
        `For captured network requests use browser_network_requests. A PDF export is not supported.`;
    }
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
            const md = await getSkillContent(skill.id);
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
      await runEventHooks('before-send', repositoryPath);
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
          `[Available tools — the CURRENT set, you may reference these; ignore any other tool names that appear in earlier turns of this conversation]\n${toolsText}`,
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
    if (activeRailCommit) {
      // A commit the user opened on a workspace screen — full message + file list.
      try {
        const d = await getCommitDetail(activeRailCommit.oid);
        const files = d.files
          .map((f) => `${f.path} (${f.status} +${f.additions} -${f.deletions})`)
          .join('\n');
        context += `\n\n[Commit — ${d.shortOid} by ${d.authorName}, ${new Date(d.timeSeconds * 1000).toLocaleString()}]\n${d.message}${files ? `\nFiles:\n${files}` : ''}`;
      } catch {
        context += `\n\n[Commit — ${activeRailCommit.oid.slice(0, 7)}] ${activeRailCommit.summary}`;
      }
    }
    if (activeRailSelection) {
      // Code the user highlighted in a workspace screen's diff/list.
      context += `\n\n[Selected code — ${activeRailSelection.path ?? activeRailSelection.source}]\n${activeRailSelection.text.slice(0, 8000)}`;
    }
    for (const attached of attachedFiles) {
      context += `\n\n[Attached file: ${attached.path}]\n${attached.content.slice(0, 12000)}`;
    }

    return context;
}

interface AgentTurnContext {
 allProviders: AiProviderEntry[];
 active: AiProviderEntry | null;
 ownerName: string; agentUsername: string; team: string;
 repository: ReturnType<typeof useRepository>['repository'];
 setSending: React.Dispatch<React.SetStateAction<boolean>>;
 setActivity: React.Dispatch<React.SetStateAction<ActivityState | null>>;
 setReplyingAs: React.Dispatch<React.SetStateAction<string>>;
 setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
 messageDepthRef: React.RefObject<number>;
 dmBubblesRef: React.RefObject<ChatMessage[]>;
}

function createAgentTurnRunner({allProviders, active, ownerName, agentUsername, team, repository, setSending, setActivity, setReplyingAs, setMessages, messageDepthRef, dmBubblesRef}: AgentTurnContext) {
  const doSend = async (
    history: ChatMessage[],
    target?: AgentEntry | null,
    chainLeft = 3,
  ): Promise<ChatMessage[]> => {
    setSending(true);
    setActivity({ kind: 'thinking', label: '' });
    try {
      return await runTurn(history, target ?? null, chainLeft);
    } finally {
      setSending(false);
      setActivity(null);
      setReplyingAs('');
      // after-reply hooks (Hooks tab) run once the reply lands or fails.
      try {
        await runEventHooks('after-reply', repository?.localPath ?? '.');
      } catch {
        // never block the UI on a hook
      }
    }
  };

  /** PARALLEL FAN-OUT — runs each tagged agent's turn in its own isolated
   * provider call (the backend spawns one curl process per call, so agents
   * genuinely work simultaneously on separate CPU processes). Each turn is
   * self-contained: no shared mutable state, no progressive streaming; the
   * finished reply lands as its own bubble the moment it completes. */
  /** One-hop agent-to-agent messaging — agent A asks agent B a question
   * and receives the reply of agent B inside its own turn. Depth-limited to one hop
   * so conversations can never loop. */
  /** DM replies collected during the current turn — shown as bubbles and
   * spliced into the turn's history so later writes keep them. */
  const askAgent = async (
    fromUsername: string,
    toUsername: string,
    message: string,
    images?: Array<{ dataUrl: string }>,
  ): Promise<string> => {
    const to = allAgents().find(
      (agent) => agent.enabled && agent.username === toUsername,
    );
    if (!to) return 'error: no agent @' + toUsername;
    if (to.username === fromUsername) return 'error: you cannot message yourself';
    if (messageDepthRef.current >= 3) {
      return 'error: message depth limit (3) reached — stop forwarding and reply directly';
    }
    messageDepthRef.current += 1;
    try {
      const reply = await runIsolatedTurn(
        [
          {
            role: 'user',
            text: '[Direct message from @' + fromUsername + ']' + '\n\n' + message,
            time: Date.now(),
            owner: fromUsername,
            images: (images ?? []).map(function (image) { return image.dataUrl; }),
          },
        ],
        to,
      );
      return reply.text || '(empty reply)';
    } finally {
      messageDepthRef.current -= 1;
    }
  };

  /** Records one group-chat exchange into the MENTIONED agent's own
   * session — so agent B remembers conversations it joined, even though
   * the group transcript lives in the panel owner's session. */
  const appendToAgentSession = async (
    username: string,
    userText: string,
    replyText: string,
    teamName: string,
  ): Promise<void> => {
    const scope = { agent: username };
    const sessions = await listSessions(scope);
    let session = sessions.find((s) => s.id === activeSessionId(scope)) ?? sessions[0];
    if (!session) {
      session = { id: 'chat-' + Date.now().toString(36), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [], team: teamName, agentUsername: username };
    }
    const userMsg: AiChatMessage = { role: 'user', text: '[group chat] ' + userText, time: Date.now(), owner: username };
    const replyMsg: AiChatMessage = { role: 'assistant', text: replyText, time: Date.now(), agent: username, owner: username };
    session.messages = [...session.messages, userMsg, replyMsg].slice(-100);
    session.updatedAt = Date.now();
    if (!session.titleCustom && !session.title) session.title = titleFromMessages(session.messages);
    await saveSession(session);
    setActiveSessionId(session.id, scope);
  };

  const doSendParallel = async (
    history: ChatMessage[],
    targets: AgentEntry[],
  ): Promise<void> => {
    setSending(true);
    setReplyingAs(targets.map((t) => '@' + t.username).join(' + '));
    setActivity({ kind: 'thinking', label: '' });
    const replies = new Map<string, ChatMessage>();
    try {
      const settled = await Promise.allSettled(
        targets.map((target) => runIsolatedTurn(history, target)),
      );
      // Land replies in the original mention order (not completion order).
      for (let i = 0; i < targets.length; i++) {
        const outcome = settled[i];
        const target = targets[i];
        if (outcome.status === 'fulfilled') {
          replies.set(target.username, outcome.value);
        } else {
          const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          replies.set(target.username, {
            role: 'assistant',
            text: message,
            time: now(),
            agent: target.username,
            owner: ownerName,
            error: true,
          });
        }
      }
      // Append every reply atomically per agent.
      setMessages((current) => {
        let updated = current;
        for (const target of targets) {
          const reply = replies.get(target.username);
          if (reply) updated = [...updated, reply];
        }
        return updated;
      });
      // Record each mentioned agent's exchange into ITS OWN session — the
      // agent remembers the group conversation in its own thread later.
      const lastUserText = String(history[history.length - 1]?.text ?? '');
      for (const target of targets) {
        const reply = replies.get(target.username);
        if (!reply) continue;
        void appendToAgentSession(
          target.username,
          lastUserText,
          reply.text ?? '',
          target.team ?? team,
        ).catch(() => {});
      }
      // after-reply hooks run once for the whole parallel batch.
      try {
        await runEventHooks('after-reply', repository?.localPath ?? '.');
      } catch {
        // never block the UI on a hook
      }
    } finally {
      setSending(false);
      setActivity(null);
      setReplyingAs('');
    }
  };

  /** One self-contained agent turn for the parallel fan-out: same payload,
   * tool allowlist and agentic loop as runTurn, but it never touches the
   * shared message list mid-run — the finished reply is returned instead. */
  const runIsolatedTurn = async (
    history: ChatMessage[],
    target: AgentEntry,
  ): Promise<ChatMessage> => {
    if (!active) throw new Error('No AI provider configured');
    const last = history[history.length - 1];
    const provider = (() => {
      if (target.model) {
        // Pinned model — on the agent's provider when set, else the chat's.
        const found = target.providerId
          ? allProviders.find((p) => p.id === target.providerId)
          : null;
        if (found) return { ...found, model: target.model };
        return { ...active, model: target.model };
      }
      // No model assigned — follow the chat selection entirely.
      return active;
    })();
    const baseSpec = modelSpecOf(provider);
    // The agent's own effort selection wins over the model entry's.
    const spec = baseSpec ? { ...baseSpec, effort: target.effort || baseSpec.effort } : null;
    setImageGate(spec);
    // What this turn actually used — shown on the reply bubble.
    const usedLabel = provider.model
      ? `${provider.model}${spec?.effort ? ' · ' + spec.effort : ''}`
      : '';
    const repliedAs = target.username;
    if (isCliProvider(provider)) {
      // The provider type IS the CLI binary (claude-code → claude,
      // zcode-cli → zcode).
      const cli =
        provider.type === 'claude-code'
          ? 'claude'
          : provider.type === 'zcode-cli'
            ? 'zcode'
            : provider.type;
      const output = await cliAgentRun(cli, last.text, provider.model || undefined);
      return {
        role: 'assistant',
        text: output || '(no output)',
        time: now(),
        agent: repliedAs,
        owner: ownerName,
        ...(usedLabel ? { used: usedLabel } : {}),
      };
    }
    const isAnthropic = provider.apiFormat === 'anthropic';
    const rawEndpoint = resolveEndpoint(provider);
    const endpoint = isAnthropic ? anthropicEndpoint(rawEndpoint) : rawEndpoint;
    const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mediaTypeOf = (dataUrl: string) =>
      dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
    let skillContext = '';
    try {
      for (const skillId of target.skills ?? []) {
        const content = await getSkillContent(skillId);
        skillContext += '\n\n[Skill: ' + skillId + ']\n' + content.slice(0, 2000);
      }
    } catch {
      // skill content unavailable
    }
    const profile = '\n\n[Your agent profile]\n' + agentProfileText(target) + skillContext;
    const toolNudge =
      '\n\n[Tool use]\nYou have file tools for this repository. When asked to create or change files, actually call write_file — do not only print code. Changes land in the working tree and are visible to git.';
    const fullText = last.text + (last.context ?? '') + profile + skillContext + toolNudge;
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
    // Every agent can always write ITS OWN memory — the note lands in the
    // agent's private vector store (the team store backs unscoped turns).
    const memoryTool: ToolSpec = {
      id: 'agent-memory',
      name: 'memory_save',
      description:
        'Save a durable note to YOUR OWN private memory (per-agent vector store, searched automatically at the start of every future turn). Use for facts, decisions, user preferences, progress and how-to notes you must remember later. One concise self-contained note per call — write it so it still makes sense weeks from now.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note to remember — self-contained, mentions the project/subject so it stays findable' },
        },
        required: ['text'],
      },
      run: async (input) => {
        const note = String(input.text ?? '').trim();
        if (!note) return 'error: memory_save needs a text';
        const agentUsername = target && target.username ? target.username : undefined;
        await memoryAdd(note, team, agentUsername);
        return 'saved to your memory (' + team + (agentUsername ? ' / ' + agentUsername : '') + ')';
      },
    };
    /** Direct agent-to-agent messaging — one hop, depth-limited. */
    const agentMessageTool: ToolSpec = {
      id: 'agent-message',
      name: 'send_message',
      description:
        'Send a direct message to another agent in this workspace and receive its reply inside your turn. Use agent_contacts / agent_lookup to find the right @username first. Chains up to 3 agents deep (A asks B, B may ask C); deeper forwards are refused. The receiving agent does not see this conversation. Optionally attach workspace images (paths) for the receiving agent. Do NOT message yourself.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The @username (without the @) of the receiving agent' },
          message: { type: 'string', description: 'The message or question for that agent — self-contained' },
          images: { type: 'string', description: 'Optional: comma-separated workspace image paths (png/jpg/gif/webp) to attach for the receiving agent' },
        },
        required: ['to', 'message'],
      },
            run: async (input) => {
        const to = String(input.to ?? '').replace(/^@/, '').trim();
        const message = String(input.message ?? '').trim();
        if (!to || !message) return 'error: send_message needs to + message';
        const imagePaths = String(input.images ?? '').split(',').map(function (p) { return p.trim(); }).filter(Boolean).slice(0, 4);
        const images: Array<{ dataUrl: string }> = [];
        for (const imagePath of imagePaths) {
          try {
            const img = await readBinaryFile(imagePath);
            if (!img.mime.startsWith('image/')) throw new Error(imagePath + ' is not an image');
            images.push({ dataUrl: 'data:' + img.mime + ';base64,' + img.data });
          } catch (error) {
            return 'error: could not load image ' + imagePath + ': ' + (error instanceof Error ? error.message : String(error));
          }
        }
        const reply = await askAgent(target.username, to, message, images);
        const bubble: ChatMessage = {
          role: 'assistant',
          text: reply,
          time: Date.now(),
          agent: to,
          owner: target ? 'self' : 'self',
        };
        dmBubblesRef.current = [...dmBubblesRef.current, bubble];
        setMessages((current) => [...current, bubble]);
        return 'reply from @' + to + ':\n' + reply;
      },
    };
    /** Recall / manage YOUR OWN private memory (agent-scoped vector store). */
    const memoryRecallTool: ToolSpec = {
      id: 'agent-memory-recall',
      name: 'memory_recall',
      description:
        'Search YOUR OWN private memory (per-agent vector store — notes you saved with memory_save plus anything noted for you). Returns matching notes with their ids. Use to recall what you previously noted about a topic, or before memory_forget.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for — semantic search over your notes' },
          limit: { type: 'number', description: 'Max notes to return (default 10)' },
        },
        required: ['query'],
      },
      run: async (input) => {
        const query = String(input.query ?? '').trim();
        if (!query) return 'error: memory_recall needs a query';
        const hits = await memorySearch(query, Number.isFinite(Number(input.limit)) ? Number(input.limit) : 10, team, target.username);
        if (hits.length === 0) return '(no matching notes in your memory)';
        return hits.map(function (h) { return h.id + " — " + h.text; }).join("\n");
      },
    };
    const memoryForgetTool: ToolSpec = {
      id: 'agent-memory-forget',
      name: 'memory_forget',
      description:
        'Delete notes from YOUR OWN private memory. Pass an id from memory_recall, or a query — every note matching the query is removed. Deletion is permanent.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact note id (from memory_recall) to remove' },
          query: { type: 'string', description: 'Alternative: remove every note matching this query' },
        },
      },
      run: async (input) => {
        const id = String(input.id ?? '').trim();
        const query = String(input.query ?? '').trim();
        if (!id && !query) return 'error: memory_forget needs an id or a query';
        if (id) { await memoryRemove(id, team, target.username); return 'forgot note ' + id; }
        const hits = await memorySearch(query, 20, team, target.username);
        if (hits.length === 0) return '(no matching notes to forget)';
        for (let hi = 0; hi < hits.length; hi++) { await memoryRemove(hits[hi].id, team, target.username); }
        return 'forgot ' + hits.length + ' note(s) matching ' + query;
      },
    };
    const agentAllowed = target.tools ?? [];
    const tools = [...FILE_TOOLS, READ_IMAGE_TOOL, ...DOC_TOOLS, ...WEB_TOOLS, ...DEVTOOLS_TOOLS, ...E2E_TOOLS, ...BROWSER_EXTRAS, AGENT_CONTACTS_TOOL, AGENT_LOOKUP_TOOL, memoryTool, memoryRecallTool, memoryForgetTool, agentMessageTool].filter(
      (tool) => {
        if (agentAllowed.length > 0 && !agentAllowed.includes(tool.id)) return false;
        // The Browser team assistant must show pages through the in-app
        // panel only — hard-drop the headless/external openers here so
        // stale overrides can never hand them back to the model.
        if (target.team === 'Browser' && (tool.id === 'playwright' || tool.id === 'browser')) return false;
        return true;
      },
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

    let assistantText = '';
    let replyError = false;
    const toolEvents: string[] = [];
    /** Last turn's provider-reported token usage (context % badge). */
    let turnTokens: number | null = null;
    // Conversation continuity: replay the prior turns (text only, last 20)
    // ahead of the current one so the model keeps context across sends —
    // without this every reply would be a fresh single-turn conversation.
    const priorTurns = history.slice(0, -1).slice(-20);
    const apiMessages: Array<Record<string, unknown>> = [
      ...priorTurns.map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: String(m.text ?? ''),
      })),
      { role: 'user', content },
    ];
    for (let iter = 0; iter < 8; iter++) {
      setActivity({ kind: 'thinking', label: '' });
      const payload = isAnthropic
        ? { model: provider.model || 'claude-sonnet', max_tokens: maxTokensFor(spec), tools: anthropicTools, messages: apiMessages, ...effortFor(spec) }
        : { model: provider.model || 'glm-4.6', tools: openaiTools, messages: apiMessages, ...(spec?.maxOutputTokens ? { max_tokens: spec.maxOutputTokens } : {}), ...effortFor(spec), stream: false };
      const result = await aiChat(endpoint, provider.apiKey, JSON.stringify(payload), isAnthropic ? 'anthropic' : 'bearer');
      const parsed = safeParse(result.body);
      turnTokens = usageFromParsed(parsed);
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
          setActivity(activityForTool(String(call.name)));
          const output = await runToolCall(tool, String(call.name), input);
          toolEvents.push(toolLabel(String(call.name), input, output));
          results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
        }
        apiMessages.push({ role: 'user', content: results });
        if (imageGate && pendingImages.length > 0) {
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
          setActivity(activityForTool(name));
          const output = await runToolCall(tool, name, input);
          toolEvents.push(toolLabel(name, input, output));
          apiMessages.push({ role: 'tool', tool_call_id: call.id ?? name, content: output });
          if (imageGate && pendingImages.length > 0) {
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
    return {
      role: 'assistant',
      text: assistantText,
      time: now(),
      agent: repliedAs,
      owner: ownerName,
      ...(usedLabel ? { used: usedLabel } : {}),
      ...(turnTokens ? { tokens: turnTokens } : {}),
      ...(replyError ? { error: true } : {}),
      ...(toolEvents.length > 0 ? { toolEvents } : {}),
    };
  };

  const runTurn = async (
    history: ChatMessage[],
    target: AgentEntry | null,
    chainLeft: number,
  ): Promise<ChatMessage[]> => {
    if (!active) throw new Error('No AI provider configured');
    const last = history[history.length - 1];
    // A tagged agent chats through its own provider/model when configured;
    // otherwise the globally active provider answers.
    const provider = (() => {
      if (target?.model) {
        // Pinned model — on the agent's provider when set, else the chat's.
        const found = target.providerId
          ? allProviders.find((p) => p.id === target.providerId)
          : null;
        if (found) return { ...found, model: target.model };
        return { ...active, model: target.model };
      }
      // No model assigned — follow the chat selection entirely.
      return active;
    })();
    const baseSpec = modelSpecOf(provider);
    // A tagged agent's own effort selection wins over the model entry's.
    const spec = baseSpec ? { ...baseSpec, effort: target?.effort || baseSpec.effort } : null;
    setImageGate(spec);
    // What this turn actually used — shown on the reply bubble.
    const usedLabel = provider.model
      ? `${provider.model}${spec?.effort ? ' · ' + spec.effort : ''}`
      : '';
    const repliedAs = target?.username ?? agentUsername;
    setReplyingAs(repliedAs);

    if (isCliProvider(provider)) {
      // The provider type IS the CLI binary (claude-code → claude,
      // zcode-cli → zcode).
      const cli =
        provider.type === 'claude-code'
          ? 'claude'
          : provider.type === 'zcode-cli'
            ? 'zcode'
            : provider.type;
      // DM bubbles collected during send_message calls — keep them visible
      // across every later setMessages(working) write.
      if (dmBubblesRef.current.length > 0) {
        history = [...history, ...dmBubblesRef.current];
        dmBubblesRef.current = [];
      }
      let working = history;
      try {
        const output = await cliAgentRun(cli, last.text, provider.model || undefined);
        working = [...history, { role: 'assistant', text: output || '(no output)', time: now(), agent: repliedAs, owner: ownerName, ...(usedLabel ? { used: usedLabel } : {}) }];
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
    // The answering agent's assigned skills ride along as full instructions.
    let skillContext = '';
    try {
      for (const skillId of target?.skills ?? []) {
        const content = await getSkillContent(skillId);
        skillContext += `\n\n[Skill: ${skillId}]\n${content.slice(0, 2000)}`;
      }
    } catch {
      // skill content unavailable
    }
    const toolNudge =
      '\n\n[Tool use]\nYou have file tools for this repository. When asked to create or change files, actually call write_file — do not only print code. Changes land in the working tree and are visible to git.';
    const fullText = last.text + (last.context ?? '') + profile + skillContext + toolNudge;
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
    // Every agent can always write ITS OWN memory — the note lands in the
    // agent's private vector store (the team store backs unscoped turns).
    const memoryTool: ToolSpec = {
      id: 'agent-memory',
      name: 'memory_save',
      description:
        'Save a durable note to YOUR OWN private memory (per-agent vector store, searched automatically at the start of every future turn). Use for facts, decisions, user preferences, progress and how-to notes you must remember later. One concise self-contained note per call — write it so it still makes sense weeks from now.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note to remember — self-contained, mentions the project/subject so it stays findable' },
        },
        required: ['text'],
      },
      run: async (input) => {
        const note = String(input.text ?? '').trim();
        if (!note) return 'error: memory_save needs a text';
        const agentUsername = target && target.username ? target.username : undefined;
        await memoryAdd(note, team, agentUsername);
        return 'saved to your memory (' + team + (agentUsername ? ' / ' + agentUsername : '') + ')';
      },
    };
    /** Direct agent-to-agent messaging — one hop, depth-limited. */
    const agentMessageTool: ToolSpec = {
      id: 'agent-message',
      name: 'send_message',
      description:
        'Send a direct message to another agent in this workspace and receive its reply inside your turn. Use agent_contacts / agent_lookup to find the right @username first. Chains up to 3 agents deep (A asks B, B may ask C); deeper forwards are refused. The receiving agent does not see this conversation. Optionally attach workspace images (paths) for the receiving agent. Do NOT message yourself.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The @username (without the @) of the receiving agent' },
          message: { type: 'string', description: 'The message or question for that agent — self-contained' },
          images: { type: 'string', description: 'Optional: comma-separated workspace image paths (png/jpg/gif/webp) to attach for the receiving agent' },
        },
        required: ['to', 'message'],
      },
      run: async (input) => {
        const to = String(input.to ?? '').replace(/^@/, '').trim();
        const message = String(input.message ?? '').trim();
        if (!to || !message) return 'error: send_message needs to + message';
        return askAgent(target?.username || 'ai-agent', to, message);
      },
    };
    /** Recall / manage YOUR OWN private memory (agent-scoped vector store). */
    const memoryRecallTool: ToolSpec = {
      id: 'agent-memory-recall',
      name: 'memory_recall',
      description:
        'Search YOUR OWN private memory (per-agent vector store — notes you saved with memory_save plus anything noted for you). Returns matching notes with their ids. Use to recall what you previously noted about a topic, or before memory_forget.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for — semantic search over your notes' },
          limit: { type: 'number', description: 'Max notes to return (default 10)' },
        },
        required: ['query'],
      },
      run: async (input) => {
        const query = String(input.query ?? '').trim();
        if (!query) return 'error: memory_recall needs a query';
        const hits = await memorySearch(query, Number.isFinite(Number(input.limit)) ? Number(input.limit) : 10, team, target?.username);
        if (hits.length === 0) return '(no matching notes in your memory)';
        return hits.map(function (h) { return h.id + " — " + h.text; }).join("\n");
      },
    };
    const memoryForgetTool: ToolSpec = {
      id: 'agent-memory-forget',
      name: 'memory_forget',
      description:
        'Delete notes from YOUR OWN private memory. Pass an id from memory_recall, or a query — every note matching the query is removed. Deletion is permanent.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact note id (from memory_recall) to remove' },
          query: { type: 'string', description: 'Alternative: remove every note matching this query' },
        },
      },
      run: async (input) => {
        const id = String(input.id ?? '').trim();
        const query = String(input.query ?? '').trim();
        if (!id && !query) return 'error: memory_forget needs an id or a query';
        if (id) { await memoryRemove(id, team, target?.username); return 'forgot note ' + id; }
        const hits = await memorySearch(query, 20, team, target?.username);
        if (hits.length === 0) return '(no matching notes to forget)';
        for (let hi = 0; hi < hits.length; hi++) { await memoryRemove(hits[hi].id, team, target?.username); }
        return 'forgot ' + hits.length + ' note(s) matching ' + query;
      },
    };
    const agentAllowed = target?.tools ?? [];
    const tools = [...FILE_TOOLS, READ_IMAGE_TOOL, ...DOC_TOOLS, ...WEB_TOOLS, ...DEVTOOLS_TOOLS, ...E2E_TOOLS, ...BROWSER_EXTRAS, AGENT_CONTACTS_TOOL, AGENT_LOOKUP_TOOL, memoryTool, memoryRecallTool, memoryForgetTool, agentMessageTool].filter(
      (tool) => {
        if (agentAllowed.length > 0 && !agentAllowed.includes(tool.id)) return false;
        // The Browser team assistant must show pages through the in-app
        // panel only — hard-drop the headless/external openers here so
        // stale overrides can never hand them back to the model.
        if (target?.team === 'Browser' && (tool.id === 'playwright' || tool.id === 'browser')) return false;
        return true;
      },
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
    /** Last turn's provider-reported token usage (context % badge). */
    let turnTokens: number | null = null;
    pendingImages.length = 0;
    try {
      if (tools.length === 0) {
        // No tools allowed — plain single-shot reply (legacy path).
        const payload = isAnthropic
          ? { model: provider.model || 'claude-sonnet', max_tokens: maxTokensFor(spec), messages: [{ role: 'user', content }], ...effortFor(spec) }
        : { model: provider.model || 'glm-4.6', messages: [{ role: 'user', content }], ...(spec?.maxOutputTokens ? { max_tokens: spec.maxOutputTokens } : {}), ...effortFor(spec), stream: false };
        const result = await aiChat(endpoint, provider.apiKey, JSON.stringify(payload), isAnthropic ? 'anthropic' : 'bearer');
        const parsed = safeParse(result.body);
        turnTokens = usageFromParsed(parsed);
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
        working = [...history, { role: 'assistant', text: assistantText, time: now(), agent: repliedAs, owner: ownerName, ...(usedLabel ? { used: usedLabel } : {}), ...(turnTokens ? { tokens: turnTokens } : {}), ...(replyError ? { error: true } : {}) }];
        setMessages(working);
      } else {
        // Agentic loop: the model may call file tools; results feed back
        // until it produces a final text reply (max 8 tool rounds).
        const apiMessages: Array<Record<string, unknown>> = [{ role: 'user', content }];
        for (let iter = 0; iter < 8; iter++) {
          setActivity({ kind: 'thinking', label: '' });
          const payload = isAnthropic
            ? { model: provider.model || 'claude-sonnet', max_tokens: maxTokensFor(spec), tools: anthropicTools, messages: apiMessages, ...effortFor(spec) }
            : { model: provider.model || 'glm-4.6', tools: openaiTools, messages: apiMessages, ...(spec?.maxOutputTokens ? { max_tokens: spec.maxOutputTokens } : {}), ...effortFor(spec), stream: false };
          const result = await aiChat(endpoint, provider.apiKey, JSON.stringify(payload), isAnthropic ? 'anthropic' : 'bearer');
          const parsed = safeParse(result.body);
          turnTokens = usageFromParsed(parsed);
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
              setActivity(activityForTool(String(call.name)));
          const output = await runToolCall(tool, String(call.name), input);
              toolEvents.push(toolLabel(String(call.name), input, output));
              results.push({ type: 'tool_result', tool_use_id: call.id, content: output });
            }
            apiMessages.push({ role: 'user', content: results });
            if (imageGate && pendingImages.length > 0) {
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
              setActivity(activityForTool(name));
          const output = await runToolCall(tool, name, input);
              toolEvents.push(toolLabel(name, input, output));
              apiMessages.push({ role: 'tool', tool_call_id: call.id ?? name, content: output });
              if (imageGate && pendingImages.length > 0) {
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
            ...(usedLabel ? { used: usedLabel } : {}),
            ...(turnTokens ? { tokens: turnTokens } : {}),
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


 return { doSend, doSendParallel, runIsolatedTurn };
}

async function summarizeAgentMemory(
 history: ChatMessage[], scopeAgent: string, team: string,
 runIsolatedTurn: ReturnType<typeof createAgentTurnRunner>['runIsolatedTurn'],
 notify: ReturnType<typeof useRepository>['notify'],
) {
    if (history.length < 4) return;
    const target = allAgents().find(
      (agent) => agent.enabled && agent.username === scopeAgent,
    );
    if (!target) return;
    const transcript = history
      .slice(-30)
      .map((m) =>
        (m.role === 'assistant' ? '@' + (m.agent ?? target.username) + ': ' : 'user: ') +
        String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
      )
      .join('\n');
    const instruction: ChatMessage = {
      role: 'user',
      text:
        '[session-end task] The conversation below is ending. Extract the durable facts, decisions, user preferences and progress as 1-3 short memory notes. One note per line, each self-contained. Return ONLY the note lines — no numbering, no commentary.\n\n--- CONVERSATION ---\n' +
        transcript,
      time: Date.now(),
      owner: 'system',
    };
    try {
      const reply = await runIsolatedTurn([instruction], target);
      const notes = (reply.text || '')
        .split('\n')
        .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
        .filter((l) => l.length > 10)
        .slice(0, 5);
      for (const note of notes) {
        await memoryAdd(note, team, target.username);
      }
      if (notes.length > 0) {
        notify('Session summarized — ' + notes.length + ' note(s) saved to @' + target.username + ' memory', 'success');
      }
    } catch {
      // provider unavailable — silently skip
    }
  }

export function AiAgentPanel({ fileName, width, onCollapse, selection, defaultTeam, onOpenFile, historySelection }: AiAgentPanelProps) {
  const { repository, notify } = useRepository();
  // Chats and memories live under this team's .pigry/teams/<team>/ store.
  const team = defaultTeam ?? 'Copilot';
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

  // Commit shared from a workspace screen (Commit graph / Branches / Cherry
  // Pick / Rebase Branch / Push Commits / Merge preview) — attachable chip.
  const [railCommit, setRailCommit] = useState<{ oid: string; summary: string } | null>(null);
  const [dismissedRailCommit, setDismissedRailCommit] = useState('');
  const [prevRailCommitOid, setPrevRailCommitOid] = useState('');
  if (prevRailCommitOid !== (railCommit?.oid ?? '')) {
    setPrevRailCommitOid(railCommit?.oid ?? '');
    setDismissedRailCommit('');
  }
  const activeRailCommit =
    railCommit && railCommit.oid !== dismissedRailCommit ? railCommit : null;

  // Code highlighted (คลุมดำ) anywhere in the workspace — either captured
  // from the DOM selection or reported by a Monaco diff editor via the
  // bridge; `source` names the workspace menu, `path` the file when known.
  const [railSelection, setRailSelection] = useState<{
    text: string;
    source: string;
    path?: string;
  } | null>(null);
  const railSelKey = railSelection?.text ?? '';
  const [dismissedRailSel, setDismissedRailSel] = useState('');
  const [prevRailSelKey, setPrevRailSelKey] = useState(railSelKey);
  if (prevRailSelKey !== railSelKey) {
    setPrevRailSelKey(railSelKey);
    setDismissedRailSel('');
  }
  const activeRailSelection =
    railSelection && railSelKey !== dismissedRailSel ? railSelection : null;

  // Context is scoped to the menu's own chat (each menu has a separate
  // conversation) — switching menus drops the shared commit/selection so one
  // menu's context never rides into another menu's chat.
  const [prevTeamScope, setPrevTeamScope] = useState(team);
  if (prevTeamScope !== team) {
    setPrevTeamScope(team);
    setRailCommit(null);
    setRailSelection(null);
  }

  // Workspace → chat bridge: screens announce the commit the user opened.
  useEffect(() => {
    const onShareCommit = (event: Event) => {
      const detail = (event as CustomEvent<{ oid?: string; summary?: string }>).detail;
      if (!detail?.oid) return;
      setRailCommit({ oid: detail.oid, summary: detail.summary ?? '' });
    };
    window.addEventListener('pigry:chat-commit', onShareCommit);
    return () => window.removeEventListener('pigry:chat-commit', onShareCommit);
  }, []);

  // Monaco diff editors announce their selections through the bridge
  // (Monaco doesn't fire DOM selection events).
  useEffect(() => {
    const onShareSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; path?: string; source?: string }>)
        .detail;
      const text = detail?.text ?? '';
      if (!text.trim()) return;
      setRailSelection({ text: text.slice(0, 8000), source: detail?.source ?? team, path: detail?.path });
    };
    window.addEventListener('pigry:chat-selection', onShareSelection);
    return () => window.removeEventListener('pigry:chat-selection', onShareSelection);
  }, [team]);

  // Capture highlighted text anywhere in the app (debounced) — except inside
  // this panel (chat text isn't context) and inside Monaco editors (they
  // report through the bridge above, their DOM selection is not visible).
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let timer = 0;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString() ?? '';
        if (!sel || sel.isCollapsed || text.trim().length === 0) return;
        const node = sel.anchorNode;
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        if (el && panelRef.current?.contains(el)) return;
        if (el?.closest?.('.monaco-editor')) return;
        setRailSelection({ text: text.slice(0, 8000), source: team });
      }, 350);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.clearTimeout(timer);
    };
  }, [team]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  /** Username of the agent currently generating a reply (typing indicator). */
  const [replyingAs, setReplyingAs] = useState('');
  /** Live phase of the replying agent — drives the activity animation. */
  const [activity, setActivity] = useState<ActivityState | null>(null);
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
  // Tier 1: the hard-coded default agent of this menu's team — answers
  // every turn that carries no @mention, with its own private memory.
  const defaultAgent = builtinAgents().find(
    (agent) => agent.enabled && agent.tier === 'default' && agent.team === team,
  );
  /** The agent identity this menu's chat belongs to: its own default agent
   * (not shared with other menus' agents), falling back to the first
   * enabled agent when the team has no default-tier one. */
  const scopeAgent = defaultAgent?.username ?? agentUsername;
  // Sessions are scoped by that agent — the same default agent continues one
  // conversation across menus; a different menu agent gets its own thread.
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
    [team],
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
  const [sessionId, setSessionId] = useState(() => activeSessionId({ agent: scopeAgent }));
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /** Context-usage dropdown beside the model pill (click the ctx ring). */
  const [ctxDropOpen, setCtxDropOpen] = useState(false);
  const ctxDropRef = useRef<HTMLDivElement | null>(null);
  const [sessionList, setSessionList] = useState<AiChatSession[]>([]);
  const sessionsRef = useRef<HTMLDivElement | null>(null);
  /** Creation time of the current session (preserved across saves). */
  const createdAtRef = useRef(now());

  // One-shot restore: active session, else the newest, else a fresh id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await migrateLocalSessions();
      const sessions = await listSessions({ agent: scopeAgent });
      if (cancelled) return;
      let id = activeSessionId({ agent: scopeAgent });
      let restored: AiChatSession | undefined = sessions.find((s) => s.id === id);
      if (!restored && sessions.length > 0) {
        restored = sessions[0];
        id = restored.id;
        setActiveSessionId(id, { agent: scopeAgent });
      }
      if (!id) {
        id = `chat-${now().toString(36)}`;
        setActiveSessionId(id, { agent: scopeAgent });
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
        // Tagged with the scope agent so the agent-scoped session list
        // (the same identity on every menu this agent serves) finds it.
        agentUsername: scopeAgent,
        owner: ownerName,
      });
      if (!cancelled) setSessionList(await listSessions({ agent: scopeAgent }));
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, sessionId, groupTitle, team, scopeAgent, ownerName]);

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

  // Outside click / Escape closes the context-usage dropdown.
  useEffect(() => {
    if (!ctxDropOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (ctxDropRef.current?.contains(event.target as Node)) return;
      setCtxDropOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCtxDropOpen(false);
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxDropOpen]);

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
  /** Rolling auto-summarize — every 15 messages since the last summary,
   * the recent slice is distilled into the agent's own memory. Closing the
   * app mid-session therefore loses at most those 15 messages of progress.
   * The New-chat button summarizes everything remaining as well. */
  const summarizedUpToRef = useRef(0);

  /** Auto-summarizes the ending session into the session owner's memory —
   * progress survives even when the agent never called memory_save itself.
   * Fire-and-forget: never blocks the new chat from starting. */
  const summarizeSessionToMemory = (history: ChatMessage[]) =>
    summarizeAgentMemory(history, scopeAgent, team, runIsolatedTurn, notify);
  const startNewChat = () => {
    // Auto-summarize the ending session into the agent's own memory.
    void summarizeSessionToMemory(messages);
    const id = `chat-${now().toString(36)}`;
    setActiveSessionId(id, { agent: scopeAgent });
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
    setActiveSessionId(session.id, { agent: scopeAgent });
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
      setSessionList(await listSessions({ agent: scopeAgent }));
      if (session.id === sessionId) setGroupTitle({ name: title, custom: true });
    } catch (error) {
      notify(`Could not rename group: ${String(error)}`, 'error');
    }
    setRenamingId(null);
  };

  const removeSession = async (id: string) => {
    await deleteSessionFile(id);
    const kept = await listSessions({ agent: scopeAgent });
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

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    // @mentions direct the turn: one mention (or none — the menu's default
    // agent) answers sequentially; TWO OR MORE mentions fan out in PARALLEL
    // — every tagged agent runs its own turn in its own provider process
    // simultaneously, and the replies land as separate bubbles.
    const mentioned = mentionedAgents(
      text,
      allAgents().filter((agent) => agent.enabled && agent.username),
    );
    const target = mentioned[0] ?? defaultAgent ?? null;
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

    const context = await buildMessageContext({
      text, team, target, repositoryPath: repository?.localPath ?? '.',
      activeSelection, activeHistory, activeRailCommit, activeRailSelection, attachedFiles,
    });

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
    // ANY @mention routes through the parallel path — each mentioned agent
    // gets the exchange recorded in ITS OWN session (single @mention works
    // the same way, targets.length === 1).
    if (mentioned.length >= 1) {
      await doSendParallel(history, mentioned);
      return;
    }
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
  const messageDepthRef = useRef(0);
  const dmBubblesRef = useRef<ChatMessage[]>([]);
  const turnRunner = () => createAgentTurnRunner({allProviders, active, ownerName, agentUsername, team, repository, setSending, setActivity, setReplyingAs, setMessages, messageDepthRef, dmBubblesRef});
  const doSend: ReturnType<typeof createAgentTurnRunner>['doSend'] = (...args) => turnRunner().doSend(...args);
  const doSendParallel: ReturnType<typeof createAgentTurnRunner>['doSendParallel'] = (...args) => turnRunner().doSendParallel(...args);
  const runIsolatedTurn: ReturnType<typeof createAgentTurnRunner>['runIsolatedTurn'] = (...args) => turnRunner().runIsolatedTurn(...args);

  const summarizeRecentMessages = useEffectEvent((history: ChatMessage[]) => {
    void summarizeSessionToMemory(history);
  });
  useEffect(() => {
    if (sending) return;
    if (messages.length - summarizedUpToRef.current < 15) return;
    const slice = messages.slice(summarizedUpToRef.current);
    summarizedUpToRef.current = messages.length;
    summarizeRecentMessages(slice);
  }, [messages, sending]);

  const clearConversation = () => {
    setMessages([]);
    try {
      localStorage.removeItem('pigry:ai-conversation');
    } catch {
      // ignore
    }
  };

  // What the composer pill and model picker highlight: this menu's default
  // agent when it pins a provider/model, else the global chat selection.
  const agentProvider = defaultAgent?.providerId
    ? providers.find((p) => p.id === defaultAgent.providerId) ?? null
    : null;
  const pointedProvider = agentProvider ?? active;
  const pointedModel = agentProvider
    ? defaultAgent?.model || agentProvider.model
    : active?.model ?? '';
  const providerLabel = pointedProvider
    ? `${pointedProvider.name || pointedProvider.type}${pointedModel ? ' · ' + pointedModel : ''}`
    : 'No provider';
  // Selected effort level of the pointed model (composer pill chip).
  const activeEffort = pointedProvider?.models.find((m) => m.name === pointedModel)?.effort ?? '';

  // Live context usage of this session — shown as a % chip beside the model
  // pill. The default agent owns the thread, so this is its context window
  // (provider-reported tokens when available, ~4 chars/token estimate else).
  const sessionTokens = useMemo(
    () =>
      messages.reduce(
        (sum, m) => sum + (m.role === 'assistant' && m.tokens ? m.tokens : estimateTokens(m)),
        0,
      ),
    [messages],
  );
  const pointedModelEntry = pointedProvider?.models.find((m) => m.name === pointedModel);
  const pointedWindow = resolveContextWindow(pointedModel, pointedModelEntry);
  /** Recent assistant turns for the context dropdown — newest first. */
  const ctxTurns = useMemo(() => {
    const turns: Array<{ used: string; tokens: number; time?: number }> = [];
    for (let i = messages.length - 1; i >= 0 && turns.length < 6; i -= 1) {
      const m = messages[i];
      if (m.role === 'assistant' && m.used) {
        turns.push({ used: m.used, tokens: m.tokens ?? estimateTokens(m), time: m.time });
      }
    }
    return turns;
  }, [messages]);
  const sessionCtxPct =
    pointedWindow && sessionTokens > 0
      ? Math.min(100, Math.max(1, Math.round((sessionTokens / pointedWindow) * 100)))
      : null;

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

  // While a modal overlay is open, tell the floating browser to hide its
  // native webviews (they composite above all HTML and would cover the
  // dialog). The cleanup keeps the count correct on close AND unmount.
  const overlayOpen = modelDialogOpen || knowDialog !== null;
  useEffect(() => {
    if (overlayOpen) emitOverlayChange(true);
    return () => {
      if (overlayOpen) emitOverlayChange(false);
    };
  }, [overlayOpen]);

  return (
    <aside ref={panelRef} className="explorer-ai" style={{ width }}>
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
                void listSessions({ agent: scopeAgent }).then(setSessionList);
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
                      {!isUser && message.used && (
                        <span className="explorer-ai__msg-used" title="Model and effort this reply used">
                          {message.used}
                        </span>
                      )}
                      {!isUser &&
                        (() => {
                          const pct = contextUsageAt(messages, index, pointedWindow);
                          if (pct === null) return null;
                          return (
                            <span
                              className={`ai-ctx${pct >= 90 ? ' ai-ctx--danger' : pct >= 70 ? ' ai-ctx--warn' : ''}`}
                              title={`Context window used so far in this session (${message.tokens ? 'provider usage' : 'estimated'})`}
                            >
                              <CtxRing pct={pct} size={12} />
                              {pct}%
                            </span>
                          );
                        })()}
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
                  <ActivityIndicator activity={activity} />
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
          {(activeSelection || activeHistory || activeRailCommit || activeRailSelection || attachedFiles.length > 0 || images.length > 0) && (
            <div className="ai-composer__attachments">
              {activeRailCommit && (
                <span
                  className="ai-composer__sel-chip"
                  title={`Commit ${activeRailCommit.oid.slice(0, 7)} — its message and changed files are included with your next message`}
                >
                  <GitCommitHorizontal size={10} strokeWidth={1.5} />
                  {activeRailCommit.summary.split('\n')[0].slice(0, 32)}
                  <span className="ai-composer__sel-range">@ {activeRailCommit.oid.slice(0, 7)}</span>
                  <button
                    type="button"
                    aria-label="Remove commit from chat"
                    onClick={() => setDismissedRailCommit(activeRailCommit.oid)}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              )}
              {activeRailSelection && (
                <span
                  className="ai-composer__sel-chip"
                  title={`Highlighted code from ${activeRailSelection.path ?? activeRailSelection.source} — included with your next message`}
                >
                  <FileText size={10} strokeWidth={1.5} />
                  {activeRailSelection.path
                    ? activeRailSelection.path.split('/').pop()
                    : activeRailSelection.source}
                  <span className="ai-composer__sel-range">
                    {activeRailSelection.text.split('\n').length} line{activeRailSelection.text.split('\n').length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove highlighted code from chat"
                    onClick={() => setDismissedRailSel(activeRailSelection.text)}
                  >
                    <X size={9} strokeWidth={2} />
                  </button>
                </span>
              )}
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
              {sessionCtxPct !== null && (
                <div className="ai-composer__ctxwrap">
                  <button
                    type="button"
                    className={`ai-composer__ctx ai-ctx${sessionCtxPct >= 90 ? ' ai-ctx--danger' : sessionCtxPct >= 70 ? ' ai-ctx--warn' : ''}`}
                    title="Context usage details"
                    aria-expanded={ctxDropOpen}
                    onClick={() => setCtxDropOpen((open) => !open)}
                  >
                    <CtxRing pct={sessionCtxPct} />
                    {sessionCtxPct}%
                  </button>
                  {ctxDropOpen && (
                    <div className="ai-ctxdrop" ref={ctxDropRef}>
                      <header className="ai-ctxdrop__head">
                        <span>Context usage</span>
                        <span className={`ai-ctx${sessionCtxPct >= 90 ? ' ai-ctx--danger' : sessionCtxPct >= 70 ? ' ai-ctx--warn' : ''}`}>
                          <CtxRing pct={sessionCtxPct} size={18} />
                          {sessionCtxPct}%
                        </span>
                      </header>
                      <div className="ai-ctxdrop__rows">
                        <div className="ai-ctxdrop__row">
                          <span>Model</span>
                          <code>{providerLabel}{activeEffort ? ` · effort ${activeEffort}` : ''}</code>
                        </div>
                        <div className="ai-ctxdrop__row">
                          <span>Window</span>
                          <code>{(pointedWindow! / 1000).toLocaleString()}k tokens</code>
                        </div>
                        <div className="ai-ctxdrop__row">
                          <span>Used</span>
                          <code>~{sessionTokens.toLocaleString()} tokens</code>
                        </div>
                      </div>
                      {ctxTurns.length > 0 && (
                        <>
                          <h5 className="ai-ctxdrop__section">Recent turns</h5>
                          <ul className="ai-ctxdrop__turns">
                            {ctxTurns.map((turn, i) => (
                              <li key={i} className="ai-ctxdrop__turn">
                                <span className="ai-ctxdrop__turn-model">{turn.used}</span>
                                <span className="ai-ctxdrop__turn-tokens">
                                  ~{turn.tokens.toLocaleString()} tok
                                  {turn.time ? ` · ${fmtMsgTime(turn.time)}` : ''}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <footer className="ai-ctxdrop__note">
                        Turns without provider-reported usage are estimated (~4 chars/token).
                      </footer>
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                className="explorer-ai__model-pill"
                title={`Change provider or model — ${providerLabel}${activeEffort ? ` · effort ${activeEffort}` : ''}`}
                onClick={() => setModelDialogOpen(true)}
              >
                <span className={`explorer-ai__model-dot explorer-ai__model-dot--${pointedProvider ? providerStatus(pointedProvider) : 'warn'}`} />
                <span className="explorer-ai__model-pill-name">{pointedModel || providerLabel}</span>
                {activeEffort && <span className="explorer-ai__model-pill-effort">{activeEffort}</span>}
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
          activeId={pointedProvider?.id ?? ''}
          activeModel={pointedModel}
          onClose={() => setModelDialogOpen(false)}
          onEffort={(providerId, modelId, effort) => {
            const list = providers.map((p) =>
              p.id === providerId
                ? { ...p, models: p.models.map((m) => (m.id === modelId ? { ...m, effort } : m)) }
                : p,
            );
            saveProviders(list, activeId);
            setProviders(list);
          }}
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
            // This menu's default agent follows the chat pick — write the
            // provider/model through to its override. A stored effort only
            // survives if the new model offers that level.
            if (defaultAgent) {
              const picked = list
                .find((p) => p.id === providerId)
                ?.models.find((m) => m.name === modelName);
              const effort =
                defaultAgent.effort && picked?.reasoningLevels?.includes(defaultAgent.effort)
                  ? defaultAgent.effort
                  : undefined;
              setAgentOverride({ ...defaultAgent, providerId, model: modelName, effort });
            }
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

/** Full-screen dialog: pick a provider on the left, a model on the right.
 * Models with reasoning levels get an inline Effort selector under their row. */
function ModelPickerDialog({
  providers,
  activeId,
  activeModel,
  onClose,
  onPick,
  onEffort,
}: {
  providers: AiProviderEntry[];
  activeId: string;
  /** The model the default agent will actually use (may differ from the
   * provider's active mirror). */
  activeModel?: string;
  onClose: () => void;
  onPick: (providerId: string, modelName: string) => void;
  onEffort: (providerId: string, modelId: string, effort: string | undefined) => void;
}) {
  const activeProvider = providers.find((p) => p.id === activeId) ?? null;
  const [viewId, setViewId] = useState(activeProvider?.id ?? providers[0]?.id ?? '');
  const viewed = providers.find((p) => p.id === viewId) ?? providers[0] ?? null;
  /** Model whose Effort selector is expanded ("Mode" toggle). */
  const [expandedId, setExpandedId] = useState<string | null>(
    activeProvider?.models.find((m) => m.name === activeProvider.model && m.reasoningLevels?.length)?.id ?? null,
  );

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
                <span className={`model-dlg__dot model-dlg__dot--${providerStatus(provider)}`} />
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
              const isChosen = viewed.id === activeId && model.name === (activeModel || viewed.model);
              const levels = model.reasoningLevels ?? [];
              const isExpanded = expandedId === model.id;
              return (
                <div key={model.id} className="model-dlg__model-block">
                  <div
                    className={`model-dlg__model${isChosen ? ' model-dlg__model--chosen' : ''}${model.enabled ? '' : ' model-dlg__model--off'}`}
                  >
                    {isChosen ? (
                      <Check size={13} strokeWidth={2} className="model-dlg__check" />
                    ) : (
                      <span className="model-dlg__check-spacer" />
                    )}
                    <span className="model-dlg__model-name">{model.name}</span>
                    {model.context && <span className="model-dlg__badge">{model.context}</span>}
                    {model.vision && <span className="model-dlg__badge">Vision</span>}
                    {model.effort && (
                      <span className="model-dlg__badge model-dlg__badge--effort">{model.effort}</span>
                    )}
                    <span className="model-dlg__row-gap" />
                    {levels.length > 0 && (
                      <button
                        type="button"
                        className="model-dlg__row-btn"
                        title="Show effort levels"
                        aria-expanded={isExpanded}
                        onClick={() => setExpandedId(isExpanded ? null : model.id)}
                      >
                        Mode
                        {isExpanded ? (
                          <ChevronDown size={11} strokeWidth={1.75} />
                        ) : (
                          <ChevronRight size={11} strokeWidth={1.75} />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="model-dlg__row-btn model-dlg__row-btn--use"
                      title="Use this model for chat"
                      disabled={!model.enabled}
                      onClick={() => onPick(viewed.id, model.name)}
                    >
                      Use
                    </button>
                  </div>
                  {isExpanded && levels.length > 0 && (
                    <div className="model-dlg__effort" aria-label={`Effort for ${model.name}`}>
                      <span className="model-dlg__effort-label">Effort</span>
                      <button
                        type="button"
                        className={`model-dlg__effort-pill${!model.effort ? ' model-dlg__effort-pill--on' : ''}`}
                        title="No effort parameter — provider default"
                        onClick={() => onEffort(viewed.id, model.id, undefined)}
                      >
                        default
                      </button>
                      {levels.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`model-dlg__effort-pill${model.effort === level ? ' model-dlg__effort-pill--on' : ''}`}
                          onClick={() => onEffort(viewed.id, model.id, level)}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
