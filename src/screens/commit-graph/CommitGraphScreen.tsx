import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  CalendarRange,
  Cloud,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag as TagIcon,
  UserRound,
} from 'lucide-react';
import { getCommitOidSet, isTauri } from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import { useCommitHistory } from '../../hooks/useCommitHistory';
import { relativeTime } from '../../lib/relativeTime';
import { laneColor } from '../../app/NavSidebar';
import { CommitGraphColumn } from './CommitGraphColumn';
import { CommitDetailPanel } from './CommitDetailPanel';
import './CommitGraphScreen.css';

/** Muted author avatar tints from the design (cycled by initials). */
const AVATAR_TONES = [
  { bg: '#303c55', fg: '#abbcdf' }, // AL
  { bg: '#393044', fg: '#c8b1d8' }, // MC
  { bg: '#233c42', fg: '#9bcbd3' }, // SR
  { bg: '#40372c', fg: '#d7c2a0' }, // JL
];

export function avatarTone(initials: string) {
  let hash = 0;
  for (let i = 0; i < initials.length; i += 1) hash = (hash * 31 + initials.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function RefIcon({ name }: { name: string }) {
  if (/^[^/]+\/.+/.test(name) && !name.startsWith('v')) return <Cloud size={12} strokeWidth={1.5} />;
  if (/^v?\d/.test(name)) return <TagIcon size={12} strokeWidth={1.5} />;
  return <GitBranch size={12} strokeWidth={1.5} />;
}

export function CommitGraphScreen({
  onStartRebase,
  focusCommit,
}: {
  onStartRebase: (oid: string) => void;
  /** Commit to select on first mount (jump-to-commit from blame hover). */
  focusCommit?: string | null;
}) {
  const { repository, fetchRemote, busy, notify, createBranch } = useRepository();
  const [includeRemotes, setIncludeRemotes] = useState(true);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(focusCommit ?? null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState<'all' | '24h' | '7d' | '30d' | 'year'>('all');
  const [pathFilter, setPathFilter] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [oidSet, setOidSet] = useState<Set<string> | null>(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCheckout, setNewBranchCheckout] = useState(true);
  const [columns, setColumns] = useState({ author: true, commit: true, time: true });
  const { history, error, loading } = useCommitHistory(
    includeRemotes,
    reloadKey,
    repository?.headOid ?? null,
  );

  const handleFetch = async () => {
    const ok = await fetchRemote();
    if (ok) {
      setLastFetch(Date.now());
      setReloadKey((key) => key + 1);
    }
  };

  // Branch / path filters resolve to a set of reachable oids via the backend.
  useEffect(() => {
    let cancelled = false;
    const branch = branchFilter;
    const path = pathFilter.trim();
    if (!branch && !path) {
      const t = window.setTimeout(() => setOidSet(null), 0);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    }
    if (!isTauri()) {
      // Browser preview has no backend — keep the full demo history visible.
      const t = window.setTimeout(() => setOidSet(null), 0);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    }
    Promise.all([
      branch ? getCommitOidSet(branch, null) : Promise.resolve(null),
      path ? getCommitOidSet(null, path) : Promise.resolve(null),
    ])
      .then(([branchSet, pathSet]) => {
        if (cancelled) return;
        let set: Set<string> | null = null;
        const merge = (arr: string[] | null) => {
          if (!arr) return set;
          const next = new Set(arr);
          return set === null ? next : new Set([...set].filter((oid) => next.has(oid)));
        };
        set = merge(branchSet);
        set = merge(pathSet);
        setOidSet(set ?? new Set());
      })
      .catch(() => {
        if (!cancelled) {
          setOidSet(null);
          notify('Filter failed — check the branch name or path', 'error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [branchFilter, pathFilter, notify]);

  const authors = useMemo(
    () => [...new Set((history?.commits ?? []).map((row) => row.authorName))].sort(),
    [history],
  );

  const timeCutoff = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- filter cutoff snapshot
    const now = Date.now() / 1000;
    switch (timeFilter) {
      case '24h': return now - 24 * 3600;
      case '7d': return now - 7 * 24 * 3600;
      case '30d': return now - 30 * 24 * 3600;
      case 'year': return now - 365 * 24 * 3600;
      default: return null;
    }
  }, [timeFilter]);

  const submitNewBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    await createBranch(name, newBranchCheckout);
    setNewBranchOpen(false);
    setNewBranchName('');
    setReloadKey((key) => key + 1);
  };

  // Branch name → lane color, so refs in the table match the graph lanes.
  const refColor = useMemo(() => {
    const branchIndex = new Map<string, number>();
    repository?.branches.forEach((branch, index) => branchIndex.set(branch.name, index));
    return (ref: string) => {
      const branch = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
      const index = branchIndex.get(branch);
      if (index !== undefined) return laneColor(index);
      return 'var(--accent)';
    };
  }, [repository]);

  const rows = useMemo(() => {
    if (!history) return [];
    const q = query.trim().toLowerCase();
    return history.commits.filter((row) => {
      if (
        q &&
        !row.summary.toLowerCase().includes(q) &&
        !row.shortOid.toLowerCase().includes(q) &&
        !row.oid.toLowerCase().includes(q) &&
        !row.authorName.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (authorFilter && row.authorName !== authorFilter) return false;
      if (timeCutoff !== null && row.timeSeconds < timeCutoff) return false;
      if (oidSet !== null && !oidSet.has(row.oid)) return false;
      return true;
    });
  }, [history, query, authorFilter, timeCutoff, oidSet]);

  // Lane index → branch name (from the refs that point at each commit), so
  // hovering a lane in the graph can show which branch it belongs to.
  const laneNames = useMemo(() => {
    const map = new Map<number, string>();
    if (!history) return map;
    const localBranches = new Set((repository?.branches ?? []).map((b) => b.name));
    for (const row of history.commits) {
      for (const ref of row.refs) {
        if (!localBranches.has(ref)) continue; // skip remotes and tags
        if (!map.has(row.lane)) map.set(row.lane, ref);
      }
    }
    return map;
  }, [history, repository]);

  const totalLabel = history
    ? history.truncated
      ? `${history.total}+ commits`
      : `${history.total} commits`
    : '';

  return (
    <div className="commit-history">
      <header className="commit-history__header">
        <div className="commit-history__title-row">
          <h1 className="commit-history__title">Commit graph</h1>
          <span className="commit-history__subtitle">{totalLabel}</span>
          <span className="commit-history__scanned">
            {lastFetch
              ? `Fetched ${relativeTime(Math.floor(lastFetch / 1000))}`
              : repository?.upstream
                ? 'Not fetched yet — press Fetch origin'
                : 'Local repository'}
          </span>
          <button
            type="button"
            className="outline-button"
            onClick={() => void handleFetch()}
            disabled={busy || !repository?.remotes.length}
            title={
              repository?.remotes.length
                ? 'Fetch from remote (auth via your credential manager)'
                : 'No remote configured'
            }
          >
            <RefreshCw size={16} strokeWidth={1.25} />
            {busy ? 'Fetching…' : 'Fetch origin'}
          </button>
          <button
            type="button"
            className="commit-history__new-branch"
            onClick={() => setNewBranchOpen(true)}
            title="Create a new branch"
          >
            <Plus size={16} strokeWidth={1.5} />
            New branch
          </button>
        </div>

        <div className="commit-history__filters">
          <div className="commit-history__search">
            <Search size={14} strokeWidth={1.25} />
            <input
              placeholder="Search commits, messages, or SHA…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd className="commit-history__search-kbd">/</kbd>
          </div>
          <FilterDropdown
            icon={<GitBranch size={16} strokeWidth={1.25} />}
            label={branchFilter || 'All branches'}
            active={!!branchFilter}
            menuWidth={260}
          >
            <button
              type="button"
              className={`filter-dd__item${!branchFilter ? ' filter-dd__item--active' : ''}`}
              onClick={() => setBranchFilter('')}
            >
              All branches
            </button>
            {(repository?.branches ?? []).map((branch) => (
              <button
                key={branch.name}
                type="button"
                className={`filter-dd__item${branchFilter === branch.name ? ' filter-dd__item--active' : ''}`}
                onClick={() => setBranchFilter(branch.name)}
              >
                <GitBranch size={12} strokeWidth={1.25} />
                {branch.name}
              </button>
            ))}
            {(repository?.remotes ?? []).map((remote) => (
              <div key={remote.remote} className="filter-dd__group">
                <p className="filter-dd__label">{remote.remote}</p>
                {remote.branches.map((branchName) => (
                  <button
                    key={branchName}
                    type="button"
                    className={`filter-dd__item${branchFilter === branchName ? ' filter-dd__item--active' : ''}`}
                    onClick={() => setBranchFilter(branchName)}
                  >
                    {branchName}
                  </button>
                ))}
              </div>
            ))}
          </FilterDropdown>

          <FilterDropdown
            icon={<UserRound size={16} strokeWidth={1.25} />}
            label={authorFilter || 'All authors'}
            active={!!authorFilter}
          >
            <button
              type="button"
              className={`filter-dd__item${!authorFilter ? ' filter-dd__item--active' : ''}`}
              onClick={() => setAuthorFilter('')}
            >
              All authors
            </button>
            {authors.map((name) => (
              <button
                key={name}
                type="button"
                className={`filter-dd__item${authorFilter === name ? ' filter-dd__item--active' : ''}`}
                onClick={() => setAuthorFilter(name)}
              >
                {name}
              </button>
            ))}
          </FilterDropdown>

          <FilterDropdown
            icon={<CalendarRange size={16} strokeWidth={1.25} />}
            label={TIME_LABELS[timeFilter]}
            active={timeFilter !== 'all'}
          >
            {(Object.keys(TIME_LABELS) as Array<keyof typeof TIME_LABELS>).map((key) => (
              <button
                key={key}
                type="button"
                className={`filter-dd__item${timeFilter === key ? ' filter-dd__item--active' : ''}`}
                onClick={() => setTimeFilter(key)}
              >
                {TIME_LABELS[key]}
              </button>
            ))}
          </FilterDropdown>

          <FilterDropdown
            icon={<FolderOpen size={16} strokeWidth={1.25} />}
            label={pathFilter || 'Path'}
            active={!!pathFilter}
            menuWidth={280}
          >
            <div className="filter-dd__path">
              <input
                placeholder="src/components or a file…"
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setPathFilter(pathDraft.trim());
                }}
                aria-label="Filter by path"
                spellCheck={false}
              />
              <div className="filter-dd__path-actions">
                <button type="button" className="filter-dd__item" onClick={() => setPathFilter(pathDraft.trim())}>
                  Apply
                </button>
                {pathFilter && (
                  <button
                    type="button"
                    className="filter-dd__item"
                    onClick={() => {
                      setPathDraft('');
                      setPathFilter('');
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          </FilterDropdown>

          <div className="commit-history__view-controls">
            <label className="commit-history__remotes">
              <input
                type="checkbox"
                checked={includeRemotes}
                onChange={(event) => setIncludeRemotes(event.target.checked)}
              />
              Show remotes
            </label>
            <FilterDropdown
              icon={<SlidersHorizontal size={16} strokeWidth={1.25} />}
              label=""
              ariaLabel="Column settings"
            >
              <p className="filter-dd__label">Columns</p>
              {(
                [
                  ['author', 'Author'],
                  ['commit', 'Commit'],
                  ['time', 'Time'],
                ] as Array<[keyof typeof columns, string]>
              ).map(([key, label]) => (
                <label key={key} className="filter-dd__check">
                  <input
                    type="checkbox"
                    checked={columns[key]}
                    onChange={(event) => setColumns((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </FilterDropdown>
          </div>
        </div>
      </header>

      {error && <div className="commit-history__notice">{error}</div>}

      <div className="commit-history__content">
        <div className="commit-history__table">
          <div className="commit-history__head commit-row commit-row--head">
            <span>Graph</span>
            <span>Commit message</span>
            {columns.author && <span>Author</span>}
            {columns.commit && <span>Commit</span>}
            {columns.time && (
              <span>
                Time <ArrowDown size={10} strokeWidth={1.5} />
              </span>
            )}
          </div>

          {loading && !history ? (
            <div className="commit-history__empty">Loading history…</div>
          ) : rows.length === 0 ? (
            <div className="commit-history__empty">
              {query
                ? 'No commits match this search.'
                : 'No commits yet — the first commit will appear here.'}
            </div>
          ) : (
            rows.map((row) => {
              const selected = row.oid === selectedCommit;
              const tone = avatarTone(row.authorInitials);
              return (
                <div
                  key={row.oid}
                  className={`commit-row commit-row--clickable${selected ? ' commit-row--selected' : ''}`}
                  onClick={() => setSelectedCommit(row.oid)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setSelectedCommit(row.oid);
                  }}
                >
                  <span className="commit-row__graph">
                    <CommitGraphColumn row={row} laneNames={laneNames} />
                  </span>
                  <span className="commit-row__message">
                    {row.refs.map((ref) => (
                      <span
                        key={ref}
                        className="ref-pill"
                        style={{
                          color: refColor(ref),
                          background: 'color-mix(in srgb, currentColor 9%, transparent)',
                          borderColor: 'color-mix(in srgb, currentColor 25%, transparent)',
                        }}
                      >
                        <RefIcon name={ref} />
                        {ref}
                      </span>
                    ))}
                    {row.summary}
                  </span>
                  {columns.author && (
                    <span className="commit-row__author">
                      <span
                        className="commit-row__avatar"
                        style={{ background: tone.bg, color: tone.fg }}
                      >
                        {row.authorInitials}
                      </span>
                      {row.authorName}
                    </span>
                  )}
                  {columns.commit && (
                    <span
                      className="commit-row__sha"
                      style={selected ? { color: 'var(--accent)' } : undefined}
                    >
                      {row.shortOid}
                    </span>
                  )}
                  {columns.time && (
                    <span className="commit-row__time">
                      {relativeTime(row.timeSeconds)}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
        {selectedCommit && (
          <CommitDetailPanel
            key={selectedCommit}
            oid={selectedCommit}
            onClose={() => setSelectedCommit(null)}
            onStartRebase={onStartRebase}
          />
        )}
      </div>

      {newBranchOpen && (
        <div className="commit-history__overlay" onClick={() => setNewBranchOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create new branch"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>Create new branch</strong>
            <span className="commit-history__branch-base">
              From <code>{repository?.currentBranch ?? 'HEAD'}</code>
            </span>
            <input
              autoFocus
              placeholder="Branch name (e.g. feat/my-feature)"
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitNewBranch();
                if (event.key === 'Escape') setNewBranchOpen(false);
              }}
              aria-label="Branch name"
              spellCheck={false}
            />
            <label className="commit-history__branch-check">
              <input
                type="checkbox"
                checked={newBranchCheckout}
                onChange={(event) => setNewBranchCheckout(event.target.checked)}
              />
              Checkout the new branch
            </label>
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setNewBranchOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void submitNewBranch()}
                disabled={!newBranchName.trim()}
              >
                <GitBranch size={12} strokeWidth={1.5} />
                Create branch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TIME_LABELS: Record<'all' | '24h' | '7d' | '30d' | 'year', string> = {
  all: 'All time',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  year: 'This year',
};

/** Generic filter dropdown — closes on any outside click (capture phase). */
function FilterDropdown({
  icon,
  label,
  active,
  children,
  menuWidth,
  ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  children: React.ReactNode;
  menuWidth?: number;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Flip to right-aligned when the menu would overflow the window edge.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setAlignRight(rect.right > window.innerWidth - 8);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);

  return (
    <div className="filter-dd" ref={ref}>
      <button
        type="button"
        className={`filter-pill${active ? ' filter-pill--active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {icon}
        {label}
        <Chevron />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={`filter-dd__menu${alignRight ? ' filter-dd__menu--right' : ''}`}
          role="menu"
          style={menuWidth ? { width: menuWidth } : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
