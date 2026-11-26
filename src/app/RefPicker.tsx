/** VS Code-style "Select a ref to checkout" picker, opened from the branch name in the status bar: type to filter local
 * branches, remote branches and tags, Enter checks the highlighted one out. A remote branch becomes a local tracking
 * branch (or switches to the local one with that name); a tag is checked out as a detached HEAD. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, Cloud, CornerDownLeft, GitBranch, Plus, Search, Tag } from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { listCheckoutRefs, type CheckoutRefInfo } from '../lib/tauriClient';
import type { RepositoryState } from '../types/repository';
import './commandPalette/CommandPalette.css';
import './RefPicker.css';

type Row =
  | { id: string; section: string; kind: 'create'; name: string | null }
  | { id: string; section: string; kind: 'ref'; ref: CheckoutRefInfo };

const SECTIONS: Record<CheckoutRefInfo['kind'], string> = { local: 'Branches', remote: 'Remote branches', tag: 'Tags' };
const MAX_ROWS = 400;

/** What the app state already knows, shown until (or if) the full list cannot be loaded. */
function refsFromState(repository: RepositoryState): CheckoutRefInfo[] {
  const base = { shortOid: '', subject: '', timeSeconds: 0, isHead: false, remote: null, branch: null };
  return [
    ...repository.branches.map((b) => ({ ...base, kind: 'local' as const, name: b.name, isHead: b.isHead, shortOid: b.oid?.slice(0, 7) ?? '' })),
    ...repository.remotes.flatMap(({ remote, branches }) => branches.filter((b) => b !== 'HEAD').map((branch) => ({
      ...base, kind: 'remote' as const, name: `${remote}/${branch}`, remote, branch,
    }))),
    ...repository.tags.map((t) => ({ ...base, kind: 'tag' as const, name: t.name, shortOid: t.commitOid?.slice(0, 7) ?? '' })),
  ];
}

export function RefPicker({ onClose }: { onClose: () => void }) {
  const { repository, checkoutBranch, checkoutRemoteBranch, checkoutTag, createBranch } = useRepository();
  const [loaded, setLoaded] = useState<CheckoutRefInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let off = false;
    listCheckoutRefs().then(
      (refs) => { if (!off) setLoaded(refs); },
      () => { /* keep the refs from the app state */ },
    );
    return () => { off = true; };
  }, []);

  const refs = useMemo(() => loaded ?? (repository ? refsFromState(repository) : []), [loaded, repository]);
  const q = query.trim();
  const localNames = useMemo(() => new Set(refs.filter((r) => r.kind === 'local').map((r) => r.name)), [refs]);

  const rows: Row[] = useMemo(() => {
    if (creating) return q ? [{ id: 'create', section: 'Create', kind: 'create', name: q }] : [];
    const needle = q.toLowerCase();
    const matching = refs.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.shortOid.startsWith(needle));
    const order: CheckoutRefInfo['kind'][] = ['local', 'remote', 'tag'];
    const out: Row[] = [{ id: 'create', section: '', kind: 'create', name: q && !localNames.has(q) ? q : null }];
    for (const kind of order) {
      // The current branch first, then newest commit first (the backend's order).
      const group = matching.filter((r) => r.kind === kind).sort((a, b) => Number(b.isHead) - Number(a.isHead));
      for (const ref of group) out.push({ id: `${kind}:${ref.name}`, section: SECTIONS[kind], kind: 'ref', ref });
    }
    return out.slice(0, MAX_ROWS);
  }, [creating, q, refs, localNames]);

  const active = Math.min(activeIndex, Math.max(0, rows.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  const run = (row: Row | undefined): void => {
    if (!row) return;
    if (row.kind === 'create') {
      if (!row.name) { setCreating(true); setActiveIndex(0); inputRef.current?.focus(); return; }
      onClose();
      void createBranch(row.name, true);
      return;
    }
    const { ref } = row;
    onClose();
    if (ref.isHead) return;
    if (ref.kind === 'local') void checkoutBranch(ref.name);
    else if (ref.kind === 'remote' && ref.remote && ref.branch) void checkoutRemoteBranch(ref.remote, ref.branch);
    else if (ref.kind === 'tag') void checkoutTag(ref.name);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (creating) { setCreating(false); setQuery(''); } else onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(rows.length ? (active + 1) % rows.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(rows.length ? (active - 1 + rows.length) % rows.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(rows[active]);
    }
  };

  const describe = (ref: CheckoutRefInfo): string => {
    if (ref.kind === 'remote') {
      return ref.branch && localNames.has(ref.branch) ? `Remote branch — switches to local ${ref.branch}` : 'Remote branch — creates a local tracking branch';
    }
    if (ref.kind === 'tag') return 'Tag — detached HEAD';
    return ref.subject;
  };

  let lastSection = '';
  return (
    <div className="command-overlay ref-picker__overlay" role="presentation" onClick={onClose}>
      <div
        className="command-palette ref-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Checkout branch or tag"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="command-palette__input-row">
          {creating ? <Plus size={14} /> : <Search size={14} />}
          <input
            ref={inputRef}
            autoFocus
            className="command-palette__input"
            aria-label={creating ? 'New branch name' : 'Search branches and tags'}
            placeholder={creating
              ? 'Branch name — Enter creates it from the current commit and switches to it'
              : `Select a branch or tag to checkout (current: ${repository?.currentBranch ?? ''})`}
            value={query}
            spellCheck={false}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          />
          <kbd className="command-palette__kbd">esc</kbd>
        </div>
        <div className="command-palette__list ref-picker__list" ref={listRef}>
          {creating && !q && <div className="command-palette__empty">Type a name for the new branch.</div>}
          {!creating && rows.length === 1 && q && <div className="command-palette__empty">No branch or tag matches “{q}”.</div>}
          {rows.map((row, index) => {
            const isActive = index === active;
            const header = row.section && row.section !== lastSection ? row.section : null;
            lastSection = row.section;
            const ref = row.kind === 'ref' ? row.ref : null;
            const Icon = row.kind === 'create' ? Plus : ref?.kind === 'remote' ? Cloud : ref?.kind === 'tag' ? Tag : GitBranch;
            return (
              <div key={row.id}>
                {header && <p className="command-palette__section">{header}</p>}
                <button
                  type="button"
                  className={`command-palette__item ref-picker__item${isActive ? ' command-palette__item--active' : ''}${ref?.isHead ? ' ref-picker__item--head' : ''}`}
                  data-active={isActive}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(row)}
                >
                  <Icon size={13} className="ref-picker__icon" />
                  {row.kind === 'create' ? (
                    <span className="command-palette__title">{row.name ? `Create new branch “${row.name}”` : 'Create new branch…'}</span>
                  ) : (
                    <>
                      <span className="command-palette__title ref-picker__name">{row.ref.name}</span>
                      <span className="ref-picker__desc">{describe(row.ref)}</span>
                      {row.ref.isHead && <span className="ref-picker__current"><Check size={11} /> current</span>}
                      {row.ref.shortOid && <span className="command-palette__hint">{row.ref.shortOid}</span>}
                    </>
                  )}
                  {isActive && <CornerDownLeft size={11} className="command-palette__enter" />}
                </button>
              </div>
            );
          })}
        </div>
        <footer className="command-palette__footer">
          <span>↑↓ navigate</span>
          <span>↵ {creating ? 'create & switch' : 'checkout'}</span>
          <span>esc {creating ? 'back' : 'close'}</span>
          {!loaded && <span>Loading all refs…</span>}
        </footer>
      </div>
    </div>
  );
}
