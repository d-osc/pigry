import { CommitFilters, CommitSortSelect } from '../commit-preview/CommitListControls';
import { browseCommits, useCommitTimeRange, type CommitSort } from '../commit-preview/commitList';
import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Copy, CopyCheck } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { useScopedState } from '../../hooks/useScopedState';
import { relativeTime } from '../../lib/relativeTime';
import { getBranchCommits, getDuplicateCommitCandidates } from '../../lib/tauriClient';
import type { BranchInfo, CommitHistory, RepositoryState } from '../../types/repository';
import { InlineCommitDetails } from '../commit-preview/InlineCommitDetails';
import '../cherry-pick/CherryPickScreen.css';
import './DuplicateCommitScreen.css';

const COMMIT_PAGE_SIZE = 40;

export function DuplicateCommitScreen() {
  const { repository, mode } = useRepository();
  if (!repository) return null;

  return (
    <div className="cherry-screen duplicate-commit">
      <h2 className="cherry__title"><Copy size={15} /> Duplicate commit</h2>
      {mode === 'tauri' ? (
        <BranchSelection key={repository.localPath} repository={repository} />
      ) : (
        <p role="status">Open the Pigry desktop app to duplicate a commit.</p>
      )}
    </div>
  );
}

function BranchSelection({ repository }: { repository: RepositoryState }) {
  const { busy } = useRepository();
  const [sourceName, setSourceName] = useState('');
  const [destinationName, setDestinationName] = useState('');
  const { branches, currentBranch, headOid } = repository;
  const source = branches.find(branch => branch.name === sourceName)
    ?? branches.find(branch => branch.name === currentBranch)
    ?? branches[0];
  const destination = branches.find(branch => branch.name === destinationName && branch.name !== source?.name);

  if (branches.length < 2 || !source) {
    return <p role="status">Create a second local branch to duplicate a commit.</p>;
  }

  return (
    <>
      <div className="duplicate-commit__branches">
        <label className="cherry__branch-label">
          Source branch
          <select
            className="cherry__branch-select"
            value={source.name}
            disabled={busy}
            onChange={event => {
              const nextSource = event.target.value;
              setSourceName(nextSource);
              if (nextSource === destinationName) setDestinationName('');
            }}
          >
            {branches.map(branch => <option key={branch.name}>{branch.name}</option>)}
          </select>
        </label>
        <ArrowRight size={14} aria-hidden="true" />
        <label className="cherry__branch-label">
          Destination branch
          <select
            className="cherry__branch-select"
            value={destination?.name ?? ''}
            disabled={busy}
            onChange={event => setDestinationName(event.target.value)}
          >
            <option value="">Select a branch</option>
            {branches.filter(branch => branch.name !== source.name)
              .map(branch => <option key={branch.name}>{branch.name}</option>)}
          </select>
        </label>
      </div>
      <SourceCommits
        key={JSON.stringify([source.name, source.oid ?? headOid])}
        source={source.name}
        destination={destination}
      />
    </>
  );
}

function SourceCommits({ source, destination }: { source: string; destination?: BranchInfo }) {
  const { busy, duplicateCommit } = useRepository();
  const destinationName = destination?.name;
  const [history, setHistory] = useState<CommitHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [comparisonRevision, setComparisonRevision] = useState(0);
  const [comparison, setComparison] = useScopedState<{ candidates: Set<string> } | { error: string } | null>(
    JSON.stringify([destinationName, destination?.oid, comparisonRevision]),
    null,
  );
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CommitSort>('newest');
  const [account, setAccount] = useState('');
  const { range, setRange, cutoff } = useCommitTimeRange();
  const [visibleCount, setVisibleCount] = useState(COMMIT_PAGE_SIZE);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getBranchCommits(`refs/heads/${source}`).then(
      result => {
        if (active) setHistory({
          ...result,
          commits: result.commits,
        });
      },
      error => { if (active) setLoadError(String(error)); },
    );
    return () => { active = false; };
  }, [source, retry]);

  useEffect(() => {
    if (!destinationName) return;
    let active = true;
    getDuplicateCommitCandidates(source, destinationName).then(
      oids => { if (active) setComparison({ candidates: new Set(oids) }); },
      error => { if (active) setComparison({ error: String(error) }); },
    );
    return () => { active = false; };
  }, [source, destinationName, setComparison]);

  if (loadError) {
    return (
      <section className="cherry__browse">
        <p role="alert">Could not load commits. {loadError}</p>
        <button type="button" className="outline-button" onClick={() => {
          setLoadError(null);
          setRetry(attempt => attempt + 1);
        }}>Try again</button>
      </section>
    );
  }
  if (!history) return <p className="cherry__empty" role="status">Loading commits…</p>;

  const selected = history.commits.find(commit => commit.oid === selectedOid);
  const candidates = comparison && 'candidates' in comparison ? comparison.candidates : null;
  const canCopy = Boolean(destinationName && selected && !selected.isMerge && candidates?.has(selected.oid));
  const matches = browseCommits(history.commits, sort, query, account, cutoff);

  const copy = async () => {
    if (!canCopy || !selected || !destinationName) return;
    const copied = await duplicateCommit(source, destinationName, selected.oid);
    if (!copied || !destination?.oid) setComparisonRevision(revision => revision + 1);
  };

  return (
    <section className="cherry__browse" aria-label="Source commits">
      <div className="duplicate-commit__actions">
        <input
          type="search"
          className="cherry__search-input"
          aria-label="Search commits"
          placeholder="Search commit message or SHA"
          value={query}
          disabled={busy}
          onChange={event => {
            setQuery(event.target.value);
            setSelectedOid(null);
            setVisibleCount(COMMIT_PAGE_SIZE);
          }}
        />
        <button
          type="button"
          className="settings__btn settings__btn--primary"
          disabled={busy || !canCopy}
          onClick={() => void copy()}
        >
          <Copy size={13} /> {selected ? `Duplicate ${selected.shortOid}` : 'Duplicate commit'}
        </button>
      </div>
      <div className="commit-list-controls">
        <CommitFilters commits={history.commits} account={account} range={range}
          onAccountChange={value => { setAccount(value); setSelectedOid(null); setVisibleCount(COMMIT_PAGE_SIZE); }}
          onRangeChange={value => { setRange(value); setSelectedOid(null); setVisibleCount(COMMIT_PAGE_SIZE); }} />
        <CommitSortSelect sort={sort} onChange={value => { setSort(value); setVisibleCount(COMMIT_PAGE_SIZE); }} />
      </div>
      {destinationName && !comparison && <p className="cherry__empty" role="status">Comparing commits…</p>}
      {comparison && 'error' in comparison && (
        <p className="cherry__empty" role="alert">
          Could not compare commits. {comparison.error}
          <button type="button" className="outline-button" onClick={() => setComparisonRevision(revision => revision + 1)}>
            Try again
          </button>
        </p>
      )}
      {history.truncated && (
        <p className="cherry__empty">Showing the latest {history.commits.length} of {history.total} commits.</p>
      )}
      {matches.length === 0 && <p className="cherry__empty" role="status">No commits match.</p>}
      <ul className="cherry__rows">
        {matches.slice(0, visibleCount).map(commit => {
          const expanded = selectedOid === commit.oid;
          const Chevron = expanded ? ChevronDown : ChevronRight;
          const eligible = !commit.isMerge && candidates?.has(commit.oid);
          const alreadyPresent = Boolean(candidates && !commit.isMerge && !eligible);
          return <li key={commit.oid} className="cherry__row-item">
            <button
              type="button"
              className={`cherry__row${expanded ? ' is-selected' : ''}`}
              disabled={busy}
              aria-expanded={expanded}
              title={commit.summary}
              onClick={() => setSelectedOid(expanded ? null : commit.oid)}
            >
              <Chevron size={14} aria-hidden="true" />
              <span className="cherry__row-sha">{commit.shortOid}</span>
              <span className="cherry__row-summary">{commit.summary}</span>
              {eligible && (
                <span
                  className="duplicate-commit__eligible"
                  role="img"
                  aria-label="Can duplicate to the selected branch"
                  title="Can duplicate to the selected branch"
                >
                  <CopyCheck size={16} aria-hidden="true" />
                </span>
              )}
              {alreadyPresent && <span className="duplicate-commit__present">Already in destination</span>}
              <span className="cherry__row-meta">
                {commit.isMerge ? 'Merge commit' : `${commit.authorName} · ${relativeTime(commit.timeSeconds)}`}
              </span>
            </button>
            {expanded && <InlineCommitDetails oid={commit.oid} source="Duplicate commit" />}
          </li>;
        })}
      </ul>
      {matches.length > visibleCount && (
        <button
          type="button"
          className="cherry__show-more"
          onClick={() => setVisibleCount(count => count + COMMIT_PAGE_SIZE)}
        >
          Show more commits ({matches.length - visibleCount} remaining)
        </button>
      )}
    </section>
  );
}
