import { useState } from 'react';
import { useRepository } from '../../hooks/useRepository';
import { useRequestGate } from '../../hooks/useRequestGate';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
import { shareCommitWithChat } from '../../lib/chatBridge';
import { relativeTime } from '../../lib/relativeTime';
import { readFileAtCommit, type PushPreviewCommit, type PushPreviewCommitFile } from '../../lib/tauriClient';
import '../../editor/monacoSetup';
import '../push-commits/PushCommitsScreen.css';

interface FileVersions {
  before: string;
  after: string;
  language: string;
}

export function CommitPreviewList({ commits, source }: { commits: PushPreviewCommit[]; source: string }) {
  const fileGate = useRequestGate();
  const { notify } = useRepository();
  const [compareError, setCompareError] = useState<string | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  const openCompare = async (commit: PushPreviewCommit, file: PushPreviewCommitFile) => {
    const isCurrent = fileGate.begin();
    const key = `${commit.oid}:${file.path}`;
    if (expandedFile === key) {
      setExpandedFile(null);
      setVersions(null);
      return;
    }
    setExpandedFile(key);
    setVersions(null);
    setCompareError(null);
    setLoadingFile(true);
    try {
      const [before, after] = await Promise.all([
        commit.parentOid && file.status !== 'A' ? readFileAtCommit(file.path, commit.parentOid) : null,
        file.status !== 'D' ? readFileAtCommit(file.path, commit.oid) : null,
      ]);
      if (!isCurrent()) return;
      if (before?.tooLarge || after?.tooLarge) {
        setCompareError('This file is too large to compare.');
        return;
      }
      if (before?.binary || after?.binary) {
        setCompareError('Binary file comparison is unavailable.');
        return;
      }
      setVersions({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || 'plaintext',
      });
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setCompareError(message);
      notify(message, 'error');
    } finally {
      if (isCurrent()) setLoadingFile(false);
    }
  };

  return (
    <ul className="push__commits">
      {commits.map((commit) => {
        const open = expandedCommit === commit.oid;
        return (
          <li key={commit.oid} className="push__commit">
            <button
              type="button"
              className={`push__commit-row${open ? ' is-open' : ''}`}
              aria-expanded={open}
              title="Show commit detail"
              onClick={() => {
                setExpandedCommit(open ? null : commit.oid);
                if (!open) shareCommitWithChat({ oid: commit.oid, summary: commit.summary });
              }}
            >
              <span className="push__commit-sha">{commit.shortOid}</span>
              <span className="push__commit-summary">{commit.summary}</span>
              <span className="push__commit-meta">
                {commit.authorName} · {relativeTime(commit.timeSeconds)}
              </span>
            </button>
            {open && (
              <div className="push__commit-detail">
                {commit.body !== commit.summary && (
                  <pre className="push__commit-body">{commit.body}</pre>
                )}
                {commit.files.length > 0 ? (
                  <ul className="push__files">
                    {commit.files.map((file) => {
                      const fileOpen = expandedFile === `${commit.oid}:${file.path}`;
                      return (
                        <li key={`${file.path}:${file.status}`} className="push__file">
                          <button
                            type="button"
                            className="push__file-row"
                            aria-expanded={fileOpen}
                            title={`Compare ${file.path} (parent vs this commit)`}
                            onClick={() => void openCompare(commit, file)}
                          >
                            <span
                              className={`push__file-status push__file-status--${file.status}`}
                            >
                              {file.status}
                            </span>
                            <span className="push__file-path">{file.path}</span>
                            <span className="push__file-stats">
                              <span className="stats-add">+{file.additions}</span>
                              <span className="stats-del">−{file.deletions}</span>
                            </span>
                          </button>
                          {fileOpen && (
                            <>
                              {loadingFile && versions === null && (
                                <p className="push__empty">Loading versions…</p>
                              )}
                              {compareError && <p className="push__empty" role="alert">{compareError}</p>}
                              {versions && (
                                <div className="push__file-view">
                                  <div className="push__file-view-labels">
                                    <span>
                                      BEFORE — {commit.parentOid?.slice(0, 7) ?? '(new file)'}
                                    </span>
                                    <span>COMMIT — {commit.shortOid}</span>
                                    <div className="push__view-mode" role="group" aria-label="Diff layout">
                                      <button
                                        type="button"
                                        className={splitView ? 'is-active' : ''}
                                        onClick={() => setSplitView(true)}
                                      >
                                        Split
                                      </button>
                                      <button
                                        type="button"
                                        className={!splitView ? 'is-active' : ''}
                                        onClick={() => setSplitView(false)}
                                      >
                                        Unified
                                      </button>
                                    </div>
                                  </div>
                                  <ChatAwareDiffEditor
                                    chatMeta={{ path: file.path, source }}
                                    key={`${commit.oid}:${file.path}`}
                                    original={versions.before}
                                    modified={versions.after}
                                    language={versions.language}
                                    options={{
                                      readOnly: true,
                                      renderSideBySide: splitView,
                                      fontSize: 11,
                                      lineHeight: 18,
                                      minimap: { enabled: false },
                                      scrollBeyondLastLine: false,
                                      automaticLayout: true,
                                    }}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="push__empty">No file changes.</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
