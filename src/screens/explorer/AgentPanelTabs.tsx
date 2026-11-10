/** Compact Tools and MCP sections that dock inside the AI Agent panel
 * (Explorer layout, ~360px wide). Same stores as the agent context builder:
 * lib/agentTools.ts and lib/mcpServers.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Check,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  Pencil,
  Plug,
  Plus,
  Quote,
  Strikethrough,
  Trash2,
} from 'lucide-react';
import {
  AGENT_TOOLS,
  loadEnabledTools,
  saveEnabledTools,
  TOOL_GROUPS,
} from '../../lib/agentTools';
import { getFileTree } from '../../lib/tauriClient';
import { renderMarkdown } from '../../lib/markdown';
import {
  loadMcpServers,
  mcpJsonExport,
  saveMcpServers,
  type McpServer,
  type McpTransport,
} from '../../lib/mcpServers';
import {
  applyPlugin,
  INSTRUCTIONS_PATH,
  AGENT_TEAMS,
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

/* ---- Instructions tab (.orbit/instructions.md, real repo file) ---- */

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
      notify('Instructions saved to .orbit/instructions.md', 'success');
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

/** Reads the repo's skill names from .orbit/skills/*.md. */
async function listSkillNames(): Promise<string[]> {
  try {
    const tree = await getFileTree();
    return tree.entries
      .filter((p) => p.startsWith('.orbit/skills/') && p.endsWith('.md'))
      .map((p) => p.split('/').pop()?.replace(/\.md$/, '') ?? '')
      .filter(Boolean);
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

export function AgentsTab({ defaultTeam }: { defaultTeam?: string } = {}) {
  const [agents, setAgents] = useState<AgentEntry[]>(() => loadAgents());
  // Repo hydration: seed localStorage from .orbit/agents.json when empty
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
    const ids = new Set(draft[kind]);
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
    const entry: AgentEntry = {
      id: draft.id,
      name: draft.name.trim(),
      username: draft.username.trim().replace(/^@/, ''),
      role: draft.role.trim(),
      team: draft.team?.trim() || undefined,
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
          <p>No agents defined yet.</p>
        </div>
      )}
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
                <textarea
                  ref={descRef}
                  rows={3}
                  value={draft.description}
                  placeholder={'**CI Bot** runs the test suite\n- reports failures'}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              )}
            </div>

            <div className="apanel__field">
              <span>Tools it can use</span>
              <div className="apanel__members">
                {AGENT_TOOLS.map((tool) => (
                  <label key={tool.id} className="apanel__member">
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(tool.id)}
                      onChange={() => toggleDraftMember('tools', tool.id)}
                    />
                    {tool.name}
                  </label>
                ))}
              </div>
            </div>

            <div className="apanel__field">
              <span>Skills it can use {skillNames.length === 0 && '(none in .orbit/skills/)'}</span>
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

