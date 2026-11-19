/** Compact Tools and MCP sections that dock inside the AI Agent panel
 * (Explorer layout, ~360px wide). Same stores as the agent context builder:
 * lib/agentTools.ts and lib/mcpServers.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Check,
  Code,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  Pencil,
  Plug,
  Plus,
  Quote,
  RotateCcw,
  Strikethrough,
  Trash2,
  X,
} from 'lucide-react';
import {
  AGENT_TOOLS,
  agentToolId,
  loadEnabledTools,
  saveEnabledTools,
  TOOL_GROUPS,
} from '../../lib/agentTools';
import { renderMarkdown } from '../../lib/markdown';
import { listSessions } from '../../lib/aiSessions';
import { activeProvider, resolveContextWindow } from '../../lib/aiProviders';
import { CtxRing } from '../../lib/CtxRing';
import { relativeTime } from '../../lib/relativeTime';
import {
  loadMcpServers,
  mcpJsonExport,
  saveMcpServers,
  type McpServer,
  type McpTransport,
} from '../../lib/mcpServers';
import { listSkills } from '../../lib/skills';
import {
  applyPlugin,
  INSTRUCTIONS_PATH,
  AGENT_TEAMS,
  allAgents,
  builtinAgents,
  hasAgentOverride,
  resetAgentOverride,
  setAgentOverride,

  loadAgents,
  loadHooks,
  loadPlugins,
  readInstructions,
  saveAgents,
  hydrateAgentsIfEmpty,
  saveHooks,
  saveInstructions,
  savePlugins,
  type AgentEntry,
  type HookEntry,
  type HookEvent,
  type PluginEntry,
} from '../../lib/agentExtras';
import { loadProviders, type AiProviderEntry } from '../../lib/aiProviders';
import {
  MentionMenu,
  applyMention,
  type MentionState,
  detectMention,
  mentionCandidates,
  skillCandidates,
  detectSkillToken,
  applySkillToken,
  SkillMenu,
  type SkillEntry,
  type SkillTokenState,
} from '../../lib/mentions';
import { useRepository } from '../../hooks/useRepository';
import './AgentPanelTabs.css';

/* ---- Tools tab ---- */

export function AgentToolsTab() {
  const [enabled, setEnabled] = useState<Set<string>>(() => loadEnabledTools());

  const persist = useCallback((next: Set<string>) => {
    setEnabled(next);
    saveEnabledTools(next);
  }, []);

  const toggle = (id: string) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persist(next);
  };

  const setGroup = (group: (typeof TOOL_GROUPS)[number], on: boolean) => {
    const next = new Set(enabled);
    for (const tool of AGENT_TOOLS.filter((t) => t.group === group)) {
      if (on) next.add(tool.id);
      else next.delete(tool.id);
    }
    persist(next);
  };

  const enabledCount = AGENT_TOOLS.filter((tool) => enabled.has(tool.id)).length;

  return (
    <div className="apanel">
      <p className="apanel__intro">
        Tools the agent may use — announced with every message.
      </p>
      {TOOL_GROUPS.map((group) => {
        const tools = AGENT_TOOLS.filter((tool) => tool.group === group);
        const onCount = tools.filter((tool) => enabled.has(tool.id)).length;
        return (
          <section key={group} className="apanel__group">
            <header className="apanel__group-head">
              <strong>{group}</strong>
              <span className="apanel__group-count">
                {onCount}/{tools.length}
              </span>
              <span className="apanel__spacer" />
              <button type="button" onClick={() => setGroup(group, true)}>All</button>
              <button type="button" onClick={() => setGroup(group, false)}>None</button>
            </header>
            {tools.map((tool) => (
              <label key={tool.id} className="apanel__tool" title={tool.description}>
                <input
                  type="checkbox"
                  checked={enabled.has(tool.id)}
                  onChange={() => toggle(tool.id)}
                />
                <span className="apanel__tool-name">{tool.name}</span>
                <span className="apanel__tool-desc">{tool.description}</span>
              </label>
            ))}
          </section>
        );
      })}
      <p className="apanel__foot">
        {enabledCount} of {AGENT_TOOLS.length} tools enabled
      </p>
    </div>
  );
}

/* ---- MCP tab ---- */

interface McpDraft {
  id: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
}

const EMPTY_DRAFT: McpDraft = {
  id: null,
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
};

export function McpTab() {
  const [servers, setServers] = useState<McpServer[]>(() => loadMcpServers());
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const persist = useCallback((next: McpServer[]) => {
    setServers(next);
    saveMcpServers(next);
  }, []);

  const enabledCount = servers.filter((server) => server.enabled).length;
  const exported = useMemo(() => mcpJsonExport(servers), [servers]);

  const toggleServer = (id: string) => {
    persist(
      servers.map((server) =>
        server.id === id ? { ...server, enabled: !server.enabled } : server,
      ),
    );
  };

  const deleteServer = (id: string) => {
    persist(servers.filter((server) => server.id !== id));
    setConfirmDelete(null);
  };

  const submitDraft = () => {
    if (!draft || !draft.name.trim()) return;
    const entry: McpServer = {
      id: draft.id ?? `mcp-${Date.now().toString(36)}`,
      name: draft.name.trim(),
      transport: draft.transport,
      command: draft.command.trim(),
      args: draft.args.trim(),
      url: draft.url.trim(),
      env: draft.env.trim(),
      enabled: true,
    };
    if (draft.id) {
      persist(servers.map((server) => (server.id === draft.id ? entry : server)));
    } else {
      persist([...servers, entry]);
    }
    setDraft(null);
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(exported);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="apanel">
      <p className="apanel__intro">
        MCP servers extend the agent with external tools. Enabled servers are announced to the
        agent and exportable as <code>.mcp.json</code>.
      </p>

      <button
        type="button"
        className="apanel__add"
        onClick={() => setDraft({ ...EMPTY_DRAFT })}
      >
        <Plus size={11} strokeWidth={1.5} />
        Add server
      </button>

      {servers.length === 0 ? (
        <div className="apanel__empty">
          <Plug size={18} strokeWidth={1.25} />
          <p>No MCP servers yet — add one to extend the agent.</p>
        </div>
      ) : (
        <div className="apanel__servers">
          {servers.map((server) => (
            <section
              key={server.id}
              className={`apanel__server${server.enabled ? '' : ' apanel__server--off'}`}
            >
              <div className="apanel__server-main">
                <div className="apanel__server-title">
                  <span className={`apanel__dot${server.enabled ? ' apanel__dot--on' : ''}`} />
                  <strong>{server.name}</strong>
                  <span className="apanel__transport">{server.transport}</span>
                </div>
                <p className="apanel__server-detail">
                  {server.transport === 'http'
                    ? server.url || '(no URL set)'
                    : [server.command, server.args].filter(Boolean).join(' ') || '(no command set)'}
                </p>
              </div>
              <div className="apanel__server-actions">
                <label className="app-settings__switch" title="Enable">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={() => toggleServer(server.id)}
                  />
                  <i />
                </label>
                <button
                  type="button"
                  aria-label={`Edit ${server.name}`}
                  onClick={() =>
                    setDraft({
                      id: server.id,
                      name: server.name,
                      transport: server.transport,
                      command: server.command,
                      args: server.args,
                      url: server.url,
                      env: server.env,
                    })
                  }
                >
                  <Pencil size={11} strokeWidth={1.25} />
                </button>
                {confirmDelete === server.id ? (
                  <span className="apanel__confirm">
                    Delete?
                    <button type="button" onClick={() => deleteServer(server.id)}>Yes</button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>No</button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete ${server.name}`}
                    onClick={() => setConfirmDelete(server.id)}
                  >
                    <Trash2 size={11} strokeWidth={1.25} />
                  </button>
                )}
              </div>
            </section>
          ))}

          <div className="apanel__export">
            <button
              type="button"
              className="apanel__export-toggle"
              onClick={() => setShowConfig((open) => !open)}
            >
              .mcp.json · {enabledCount} enabled
            </button>
            {showConfig && (
              <>
                <pre className="apanel__config">{exported}</pre>
                <button type="button" className="apanel__copy" onClick={copyConfig}>
                  {copied ? <Check size={11} strokeWidth={1.5} /> : null}
                  {copied ? 'Copied' : 'Copy config'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {draft && (
        <div className="apanel__overlay" role="dialog" aria-label="MCP server">
          <div className="apanel__dialog">
            <h3>{draft.id ? 'Edit server' : 'Add MCP server'}</h3>
            <label className="apanel__field">
              <span>Name</span>
              <input
                autoFocus
                value={draft.name}
                placeholder="filesystem"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="apanel__field">
              <span>Transport</span>
              <select
                value={draft.transport}
                onChange={(event) =>
                  setDraft({ ...draft, transport: event.target.value as McpTransport })
                }
              >
                <option value="stdio">stdio — local command</option>
                <option value="http">http — streamable endpoint</option>
              </select>
            </label>
            {draft.transport === 'stdio' ? (
              <>
                <label className="apanel__field">
                  <span>Command</span>
                  <input
                    value={draft.command}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem"
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  />
                </label>
                <label className="apanel__field">
                  <span>Arguments</span>
                  <input
                    value={draft.args}
                    placeholder='. /path/to/repo'
                    onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <label className="apanel__field">
                <span>URL</span>
                <input
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </label>
            )}
            <label className="apanel__field">
              <span>Environment variables (one per line)</span>
              <textarea
                rows={2}
                value={draft.env}
                placeholder={'API_TOKEN=...'}
                onChange={(event) => setDraft({ ...draft, env: event.target.value })}
              />
            </label>
            <div className="apanel__dialog-actions">
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button
                type="button"
                className="apanel__dialog-primary"
                disabled={!draft.name.trim()}
                onClick={submitDraft}
              >
                {draft.id ? 'Save' : 'Add server'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Instructions tab (.pigry/instructions.md, real repo file) ---- */

export function InstructionsTab() {
  const { mode, notify } = useRepository();
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    readInstructions().then((text) => {
      if (cancelled) return;
      setContent(text);
      setSaved(text);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = content !== saved;

  const save = async () => {
    try {
      await saveInstructions(content);
      setSaved(content);
      notify('Instructions saved to .pigry/instructions.md', 'success');
    } catch (error) {
      notify(`Could not save instructions: ${String(error)}`, 'error');
    }
  };

  return (
    <div className="apanel">
      <p className="apanel__intro">
        Always included with every message. Stored in the repository at{' '}
        <code>{INSTRUCTIONS_PATH}</code>.
      </p>
      {mode === 'browser' ? (
        <div className="apanel__empty">
          <p>Reading and writing files needs the desktop app.</p>
        </div>
      ) : loading ? (
        <p className="apanel__foot">Loading…</p>
      ) : (
        <>
          <textarea
            className="apanel__editor"
            value={content}
            rows={10}
            placeholder={'e.g. Always run the test suite before committing…'}
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="apanel__editor-actions">
            <span className="apanel__dirty">{dirty ? 'Unsaved changes' : 'Saved'}</span>
            <button
              type="button"
              className="apanel__dialog-primary"
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---- Agents tab (sub-agent definitions announced to the model) ---- */

/** Reads the repo's skill names from .pigry/skills/*.md. */
async function listSkillNames(): Promise<string[]> {
  try {
    return (await listSkills()).map((skill) => skill.id);
  } catch {
    return [];
  }
}

/** Downscales an image file to a square 96px avatar data URL. */
async function fileToAvatar(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('bad image'));
    img.src = dataUrl;
  });
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}

export function AgentDetailsDialog({
  agent,
  onClose,
  onEdit,
}: {
  agent: AgentEntry;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const provider = agent.providerId
    ? loadProviders().find((p) => p.id === agent.providerId)
    : activeProvider() ?? undefined;
  const providerName = provider?.name ?? 'no provider';
  const model = agent.model || provider?.model || '(active model)';
  const modelEntry = provider?.models.find((m) => m.name === model);

  // Per-agent context usage — sessions and context windows are owned by the
  // agent that answered: sum the tokens of the assistant turns carrying this
  // agent's username across the repo's chat sessions, with per-model and
  // per-day breakdowns for the usage panel.
  const [contextInfo, setContextInfo] = useState<{
    window: number | null;
    usedTokens: number;
    turns: number;
    sessions: number;
    lastTitle: string | null;
    lastTime: number | null;
    avgTokens: number;
    byModel: Array<{ label: string; turns: number; tokens: number }>;
    days: Array<{ label: string; tokens: number; turns: number }>;
    recent: Array<{ used: string; tokens: number; time?: number; title: string }>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const win = resolveContextWindow(model, modelEntry);
      // Turns this agent answered carry its username — scan EVERY session
      // (its own agent-scoped threads plus group threads where it replied
      // via @mention); legacy untagged sessions must not shadow them. `own`
      // only feeds the owned-sessions count.
      const [own, every] = await Promise.all([
        agent.username ? listSessions({ agent: agent.username }) : Promise.resolve([]),
        listSessions(),
      ]);
      let usedTokens = 0;
      let turns = 0;
      let lastTitle: string | null = null;
      let lastTime: number | null = null;
      const byModel = new Map<string, { turns: number; tokens: number }>();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const dayKeys: number[] = [];
      const dayTokens: number[] = [];
      const dayTurns: number[] = [];
      for (let i = 6; i >= 0; i -= 1) {
        dayKeys.push(todayStart.getTime() - i * 86_400_000);
        dayTokens.push(0);
        dayTurns.push(0);
      }
      const dayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      const recent: Array<{ used: string; tokens: number; time?: number; title: string }> = [];
      for (const session of every) {
        for (const msg of session.messages) {
          if (msg.role !== 'assistant' || msg.agent !== agent.username) continue;
          const tokens =
            msg.tokens ?? Math.ceil(((msg.text?.length ?? 0) + (msg.context?.length ?? 0)) / 4);
          turns += 1;
          usedTokens += tokens;
          lastTitle = session.title;
          if (msg.time) lastTime = Math.max(lastTime ?? 0, msg.time);
          const label = msg.used ?? 'estimate';
          const bucket = byModel.get(label) ?? { turns: 0, tokens: 0 };
          bucket.turns += 1;
          bucket.tokens += tokens;
          byModel.set(label, bucket);
          if (msg.time) {
            const dayStart = new Date(msg.time);
            dayStart.setHours(0, 0, 0, 0);
            const idx = dayKeys.indexOf(dayStart.getTime());
            if (idx !== -1) {
              dayTokens[idx] += tokens;
              dayTurns[idx] += 1;
            }
          }
          recent.push({ used: label, tokens, time: msg.time, title: session.title });
        }
      }
      if (!cancelled) {
        setContextInfo({
          window: win,
          usedTokens,
          turns,
          sessions: own.length,
          lastTitle,
          lastTime,
          avgTokens: turns > 0 ? Math.round(usedTokens / turns) : 0,
          byModel: [...byModel.entries()]
            .map(([label, v]) => ({ label, ...v }))
            .sort((a, b) => b.tokens - a.tokens),
          days: dayKeys.map((t, i) => ({
            label: dayLabels[new Date(t).getDay()],
            tokens: dayTokens[i],
            turns: dayTurns[i],
          })),
          recent: recent.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 5),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.username, model, modelEntry]);
  const ctxWindow = contextInfo?.window ?? null;
  const ctxUsed = contextInfo?.usedTokens ?? 0;
  const ctxPct =
    ctxWindow && ctxUsed > 0
      ? Math.min(100, Math.max(1, Math.round((ctxUsed / ctxWindow) * 100)))
      : null;
  return (
    <div
      className="know-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="know-dlg apanel-dlg" role="dialog" aria-modal="true" aria-label="Agent details">
        <header className="apanel-dlg__hero">
          {agent.avatar ? (
            <img className="apanel-dlg__avatar" src={agent.avatar} alt="" />
          ) : (
            <span className="apanel-dlg__avatar apanel-dlg__avatar--blank">
              {agent.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="apanel-dlg__hero-text">
            <strong className="apanel-dlg__name">{agent.name}</strong>
            <p className="apanel-dlg__sub">
              {agent.username ? `@${agent.username}` : ''}
              {agent.team ? ` · ${agent.team}` : ''}
            </p>
            {agent.role && <p className="apanel-dlg__role">{agent.role}</p>}
          </div>
          {agent.tier && (
            <span className={`apanel-dlg__tier apanel-dlg__tier--${agent.tier}`}>
              {agent.tier === 'default' ? 'default agent' : agent.tier === 'base' ? 'base agent' : 'extension'}
            </span>
          )}
          <button type="button" className="know-dlg__close" onClick={onClose} aria-label="Close details">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="know-dlg__body know-dlg__body--editor apanel-dlg__body">
          {agent.description && (
            <>
              <h4 className="apanel-dlg__section">About</h4>
              <div className="apanel-dlg__desc">{renderMarkdown(agent.description)}</div>
            </>
          )}
          <h4 className="apanel-dlg__section">Setup</h4>
          <div className="apanel-dlg__rows">
            <div className="apanel-dlg__row">
              <span>Provider</span>
              <code>{providerName} · {model}{agent.effort ? ` · effort ${agent.effort}` : modelEntry?.effort ? ` · effort ${modelEntry.effort}` : ''}</code>
            </div>
            {agent.team && agent.username && (
              <div className="apanel-dlg__row">
                <span>Memory</span>
                <code>.pigry/teams/{agent.team}/agents/{agent.username}/memory.vector.json</code>
              </div>
            )}
          </div>
          <h4 className="apanel-dlg__section">Context usage</h4>
          {contextInfo && contextInfo.turns > 0 ? (
            <div className="apanel-dlg__ctxcard">
              <div className="apanel-dlg__ctxhero">
                <span
                  className={`apanel-dlg__ctxring ai-ctx${ctxPct !== null && ctxPct >= 90 ? ' ai-ctx--danger' : ctxPct !== null && ctxPct >= 70 ? ' ai-ctx--warn' : ''}`}
                >
                  <CtxRing pct={ctxPct ?? 0} size={64} stroke={5} />
                  <b>{ctxPct !== null ? `${ctxPct}%` : '—'}</b>
                </span>
                <div className="apanel-dlg__ctxhero-main">
                  <div className="apanel-dlg__ctxhero-line">
                    <b>~{ctxUsed.toLocaleString()}</b> of{' '}
                    {ctxWindow ? `${(ctxWindow / 1000).toLocaleString()}k` : '?'} tokens
                  </div>
                  <div className="apanel-dlg__ctxbar">
                    <span
                      className={`apanel-dlg__ctxbar-fill${ctxPct !== null && ctxPct >= 90 ? ' apanel-dlg__ctxbar-fill--danger' : ctxPct !== null && ctxPct >= 70 ? ' apanel-dlg__ctxbar-fill--warn' : ''}`}
                      style={{ width: `${ctxPct ?? 0}%` }}
                    />
                  </div>
                  <div className="apanel-dlg__ctxhero-sub">
                    {contextInfo.lastTime
                      ? `Last answered ${relativeTime(Math.floor(contextInfo.lastTime / 1000))}`
                      : '—'}
                    {contextInfo.lastTitle ? ` · ${contextInfo.lastTitle}` : ''}
                  </div>
                </div>
              </div>
              <div className="apanel-dlg__tiles">
                <div className="apanel-dlg__tile">
                  <b>{contextInfo.turns}</b>
                  <span>turns answered</span>
                </div>
                <div className="apanel-dlg__tile">
                  <b>
                    ~{ctxUsed >= 1000 ? `${(ctxUsed / 1000).toFixed(1)}k` : ctxUsed.toLocaleString()}
                  </b>
                  <span>tokens used</span>
                </div>
                <div className="apanel-dlg__tile">
                  <b>~{contextInfo.avgTokens.toLocaleString()}</b>
                  <span>avg / turn</span>
                </div>
                <div className="apanel-dlg__tile">
                  <b>{contextInfo.sessions}</b>
                  <span>sessions owned</span>
                </div>
              </div>
              <div className="apanel-dlg__days">
                {contextInfo.days.map((day, i) => {
                  const max = Math.max(...contextInfo.days.map((x) => x.tokens), 1);
                  const height = day.tokens > 0 ? Math.max(12, Math.round((day.tokens / max) * 100)) : 0;
                  const isToday = i === contextInfo.days.length - 1;
                  return (
                    <div
                      key={i}
                      className={`apanel-dlg__day${isToday ? ' apanel-dlg__day--today' : ''}`}
                      title={`${day.label} — ${day.turns} turn${day.turns === 1 ? '' : 's'} · ~${day.tokens.toLocaleString()} tokens`}
                    >
                      <span
                        className="apanel-dlg__daybar"
                        style={{ height: `${height}%`, opacity: day.tokens > 0 ? 1 : 0.2 }}
                      />
                      <span className="apanel-dlg__daylabel">{day.label}</span>
                    </div>
                  );
                })}
              </div>
              {contextInfo.byModel.length > 0 && (
                <div className="apanel-dlg__models">
                  <h5 className="apanel-dlg__ctxsub">By model</h5>
                  {contextInfo.byModel.map((entry) => (
                    <div key={entry.label} className="apanel-dlg__modelrow">
                      <code>{entry.label}</code>
                      <span className="apanel-dlg__modelbar">
                        <span
                          style={{ width: `${ctxUsed > 0 ? Math.round((entry.tokens / ctxUsed) * 100) : 0}%` }}
                        />
                      </span>
                      <span className="apanel-dlg__modelmeta">
                        {entry.turns} turn{entry.turns === 1 ? '' : 's'} · ~
                        {entry.tokens >= 1000 ? `${(entry.tokens / 1000).toFixed(1)}k` : entry.tokens}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {contextInfo.recent.length > 0 && (
                <div className="apanel-dlg__recent">
                  <h5 className="apanel-dlg__ctxsub">Recent turns</h5>
                  {contextInfo.recent.map((turn, i) => (
                    <div key={i} className="apanel-dlg__recentrow">
                      <span className="apanel-dlg__recenttokens">
                        ~{turn.tokens.toLocaleString()}
                      </span>
                      <span className="apanel-dlg__recentmodel">{turn.used}</span>
                      <span className="apanel-dlg__recentmeta">
                        {turn.time
                          ? new Date(turn.time).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : ''}
                        {turn.title ? ` · ${turn.title}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="apanel-dlg__ctxcard apanel-dlg__ctxcard--empty">
              No turns answered yet — usage stats appear after this agent replies.
            </div>
          )}
          <h4 className="apanel-dlg__section">Capabilities</h4>
          <div className="apanel-dlg__caps">
            <div className="apanel-dlg__cap">
              <span className="apanel-dlg__cap-label">Tools</span>
              <div className="apanel-dlg__cap-chips">
                {agent.tools.length > 0
                  ? agent.tools.map((tool) => (
                      <code key={tool} className="apanel-dlg__chip apanel-dlg__chip--tool">
                        {tool}
                      </code>
                    ))
                  : <span className="apanel-dlg__cap-none">all enabled tools</span>}
              </div>
            </div>
            <div className="apanel-dlg__cap">
              <span className="apanel-dlg__cap-label">Skills</span>
              <div className="apanel-dlg__cap-chips">
                {agent.skills.length > 0
                  ? agent.skills.map((skill) => (
                      <code key={skill} className="apanel-dlg__chip apanel-dlg__chip--skill">
                        #{skill}
                      </code>
                    ))
                  : <span className="apanel-dlg__cap-none">—</span>}
              </div>
            </div>
            <div className="apanel-dlg__cap">
              <span className="apanel-dlg__cap-label">MCP</span>
              <div className="apanel-dlg__cap-chips">
                {agent.mcpServers.length > 0
                  ? agent.mcpServers.map((server) => (
                      <code key={server} className="apanel-dlg__chip apanel-dlg__chip--mcp">
                        {server}
                      </code>
                    ))
                  : <span className="apanel-dlg__cap-none">—</span>}
              </div>
            </div>
          </div>
          {agent.builtIn ? (
            <p className="apanel-dlg__note">
              Built-in {agent.tier === 'default' ? 'default' : 'base'} agent — you can edit it;
              your changes override the default and can be reset any time.
            </p>
          ) : (
            onEdit && (
              <div className="apanel-dlg__actions">
                <button
                  type="button"
                  className="know-editor__btn know-editor__btn--primary"
                  onClick={() => {
                    onClose();
                    onEdit();
                  }}
                >
                  <Pencil size={11} strokeWidth={1.5} />
                  Edit agent
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentsTab({ defaultTeam }: { defaultTeam?: string } = {}) {
  const [agents, setAgents] = useState<AgentEntry[]>(() => loadAgents());
  // Full-detail viewer for one agent (built-in or extension).
  const [viewing, setViewing] = useState<AgentEntry | null>(null);
  /** Providers for the per-agent model selector (read once on mount). */
  const [providers] = useState<AiProviderEntry[]>(() => loadProviders());
  // Repo hydration: seed localStorage from .pigry/agents.json when empty
  // (migrates the legacy per-team layout on first run).
  useEffect(() => {
    let cancelled = false;
    void hydrateAgentsIfEmpty().then((list) => {
      if (!cancelled && list.length > 0) setAgents(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [draft, setDraft] = useState<(AgentEntry & { isNew: boolean }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [mcpNames] = useState<string[]>(() => loadMcpServers().map((server) => server.name));
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [descPreview, setDescPreview] = useState(false);
  // @mention autocomplete in the description — typing `@` opens the agent
  // picker; picking inserts the `@username` tag into the markdown text.
  const [descMention, setDescMention] = useState<MentionState | null>(null);
  // #skill twin of the description's @mention picker.
  const [descSkill, setDescSkill] = useState<SkillTokenState | null>(null);
  const [descSkillIdx, setDescSkillIdx] = useState(0);
  // Skill metadata for the # picker (id/name/description).
  const [skillMetas, setSkillMetas] = useState<SkillEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    listSkills()
      .then((list) => {
        if (!cancelled) setSkillMetas(list);
      })
      .catch(() => {
        // skill listing unavailable
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const descSkillList = useMemo(
    () => (descSkill ? skillCandidates(skillMetas, descSkill.query) : []),
    [descSkill, skillMetas],
  );
  const descSkillPos = Math.min(descSkillIdx, Math.max(0, descSkillList.length - 1));

  const pickDescSkill = (skill: SkillEntry) => {
    if (!draft || !descSkill) return;
    const caret = descRef.current?.selectionStart ?? draft.description.length;
    const next = applySkillToken(draft.description, descSkill, caret, skill.id);
    setDraft({ ...draft, description: next.value });
    setDescSkill(null);
    setDescSkillIdx(0);
    requestAnimationFrame(() => {
      descRef.current?.focus();
      descRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const [descMentionIdx, setDescMentionIdx] = useState(0);
  const descMentionList = useMemo(
    () => (descMention ? mentionCandidates(allAgents(), descMention.query) : []),
    [descMention],
  );
  const descMentionPos = Math.min(descMentionIdx, Math.max(0, descMentionList.length - 1));

  const pickDescMention = (agent: AgentEntry) => {
    if (!draft || !descMention) return;
    const caret = descRef.current?.selectionStart ?? draft.description.length;
    const next = applyMention(draft.description, descMention, caret, agent.username);
    setDraft({ ...draft, description: next.value });
    setDescMention(null);
    setDescMentionIdx(0);
    requestAnimationFrame(() => {
      descRef.current?.focus();
      descRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  useEffect(() => {
    let cancelled = false;
    listSkillNames().then((names) => {
      if (!cancelled) setSkillNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Wraps the description selection with markdown tokens. */
  const applyDescMd = (before: string, after: string, placeholder: string) => {
    if (!draft) return;
    const ta = descRef.current;
    const value = draft.description;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const body = selected || placeholder;
    setDraft({ ...draft, description: value.slice(0, start) + before + body + after + value.slice(end) });
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const selStart = start + before.length;
      ta.setSelectionRange(selStart, selStart + body.length);
    });
  };

  /** Prefixes every selected description line. */
  const applyDescMdPrefix = (prefix: string) => {
    if (!draft) return;
    const ta = descRef.current;
    const value = draft.description;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const block = value.slice(lineStart, end);
    const prefixed = block
      ? block.split('\n').map((line) => (line.startsWith(prefix) ? line : prefix + line)).join('\n')
      : prefix;
    setDraft({ ...draft, description: value.slice(0, lineStart) + prefixed + value.slice(end) });
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(lineStart, lineStart + prefixed.length);
    });
  };

  /** Inline `code`, or a fenced block when the selection spans lines. */
  const applyDescMdCode = () => {
    if (!draft) return;
    const ta = descRef.current;
    const value = draft.description;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    const multi = value.slice(start, end).includes('\n');
    applyDescMd(multi ? '```\n' : '`', multi ? '\n```' : '`', 'code');
  };

  const persist = useCallback((next: AgentEntry[]) => {
    setAgents(next);
    saveAgents(next);
  }, []);

  const toggle = (id: string) => {
    persist(agents.map((agent) => (agent.id === id ? { ...agent, enabled: !agent.enabled } : agent)));
  };

  /** Toggles a checkbox member list in the draft. */
  const toggleDraftMember = (kind: 'tools' | 'skills' | 'mcpServers', value: string) => {
    if (!draft) return;
    const ids = new Set(kind === 'tools' ? draft.tools.map(agentToolId) : draft[kind]);
    if (ids.has(value)) ids.delete(value);
    else ids.add(value);
    setDraft({ ...draft, [kind]: [...ids] });
  };

  const pickAvatar = async (file: File | undefined) => {
    if (!file || !draft) return;
    try {
      setDraft({ ...draft, avatar: await fileToAvatar(file) });
    } catch {
      // bad image — ignore
    }
  };

  const submit = () => {
    if (!draft || !draft.name.trim()) return;
    // Built-in agents keep their identity — the edit lands in the override
    // store (resettable) instead of the extension registry.
    if (draft.builtIn) {
      setAgentOverride({ ...draft, isNew: undefined } as AgentEntry);
      setAgents(loadAgents());
      setDraft(null);
      return;
    }
    const entry: AgentEntry = {
      id: draft.id,
      name: draft.name.trim(),
      username: draft.username.trim().replace(/^@/, ''),
      role: draft.role.trim(),
      team: draft.team?.trim() || undefined,
      providerId: draft.providerId || undefined,
      model: draft.model || undefined,
      effort: draft.effort || undefined,
      avatar: draft.avatar,
      description: draft.description.trim(),
      enabled: draft.enabled,
      tools: draft.tools,
      skills: draft.skills,
      mcpServers: draft.mcpServers,
    };
    if (draft.isNew) persist([...agents, entry]);
    else persist(agents.map((agent) => (agent.id === draft.id ? entry : agent)));
    setDraft(null);
  };

  return (
    <div className="apanel">
      <p className="apanel__intro">
        Named agents announced to the model — reference them by name and it knows what each one
        does, and which tools, skills and MCP servers it may use.
      </p>
      <button
        type="button"
        className="apanel__add"
        onClick={() => {
          setDescPreview(false);
          setDraft({
            id: `agent-${Date.now().toString(36)}`,
            name: '',
            username: '',
            role: '',
            // Preselect the team of the screen the panel lives in.
            team: defaultTeam ?? '',
            providerId: '',
            model: '',
            description: '',
            enabled: true,
            tools: [],
            skills: [],
            mcpServers: [],
            isNew: true,
          });
        }}
      >
        <Plus size={11} strokeWidth={1.5} />
        Add agent
      </button>
      {agents.length === 0 && (
        <div className="apanel__empty">
          <p>No extension agents yet — add your own below the built-ins.</p>
        </div>
      )}
      {(() => {
        const builtins = builtinAgents();
        const defaults = builtins.filter((agent) => agent.tier === 'default');
        const base = builtins.filter((agent) => agent.tier === 'base');
        const card = (agent: (typeof builtins)[number]) => (
          <div key={agent.id} className="apanel__server">
            {agent.avatar && (
              <img className="apanel__avatar" src={agent.avatar} alt="" />
            )}
            <div className="apanel__server-main">
              <div className="apanel__server-title">
                <strong>{agent.name}</strong>
                {agent.username && <span className="apanel__username">@{agent.username}</span>}
                {agent.role && <span className="apanel__role">{agent.role}</span>}
                {agent.team && <span className="apanel__role apanel__team">{agent.team}</span>}
              </div>
              {agent.description && <p className="apanel__server-detail">{agent.description}</p>}
            </div>
            <span className="apanel__builtin-tag">
              {agent.tier === 'default' ? 'default' : 'base'}
            </span>
            {hasAgentOverride(agent.username) && (
              <button
                type="button"
                className="apanel__view-btn"
                title="Reset to the original definition"
                aria-label={`Reset ${agent.name}`}
                onClick={() => {
                  resetAgentOverride(agent.username);
                  setAgents(loadAgents());
                }}
              >
                <RotateCcw size={12} strokeWidth={1.5} />
              </button>
            )}
            <button
              type="button"
              className="apanel__view-btn"
              title={`Edit ${agent.name}`}
              aria-label={`Edit ${agent.name}`}
              onClick={() => {
                setDescPreview(false);
                setDraft({ ...agent, isNew: false });
              }}
            >
              <Pencil size={12} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="apanel__view-btn"
              title="View details"
              onClick={() => setViewing(agent)}
            >
              <Eye size={12} strokeWidth={1.5} />
            </button>
          </div>
        );
        return (
          <div className="apanel__builtin">
            <h4 className="apanel__group-title">Built-in — default agents</h4>
            <p className="apanel__group-hint">
              One per workspace menu — answers turns typed there without a tag.
            </p>
            {defaults.map(card)}
            <h4 className="apanel__group-title">Built-in — base agents</h4>
            <p className="apanel__group-hint">Tag them with @username in their team’s menu.</p>
            {base.map(card)}
          </div>
        );
      })()}
/** Full-detail dialog for one agent — shared by the Agents tab and the
 * chat bubbles (click an agent to inspect it). */

      {viewing && (
        <AgentDetailsDialog
          agent={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setViewing(null);
            setDescPreview(false);
            setDraft({ ...viewing, isNew: false });
          }}
        />
      )}
      <h4 className="apanel__group-title">Extension agents</h4>
      <div className="apanel__servers">
        {agents.map((agent) => (
          <section
            key={agent.id}
            className={`apanel__server${agent.enabled ? '' : ' apanel__server--off'}`}
          >
            <div className="apanel__server-main">
              <div className="apanel__server-title">
                {agent.avatar ? (
                  <img className="apanel__avatar" src={agent.avatar} alt="" />
                ) : (
                  <span className={`apanel__dot${agent.enabled ? ' apanel__dot--on' : ''}`} />
                )}
                <strong>{agent.name}</strong>
                {agent.username && <span className="apanel__username">@{agent.username}</span>}
                {agent.role && <span className="apanel__role">{agent.role}</span>}
                {agent.team && <span className="apanel__role apanel__team">{agent.team}</span>}
              </div>
              {agent.description && (
                <p className="apanel__server-detail">{agent.description}</p>
              )}
              {(agent.tools.length > 0 || agent.skills.length > 0 || agent.mcpServers.length > 0) && (
                <p className="apanel__server-scope">
                  {[
                    agent.tools.length > 0 ? `${agent.tools.length} tools` : '',
                    agent.skills.length > 0 ? `${agent.skills.length} skills` : '',
                    agent.mcpServers.length > 0 ? `${agent.mcpServers.length} mcp` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            <div className="apanel__server-actions">
              <button
                type="button"
                className="apanel__view-btn"
                title="View details"
                onClick={() => setViewing(agent)}
              >
                <Eye size={12} strokeWidth={1.5} />
              </button>
              <label className="app-settings__switch" title="Enable">
                <input type="checkbox" checked={agent.enabled} onChange={() => toggle(agent.id)} />
                <i />
              </label>
              <button
                type="button"
                aria-label={`Edit ${agent.name}`}
                onClick={() => {
                  setDescPreview(false);
                  setDraft({ ...agent, isNew: false });
                }}
              >
                <Pencil size={11} strokeWidth={1.25} />
              </button>
              {confirmDelete === agent.id ? (
                <span className="apanel__confirm">
                  Delete?
                  <button
                    type="button"
                    onClick={() => {
                      persist(agents.filter((a) => a.id !== agent.id));
                      setConfirmDelete(null);
                    }}
                  >
                    Yes
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(null)}>No</button>
                </span>
              ) : (
                <button type="button" aria-label={`Delete ${agent.name}`} onClick={() => setConfirmDelete(agent.id)}>
                  <Trash2 size={11} strokeWidth={1.25} />
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {draft && (
        <div className="apanel__overlay" role="dialog" aria-label="Agent">
          <div className="apanel__dialog apanel__dialog--wide">
            <h3>{draft.isNew ? 'Add agent' : 'Edit agent'}</h3>

            <div className="apanel__avatar-row">
              {draft.avatar ? (
                <img className="apanel__avatar-preview" src={draft.avatar} alt="" />
              ) : (
                <span className="apanel__avatar-preview apanel__avatar-preview--empty">
                  {draft.name.trim().slice(0, 2).toUpperCase() || '?'}
                </span>
              )}
              <div className="apanel__avatar-actions">
                <button type="button" onClick={() => avatarInputRef.current?.click()}>
                  {draft.avatar ? 'Change picture' : 'Upload picture'}
                </button>
                {draft.avatar && (
                  <button type="button" onClick={() => setDraft({ ...draft, avatar: undefined })}>
                    Remove
                  </button>
                )}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    void pickAvatar(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </div>
            </div>

            <label className="apanel__field">
              <span>Name</span>
              <input
                autoFocus
                value={draft.name}
                placeholder="Test Runner"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="apanel__field">
              <span>Username</span>
              <input
                value={draft.username}
                placeholder="test-runner"
                disabled={Boolean(draft.builtIn)}
                title={draft.builtIn ? 'Built-in agents keep their @username' : undefined}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
              />
            </label>
            <label className="apanel__field">
              <span>Job title</span>
              <input
                value={draft.role}
                placeholder="Senior QA Engineer"
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              />
            </label>
            <label className="apanel__field">
              <span>Team</span>
              <select
                value={draft.team ?? ''}
                onChange={(event) => setDraft({ ...draft, team: event.target.value })}
              >
                <option value="">No team</option>
                {AGENT_TEAMS.map((team) => (
                  <option key={team} value={team}>
                    {team}
                  </option>
                ))}
              </select>
            </label>
            <label className="apanel__field">
              <span>Provider</span>
              <select
                value={draft.providerId ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, providerId: event.target.value, model: '', effort: undefined })
                }
              >
                <option value="">Global active provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="apanel__field">
              <span>Model</span>
              <select
                value={draft.model ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value, effort: undefined })
                }
                disabled={!draft.providerId}
              >
                <option value="">Follow chat (global active)</option>
                {(providers.find((p) => p.id === draft.providerId)?.models ?? [])
                  .filter((m) => m.enabled)
                  .map((m) => (
                    <option key={m.id} value={m.name}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="apanel__field">
              <span>Effort</span>
              <select
                value={draft.effort ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, effort: event.target.value || undefined })
                }
                disabled={!draft.providerId || !draft.model}
                title="Reasoning effort this agent forces on its model"
              >
                <option value="">Model default</option>
                {(providers
                  .find((p) => p.id === draft.providerId)
                  ?.models.find((m) => m.name === draft.model)?.reasoningLevels ?? []).map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <div className="apanel__field">
              <div className="apanel__field-head">
                <span>Description (markdown supported)</span>
                <div className="apanel__toggle">
                  <button
                    type="button"
                    className={!descPreview ? 'apanel__toggle--on' : ''}
                    onClick={() => setDescPreview(false)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={descPreview ? 'apanel__toggle--on' : ''}
                    onClick={() => setDescPreview(true)}
                  >
                    Preview
                  </button>
                </div>
              </div>
              {!descPreview && (
                <div className="ai-composer__mdtools" role="toolbar" aria-label="Markdown formatting">
                  <button type="button" title="Bold **…**" onClick={() => applyDescMd('**', '**', 'bold')}>
                    <Bold size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Italic _…_" onClick={() => applyDescMd('_', '_', 'italic')}>
                    <Italic size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Strikethrough ~~…~~" onClick={() => applyDescMd('~~', '~~', 'strike')}>
                    <Strikethrough size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Code" onClick={applyDescMdCode}>
                    <Code size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Heading ##" onClick={() => applyDescMdPrefix('## ')}>
                    <Heading2 size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Link […](url)" onClick={() => applyDescMd('[', '](https://)', 'link text')}>
                    <Link2 size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Bullet list -" onClick={() => applyDescMdPrefix('- ')}>
                    <List size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Quote >" onClick={() => applyDescMdPrefix('> ')}>
                    <Quote size={12} strokeWidth={1.5} />
                  </button>
                </div>
              )}
              {descPreview ? (
                <div className="apanel__preview">
                  {draft.description.trim() ? (
                    renderMarkdown(draft.description)
                  ) : (
                    <span className="apanel__foot">Nothing to preview yet.</span>
                  )}
                </div>
              ) : (
                <div className="ai-composer__input-wrap">
                  {descMention && (
                    <MentionMenu
                      candidates={descMentionList}
                      highlighted={descMentionPos}
                      onHover={setDescMentionIdx}
                      onPick={pickDescMention}
                      onOutside={() => {
                        setDescMention(null);
                        setDescMentionIdx(0);
                      }}
                      anchorRef={descRef}
                      direction="down"
                      label="Mention an agent"
                    />
                  )}
                  {descSkill && !descMention && (
                    <SkillMenu
                      candidates={descSkillList}
                      highlighted={descSkillPos}
                      onHover={setDescSkillIdx}
                      onPick={pickDescSkill}
                      onOutside={() => {
                        setDescSkill(null);
                        setDescSkillIdx(0);
                      }}
                      anchorRef={descRef}
                      direction="down"
                      label="Use a skill"
                    />
                  )}
                  <textarea
                    ref={descRef}
                    rows={3}
                    value={draft.description}
                    placeholder={'**CI Bot** runs the test suite\n- reports failures\n@other-agent tags a teammate, #skill-name uses a skill'}
                    onChange={(event) => {
                      const { value, selectionStart } = event.target;
                      setDraft({ ...draft, description: value });
                      const caret = selectionStart ?? value.length;
                      const at = detectMention(value, caret);
                      setDescMention(at);
                      setDescMentionIdx(0);
                      setDescSkill(at ? null : detectSkillToken(value, caret));
                      setDescSkillIdx(0);
                    }}
                    onKeyDown={(event) => {
                      if (descMention && descMentionList.length > 0) {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          const delta = event.key === 'ArrowUp' ? -1 : 1;
                          setDescMentionIdx((i) => (i + delta + descMentionList.length) % descMentionList.length);
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          event.preventDefault();
                          pickDescMention(descMentionList[descMentionPos]);
                          return;
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setDescMention(null);
                          setDescMentionIdx(0);
                          return;
                        }
                      }
                      if (descSkill && descSkillList.length > 0) {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          const delta = event.key === 'ArrowUp' ? -1 : 1;
                          setDescSkillIdx((i) => (i + delta + descSkillList.length) % descSkillList.length);
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          event.preventDefault();
                          pickDescSkill(descSkillList[descSkillPos]);
                          return;
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setDescSkill(null);
                          setDescSkillIdx(0);
                        }
                      }
                    }}
                  />
                </div>
              )}
            </div>

            <div className="apanel__field">
              <span>Tools it can use</span>
              <div className="apanel__members">
                {AGENT_TOOLS.map((tool) => (
                  <label key={tool.id} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.tools.some(key => agentToolId(key) === tool.id)}
                      onChange={() => toggleDraftMember('tools', tool.id)}
                    />
                    {tool.name}
                  </label>
                ))}
              </div>
            </div>

            <div className="apanel__field">
              <span>Skills it can use {skillNames.length === 0 && '(none in .pigry/skills/)'}</span>
              <div className="apanel__members">
                {skillNames.map((skill) => (
                  <label key={skill} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.skills.includes(skill)}
                      onChange={() => toggleDraftMember('skills', skill)}
                    />
                    {skill}
                  </label>
                ))}
              </div>
            </div>

            <div className="apanel__field">
              <span>MCP servers it can use {mcpNames.length === 0 && '(none configured)'}</span>
              <div className="apanel__members">
                {mcpNames.map((name) => (
                  <label key={name} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.mcpServers.includes(name)}
                      onChange={() => toggleDraftMember('mcpServers', name)}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </div>

            <div className="apanel__dialog-actions">
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button
                type="button"
                className="apanel__dialog-primary"
                disabled={!draft.name.trim()}
                onClick={submit}
              >
                {draft.isNew ? 'Add' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Hooks tab (lifecycle commands run around agent sends) ---- */

const HOOK_EVENT_LABEL: Record<HookEvent, string> = {
  'before-send': 'Before send',
  'after-reply': 'After reply',
};

export function HooksTab() {
  const [hooks, setHooks] = useState<HookEntry[]>(() => loadHooks());
  const [draft, setDraft] = useState<(HookEntry & { isNew: boolean }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const persist = useCallback((next: HookEntry[]) => {
    setHooks(next);
    saveHooks(next);
  }, []);

  const toggle = (id: string) => {
    persist(hooks.map((hook) => (hook.id === id ? { ...hook, enabled: !hook.enabled } : hook)));
  };

  const submit = () => {
    if (!draft || !draft.command.trim()) return;
    const entry: HookEntry = {
      id: draft.id,
      event: draft.event,
      command: draft.command.trim(),
      enabled: draft.enabled,
    };
    if (draft.isNew) persist([...hooks, entry]);
    else persist(hooks.map((hook) => (hook.id === draft.id ? entry : hook)));
    setDraft(null);
  };

  return (
    <div className="apanel">
      <p className="apanel__intro">
        Shell commands run automatically in the repository root — <code>before-send</code> fires
        when you submit a message, <code>after-reply</code> when the agent finishes.
      </p>
      <button
        type="button"
        className="apanel__add"
        onClick={() =>
          setDraft({ id: `hook-${Date.now().toString(36)}`, event: 'before-send', command: '', enabled: true, isNew: true })
        }
      >
        <Plus size={11} strokeWidth={1.5} />
        Add hook
      </button>
      {hooks.length === 0 && (
        <div className="apanel__empty">
          <p>No hooks configured.</p>
        </div>
      )}
      <div className="apanel__servers">
        {hooks.map((hook) => (
          <section
            key={hook.id}
            className={`apanel__server${hook.enabled ? '' : ' apanel__server--off'}`}
          >
            <div className="apanel__server-main">
              <div className="apanel__server-title">
                <span className={`apanel__dot${hook.enabled ? ' apanel__dot--on' : ''}`} />
                <span className="apanel__transport">{HOOK_EVENT_LABEL[hook.event]}</span>
              </div>
              <p className="apanel__server-detail">$ {hook.command}</p>
            </div>
            <div className="apanel__server-actions">
              <label className="app-settings__switch" title="Enable">
                <input type="checkbox" checked={hook.enabled} onChange={() => toggle(hook.id)} />
                <i />
              </label>
              <button type="button" aria-label="Edit hook" onClick={() => setDraft({ ...hook, isNew: false })}>
                <Pencil size={11} strokeWidth={1.25} />
              </button>
              {confirmDelete === hook.id ? (
                <span className="apanel__confirm">
                  Delete?
                  <button
                    type="button"
                    onClick={() => {
                      persist(hooks.filter((h) => h.id !== hook.id));
                      setConfirmDelete(null);
                    }}
                  >
                    Yes
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(null)}>No</button>
                </span>
              ) : (
                <button type="button" aria-label="Delete hook" onClick={() => setConfirmDelete(hook.id)}>
                  <Trash2 size={11} strokeWidth={1.25} />
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {draft && (
        <div className="apanel__overlay" role="dialog" aria-label="Hook">
          <div className="apanel__dialog">
            <h3>{draft.isNew ? 'Add hook' : 'Edit hook'}</h3>
            <label className="apanel__field">
              <span>Event</span>
              <select
                value={draft.event}
                onChange={(event) => setDraft({ ...draft, event: event.target.value as HookEvent })}
              >
                <option value="before-send">before-send</option>
                <option value="after-reply">after-reply</option>
              </select>
            </label>
            <label className="apanel__field">
              <span>Command</span>
              <input
                autoFocus
                value={draft.command}
                placeholder="npm test -- --silent"
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
            </label>
            <div className="apanel__dialog-actions">
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button
                type="button"
                className="apanel__dialog-primary"
                disabled={!draft.command.trim()}
                onClick={submit}
              >
                {draft.isNew ? 'Add' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Plugins tab (bundles that toggle agents + hooks together) ---- */

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginEntry[]>(() => loadPlugins());
  const [agents, setAgents] = useState<AgentEntry[]>(() => loadAgents());
  const [hooks, setHooks] = useState<HookEntry[]>(() => loadHooks());
  const [draft, setDraft] = useState<(PluginEntry & { isNew: boolean }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const persist = useCallback((next: PluginEntry[]) => {
    setPlugins(next);
    savePlugins(next);
  }, []);

  const toggle = (plugin: PluginEntry) => {
    const on = !plugin.enabled;
    applyPlugin({ ...plugin, enabled: on }, on);
    setAgents(loadAgents());
    setHooks(loadHooks());
    persist(plugins.map((p) => (p.id === plugin.id ? { ...p, enabled: on } : p)));
  };

  const submit = () => {
    if (!draft || !draft.name.trim()) return;
    const entry: PluginEntry = {
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      enabled: false,
      agentIds: draft.agentIds,
      hookIds: draft.hookIds,
    };
    persist(draft.isNew ? [...plugins, entry] : plugins.map((p) => (p.id === draft.id ? entry : p)));
    setDraft(null);
  };

  const toggleMember = (kind: 'agentIds' | 'hookIds', id: string) => {
    if (!draft) return;
    const ids = new Set(draft[kind]);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    setDraft({ ...draft, [kind]: [...ids] });
  };

  return (
    <div className="apanel">
      <p className="apanel__intro">
        A plugin bundles agents and hooks under one switch — turning it on enables exactly those
        members.
      </p>
      <button
        type="button"
        className="apanel__add"
        onClick={() =>
          setDraft({
            id: `plugin-${Date.now().toString(36)}`,
            name: '',
            description: '',
            enabled: false,
            agentIds: [],
            hookIds: [],
            isNew: true,
          })
        }
      >
        <Plus size={11} strokeWidth={1.5} />
        New plugin
      </button>
      {plugins.length === 0 && (
        <div className="apanel__empty">
          <p>No plugins yet — bundle agents and hooks to make one.</p>
        </div>
      )}
      <div className="apanel__servers">
        {plugins.map((plugin) => (
          <section
            key={plugin.id}
            className={`apanel__server${plugin.enabled ? '' : ' apanel__server--off'}`}
          >
            <div className="apanel__server-main">
              <div className="apanel__server-title">
                <span className={`apanel__dot${plugin.enabled ? ' apanel__dot--on' : ''}`} />
                <strong>{plugin.name}</strong>
              </div>
              <p className="apanel__server-detail">
                {plugin.agentIds.length} agent{plugin.agentIds.length === 1 ? '' : 's'} ·{' '}
                {plugin.hookIds.length} hook{plugin.hookIds.length === 1 ? '' : 's'}
                {plugin.description ? ` — ${plugin.description}` : ''}
              </p>
            </div>
            <div className="apanel__server-actions">
              <label className="app-settings__switch" title="Toggle plugin">
                <input type="checkbox" checked={plugin.enabled} onChange={() => toggle(plugin)} />
                <i />
              </label>
              <button type="button" aria-label={`Edit ${plugin.name}`} onClick={() => setDraft({ ...plugin, isNew: false })}>
                <Pencil size={11} strokeWidth={1.25} />
              </button>
              {confirmDelete === plugin.id ? (
                <span className="apanel__confirm">
                  Delete?
                  <button
                    type="button"
                    onClick={() => {
                      persist(plugins.filter((p) => p.id !== plugin.id));
                      setConfirmDelete(null);
                    }}
                  >
                    Yes
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(null)}>No</button>
                </span>
              ) : (
                <button type="button" aria-label={`Delete ${plugin.name}`} onClick={() => setConfirmDelete(plugin.id)}>
                  <Trash2 size={11} strokeWidth={1.25} />
                </button>
              )}
            </div>
          </section>
        ))}
      </div>

      {draft && (
        <div className="apanel__overlay" role="dialog" aria-label="Plugin">
          <div className="apanel__dialog">
            <h3>{draft.isNew ? 'New plugin' : 'Edit plugin'}</h3>
            <label className="apanel__field">
              <span>Name</span>
              <input
                autoFocus
                value={draft.name}
                placeholder="pre-commit checks"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="apanel__field">
              <span>Description</span>
              <input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className="apanel__field">
              <span>Agents in this plugin</span>
              {agents.length === 0 ? (
                <p className="apanel__foot">No agents defined.</p>
              ) : (
                agents.map((agent) => (
                  <label key={agent.id} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.agentIds.includes(agent.id)}
                      onChange={() => toggleMember('agentIds', agent.id)}
                    />
                    {agent.name}
                  </label>
                ))
              )}
            </div>
            <div className="apanel__field">
              <span>Hooks in this plugin</span>
              {hooks.length === 0 ? (
                <p className="apanel__foot">No hooks defined.</p>
              ) : (
                hooks.map((hook) => (
                  <label key={hook.id} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.hookIds.includes(hook.id)}
                      onChange={() => toggleMember('hookIds', hook.id)}
                    />
                    <span className="apanel__tool-name">{hook.command}</span>
                  </label>
                ))
              )}
            </div>
            <div className="apanel__dialog-actions">
              <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button
                type="button"
                className="apanel__dialog-primary"
                disabled={!draft.name.trim()}
                onClick={submit}
              >
                {draft.isNew ? 'Create' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

