import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { relativeTime } from '../../lib/relativeTime';
import { getBranchCommits } from '../../lib/tauriClient';
import type { CommitHistory } from '../../types/repository';
import { InlineCommitDetails } from '../commit-preview/InlineCommitDetails';
import '../cherry-pick/CherryPickScreen.css';

const PAGE_SIZE = 40;

export function EditCommitScreen() {
  const { repository, mode } = useRepository();
  if (!repository) return null;
  const { commitEdit, currentBranch, headOid, files, localPath, rebaseInProgress } = repository;
  const attached = repository.branches.some(branch => branch.isHead && branch.name === currentBranch);

  return (
    <div className="cherry-screen">
      <h2 className="cherry__title"><Pencil size={15} /> Edit commit</h2>
      {mode !== 'tauri' ? (
        <p role="status">Open the Pigry desktop app to edit commits.</p>
      ) : commitEdit ? (
        <InlineCommitDetails key={commitEdit.oid} oid={commitEdit.oid} source="Edit commit" />
      ) : rebaseInProgress ? (
        <p role="status">Finish the rebase in progress before editing a commit.</p>
      ) : attached && headOid ? (
        <CommitPicker
          key={JSON.stringify([localPath, currentBranch, headOid])}
          branch={currentBranch}
          headOid={headOid}
          dirty={files.length > 0}
        />
      ) : (
        <p role="status">Check out a local branch with commits to begin.</p>
      )}
    </div>
  );
}

function CommitPicker({ branch, headOid, dirty }: { branch: string; headOid: string; dirty: boolean }) {
  const { busy, startCommitEdit } = useRepository();
  const [history, setHistory] = useState<CommitHistory | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    let active = true;
    getBranchCommits(`refs/heads/${branch}`, true).then(
      result => { if (active) setHistory(result); },
      error => { if (active) setError(String(error)); },
    );
    return () => { active = false; };
  }, [branch, retry]);

  const term = query.trim().toLowerCase();
  const commits = history?.commits.filter(commit =>
    commit.oid.toLowerCase().includes(term) || commit.summary.toLowerCase().includes(term));

  return (
    <section className="cherry__browse" aria-label="Editable commits">
      <div className="cherry__header">
        <strong>{branch}</strong>
        <p className="cherry__branch">Editing rewrites the selected commit and replays later commits on this branch.</p>
        {dirty && <p className="cherry__branch" role="status">Commit or stash your working changes to begin.</p>}
      </div>
      {error ? (
        <p role="alert">
          Could not load commits. {error}{' '}
          <button type="button" className="outline-button" onClick={() => {
            setError('');
            setRetry(attempt => attempt + 1);
          }}>Try again</button>
        </p>
      ) : !commits ? (
        <p className="cherry__empty" role="status">Loading commits…</p>
      ) : (
        <>
          <div className="cherry__search">
            <input
              type="search"
              className="cherry__search-input"
              aria-label="Search commits"
              placeholder="Search commit message or SHA"
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setSelected(null);
                setVisible(PAGE_SIZE);
              }}
            />
            <button
              type="button"
              className="settings__btn settings__btn--primary"
              disabled={!selected || busy || dirty}
              onClick={() => { if (selected) void startCommitEdit(branch, headOid, selected); }}
            >
              <Pencil size={13} /> Start editing
            </button>
          </div>
          {history?.truncated && (
            <p className="cherry__empty">Showing {history.commits.length} of {history.total} commits on this branch.</p>
          )}
          {commits.length === 0 && <p className="cherry__empty" role="status">No commits match.</p>}
          <ul className="cherry__rows">
            {commits.slice(0, visible).map(commit => {
              const expanded = commit.oid === selected;
              const Chevron = expanded ? ChevronDown : ChevronRight;
              return (
                <li className="cherry__row-item" key={commit.oid}>
                  <button
                    type="button"
                    className={`cherry__row${expanded ? ' is-selected' : ''}`}
                    title={commit.summary}
                    aria-expanded={expanded}
                    disabled={busy}
                    onClick={() => setSelected(expanded ? null : commit.oid)}
                  >
                    <Chevron size={14} aria-hidden="true" />
                    <span className="cherry__row-sha">{commit.shortOid}</span>
                    <span className="cherry__row-summary">{commit.summary}</span>
                    <span className="cherry__row-meta">{commit.authorName} · {relativeTime(commit.timeSeconds)}</span>
                  </button>
                  {expanded && <InlineCommitDetails oid={commit.oid} source="Edit commit" />}
                </li>
              );
            })}
          </ul>
          {visible < commits.length && (
            <button type="button" className="cherry__show-more" onClick={() => setVisible(count => count + PAGE_SIZE)}>
              Show more commits ({commits.length - visible} remaining)
            </button>
          )}
        </>
      )}
    </section>
  );
}
