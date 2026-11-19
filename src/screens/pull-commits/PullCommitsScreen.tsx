import { useEffect, useState } from 'react';
import { ArrowDownCircle, CloudDownload } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { useScopedState } from '../../hooks/useScopedState';
import { pullPreview, type PushPreviewCommit } from '../../lib/tauriClient';
import { CommitPreviewList } from '../commit-preview/CommitPreviewList';
import '../push-commits/PushCommitsScreen.css';

const PAGE_SIZE = 40;

export function PullCommitsScreen() {
  const { repository, mode, busy, fetchRemote, pullRemote } = useRepository();
  const [reload, setReload] = useState(0);
  const scope = JSON.stringify([repository?.localPath, repository?.currentBranch, repository?.headOid, repository?.upstream, reload]);
  const [commits, setCommits] = useScopedState<PushPreviewCommit[] | null>(scope, null);
  const [previewError, setPreviewError] = useScopedState<string | null>(scope, null);
  const [visibleCount, setVisibleCount] = useScopedState(scope, PAGE_SIZE);
  const hasUpstream = Boolean(repository?.upstream);

  useEffect(() => {
    if (!hasUpstream || mode !== 'tauri') return;

    let cancelled = false;
    pullPreview()
      .then((result) => {
        if (cancelled) return;
        setCommits(result);
        setPreviewError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCommits(null);
        setPreviewError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [hasUpstream, mode, repository, setCommits, setPreviewError]);

  if (!repository) return null;

  const { currentBranch, upstream } = repository;
  const refreshPreview = () => setReload((value) => value + 1);

  const sync = async (action: () => Promise<boolean>) => {
    await action();
    refreshPreview();
  };

  return (
    <div className="push-screen">
      <section className="push__section push__header">
        <div className="push__title-row">
          <h3 className="push__title">
            <ArrowDownCircle size={14} strokeWidth={1.5} />
            Pull commit
          </h3>
          <span className="push__branch">
            {upstream ? `${currentBranch} ← ${upstream.name}` : currentBranch}
          </span>
        </div>
        <div className="push__title-row">
          <button
            type="button"
            className="push__push-btn"
            disabled={busy || mode !== 'tauri' || !upstream}
            onClick={() => void sync(pullRemote)}
          >
            <ArrowDownCircle size={14} strokeWidth={1.5} />
            Pull (fast-forward only)
          </button>
          <button
            type="button"
            className="settings__btn"
            disabled={busy || mode !== 'tauri' || repository.remotes.length === 0}
            onClick={() => void sync(fetchRemote)}
          >
            <CloudDownload size={14} strokeWidth={1.5} />
            Fetch
          </button>
        </div>
      </section>
      {mode !== 'tauri' ? (
        <p className="push__empty" role="status">Open the Pigry desktop app to preview incoming commits.</p>
      ) : !upstream ? (
        <p className="push__empty" role="status">{currentBranch} has no upstream configured.</p>
      ) : previewError ? (
        <section className="push__load-error" role="alert">
          <h2>Could not load incoming commits</h2>
          <p>{previewError}</p>
          <button type="button" className="outline-button" onClick={refreshPreview}>Try again</button>
        </section>
      ) : commits === null ? (
        <p className="push__empty" role="status">Loading incoming commits…</p>
      ) : commits.length === 0 ? (
        <p className="push__empty" role="status">No incoming commits in {upstream.name}. Fetch to check for updates.</p>
      ) : (
        <section className="push__section">
          <h3 className="push__section-title">Incoming commits ({commits.length})</h3>
          {upstream.ahead > 0 && (
            <p className="push__empty" role="status">Branches have diverged. Fast-forward pull requires a shared history without local-only commits.</p>
          )}
          <CommitPreviewList key={scope} commits={commits.slice(-visibleCount).reverse()} source="Pull commit" />
          {commits.length > visibleCount && (
            <button
              type="button"
              className="push__show-more"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              Show more — {commits.length - visibleCount} older commits
            </button>
          )}
        </section>
      )}
    </div>
  );
}
