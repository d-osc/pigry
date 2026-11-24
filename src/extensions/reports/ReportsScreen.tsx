import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, FolderOpen, RefreshCw, Search } from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import { useRequestGate } from '../../hooks/useRequestGate';
import { getFileTree, readWorktreeFile } from '../../lib/tauriClient';
import { extractHeadings, renderMarkdown } from '../../lib/markdown';
import { filterReports, groupReports, reportsFromTree, type ReportRef } from './reports';
import '../../screens/wiki/WikiScreen.css';
import './ReportsScreen.css';

type Phase = 'loading' | 'ready' | 'error';

export function ReportsScreen() {
  const listGate = useRequestGate();
  const readGate = useRequestGate();
  const [listWidth, setListWidth] = useState(260);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [reports, setReports] = useState<ReportRef[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState('');

  const loadList = useCallback(async () => {
    const current = listGate.begin();
    setRefreshing(true);
    try {
      const tree = await getFileTree();
      if (!current()) return;
      setReports(reportsFromTree(tree.entries));
      setPhase('ready');
    } catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    } finally {
      if (current()) setRefreshing(false);
    }
  }, [listGate]);

  useEffect(() => {
    // Initial load plus a refresh whenever the window regains focus — agents write reports while the user is elsewhere.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList();
    const onFocus = () => void loadList();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadList]);

  const visible = useMemo(() => filterReports(reports, search), [reports, search]);
  const groups = useMemo(() => groupReports(visible), [visible]);
  // The open report: the chosen one while it still exists, otherwise the first in the list.
  const active = useMemo(
    () => reports.find((report) => report.path === activePath) ?? groupReports(reports)[0]?.reports[0] ?? null,
    [reports, activePath],
  );
  const activeFile = active?.path ?? null;

  useEffect(() => {
    if (!activeFile) return;
    const current = readGate.begin();
    readWorktreeFile(activeFile)
      .then((file) => {
        if (!current()) return;
        setContentError(file.binary || file.tooLarge ? 'This file cannot be shown.' : '');
        setContent(file.binary || file.tooLarge ? '' : file.content);
      })
      .catch((cause) => {
        if (!current()) return;
        setContentError(cause instanceof Error ? cause.message : String(cause));
        setContent('');
      });
  }, [activeFile, readGate]);

  const shown = activeFile ? content : null;
  const headings = useMemo(() => (shown ? extractHeadings(shown) : []), [shown]);
  const isMarkdown = !!active && !active.name.toLowerCase().endsWith('.txt');

  return (
    <div className="screen wiki-screen reports-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Reports</h1>
        <span className="screen-header__count">{reports.length}</span>
        <span className="screen-header__meta">Reports your agents saved under .pigry/reports/</span>
        <button
          type="button"
          className="outline-button wiki-screen__new"
          onClick={() => void loadList()}
          disabled={refreshing}
          title="Look for new reports"
        >
          <RefreshCw size={12} strokeWidth={1.25} className={refreshing ? 'spin' : ''} />
          Refresh
        </button>
      </header>

      <div className="screen-body wiki-screen__body">
        <aside className="wiki-pages" style={{ width: listWidth }}>
          <div className="wiki-pages__head">
            <span>Reports</span>
          </div>
          <div className="wiki-pages__search">
            <Search size={13} strokeWidth={1.25} />
            <input
              placeholder="Find a report…"
              aria-label="Find a report"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {phase === 'ready' && visible.length === 0 && (
            <div className="wiki-pages__none">
              <FileText size={16} strokeWidth={1.25} />
              {reports.length === 0 ? 'No reports yet' : 'No reports match'}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.owner || '(none)'} className="wiki-pages__section">
              <div className="wiki-pages__section-head">
                <FolderOpen size={13} strokeWidth={1.25} />
                <span>{group.owner ? `@${group.owner}` : 'Shared'}</span>
                <span className="reports-count">{group.reports.length}</span>
              </div>
              {group.reports.map((report) => (
                <button
                  key={report.path}
                  type="button"
                  className={`wiki-page${report.path === activeFile ? ' wiki-page--active' : ''}`}
                  title={report.path}
                  onClick={() => setActivePath(report.path)}
                >
                  <FileText size={13} strokeWidth={1.25} />
                  <span>{report.name}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize report list"
          onDelta={(dx) => setListWidth((w) => Math.min(420, Math.max(200, w + dx)))}
        />

        <article className="wiki-article">
          {phase === 'loading' && <p className="reports-note">Loading reports…</p>}
          {phase === 'error' && (
            <div className="wiki-placeholder">
              <p>Could not list the reports: {error}</p>
              <button type="button" className="outline-button" onClick={() => void loadList()}>Try again</button>
            </div>
          )}
          {phase === 'ready' && !active && (
            <div className="wiki-placeholder reports-empty">
              <FileText size={28} strokeWidth={1.25} />
              <p>No reports yet.</p>
              <p className="reports-note">Ask an agent for a report, test cases or a handoff document — it saves them to <code>.pigry/reports/&lt;agent&gt;/</code> and they show up here.</p>
            </div>
          )}
          {phase === 'ready' && active && (
            <>
              <div className="wiki-article__top">
                <nav className="wiki-article__crumbs">
                  <span>Reports</span>
                  {active.owner && <> › <span>@{active.owner}</span></>}
                  {' '}› <span className="wiki-article__crumb-current">{active.name}</span>
                </nav>
                <div className="wiki-article__actions">
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => window.dispatchEvent(new CustomEvent('pigry:goto-file', { detail: { path: active.path } }))}
                  >
                    <ExternalLink size={12} strokeWidth={1.25} />
                    Open in Explorer
                  </button>
                </div>
              </div>
              <p className="wiki-article__byline reports-path" title="Where the agent saved this report">{active.path}</p>
              {contentError && <p className="reports-note">{contentError}</p>}
              {shown !== null && !contentError && (isMarkdown
                ? <div className="wiki-md">{renderMarkdown(shown, { fileLinks: true })}</div>
                : <pre className="reports-text">{shown}</pre>)}
            </>
          )}
        </article>

        {headings.length > 0 && (
          <aside className="wiki-toc reports-toc">
            <p className="wiki-toc__label">On this page</p>
            {headings.map((heading) => (
              <button
                key={heading.slug}
                type="button"
                className={`wiki-toc__link${heading.level === 3 ? ' wiki-toc__link--sub' : ''}`}
                onClick={() => document.getElementById(heading.slug)?.scrollIntoView({ behavior: 'smooth' })}
              >
                {heading.text}
              </button>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}
