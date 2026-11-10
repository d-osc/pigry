/** Push Commits screen — the local commits waiting for the upstream, each
 * expandable with its message and files, files open as before/after compares,
 * plus the push action itself. */
import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { ArrowUpCircle, CheckCircle2, CloudUpload } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  pushPreview,
  gitPush,
  readFileAtCommit,
  type PushPreview,
  type PushPreviewCommit,
  type PushPreviewCommitFile,
} from '../../lib/tauriClient';
import { relativeTime } from '../../lib/relativeTime';
import '../../editor/monacoSetup';
import './PushCommitsScreen.css';

interface FileVersions {
  before: string;
  after: string;
  language: string;
}

export function PushCommitsScreen() {
  const { repository, refresh, notify } = useRepository();
  const headOid = repository?.headOid ?? '';
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [pushing, setPushing] = useState(false);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  // Reload whenever HEAD moves or the screen remounts.
  useEffect(() => {
    let cancelled = false;
    pushPreview()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [headOid]);

  const openCompare = async (commit: PushPreviewCommit, file: PushPreviewCommitFile) => {
    const key = `${commit.oid}:${file.path}`;
    if (expandedFile === key) {
      setExpandedFile(null);
      setVersions(null);
      return;
    }
    setExpandedFile(key);
    setVersions(null);
    setLoadingFile(true);
    try {
      const [before, after] = await Promise.all([
        commit.parentOid ? readFileAtCommit(file.path, commit.parentOid) : null,
        readFileAtCommit(file.path, commit.oid),
      ]);
      setVersions({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || 'plaintext',
      });
    } catch {
      setVersions(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const doPush = async () => {
    if (pushing) return;
    setPushing(true);
    try {
      const result = await gitPush();
      notify(result.summary || 'Pushed', 'success');
      refresh();
      setPreview(await pushPreview());
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setPushing(false);
    }
  };

  if (!preview) {
    return (
      <div className="push-screen">
        <p className="push__empty">Loading push preview…</p>
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
          disabled={pushing || (!canPush && !hasUpstream)}
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
          <h3 className="push__section-title">
            Commits to push ({preview.ahead})
          </h3>
          <ul className="push__commits">
            {preview.commits.map((commit) => {
              const open = expandedCommit === commit.oid;
              return (
                <li key={commit.oid} className="push__commit">
                  <button
                    type="button"
                    className={`push__commit-row${open ? ' is-open' : ''}`}
                    title="Show commit detail"
                    onClick={() => setExpandedCommit(open ? null : commit.oid)}
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
                                    +{file.additions} / −{file.deletions}
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && versions === null && (
                                      <p className="push__empty">Loading versions…</p>
                                    )}
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
                                      <DiffEditor
                                        key={`${commit.oid}:${file.path}`}
                                        original={versions?.before ?? ''}
                                        modified={versions?.after ?? ''}
                                        language={versions?.language ?? 'plaintext'}
                                        theme="orbit-dark"
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
                                  </>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="push__empty">No file changes (merge commit).</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
