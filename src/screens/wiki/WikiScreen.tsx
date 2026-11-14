import { useRequestGate } from '../../hooks/useRequestGate';
import { useEffect, useMemo, useState } from 'react';
import {
  BookMarked,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  ghOpenUrl,
  wikiCheck,
  wikiCreate,
  wikiList,
  wikiPageHistory,
  wikiRead,
  wikiSave,
  wikiSync,
} from '../../lib/tauriClient';
import { extractHeadings, renderMarkdown } from '../../lib/markdown';
import { colorOf, formatDate, initialsOf, relativeTime } from '../../lib/ghData';
import { useRepository } from '../../hooks/useRepository';
import type { WikiCommit, WikiPage, WikiPageContent, WikiStatus } from '../../types/repository';
import './WikiScreen.css';

type Phase = 'loading' | 'unsupported' | 'missing' | 'error' | 'ready';

interface EditorState {
  mode: 'edit' | 'create';
  file: string;
  title: string;
  content: string;
}

/** "My Page" → "My-Page.md" — matches GitHub's wiki file naming. */
function toFileName(title: string): string {
  const base =
    title
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._-]/gu, '') || 'Page';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

export function WikiScreen() {
  const listGate = useRequestGate();
  const { notify } = useRepository();
  const [pagesWidth, setPagesWidth] = useState(240);
  const [tocWidth, setTocWidth] = useState(200);

  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [loadError, setLoadError] = useState('');

  const [pages, setPages] = useState<WikiPage[]>([]);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPageContent | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');

  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [history, setHistory] = useState<{ title: string; commits: WikiCommit[] } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  // Full load: probe → clone/fetch → list pages.
  const loadWiki = async () => {
    const isCurrent = listGate.begin();
    setPhase('loading');
    setLoadError('');
    setPagesLoading(true);
    try {
      const st = await wikiCheck();
      if (!isCurrent()) return;
      setStatus(st);
      if (!st.supported) {
        setPhase('unsupported');
        return;
      }
      if (!st.hasWiki) {
        setPages([]);
        setPhase('missing');
        return;
      }
      await wikiSync();
      if (!isCurrent()) return;
      const list = await wikiList();
      if (!isCurrent()) return;
      setPages(list);
      setActiveFile((current) =>
        list.some((entry) => entry.file === current)
          ? current
          : (list.find((entry) => entry.file === 'Home.md') ?? list[0])?.file ?? null,
      );
      setSyncedAt(Date.now());
      setPhase('ready');
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setPhase('error');
    } finally {
      if (isCurrent()) setPagesLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWiki(), 0);
    return () => window.clearTimeout(timer);
     
  }, []);

  // The selected page always reads through the local wiki clone.
  useEffect(() => {
    if (phase !== 'ready' || !activeFile) {
      const t0 = window.setTimeout(() => {
        setPage(null);
        setPageError('');
      }, 0);
      return () => window.clearTimeout(t0);
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setPageLoading(true);
      setPageError('');
    }, 0);
    wikiRead(activeFile)
      .then((result) => {
        if (!cancelled) setPage(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setPage(null);
          setPageError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [activeFile, phase, reloadNonce]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await wikiSync();
      const list = await wikiList();
      setPages(list);
      setActiveFile((current) =>
        list.some((entry) => entry.file === current) ? current : (list[0]?.file ?? null),
      );
      setSyncedAt(Date.now());
      setReloadNonce((nonce) => nonce + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const openHistory = async () => {
    if (!activeFile || !page) return;
    setHistoryLoading(true);
    try {
      const commits = await wikiPageHistory(activeFile);
      setHistory({ title: page.title, commits });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setHistoryLoading(false);
    }
  };

  const savePage = async () => {
    if (!editor) return;
    const title = editor.title.trim();
    const content = editor.content;
    if (!title) return;
    const file = editor.mode === 'edit' ? editor.file : toFileName(title);
    if (editor.mode === 'create' && pages.some((entry) => entry.file === file)) {
      notify(`A page named "${title}" already exists`, 'error');
      return;
    }
    setSaving(true);
    try {
      const message = `${editor.mode === 'edit' ? 'Update' : 'Create'} ${title}`;
      const summary =
        editor.mode === 'edit'
          ? await wikiSave(file, content, message)
          : await wikiCreate(file, content, message);
      notify(summary, 'success');
      setEditor(null);
      if (phase === 'ready') {
        const list = await wikiList();
        setPages(list);
        setActiveFile(file);
        setReloadNonce((nonce) => nonce + 1);
      } else {
        // The wiki itself was just created — re-probe and enter the reader.
        await loadWiki();
        setActiveFile(file);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const visiblePages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (entry) => entry.title.toLowerCase().includes(q) || entry.file.toLowerCase().includes(q),
    );
  }, [pages, search]);

  const headings = useMemo(() => extractHeadings(page?.content ?? ''), [page]);
  const words = page ? page.content.split(/\s+/).filter(Boolean).length : 0;
  const minRead = Math.max(1, Math.round(words / 200));
  const activeIndex = pages.findIndex((entry) => entry.file === activeFile);
  const prevPage = activeIndex > 0 ? pages[activeIndex - 1] : null;
  const nextPage = activeIndex >= 0 && activeIndex < pages.length - 1 ? pages[activeIndex + 1] : null;

  const jumpTo = (slug: string) => {
    document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const pagesSkeleton = (
    <div className="wiki-skeleton-list" aria-label="Loading pages">
      {Array.from({ length: 7 }).map((_, index) => (
        <div
          key={index}
          className="wiki-skeleton wiki-skeleton--page"
          style={{ width: `${88 - (index % 3) * 14}%` }}
        />
      ))}
    </div>
  );

  const articleSkeleton = (
    <div className="wiki-skeleton-article" aria-label="Loading page">
      <div className="wiki-skeleton wiki-skeleton--title" />
      <div className="wiki-skeleton wiki-skeleton--byline" />
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="wiki-skeleton wiki-skeleton--line" style={{ width: `${96 - (index % 4) * 12}%` }} />
      ))}
    </div>
  );

  const placeholder = (icon: React.ReactNode, title: string, detail: string, action?: React.ReactNode) => (
    <div className="wiki-placeholder">
      {icon}
      <p>{title}</p>
      <span>{detail}</span>
      {action}
    </div>
  );

  return (
    <div className="screen wiki-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Wiki</h1>
        <span className="screen-header__count">
          {phase === 'ready' ? `${pages.length} pages` : ''}
        </span>
        <span className="screen-header__meta">
          {syncedAt ? `Synced ${relativeTime(new Date(syncedAt).toISOString())}` : 'Not synced yet'}
        </span>
        <button
          type="button"
          className="outline-button"
          onClick={() => void refresh()}
          disabled={phase !== 'ready' || refreshing}
        >
          <RefreshCw size={12} strokeWidth={1.25} className={refreshing ? 'spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          className="primary-button wiki-screen__new"
          onClick={() => setEditor({ mode: 'create', file: '', title: '', content: '' })}
          disabled={phase === 'loading' || phase === 'unsupported'}
        >
          <Plus size={12} strokeWidth={1.25} />
          New page
        </button>
      </header>

      <div className="screen-body wiki-screen__body">
        <aside className="wiki-pages" style={{ width: pagesWidth }}>
          <div className="wiki-pages__head">
            <span>Pages</span>
            <SlidersHorizontal size={12} strokeWidth={1.25} />
          </div>
          <div className="wiki-pages__search">
            <Search size={13} strokeWidth={1.25} />
            <input
              placeholder="Find a page…"
              aria-label="Find a page"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>/</kbd>
          </div>

          {phase === 'ready' && pagesLoading && pagesSkeleton}
          {phase === 'ready' && !pagesLoading && visiblePages.length === 0 && (
            <div className="wiki-pages__none">
              <FileText size={16} strokeWidth={1.25} />
              {pages.length === 0 ? 'No pages yet' : 'No pages match'}
            </div>
          )}
          {visiblePages.map((entry) => (
            <button
              key={entry.file}
              type="button"
              className={`wiki-page${entry.file === activeFile ? ' wiki-page--active' : ''}`}
              onClick={() => setActiveFile(entry.file)}
            >
              <FileText size={13} strokeWidth={1.25} />
              <span>{entry.title}</span>
            </button>
          ))}

          {status?.url && (
            <button
              type="button"
              className="wiki-pages__foot"
              onClick={() => void ghOpenUrl(status.url)}
              title="Open the wiki on GitHub"
            >
              <BookMarked size={12} strokeWidth={1.25} />
              wiki on GitHub ↗
            </button>
          )}
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize wiki pages"
          onDelta={(dx) => setPagesWidth((w) => Math.min(380, Math.max(180, w + dx)))}
        />

        <article className="wiki-article">
          {phase === 'loading' && articleSkeleton}
          {phase === 'unsupported' &&
            placeholder(
              <BookOpen size={26} strokeWidth={1.25} />,
              'Wiki unavailable',
              'The origin remote of this repository is not on GitHub — wikis live at github.com.',
            )}
          {phase === 'error' &&
            placeholder(
              <BookOpen size={26} strokeWidth={1.25} />,
              'Could not load the wiki',
              loadError,
              <button type="button" className="outline-button" onClick={() => void loadWiki()}>
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>,
            )}
          {phase === 'missing' &&
            placeholder(
              <BookOpen size={26} strokeWidth={1.25} />,
              'This repository has no wiki yet',
              'Press "New page" to create the first page — pigry initializes the wiki and pushes it to GitHub.',
              <button
                type="button"
                className="primary-button"
                onClick={() => setEditor({ mode: 'create', file: '', title: '', content: '' })}
              >
                <Plus size={12} strokeWidth={1.25} />
                Create first page
              </button>,
            )}

          {phase === 'ready' && pageError && !pageLoading && (
            placeholder(
              <BookOpen size={26} strokeWidth={1.25} />,
              'Could not load this page',
              pageError,
              <button
                type="button"
                className="outline-button"
                onClick={() => setReloadNonce((nonce) => nonce + 1)}
              >
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>,
            )
          )}

          {phase === 'ready' && !pageError && (pageLoading || !page) && articleSkeleton}

          {phase === 'ready' && !pageError && page && (
            <>
              <div className="wiki-article__top">
                <nav className="wiki-article__crumbs">
                  <span>Wiki</span> › <span className="wiki-article__crumb-current">{page.title}</span>
                </nav>
                <div className="wiki-article__actions">
                  <button type="button" className="outline-button" onClick={() => void openHistory()}>
                    <History size={12} strokeWidth={1.25} />
                    Page history
                  </button>
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() =>
                      setEditor({ mode: 'edit', file: page.file, title: page.title, content: page.content })
                    }
                  >
                    <PenLine size={12} strokeWidth={1.25} />
                    Edit page
                  </button>
                </div>
              </div>

              <h1 className="wiki-article__title">{page.title}</h1>
              <p className="wiki-article__byline">
                <span className="wiki-article__avatar" style={{ background: colorOf(page.author || '?') }}>
                  {initialsOf(page.author || '?')}
                </span>
                {page.author ? (
                  <>
                    <strong>{page.author}</strong> edited {relativeTime(page.updatedAt)}
                  </>
                ) : (
                  <strong>Not committed yet</strong>
                )}
                <span>· {minRead} min read</span>
              </p>

              <div className="wiki-md">{renderMarkdown(page.content)}</div>

              <footer className="wiki-article__continue">
                <p>More pages</p>
                <div>
                  {prevPage ? (
                    <button type="button" onClick={() => setActiveFile(prevPage.file)}>
                      <ChevronLeft size={12} strokeWidth={1.5} />
                      {prevPage.title}
                    </button>
                  ) : (
                    <span />
                  )}
                  {nextPage ? (
                    <button type="button" onClick={() => setActiveFile(nextPage.file)}>
                      {nextPage.title}
                      <ChevronRight size={12} strokeWidth={1.5} />
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              </footer>
            </>
          )}
        </article>

        <ResizeHandle
          orientation="v"
          label="Resize table of contents"
          onDelta={(dx) => setTocWidth((w) => Math.min(320, Math.max(150, w - dx)))}
        />
        <aside className="wiki-toc" style={{ width: tocWidth }}>
          <p className="wiki-toc__label">On this page</p>
          {headings.length === 0 && <p className="wiki-toc__value">—</p>}
          {headings.map((heading) => (
            <a
              key={heading.slug}
              className={`wiki-toc__link${heading.level === 3 ? ' wiki-toc__link--sub' : ''}`}
              href={`#${heading.slug}`}
              onClick={(event) => {
                event.preventDefault();
                jumpTo(heading.slug);
              }}
            >
              {heading.text}
            </a>
          ))}
          {page && (
            <>
              <div className="wiki-toc__divider" />
              <p className="wiki-toc__label">Maintained by</p>
              <div className="wiki-toc__row">
                <span
                  className="wiki-article__avatar"
                  style={{ background: colorOf(page.author || '?') }}
                >
                  {initialsOf(page.author || '?')}
                </span>
                <span>{page.author || '—'}</span>
              </div>
              <p className="wiki-toc__file">{page.file}</p>
            </>
          )}
        </aside>
      </div>

      {history && (
        <div className="commit-history__overlay" onClick={() => setHistory(null)} role="presentation">
          <div
            className="commit-history__branch-modal wiki-history"
            role="dialog"
            aria-modal="true"
            aria-label="Page history"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>History · {history.title}</strong>
            {historyLoading && <p className="wiki-history__empty">Loading history…</p>}
            {!historyLoading && history.commits.length === 0 && (
              <p className="wiki-history__empty">No commits recorded for this page.</p>
            )}
            <div className="wiki-history__list">
              {history.commits.map((commit) => (
                <div key={commit.oid} className="wiki-history__row">
                  <code>{commit.oid.slice(0, 7)}</code>
                  <span className="wiki-history__message">{commit.message}</span>
                  <span className="wiki-history__meta">
                    {commit.author} · {formatDate(commit.date)}
                  </span>
                </div>
              ))}
            </div>
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setHistory(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div
          className="commit-history__overlay"
          onClick={() => {
            if (!saving) setEditor(null);
          }}
          role="presentation"
        >
          <div
            className="commit-history__branch-modal wiki-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editor.mode === 'edit' ? 'Edit page' : 'New page'}
            onClick={(event) => event.stopPropagation()}
          >
            <strong>{editor.mode === 'edit' ? `Edit · ${editor.title}` : 'New page'}</strong>
            {editor.mode === 'create' && (
              <input
                autoFocus
                placeholder="Page title (e.g. Architecture)"
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                aria-label="Page title"
                spellCheck={false}
              />
            )}
            <textarea
              placeholder="Markdown content…"
              aria-label="Page content"
              value={editor.content}
              onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              rows={12}
              spellCheck={false}
            />
            <span className="wiki-editor__hint">
              {editor.mode === 'edit'
                ? `Committed to ${editor.file} and pushed to the wiki.`
                : `Will be saved as ${toFileName(editor.title || 'Page')}`}
            </span>
            <div className="commit-history__branch-actions">
              <button
                type="button"
                className="outline-button"
                onClick={() => setEditor(null)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void savePage()}
                disabled={saving || !editor.title.trim()}
              >
                {saving ? 'Saving…' : editor.mode === 'edit' ? 'Save page' : 'Create page'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
