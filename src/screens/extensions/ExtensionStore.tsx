/** The Extension Store: search the extensions Pigry offers, see what each one adds, and install it. What is installed
 * is managed in Settings › Extensions. */
import { useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Puzzle, Search, Settings, Wand2 } from 'lucide-react';
import { useDisabledMenus, useExtensions } from '../../hooks/useExtensions';
import { OPEN_SETTINGS_EVENT } from '../../lib/builtinExtensions';
import { searchStore, STORE_CATALOG, STORE_CATEGORIES } from '../../lib/extensionCatalog';
import { BUILTIN_CATEGORY, BuiltinCard, BuiltinDetail, builtinEntries, searchBuiltins } from './BuiltinExtensions';
import { ExtensionDetail } from './ExtensionDetail';
import { useExtensionInstall } from './useExtensionInstall';
import './ExtensionsPanel.css';

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function ExtensionStore() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The extension shown on its own page (null: the list). The search and category stay as they were when you come back.
  const [pageId, setPageId] = useState<string | null>(null);
  const installed = useExtensions();
  const disabledMenus = useDisabledMenus();
  const { startReview, feedback, dialog } = useExtensionInstall();
  const results = useMemo(() => searchStore(STORE_CATALOG, query, category), [query, category]);
  const builtins = useMemo(() => searchBuiltins(query, category), [query, category]);
  const total = results.length + builtins.length;
  const installedIds = new Set(installed.map((extension) => extension.id));

  const openSettings = (id?: string) => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: 'extensions', extensionId: id } }));
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const builtinPage = pageId ? builtinEntries().find((item) => item.id === pageId) : undefined;
  if (builtinPage) {
    return (
      <div className="ext-panel ext-store">
        <BuiltinDetail item={builtinPage} enabled={!disabledMenus.has(builtinPage.id)} onBack={() => setPageId(null)} />
      </div>
    );
  }

  const page = pageId ? STORE_CATALOG.find((entry) => entry.manifest.id === pageId) : undefined;
  if (page) {
    return (
      <div className="ext-panel ext-store">
        {feedback}
        <ExtensionDetail
          entry={page}
          installed={installedIds.has(page.manifest.id)}
          onBack={() => setPageId(null)}
          onInstall={() => void startReview(page.manifest, 'catalog')}
          onManage={() => openSettings(page.manifest.id)}
        />
        {dialog}
      </div>
    );
  }

  return (
    <div className="ext-panel ext-store">
      <div className="store-search">
        <Search size={15} strokeWidth={1.5} />
        <input
          type="search"
          aria-label="Search extensions"
          placeholder="Search extensions, agents and skills"
          value={query}
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="store-cats" role="group" aria-label="Categories">
        {['', ...STORE_CATEGORIES, BUILTIN_CATEGORY].map((name) => (
          <button key={name || 'all'} type="button" aria-pressed={category === name} className={`store-cat${category === name ? ' store-cat--on' : ''}`} onClick={() => setCategory(name)}>
            {name || 'All'}
          </button>
        ))}
      </div>

      {feedback}

      <p className="ext-hint" role="status">
        {total === 0 ? 'No extensions match.' : `${count(total, 'extension')}${query.trim() || category ? ' found' : ''}`}
        {' · '}
        <button type="button" className="store-link" onClick={() => openSettings()}><Settings size={11} strokeWidth={1.5} /> Manage installed extensions</button>
      </p>

      {total === 0 && (
        <div className="ext-empty">
          <p>Nothing matches “{query.trim()}”{category ? ` in ${category}` : ''}.</p>
          <button type="button" className="ext-btn" onClick={() => { setQuery(''); setCategory(''); }}>Clear search</button>
        </div>
      )}

      <div className="store-grid">
        {builtins.map((item) => <BuiltinCard key={item.id} item={item} enabled={!disabledMenus.has(item.id)} onOpenPage={() => setPageId(item.id)} />)}
        {results.map(({ manifest, category: cardCategory }) => {
          const isInstalled = installedIds.has(manifest.id);
          const expanded = open.has(manifest.id);
          return (
            <article key={manifest.id} className="ext-card store-card" aria-label={manifest.name}>
              <button type="button" className="store-card__open" aria-label={`Open ${manifest.name}`} onClick={() => setPageId(manifest.id)}>
                <span className="ext-card__head">
                  <Puzzle size={18} strokeWidth={1.5} className="ext-card__icon" />
                  <span className="ext-card__main">
                    <strong>{manifest.name}</strong>
                    <span className="ext-card__meta">v{manifest.version} · {manifest.author}</span>
                  </span>
                </span>
                <span className="ext-card__desc">{manifest.description}</span>
                <span className="ext-chips">
                  <span>{cardCategory}</span>
                  <span>{count(manifest.agents.length, 'agent')}</span>
                  <span>{count(manifest.skills.length, 'skill')}</span>
                </span>
              </button>
              {expanded && (
                <div className="ext-contents">
                  {manifest.agents.map((agent) => <p key={agent.username}><Bot size={12} strokeWidth={1.5} /> <strong>@{agent.username}</strong> {agent.role}</p>)}
                  {manifest.skills.map((skill) => <p key={skill.id}><Wand2 size={12} strokeWidth={1.5} /> <strong>#{skill.id}</strong> {skill.name}</p>)}
                </div>
              )}
              <div className="store-card__foot">
                <button type="button" className="store-link" aria-expanded={expanded} aria-label={`What ${manifest.name} adds`} onClick={() => toggle(manifest.id)}>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} What it adds
                </button>
                {isInstalled ? (
                  <span className="store-card__installed">
                    <span className="ext-installed"><Check size={12} strokeWidth={1.75} /> Installed</span>
                    <button type="button" className="store-link" onClick={() => openSettings(manifest.id)}>Manage</button>
                  </span>
                ) : (
                  <button type="button" className="ext-btn ext-btn--primary" aria-label={`Install ${manifest.name}`} onClick={() => void startReview(manifest, 'catalog')}>Install</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}
