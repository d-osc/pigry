import { useScopedState } from '../../hooks/useScopedState';
/** Push Commits screen — the local commits waiting for the upstream, each
 * expandable with its message and files, files open as before/after compares,
 * plus the push action itself. The list sorts by date (toggle) and reveals
 * older commits in batches. */
import { useEffect, useMemo, useState } from 'react';
import { CommitPreviewList } from '../commit-preview/CommitPreviewList';
import { ArrowDown, ArrowUp, ArrowUpCircle, CheckCircle2, CloudUpload } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  pushPreview,
  type PushPreview,
} from '../../lib/tauriClient';
import './PushCommitsScreen.css';
import { canPushPreview, parsePushSort, pushErrorMessage } from './pushState';

const PAGE_SIZE = 40;
const SORT_KEY = 'pigry:push-sort-v2'; // v2: resets stale persisted orders

function loadSortDir(): 'desc' | 'asc' {
  try {
    return parsePushSort(localStorage.getItem(SORT_KEY));
  } catch {
    // corrupt cache — default
  }
  return 'desc';
}

export function PushCommitsScreen() {
  const { repository, pushRemote, busy, notify } = useRepository();
  const headOid = repository?.headOid ?? '';
  const [reload, setReload] = useState(0);
  const previewScope = `${headOid}:${repository?.localPath}:${repository?.currentBranch}:${reload}`;
  const [preview, setPreview] = useScopedState<PushPreview | null>(previewScope, null);
  const [pushing, setPushing] = useState(false);
  const [previewError, setPreviewError] = useScopedState<string | null>(previewScope, null);
  /** Commit list order — newest first by default, toggle to oldest first. */
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>(loadSortDir);
  /** How many commits are shown before "Show more". */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  /** Commit search — sha, message, or author. */
  const [commitQuery, setCommitQuery] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sortDir);
    } catch {
      // storage full — skip persist
    }
  }, [sortDir]);

  // Reload whenever HEAD moves or the screen remounts.
  useEffect(() => {
    let cancelled = false;
    pushPreview()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreviewError(pushErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [headOid, repository?.localPath, repository?.currentBranch, reload, setPreview, setPreviewError]);

  const doPush = async () => {
    if (pushing || busy) return;
    setPushing(true);
    try {
      if (!(await pushRemote())) return;
      setReload((value) => value + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setPushing(false);
    }
  };

  /** Search + date-sorted view of the unpushed commits. The backend walk
   * delivers oldest-first, so BOTH directions sort explicitly — desc puts
   * the newest commit on top. */
  const sortedCommits = useMemo(() => {
    const commits = preview?.commits ?? [];
    const query = commitQuery.trim().toLowerCase();
    const filtered = query
      ? commits.filter(
          (commit) =>
            commit.oid.toLowerCase().includes(query) ||
            commit.shortOid.toLowerCase().includes(query) ||
            commit.summary.toLowerCase().includes(query) ||
            commit.authorName.toLowerCase().includes(query),
        )
      : commits;
    return [...filtered].sort((a, b) =>
      sortDir === 'asc' ? a.timeSeconds - b.timeSeconds : b.timeSeconds - a.timeSeconds,
    );
  }, [preview, sortDir, commitQuery]);
  const shownCommits = sortedCommits.slice(0, visibleCount);
  const hasMore = sortedCommits.length > visibleCount;

  if (!preview) {
    return (
      <div className="push-screen">
        {previewError ? (
          <section className="push__load-error" role="alert">
            <h2>Could not load push preview</h2>
            <p>{previewError}</p>
            <button type="button" className="outline-button" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </section>
        ) : <p className="push__empty" role="status">Loading push preview…</p>}
      </div>
    );
  }

  const hasUpstream = preview.upstream !== null;
  const upToDate = hasUpstream && preview.ahead === 0;
  const canPush = hasUpstream && preview.ahead > 0;

  return (
    <div className="push-screen">
      <section className="push__section push__header">
        <div className="push__title-row">
          <h3 className="push__title">
            <CloudUpload size={14} strokeWidth={1.5} />
            Push Commits
          </h3>
          <span className="push__branch">
            {preview.branch} {hasUpstream ? `→ ${preview.upstream}` : '→ (no upstream yet)'}
          </span>
        </div>
        <button
          type="button"
          className="push__push-btn"
          disabled={pushing || busy || !canPushPreview(preview.upstream, preview.ahead)}
          title={
            hasUpstream
              ? `Push ${preview.ahead} commit${preview.ahead === 1 ? '' : 's'} to ${preview.upstream}`
              : `Publish ${preview.branch} — pushes and sets upstream`
          }
          onClick={() => void doPush()}
        >
          <ArrowUpCircle size={14} strokeWidth={1.5} />
          {pushing
            ? 'Pushing…'
            : hasUpstream
              ? `Push ${preview.ahead} commit${preview.ahead === 1 ? '' : 's'}`
              : 'Publish branch'}
        </button>
      </section>

      {!hasUpstream && (
        <section className="push__section">
          <p className="push__empty">
            {preview.branch} has no upstream yet — publishing pushes the branch and sets{' '}
            {`origin/${preview.branch}`} as its upstream.
          </p>
        </section>
      )}

      {hasUpstream && upToDate && (
        <section className="push__section push__up-to-date">
          <p className="push__empty">
            <CheckCircle2 size={13} strokeWidth={1.5} /> Everything is pushed — {preview.branch} is
            up to date with {preview.upstream}.
          </p>
        </section>
      )}

      {canPush && (
        <section className="push__section">
          <div className="push__list-head">
            <h3 className="push__section-title">
              Commits to push ({preview.ahead}
              {commitQuery.trim() && ` · ${sortedCommits.length} match`})
            </h3>
            <button
              type="button"
              className="push__sort-btn"
              title={sortDir === 'desc' ? 'Newest first — click for oldest first' : 'Oldest first — click for newest first'}
              onClick={() => {
                setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
                setVisibleCount(PAGE_SIZE);
              }}
            >
              {sortDir === 'desc' ? (
                <>
                  <ArrowDown size={11} strokeWidth={1.6} />
                  Newest first
                </>
              ) : (
                <>
                  <ArrowUp size={11} strokeWidth={1.6} />
                  Oldest first
                </>
              )}
            </button>
          </div>
          <input
            type="text"
            className="push__search"
            placeholder="Search commits — sha, message, or author"
            value={commitQuery}
            onChange={(event) => {
              setCommitQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
          <CommitPreviewList key={previewScope} commits={shownCommits} source="Push Commits" />
          {hasMore && (
            <button
              type="button"
              className="push__show-more"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              Show more — {sortedCommits.length - visibleCount} older commits
            </button>
          )}
        </section>
      )}
    </div>
  );
}
