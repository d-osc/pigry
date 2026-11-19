import { ArrowDownCircle, CloudDownload } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import '../push-commits/PushCommitsScreen.css';

export function PullCommitsScreen() {
  const { repository, busy, fetchRemote, pullRemote } = useRepository();
  if (!repository) return null;

  const { currentBranch, upstream } = repository;
  const behind = upstream?.behind ?? 0;

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
            disabled={busy || !upstream}
            onClick={() => void pullRemote()}
          >
            <ArrowDownCircle size={14} strokeWidth={1.5} />
            Pull (fast-forward only)
          </button>
          <button
            type="button"
            className="settings__btn"
            disabled={busy || repository.remotes.length === 0}
            onClick={() => void fetchRemote()}
          >
            <CloudDownload size={14} strokeWidth={1.5} />
            Fetch
          </button>
        </div>
        <p className="push__empty" role="status">
          {upstream
            ? `${behind} incoming commit${behind === 1 ? '' : 's'} in ${upstream.name}`
            : `${currentBranch} has no upstream configured.`}
        </p>
      </section>
    </div>
  );
}
