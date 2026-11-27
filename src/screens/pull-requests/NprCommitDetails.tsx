/** One commit of a new pull request, opened from the Commits tab: its whole message, author, date, SHA and parents,
 * and the files it changed — each opens the commit's compare view. Read from local git. */
import { useEffect, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { getCommitDetail } from '../../lib/tauriClient';
import type { CommitDetail } from '../../types/repository';

type Loaded = { oid: string; detail: CommitDetail } | { oid: string; error: string };

export function NprCommitDetails({ oid, onOpenFile }: {
  oid: string;
  /** Opens the compare view of `path` in this commit. */
  onOpenFile: (detail: CommitDetail, path: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    getCommitDetail(oid).then(
      (detail) => { if (live) setLoaded({ oid, detail }); },
      (error) => { if (live) setLoaded({ oid, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [oid]);

  if (!loaded || loaded.oid !== oid) return <p className="npr-commit__note" role="status">Loading commit…</p>;
  if ('error' in loaded) return <p className="npr-commit__note npr-compare__bad" role="alert">Could not read the commit. {loaded.error}</p>;
  const { detail } = loaded;
  const body = detail.message.trim().split('\n').slice(1).join('\n').trim();

  return (
    <div className="npr-commit" aria-label={`Commit ${detail.shortOid}`}>
      <div className="npr-commit__head">
        <strong className="npr-commit__summary">{detail.summary}</strong>
        {body && <p className="npr-commit__body">{body}</p>}
        <dl className="npr-commit__meta">
          <div><dt>Author</dt><dd>{detail.authorName}</dd></div>
          <div><dt>Date</dt><dd>{new Date(detail.timeSeconds * 1000).toLocaleString()}</dd></div>
          <div><dt>Commit</dt><dd><code title="Commit SHA">{detail.oid}</code></dd></div>
          {detail.parents.length > 0 && <div><dt>{detail.parents.length === 1 ? 'Parent' : 'Parents'}</dt><dd><code>{detail.parents.join(' ')}</code></dd></div>}
        </dl>
      </div>
      {detail.files.length === 0 ? <p className="npr-commit__note npr-muted">No changed files.</p> : (
        <ul className="npr-commit__files" aria-label={`Files changed in ${detail.shortOid}`}>
          {detail.files.map((file) => (
            <li key={`${file.status}:${file.path}`}>
              <button type="button" title={`Compare ${file.path}`} onClick={() => onOpenFile(detail, file.path)}>
                <span className={`npr-status npr-status--${file.status}`}>{file.status}</span>
                <span className="npr-list__main">{file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path}</span>
                <span className="npr-list__meta"><span className="npr-add">+{file.additions}</span> <span className="npr-del">−{file.deletions}</span></span>
                <FileDiff size={13} strokeWidth={1.5} className="npr-open-icon" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
