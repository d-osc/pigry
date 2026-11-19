import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
import { getCommitDetail, getCommitFileDiff } from '../../lib/tauriClient';
import type { CommitDetail, CommitFileEntry, FileDiffContent } from '../../types/repository';
import '../push-commits/PushCommitsScreen.css';
import './InlineCommitDetails.css';

type LoadResult<T> = { data: T } | { error: string };

export function InlineCommitDetails({ oid, source }: { oid: string; source: string }) {
  const [detail, setDetail] = useState<LoadResult<CommitDetail> | null>(null);
  const [openFile, setOpenFile] = useState<CommitFileEntry | null>(null);
  const [diff, setDiff] = useState<LoadResult<FileDiffContent> | null>(null);
  const [split, setSplit] = useState(true);
  const fileGate = useRequestGate();

  useEffect(() => {
    let active = true;
    getCommitDetail(oid).then(
      data => { if (active) setDetail({ data }); },
      error => { if (active) setDetail({ error: String(error) }); },
    );
    return () => { active = false; };
  }, [oid]);

  const toggleFile = (file: CommitFileEntry) => {
    const isCurrent = fileGate.begin();
    setDiff(null);
    if (openFile === file) {
      setOpenFile(null);
      return;
    }
    setOpenFile(file);
    getCommitFileDiff(oid, file.path, file.previousPath).then(
      data => { if (isCurrent()) setDiff({ data }); },
      error => { if (isCurrent()) setDiff({ error: String(error) }); },
    );
  };

  if (!detail) return <p className="cherry__empty" role="status">Loading commit…</p>;
  if ('error' in detail) return <p className="cherry__empty" role="alert">Could not load commit. {detail.error}</p>;

  const { authorName, timeSeconds, message, parents, files } = detail.data;
  const date = new Date(timeSeconds * 1000);
  return (
    <section className="cherry__detail inline-commit-details" aria-label="Commit details">
      <div className="inline-commit-details__metadata">
        <code>{oid}</code>
        <span>{authorName} · <time dateTime={date.toISOString()}>{date.toLocaleString()}</time></span>
      </div>
      {message && <pre className="cherry__detail-body">{message}</pre>}
      <div className="push__list-head">
        <h3 className="cherry__section-title">Files changed ({files.length})</h3>
        {openFile && (
          <div className="push__view-mode" role="group" aria-label="Diff layout">
            <button type="button" className={split ? 'is-active' : ''} aria-pressed={split} onClick={() => setSplit(true)}>Split</button>
            <button type="button" className={!split ? 'is-active' : ''} aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button>
          </div>
        )}
      </div>
      {files.length === 0 ? (
        <p className="cherry__empty">No file changes.</p>
      ) : (
        <ul className="push__files">
          {files.map(file => {
            const expanded = openFile === file;
            const Chevron = expanded ? ChevronDown : ChevronRight;
            const label = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
            return (
              <li key={`${file.status}:${file.path}`} className="push__file">
                <button
                  type="button"
                  className="push__file-row"
                  title={label}
                  aria-expanded={expanded}
                  onClick={() => toggleFile(file)}
                >
                  <Chevron size={13} aria-hidden="true" />
                  <span className={`push__file-status push__file-status--${file.status}`}>{file.status}</span>
                  <span className="push__file-path">{label}</span>
                  <span className="push__file-stats">
                    <span className="stats-add">+{file.additions}</span>
                    <span className="stats-del">−{file.deletions}</span>
                  </span>
                </button>
                {expanded && (
                  <FileComparison path={file.path} parent={parents[0]} diff={diff} split={split} source={source} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FileComparison({ path, parent, diff, split, source }: {
  path: string;
  parent?: string;
  diff: LoadResult<FileDiffContent> | null;
  split: boolean;
  source: string;
}) {
  if (!diff) return <p className="cherry__empty" role="status">Loading file comparison…</p>;
  if ('error' in diff) return <p className="cherry__empty" role="alert">Could not compare file. {diff.error}</p>;

  const { original, modified, language, binary, tooLarge } = diff.data;
  if (binary) return <p className="cherry__empty">Binary file comparison is unavailable.</p>;
  if (tooLarge) return <p className="cherry__empty">This file is too large to compare.</p>;
  if (original === modified) return <p className="cherry__empty">No text changes.</p>;

  return (
    <div className="inline-commit-details__diff" aria-label={parent ? `Compared to parent ${parent}` : 'Initial commit diff'}>
      <ChatAwareDiffEditor
        chatMeta={{ path, source }}
        height={300}
        original={original ?? ''}
        modified={modified ?? ''}
        language={language}
        options={{
          readOnly: true,
          renderSideBySide: split,
          useInlineViewWhenSpaceIsLimited: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
