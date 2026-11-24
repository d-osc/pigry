/** One extension of the store on its own page: what it is, every agent and skill it adds, what it can do on this
 * computer, and the Install button. */
import { useState } from 'react';
import { ArrowLeft, Bot, Check, Puzzle, ShieldCheck, Terminal, Wand2 } from 'lucide-react';
import type { StoreEntry } from '../../lib/extensionCatalog';
import { needsTrust } from '../../lib/extensionManifest';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Props {
  entry: StoreEntry;
  installed: boolean;
  onBack: () => void;
  onInstall: () => void;
  onManage: () => void;
}

export function ExtensionDetail({ entry, installed, onBack, onInstall, onManage }: Props) {
  const { manifest, category, tags } = entry;
  const [openSkills, setOpenSkills] = useState<Set<string>>(() => new Set());
  const tools = [...new Set(manifest.agents.flatMap((agent) => agent.tools))].sort();
  const runsPrograms = needsTrust(manifest);
  const toggleSkill = (id: string) => setOpenSkills((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <article className="ext-detail" aria-label={`${manifest.name} extension`}>
      <button type="button" className="store-link ext-detail__back" onClick={onBack}><ArrowLeft size={13} strokeWidth={1.5} /> Extension Store</button>

      <header className="ext-detail__head">
        <span className="ext-detail__icon" aria-hidden="true"><Puzzle size={34} strokeWidth={1.25} /></span>
        <div className="ext-detail__titles">
          <h2>{manifest.name}</h2>
          <p className="ext-card__meta">{manifest.author} · v{manifest.version} · {category}</p>
          <p className="ext-detail__lead">{manifest.description}</p>
          <p className="ext-chips">
            <span>{count(manifest.agents.length, 'agent')}</span>
            <span>{count(manifest.skills.length, 'skill')}</span>
            <span>{runsPrograms ? 'Runs programs' : 'Runs nothing'}</span>
          </p>
        </div>
        <div className="ext-detail__actions">
          {installed ? (
            <>
              <span className="ext-installed"><Check size={13} strokeWidth={1.75} /> Installed</span>
              <button type="button" className="ext-btn" onClick={onManage}>Manage</button>
            </>
          ) : (
            <button type="button" className="ext-btn ext-btn--primary ext-detail__install" aria-label={`Install ${manifest.name}`} onClick={onInstall}>Install</button>
          )}
        </div>
      </header>

      <div className="ext-detail__layout">
        <div className="ext-detail__main">
          <section aria-label="About">
            <h3>About</h3>
            <p>{manifest.description}</p>
            <p>
              Installing adds {count(manifest.agents.length, 'agent')} you can @mention in any AI Agent panel and {count(manifest.skills.length, 'skill')} you can
              attach to a message with #. {runsPrograms
                ? 'It also adds hooks or MCP servers that run programs on this computer; you review them before anything is installed.'
                : 'It does not add hooks or MCP servers, so installing it never runs anything on your computer.'}
            </p>
          </section>

          <section aria-label="Agents">
            <h3><Bot size={15} strokeWidth={1.5} /> Agents <span className="ext-count">{manifest.agents.length}</span></h3>
            <div className="ext-detail__list">
              {manifest.agents.map((agent) => (
                <div key={agent.username} className="ext-detail__item">
                  <div className="ext-detail__item-head">
                    <span className="ext-detail__emoji" aria-hidden="true">{agent.emoji ?? '🧩'}</span>
                    <div>
                      <strong>{agent.name}</strong> <code>@{agent.username}</code>
                      <p className="ext-card__meta">{agent.role}</p>
                    </div>
                  </div>
                  <p>{agent.description}</p>
                  <p className="ext-chips">
                    {agent.tools.map((tool) => <span key={tool}>{tool}</span>)}
                  </p>
                  {agent.skills.length > 0 && <p className="ext-card__meta">Uses {agent.skills.map((skill) => `#${skill}`).join(', ')}</p>}
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Skills">
            <h3><Wand2 size={15} strokeWidth={1.5} /> Skills <span className="ext-count">{manifest.skills.length}</span></h3>
            <div className="ext-detail__list">
              {manifest.skills.map((skill) => {
                const open = openSkills.has(skill.id);
                const lines = skill.content.split('\n');
                return (
                  <div key={skill.id} className="ext-detail__item">
                    <div className="ext-detail__item-head">
                      <div>
                        <strong>{skill.name}</strong> <code>#{skill.id}</code>
                        <p className="ext-card__meta">{skill.description}</p>
                      </div>
                    </div>
                    <pre className="ext-detail__skill">{(open ? lines : lines.slice(0, 6)).join('\n')}</pre>
                    {lines.length > 6 && (
                      <button type="button" className="store-link" aria-expanded={open} onClick={() => toggleSkill(skill.id)}>
                        {open ? 'Show less' : `Show all ${lines.length} lines`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="ext-detail__side" aria-label="Details">
          <h3>Details</h3>
          <dl>
            <dt>Publisher</dt><dd>{manifest.author}</dd>
            <dt>Version</dt><dd>{manifest.version}</dd>
            <dt>Identifier</dt><dd><code>{manifest.id}</code></dd>
            <dt>Category</dt><dd>{category}</dd>
            <dt>Tags</dt>
            <dd className="ext-chips">{tags.map((tag) => <span key={tag}>{tag}</span>)}</dd>
          </dl>
          <h3><ShieldCheck size={15} strokeWidth={1.5} /> What it can do</h3>
          <dl>
            <dt>Runs commands</dt><dd>{manifest.hooks.length > 0 ? `Yes — ${count(manifest.hooks.length, 'hook')}` : 'No hooks'}</dd>
            <dt>Starts programs</dt><dd>{manifest.mcpServers.length > 0 ? `Yes — ${count(manifest.mcpServers.length, 'MCP server')}` : 'No MCP servers'}</dd>
            <dt>Tools its agents may use</dt>
            <dd className="ext-chips">{tools.map((tool) => <span key={tool}>{tool}</span>)}</dd>
          </dl>
          <h3><Terminal size={15} strokeWidth={1.5} /> How to use it</h3>
          <ul className="ext-detail__how">
            {manifest.agents.slice(0, 2).map((agent) => <li key={agent.username}>Type <code>@{agent.username}</code> in an AI Agent panel and ask it what you need.</li>)}
            {manifest.skills.slice(0, 1).map((skill) => <li key={skill.id}>Add <code>#{skill.id}</code> to a message to give any agent this skill.</li>)}
          </ul>
        </aside>
      </div>
    </article>
  );
}
