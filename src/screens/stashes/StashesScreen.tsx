import { useRequestGate } from '../../hooks/useRequestGate';
/** Stashes screen — create stashes, view their contents, and apply/pop/drop
 * a selected entry (or the latest one) without leaving the screen. */
import { useState } from 'react';
import { ChatAwareDiffEditor } from '../../lib/ChatAwareDiffEditor';
import { Archive, CheckCircle2, Eye } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  stashChanges,
  stashApply,
  stashPop,
  stashDrop,
  stashPreview,
  readFileAtCommit,
  type StashPreview,
} from '../../lib/tauriClient';
import { languageForPath } from '../../lib/ghData';
import '../../editor/monacoSetup';
import './StashesScreen.css';

export function StashesScreen() {
  const fileGate = useRequestGate();
  const detailGate = useRequestGate();
  const { repository, refresh, notify } = useRepository();
  const stashes = repository?.stashes ?? [];
  const dirtyCount = repository?.files.length ?? 0;

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewed, setViewed] = useState<number | null>(null);
  const [preview, setPreview] = useState<StashPreview | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{ before: string; after: string; language: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [splitView, setSplitView] = useState(true);

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      notify(label, 'success');
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const createStash = () => {
    void run('Changes stashed', async () => {
      await stashChanges(message.trim() || undefined);
      setMessage('');
    });
  };

  const viewStash = async (index: number) => {
    const isCurrent = detailGate.begin();
    fileGate.invalidate();
    if (viewed === index) {
      setViewed(null);
      setPreview(null);
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    setViewed(index);
    setPreview(null);
    setOpenFile(null);
    setFileContent(null);
    setLoadingView(true);
    try {
      const result = await stashPreview(index);
      if (isCurrent()) setPreview(result);
    } catch (error) {
      if (!isCurrent()) return;
      notify(error instanceof Error ? error.message : String(error), 'error');
      setViewed(null);
    } finally {
      if (isCurrent()) setLoadingView(false);
    }
  };

  const openStashFile = async (index: number, filePath: string) => {
    const isCurrent = fileGate.begin();
    const key = `${index}:${filePath}`;
    if (openFile === key) {
      setOpenFile(null);
      setFileContent(null);
      return;
    }
    if (!preview) return;
    setOpenFile(key);
    setFileContent(null);
    setLoadingFile(true);
    try {
      const [before, after] = await Promise.all([
        preview.parentOid ? readFileAtCommit(filePath, preview.parentOid) : null,
        readFileAtCommit(filePath, preview.oid),
      ]);
      if (!isCurrent()) return;
      setFileContent({
        before: before?.content ?? '',
        after: after?.content ?? '',
        language: after?.language || before?.language || languageForPath(filePath),
      });
    } catch (error) {
      if (!isCurrent()) return;
      notify(error instanceof Error ? error.message : String(error), 'error');
      setFileContent(null);
    } finally {
      if (isCurrent()) setLoadingFile(false);
    }
  };

  const dropStash = (index: number) => {
    if (!window.confirm(`Drop stash #${index}? This cannot be undone.`)) return;
    void run(`Stash #${index} dropped`, () => stashDrop(index));
  };

  return (
    <div className="stashes-screen">
      <section className="stashes__section stashes__header">
        <h3 className="stashes__title">
          <Archive size={14} strokeWidth={1.5} />
          Stashes Code
        </h3>
        <div className="stashes__create">
          <input
            type="text"
            className="stashes__input"
            placeholder={
              dirtyCount > 0
                ? `Stash ${dirtyCount} changed file${dirtyCount === 1 ? '' : 's'} — message (optional)`
                : 'No working changes to stash'
            }
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dirtyCount > 0) createStash();
            }}
            disabled={dirtyCount === 0 || busy}
          />
          <button
            type="button"
            className="stashes__stash-btn"
            disabled={dirtyCount === 0 || busy}
            onClick={createStash}
          >
            Stash
          </button>
        </div>
        {stashes.length > 0 && (
          <div className="stashes__quick">
            <button
              type="button"
              className="stashes__quick-btn"
              disabled={busy}
              title="Apply stash@{0} — the most recent entry"
              onClick={() => void run('Latest stash applied', () => stashApply(0))}
            >
              Apply latest
            </button>
            <button
              type="button"
              className="stashes__quick-btn"
              disabled={busy}
              title="Pop stash@{0} — apply and remove the entry"
              onClick={() => void run('Latest stash popped', () => stashPop(0))}
            >
              Pop latest
            </button>
          </div>
        )}
      </section>

      {stashes.length === 0 ? (
        <section className="stashes__section stashes__empty-section">
          <p className="stashes__empty">
            <CheckCircle2 size={13} strokeWidth={1.5} /> No stashes — stash your working changes
            above to park them for later.
          </p>
        </section>
      ) : (
        <section className="stashes__section">
          <h3 className="stashes__section-title">Stashes ({stashes.length})</h3>
          <ul className="stashes__list">
            {stashes.map((stash) => {
              const expanded = viewed === stash.index;
              return (
                <li key={stash.index} className="stashes__entry">
                  <div className="stashes__entry-row">
                    <button
                      type="button"
                      className={`stashes__entry-btn${expanded ? ' is-open' : ''}`}
                      title="View this stash's changes"
                      onClick={() => void viewStash(stash.index)}
                    >
                      <span className="stashes__entry-index">#{stash.index}</span>
                      <span className="stashes__entry-message">{stash.message}</span>
                    </button>
                    <div className="stashes__entry-actions">
                      <button
                        type="button"
                        className="stashes__action-btn stashes__action-btn--view"
                        title="View the files this stash changes"
                        onClick={() => void viewStash(stash.index)}
                      >
                        <Eye size={12} strokeWidth={1.5} />
                        View
                      </button>
                      <button
                        type="button"
                        className="stashes__action-btn stashes__action-btn--apply"
                        disabled={busy}
                        title="Apply this stash (keeps the entry)"
                        onClick={() => void run(`Stash #${stash.index} applied`, () => stashApply(stash.index))}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="stashes__action-btn stashes__action-btn--pop"
                        disabled={busy}
                        title="Pop this stash (apply and remove)"
                        onClick={() => void run(`Stash #${stash.index} popped`, () => stashPop(stash.index))}
                      >
                        Pop
                      </button>
                      <button
                        type="button"
                        className="stashes__action-btn stashes__action-btn--drop"
                        disabled={busy}
                        title="Drop this stash (delete permanently)"
                        onClick={() => dropStash(stash.index)}
                      >
                        Drop
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="stashes__view">
                      {loadingView && <p className="stashes__empty">Loading stash…</p>}
                      {preview && (
                        <ul className="stashes__files">
                          {preview.files.map((file) => {
                            const fileKey = `${stash.index}:${file.path}`;
                            const fileOpen = openFile === fileKey;
                            return (
                              <li key={`${file.path}:${file.status}`} className="stashes__file">
                                <button
                                  type="button"
                                  className="stashes__file-row"
                                  title={`Compare ${file.path} (base vs stash)`}
                                  onClick={() => void openStashFile(stash.index, file.path)}
                                >
                                  <span
                                    className={`stashes__file-status stashes__file-status--${file.status}`}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="stashes__file-path">{file.path}</span>
                                  <span className="stashes__file-stats">
                                    <span className="stats-add">+{file.additions}</span>
                                    <span className="stats-del">−{file.deletions}</span>
                                  </span>
                                </button>
                                {fileOpen && (
                                  <>
                                    {loadingFile && (
                                      <p className="stashes__empty">Loading versions…</p>
                                    )}
                                    <div className="stashes__file-view">
                                      <div className="stashes__file-view-labels">
                                        <span>
                                          BASE — {preview.parentOid?.slice(0, 7) ?? '(new file)'}
                                        </span>
                                        <span>STASH — #{stash.index}</span>
                                        <div
                                          className="stashes__view-mode"
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
                                      <ChatAwareDiffEditor
                                        chatMeta={{ path: file.path, source: 'Stashes Code' }}
                                        key={fileKey}
                                        original={fileContent?.before ?? ''}
                                        modified={fileContent?.after ?? ''}
                                        language={fileContent?.language ?? 'plaintext'}
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
