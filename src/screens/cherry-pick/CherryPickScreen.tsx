/** Cherry Pick screen — browse recent commits, inspect one, and pick it onto
 * the current branch (staged, commit to finish). Conflicted picks surface
 * the conflicted files with an abort action. */
import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Cherry, CircleAlert, Undo2 } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  cherryPick,
  cherryPickAbort,
  getBranchCommits,
  getCommitDetail,
  getCommitHistory,
  mergeStatus,
  readFileAtCommit,
} from '../../lib/tauriClient';
import type { CommitDetail, CommitRow } from '../../types/repository';
import { relativeTime } from '../../lib/relativeTime';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './CherryPickScreen.css';

const MAX_ROWS = 40;

export function CherryPickScreen() {
  const { repository, refresh, notify } = useRepository();
  const headOid = repository?.headOid ?? '';
  const [rows, setRows] = useState<CommitRow[]>([]);
  const [query, setQuery] = useState('');
  /** '' = every branch (full history); otherwise a branch ref to browse. */
  const [branchFilter, setBranchFilter] = useState('');
  const [selected, setSelected] = useState<CommitRow | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [picking, setPicking] = useState(false);
  const [conflicted, setConflicted] = useState<string[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{
    before: string;
    after: string;
    language: string;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  // Reload the browse list whenever HEAD moves or the branch filter changes.
  useEffect(() => {
    let cancelled = false;
    const load = branchFilter
      ? getBranchCommits(branchFilter)
      : getCommitHistory(false);
    load
      .then((history) => {
        if (!cancelled) setRows(history.commits);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [headOid, branchFilter]);

  const selectCommit = async (row: CommitRow) => {
    // Clicking the selected row again collapses its detail.
    if (selected?.oid === row.oid) {
      setSelected(null);
      setDetail(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setSelected(row);
    setDetail(null);
    setOpenFile(null);
    setFileContent(null);
    setLoadingDetail(true);
    try {
      setDetail(await getCommitDetail(row.oid));
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const openCompare = async (oid: string, parentOid: string | null, filePath: string) => {
    const key = `${oid}:${filePath}`;
    if (openFile === key) {
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setOpenFile(key);
    setFileContent(null);
    setLoadingFile(true);
    try {
      const [before, after] = await Promise.all([
        parentOid ? readFileAtCommit(filePath, parentOid) : null,
        readFileAtCommit(filePath, oid),
      ]);
      setFileContent({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || languageForPath(filePath),
      });
    } catch {
      setFileContent(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const doPick = async (row: CommitRow) => {
    if (picking) return;
    setPicking(true);
    try {
      await cherryPick(row.oid);
      notify(`Cherry-picked ${row.shortOid} — staged, commit to finish`, 'success');
      refresh();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.includes('CONFLICT') || messageText.includes('could not apply')) {
        try {
          const status = await mergeStatus();
          setConflicted(status.conflicted);
        } catch {
          setConflicted([]);
        }
        notify('Cherry-pick conflicts — resolve in Working changes or abort', 'error');
      } else {
        notify(messageText, 'error');
      }
    } finally {
      setPicking(false);
    }
  };

  const doAbort = async () => {
    try {
      await cherryPickAbort();
      notify('Cherry-pick aborted — branch restored', 'success');
      setConflicted(null);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const currentBranch = repository?.currentBranch ?? '';

  return (
    <div className="cherry-screen">
      <section className="cherry__header">
        <h3 className="cherry__title">
          <Cherry size={14} strokeWidth={1.5} />
          Cherry Pick
        </h3>
        <span className="cherry__branch">
          picks onto {currentBranch || 'the current branch'} — changes are staged, commit to finish
        </span>
      </section>

      {conflicted !== null && (
        <section className="cherry__conflict">
          <p className="cherry__conflict-title">
            <CircleAlert size={13} strokeWidth={1.5} />
            Cherry-pick conflicts
          </p>
          <ul className="cherry__conflict-files">
            {conflicted.map((file) => (
              <li key={file} className="cherry__conflict-file">
                {file}
              </li>
            ))}
          </ul>
          <div className="cherry__conflict-actions">
            <button
              type="button"
              className="cherry__abort-btn"
              onClick={() => void doAbort()}
            >
              <Undo2 size={12} strokeWidth={1.5} />
              Abort cherry-pick
            </button>
            <span className="cherry__conflict-hint">
              resolve the files in Working changes, then commit
            </span>
          </div>
        </section>
      )}

      <section className="cherry__browse">
        <h4 className="cherry__section-title">Recent commits</h4>
        <div className="cherry__branch-row">
          <label className="cherry__branch-label">
            Branch
            <select
              className="cherry__branch-select"
              value={branchFilter}
              onChange={(event) => {
                setBranchFilter(event.target.value);
                setSelected(null);
                setDetail(null);
              }}
            >
              <option value="">All branches</option>
              {(repository?.branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.isHead ? '  (checked out)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="cherry__search">
          <input
            type="text"
            className="cherry__search-input"
            placeholder="Search commits — sha or message"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="cherry__search-clear"
              title="Clear search"
              onClick={() => setQuery('')}
            >
              ×
            </button>
          )}
        </div>
        <ul className="cherry__rows">
          {(() => {
            const q = query.trim().toLowerCase();
            return (q
              ? rows.filter(
                  (row) =>
                    row.oid.toLowerCase().includes(q) ||
                    row.shortOid.toLowerCase().includes(q) ||
                    row.summary.toLowerCase().includes(q),
                )
              : rows.slice(0, MAX_ROWS)
            );
          })().map((row) => {
            const isSelected = selected?.oid === row.oid;
            return (
              <li key={row.oid} className="cherry__row-item">
                <button
                  type="button"
                  className={`cherry__row${isSelected ? ' is-selected' : ''}`}
                  onClick={() => void selectCommit(row)}
                >
                  <span className="cherry__row-sha">{row.shortOid}</span>
                  <span className="cherry__row-summary">{row.summary}</span>
                  <span className="cherry__row-meta">
                    {row.authorName} · {relativeTime(row.timeSeconds)}
                  </span>
                </button>
                {isSelected && (
                  <div className="cherry__detail">
                    {loadingDetail && <p className="cherry__empty">Loading commit…</p>}
                    {detail && (
                      <>
                        <div className="cherry__detail-head">
                          <div>
                            <span className="cherry__detail-sha">{detail.shortOid}</span>
                            <span className="cherry__detail-summary">{detail.summary}</span>
                            <div className="cherry__detail-meta">
                              {detail.authorName} · {relativeTime(detail.timeSeconds)}
                              {detail.isMerge && ' · merge commit'}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="cherry__pick-btn"
                            disabled={picking || detail.isMerge}
                            title={
                              detail.isMerge
                                ? 'Merge commits cannot be cherry-picked'
                                : `Apply ${detail.shortOid} onto ${currentBranch}`
                            }
                            onClick={() => void doPick(selected)}
                          >
                            <Cherry size={13} strokeWidth={1.5} />
                            {picking ? 'Picking…' : `Cherry-pick ${detail.shortOid}`}
                          </button>
                        </div>
                        {detail.message !== detail.summary && (
                          <pre className="cherry__detail-body">{detail.message}</pre>
                        )}
                        <h4 className="cherry__section-title">
                          Files ({detail.files.length})
                        </h4>
                        <ul className="cherry__files">
                          {detail.files.map((file) => {
                            const parentOid = detail.parents[0] ?? null;
                            const fileKey = `${detail.oid}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li
                                key={`${file.path}:${file.status}`}
                                className="cherry__file"
                              >
                                <button
                                  type="button"
                                  className="cherry__file-row"
                                  title={`Compare ${file.path} (parent vs commit)`}
                                  onClick={() =>
                                    void openCompare(detail.oid, parentOid, file.path)
                                  }
                                >
                                  <span
                                    className={`cherry__file-status cherry__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="cherry__file-path">{file.path}</span>
                                  <span className="cherry__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && (
                                      <p className="cherry__empty">Loading versions…</p>
                                    )}
                                    <div className="cherry__file-view">
                                      <div className="cherry__file-view-labels">
                                        <span>
                                          BEFORE — {parentOid?.slice(0, 7) ?? '(new file)'}
                                        </span>
                                        <span>COMMIT — {detail.shortOid}</span>
                                        <div
                                          className="cherry__view-mode"
                                          role="group"
                                          aria-label="Diff layout"
                                        >
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
                                        key={fileKey}
                                        original={fileContent?.before ?? ''}
                                        modified={fileContent?.after ?? ''}
                                        language={fileContent?.language ?? 'plaintext'}
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
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {query.trim() === '' && rows.length === 0 && (
            <li className="cherry__empty">Loading commits…</li>
          )}
          {query.trim() !== '' &&
            rows.filter(
              (row) =>
                row.oid.toLowerCase().includes(query.trim().toLowerCase()) ||
                row.summary.toLowerCase().includes(query.trim().toLowerCase()),
            ).length === 0 && <li className="cherry__empty">No commits match the search.</li>}
        </ul>
      </section>

    </div>
  );
}
