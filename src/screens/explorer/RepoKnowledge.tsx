/** Project knowledge dialogs — memory + skills, stored IN the working repo
 * so they are versionable with the code:
 *   memory → three vector tiers: project-wide (.pigry/memory.vector.json),
 *     team-shared (.pigry/teams/<team>/memory.vector.json) and per-agent
 *     (.pigry/teams/<team>/agents/<user>/memory.vector.json), each with a
 *     human-readable .md mirror
 *   skills → .pigry/skills/<slug>.md (one markdown file per skill)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  deleteWorktreeFile,
  getFileTree,
  memoryAdd,
  memoryList,
  memoryRemove,
  memorySearch,
  readWorktreeFile,
  writeWorktreeFile,
  type MemoryEntry,
} from '../../lib/tauriClient';
import { loadAgents } from '../../lib/agentExtras';
import type { AgentEntry } from '../../lib/agentExtras';
import './RepoKnowledge.css';

const SKILLS_DIR = '.pigry/skills/';

/** Memory storage tiers — main (project-wide), team-shared, agent-private. */
type MemoryTier = 'main' | 'team' | 'agent';

const TIER_LABEL: Record<MemoryTier, string> = {
  main: 'Main',
  team: 'Team',
  agent: 'Agent',
};

const TIER_PATH: Record<MemoryTier, string> = {
  main: '.pigry/memory.vector.json (scope: project)',
  team: '.pigry/memory.vector.json (scope: team/<team>)',
  agent: '.pigry/memory.vector.json (scope: agent/<team>/<user>)',
};

/** Vector-backed memory across three tiers: project-wide, team-shared and
 * per-agent stores — each with list / semantic search / add / remove. */
export function MemoryDialog({
  onClose,
  notify,
  /** Team name — scopes team and agent tiers to .pigry/teams/<team>/. */
  team,
}: {
  onClose: () => void;
  notify: (m: string, t?: 'success' | 'error') => void;
  team?: string;
}) {
  const resolvedTeam = team || 'Copilot';
  const [tier, setTier] = useState<MemoryTier>('main');
  const [agentUser, setAgentUser] = useState('');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  /** Uncontrolled input — value read from the DOM on submit so external
   * value-setters (automation, IMEs) that skip React onChange still work. */
  const draftRef = useRef<HTMLInputElement | null>(null);
  const queryRef = useRef<HTMLInputElement | null>(null);

  // Agents available for the agent tier (enabled ones from the Agents tab).
  // Read synchronously from localStorage at init — no effect needed.
  const [agents] = useState<AgentEntry[]>(() =>
    loadAgents().filter((agent) => agent.enabled && agent.username),
  );

  const scopeArgs = useCallback((): [string?, string?] => {
    if (tier === 'team') return [resolvedTeam, undefined];
    if (tier === 'agent') return agentUser ? [resolvedTeam, agentUser] : [undefined, undefined];
    return [undefined, undefined];
  }, [tier, resolvedTeam, agentUser]);

  const load = useCallback(async () => {
    const [t, a] = scopeArgs();
    try {
      setEntries(await memoryList(t, a));
    } catch {
      setEntries([]);
    }
    setLoaded(true);
  }, [scopeArgs]);

  // Initial load + reload when the tier/agent scope changes.
  useEffect(() => {
    let cancelled = false;
    const [t, a] = scopeArgs();
    (async () => {
      try {
        const list = await memoryList(t, a);
        if (!cancelled) setEntries(list);
      } catch {
        if (!cancelled) setEntries([]);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeArgs]);

  // Live semantic search (250 ms debounce on the raw input value).
  useEffect(() => {
    if (!loaded) return;
    const handle = window.setTimeout(async () => {
      const q = queryRef.current?.value.trim() ?? '';
      const [t, a] = scopeArgs();
      if (!q) {
        try {
          setEntries(await memoryList(t, a));
        } catch {
          setEntries([]);
        }
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const hits = await memorySearch(q, 20, t, a);
        setEntries(
          hits.map((hit) => ({
            id: hit.id,
            text: hit.text,
            vector: [],
            createdAt: hit.createdAt,
          })),
        );
      } catch {
        setEntries([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, loaded, scopeArgs]);

  const addEntry = async () => {
    const line = draftRef.current?.value.trim() ?? '';
    if (!line) return;
    const [t, a] = scopeArgs();
    try {
      await memoryAdd(line, t, a);
      if (draftRef.current) draftRef.current.value = '';
      notify('Memory saved', 'success');
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const removeEntry = async (id: string) => {
    const [t, a] = scopeArgs();
    try {
      await memoryRemove(id, t, a);
      notify('Memory removed', 'success');
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const agentChoices = agents.length > 0 ? agents : [];

  return (
    <div
      className="know-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="know-dlg" role="dialog" aria-modal="true" aria-label="Project memory">
        <header className="know-dlg__head">
          <div>
            <strong className="know-dlg__title">Project memory</strong>
            <p className="know-dlg__sub">
              Semantic vector database in three tiers — main, team-shared and per-agent.
              Stored in the repo and versioned with the code.
            </p>
          </div>
          <button type="button" className="know-dlg__close" onClick={onClose} aria-label="Close memory">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>
        <div className="know-dlg__body">
          <div className="know-tier-row">
            {(['main', 'team', 'agent'] as MemoryTier[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`know-tier-btn${tier === t ? ' know-tier-btn--on' : ''}`}
                onClick={() => {
                  setTier(t);
                  setLoaded(false);
                }}
              >
                {TIER_LABEL[t]}
              </button>
            ))}
          </div>
          {tier === 'agent' && (
            <label className="know-dlg__field know-dlg__field--row">
              <span className="know-dlg__label">Agent</span>
              <select
                className="know-dlg__input"
                value={agentUser}
                onChange={(event) => setAgentUser(event.target.value)}
                aria-label="Agent memory store"
              >
                <option value="">Select an agent…</option>
                {agentChoices.map((agent) => (
                  <option key={agent.id} value={agent.username}>
                    {agent.name} (@{agent.username})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="know-dlg__store-path">
            <code>{TIER_PATH[tier].replace('<team>', resolvedTeam).replace('<user>', agentUser || '<user>')}</code>
          </p>
          <input
            ref={queryRef}
            className="know-dlg__input know-dlg__search"
            placeholder="Semantic search… (ranked by similarity)"
            aria-label="Search memories"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {!loaded && <p className="know-dlg__empty">Loading…</p>}
          {loaded && tier === 'agent' && !agentUser && (
            <p className="know-dlg__empty">Pick an agent above to browse its memory.</p>
          )}
          {loaded && entries.length === 0 && (
            <p className="know-dlg__empty">No memories yet — add one below.</p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="know-row">
              <span className="know-row__text">{entry.text}</span>
              <button
                type="button"
                className="know-row__del"
                aria-label={`Remove memory: ${entry.text}`}
                onClick={() => void removeEntry(entry.id)}
              >
                <Trash2 size={11} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          {searching && <p className="know-dlg__empty">Searching…</p>}
        </div>
        <form
          className="know-dlg__foot"
          onSubmit={(event) => {
            event.preventDefault();
            void addEntry();
          }}
        >
          <input
            ref={draftRef}
            className="know-dlg__input"
            placeholder="e.g. Tests must run serially on Windows"
            aria-label="New memory"
            spellCheck={false}
          />
          <button type="submit" className="know-dlg__add">
            <Plus size={12} strokeWidth={2} />
            Add
          </button>
        </form>
      </div>
    </div>
  );
}export function SkillsDialog({ onClose, notify }: { onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void }) {
  const [skills, setSkills] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Uncontrolled new-skill name (read from the DOM on submit). */
  const newNameRef = useRef<HTMLInputElement | null>(null);
  /** Currently open skill: name + body being edited. */
  const [editing, setEditing] = useState<{ name: string; body: string; isNew: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      const tree = await getFileTree();
      const names = tree.entries
        .filter((p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'))
        .map((p) => p.slice(SKILLS_DIR.length, -3))
        .sort();
      setSkills(names);
    } catch {
      setSkills([]);
    }
    setLoaded(true);
  }, []);

  // One-shot initial load with the cancelled guard (react-hooks v7 rule).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tree = await getFileTree();
        if (cancelled) return;
        setSkills(
          tree.entries
            .filter((p) => p.startsWith(SKILLS_DIR) && p.endsWith('.md'))
            .map((p) => p.slice(SKILLS_DIR.length, -3))
            .sort(),
        );
      } catch {
        if (!cancelled) setSkills([]);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const slugOf = (name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'skill';

  const openSkill = async (name: string) => {
    try {
      const file = await readWorktreeFile(`${SKILLS_DIR}${name}.md`);
      // Drop the leading "# Title" line — the name is shown separately.
      const body = file.content.replace(/^#\s+.*\n/, '').trimStart();
      setEditing({ name, body, isNew: false });
    } catch {
      setEditing({ name, body: '', isNew: false });
    }
  };

  const createSkill = async () => {
    const name = newNameRef.current?.value.trim() ?? '';
    if (!name) return;
    const slug = slugOf(name);
    try {
      await readWorktreeFile(`${SKILLS_DIR}${slug}.md`);
      notify(`Skill "${slug}" already exists`, 'error');
      return;
    } catch {
      // not found → good, we can create it
    }
    await writeWorktreeFile(`${SKILLS_DIR}${slug}.md`, `# ${name}\n\n`);
    if (newNameRef.current) newNameRef.current.value = '';
    await reload();
    setEditing({ name: slug, body: '', isNew: true });
    notify(`Skill "${slug}" created`, 'success');
  };

  const saveSkill = async () => {
    if (!editing) return;
    const body = `# ${editing.name}\n\n${editing.body.trimStart()}`;
    try {
      await writeWorktreeFile(`${SKILLS_DIR}${editing.name}.md`, body);
      notify(`Skill "${editing.name}" saved`, 'success');
      setEditing(null);
      await reload();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const removeSkill = async (name: string) => {
    try {
      await deleteWorktreeFile(`${SKILLS_DIR}${name}.md`);
      notify(`Skill "${name}" deleted`, 'success');
      await reload();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div
      className="know-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="know-dlg" role="dialog" aria-modal="true" aria-label="Project skills">
        <header className="know-dlg__head">
          <div>
            <strong className="know-dlg__title">Project skills</strong>
            <p className="know-dlg__sub">
              Reusable instructions the AI can follow — one markdown file per skill in{' '}
              <code>{SKILLS_DIR}</code>.
            </p>
          </div>
          <button type="button" className="know-dlg__close" onClick={onClose} aria-label="Close skills">
            <X size={13} strokeWidth={1.5} />
          </button>
        </header>

        {editing ? (
          <div className="know-dlg__body know-dlg__body--editor">
            <div className="know-editor__head">
              <code className="know-editor__name">{SKILLS_DIR}{editing.name}.md</code>
            </div>
            <textarea
              className="know-editor__body"
              value={editing.body}
              placeholder="Describe when to use this skill and step-by-step instructions…"
              spellCheck={false}
              onChange={(event) =>
                setEditing((prev) => (prev ? { ...prev, body: event.target.value } : prev))
              }
            />
            <div className="know-editor__actions">
              <button
                type="button"
                className="know-editor__btn"
                onClick={() => setEditing(null)}
                disabled={!editing.isNew}
                title={editing.isNew ? 'A new skill must be saved first' : 'Back to the skill list'}
              >
                Back
              </button>
              <button
                type="button"
                className="know-editor__btn know-editor__btn--primary"
                onClick={() => void saveSkill()}
              >
                <Check size={11} strokeWidth={2} />
                Save skill
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="know-dlg__body">
              {!loaded && <p className="know-dlg__empty">Loading…</p>}
              {loaded && skills.length === 0 && (
                <p className="know-dlg__empty">No skills yet — add one below.</p>
              )}
              {skills.map((name) => (
                <div key={name} className="know-row">
                  <button type="button" className="know-row__text know-row__text--btn" onClick={() => void openSkill(name)}>
                    {name}
                  </button>
                  <button
                    type="button"
                    className="know-row__del"
                    aria-label={`Edit skill: ${name}`}
                    onClick={() => void openSkill(name)}
                  >
                    <Pencil size={11} strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    className="know-row__del"
                    aria-label={`Delete skill: ${name}`}
                    onClick={() => void removeSkill(name)}
                  >
                    <Trash2 size={11} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
            </div>
            <form
              className="know-dlg__foot"
              onSubmit={(event) => {
                event.preventDefault();
                void createSkill();
              }}
            >
              <input
                ref={newNameRef}
                className="know-dlg__input"
                placeholder="New skill name, e.g. Run tests"
                aria-label="New skill name"
                spellCheck={false}
              />
              <button type="submit" className="know-dlg__add">
                <Plus size={12} strokeWidth={2} />
                Add
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
