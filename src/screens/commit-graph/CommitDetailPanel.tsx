import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { ListTree, ShieldCheck, Undo2, X } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { verifyCommitSig } from '../../lib/tauriClient';
import { getCommitDetail, getCommitFileDiff } from '../../lib/tauriClient';
import { relativeTime } from '../../lib/relativeTime';
import type { CommitDetail, CommitFileEntry, FileDiffContent } from '../../types/repository';
import '../../editor/monacoSetup';
import './CommitDetailPanel.css';

interface CommitDetailPanelProps {
  oid: string;
  onClose: () => void;
  /** Opens the interactive rebase planner with this commit as the base. */
  onStartRebase: (oid: string) => void;
}

function statusClass(status: string): string {
  switch (status) {
    case 'A':
      return 'commit-detail__status--added';
    case 'D':
      return 'commit-detail__status--deleted';
    case 'R':
      return 'commit-detail__status--renamed';
    default:
      return 'commit-detail__status--modified';
  }
}

export function CommitDetailPanel({ oid, onClose, onStartRebase }: CommitDetailPanelProps) {
  const { revertCommit, busy } = useRepository();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedFile, setSelectedFile] = useState<CommitFileEntry | null>(null);
  const [fileDiff, setFileDiff] = useState<{
    path: string;
    diff: FileDiffContent | null;
  } | null>(null);

  // Load commit metadata once per mount (parent remounts us via key={oid}).
  useEffect(() => {
    let cancelled = false;
    getCommitDetail(oid)
      .then((result) => {
        if (!cancelled) setDetail(result);
        verifyCommitSig(result.oid).then((sig) => {
          if (!cancelled) setSignature(sig);
        }).catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [oid]);

  // Load the selected file's diff.
  useEffect(() => {
    if (!selectedFile) return;
    let cancelled = false;
    getCommitFileDiff(oid, selectedFile.path)
      .then((diff) => {
        if (!cancelled) setFileDiff({ path: selectedFile.path, diff });
      })
      .catch(() => {
        if (!cancelled) setFileDiff({ path: selectedFile.path, diff: null });
      });
    return () => {
      cancelled = true;
    };
  }, [oid, selectedFile]);

  return (
    <aside className="commit-detail" aria-label="Commit details">
      <header className="commit-detail__header">
        <div className="commit-detail__title-row">
          <span className="commit-detail__sha">{detail?.shortOid ?? '…'}</span>
          {detail?.isMerge && <span className="commit-detail__merge">Merge</span>}
          {signature === 'good' && (
            <span className="commit-detail__signed" title="GPG signature verified">
              <ShieldCheck size={11} /> Signed
            </span>
          )}
          {signature === 'bad' && (
            <span className="commit-detail__signed commit-detail__signed--bad" title="GPG signature invalid">
              Invalid signature
            </span>
          )}
          <span className="commit-detail__time">
            {detail ? relativeTime(detail.timeSeconds) : ''}
          </span>
          <button
            type="button"
            className="commit-detail__revert"
            title="Revert this commit"
            onClick={() => void revertCommit(oid)}
            disabled={busy}
          >
            <Undo2 size={12} />
            Revert
          </button>
          <button
            type="button"
            className="commit-detail__revert"
            title="Replay every commit above this one (reorder, squash, drop)"
            onClick={() => onStartRebase(oid)}
            disabled={busy}
          >
            <ListTree size={12} />
            Rebase…
          </button>
          <button
            type="button"
            className="commit-detail__close"
            onClick={onClose}
            aria-label="Close commit details"
          >
            <X size={13} />
          </button>
        </div>
        <p className="commit-detail__summary">
          {loadFailed ? 'Failed to load commit' : (detail?.summary ?? 'Loading…')}
        </p>
        {detail && detail.message !== detail.summary && (
          <pre className="commit-detail__message">{detail.message}</pre>
        )}
        {detail && (
          <p className="commit-detail__author">
            <span className="commit-detail__avatar">{detail.authorInitials}</span>
            {detail.authorName}
            <span className="commit-detail__count">
              {detail.files.length} file{detail.files.length === 1 ? '' : 's'}
            </span>
          </p>
        )}
      </header>

      <div className="commit-detail__files">
        {detail?.files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={`commit-detail__file${
              selectedFile?.path === file.path ? ' commit-detail__file--selected' : ''
            }`}
            onClick={() => setSelectedFile(file)}
            title={file.path}
          >
            <span className={`commit-detail__status ${statusClass(file.status)}`}>
              {file.status}
            </span>
            <span className="commit-detail__file-path">
              {file.directory && (
                <span className="commit-detail__file-dir">{file.directory}/</span>
              )}
              {file.name}
            </span>
            <span className="commit-detail__diffstat">
              <span className="commit-detail__add">+{file.additions}</span>
              <span className="commit-detail__del">−{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>

      {selectedFile && (
        <div className="commit-detail__diff">
          <p className="commit-detail__diff-path" title={selectedFile.path}>
            {selectedFile.path}
          </p>
          <div className="commit-detail__diff-editor">
            {fileDiff?.path === selectedFile.path ? (
              fileDiff.diff && !fileDiff.diff.binary && !fileDiff.diff.tooLarge ? (
                <DiffEditor
                  key={`${oid}:${selectedFile.path}`}
                  original={fileDiff.diff.original ?? ''}
                  modified={fileDiff.diff.modified ?? ''}
                  language={fileDiff.diff.language}
                  theme="orbit-dark"
                  options={{
                    readOnly: true,
                    renderSideBySide: false,
                    fontSize: 11,
                    lineHeight: 17,
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    renderOverviewRuler: false,
                    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
                    stickyScroll: { enabled: false },
                  }}
                />
              ) : (
                <div className="commit-detail__diff-notice">
                  {fileDiff.diff?.binary
                    ? 'Binary file'
                    : fileDiff.diff?.tooLarge
                      ? 'File too large to display'
                      : 'Diff unavailable'}
                </div>
              )
            ) : (
              <div className="commit-detail__diff-notice">Loading diff…</div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
