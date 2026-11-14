import { useRequestGate } from '../../hooks/useRequestGate';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FilePen,
  GitBranch,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  getCommitOidSet,
  ghOpenUrl,
  ghReleaseCreate,
  ghReleaseDelete,
  ghReleaseEdit,
  ghReleaseList,
  ghReleaseView,
} from '../../lib/tauriClient';
import type { GhRelease, GhReleaseDetail } from '../../types/repository';
import { useRepository } from '../../hooks/useRepository';
import { useCommitHistory } from '../../hooks/useCommitHistory';
import { formatDate, relativeTime } from '../../lib/ghData';
import './ReleasesScreen.css';

interface Release {
  tag: string;
  title?: string;
  publishedAt: string;
  meta: string;
  badge?: 'Draft' | 'Latest' | 'Prerelease';
}

type StatusFilter = 'all' | 'draft' | 'prerelease' | 'published';

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All statuses',
  draft: 'Drafts',
  prerelease: 'Prereleases',
  published: 'Published releases',
};

function toDisplayRelease(gh: GhRelease): Release {
  const badge: Release['badge'] = gh.isDraft
    ? 'Draft'
    : gh.isPrerelease
      ? 'Prerelease'
      : gh.isLatest
        ? 'Latest'
        : undefined;
  return {
    tag: gh.tagName,
    title: gh.name || gh.tagName,
    publishedAt: gh.publishedAt,
    meta: formatDate(gh.publishedAt) || 'Draft',
    badge,
  };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const REPO_SLUG = 'd-osc/pigry';

function isTauriRuntime() {
  try {
    return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

export function ReleasesScreen() {
  const listGate = useRequestGate();
  const { repository, notify } = useRepository();
  const [listWidth, setListWidth] = useState(360);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'releases' | 'tags'>('releases');
  const [releases, setReleases] = useState<GhRelease[]>([]);
  const [live, setLive] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Filters
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortDesc, setSortDesc] = useState(true);

  // Detail
  const [detail, setDetail] = useState<GhReleaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Modals + menu
  const [newOpen, setNewOpen] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newDraft, setNewDraft] = useState(false);
  const [newPrerelease, setNewPrerelease] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  const { history } = useCommitHistory(false, 0, repository?.headOid ?? null);

  const loadList = async () => {
    const isCurrent = listGate.begin();
    setListLoading(true);
    setListError(null);
    try {
      const list = await ghReleaseList();
      if (!isCurrent()) return;
      setReleases(list);
      setLive(true);
      setSyncedAt(Date.now());
      setSelected((current) =>
        list.some((release) => release.tagName === current)
          ? current
          : (list.find((release) => release.isLatest) ?? list[0])?.tagName ?? null,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setListLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking outside the ⋯ menu closes it (capture phase).
  useEffect(() => {
    if (!moreOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (moreRef.current?.contains(event.target as Node)) return;
      setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [moreOpen]);

  const sorted = useMemo(() => {
    const list = [...releases];
    list.sort((a, b) => {
      const av = a.publishedAt || (a.isDraft ? a.tagName : '');
      const bv = b.publishedAt || (b.isDraft ? b.tagName : '');
      return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    });
    return list;
  }, [releases, sortDesc]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((release) => {
      if (
        q &&
        !release.tagName.toLowerCase().includes(q) &&
        !(release.name ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (statusFilter === 'draft' && !release.isDraft) return false;
      if (statusFilter === 'prerelease' && !release.isPrerelease) return false;
      if (statusFilter === 'published' && (release.isDraft || release.isPrerelease)) return false;
      return true;
    });
  }, [sorted, query, statusFilter]);

  const selectedIndex = sorted.findIndex((release) => release.tagName === selected);
  const current = sorted[selectedIndex] ?? sorted[0];
  const previous = selectedIndex >= 0 ? sorted[selectedIndex + 1] : undefined;

  // Detail follows the selected tag (real data via gh).
  useEffect(() => {
    if (!live || !current) {
      const t = window.setTimeout(() => {
        setDetail(null);
        setDetailError(null);
      }, 0);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    const t2 = window.setTimeout(() => {
      setDetailLoading(true);
      setDetailError(null);
    }, 0);
    ghReleaseView(current.tagName)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t2);
    };
  }, [current?.tagName, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Commits between the previous tag and this one (real range via backend).
  const [rangeCommits, setRangeCommits] = useState<Array<{ oid: string; summary: string; authorName: string }> | null>(null);
  useEffect(() => {
    if (!isTauriRuntime() || !current || !previous) {
      const t = window.setTimeout(() => setRangeCommits(null), 0);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    getCommitOidSet(current.tagName, null, previous.tagName)
      .then((oids) => {
        if (cancelled) return;
        const byOid = new Map((history?.commits ?? []).map((row) => [row.oid, row]));
        setRangeCommits(
          oids.map((oid) => {
            const row = byOid.get(oid);
            return {
              oid,
              summary: row?.summary ?? oid.slice(0, 7),
              authorName: row?.authorName ?? '',
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setRangeCommits(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.tagName, previous?.tagName, history]);

  const d = detail ?? (current
    ? {
        tagName: current.tagName,
        name: current.name || current.tagName,
        body: '',
        publishedAt: current.publishedAt,
        createdAt: '',
        isLatest: current.isLatest,
        isDraft: current.isDraft,
        isPrerelease: current.isPrerelease,
        author: '',
        url: '',
        assets: [],
      }
    : null);
  const tags = repository?.tags ?? [];

  const saveEdit = async () => {
    try {
      await ghReleaseEdit(d!.tagName, editTitle.trim() || d!.tagName, editNotes);
      notify('Release updated', 'success');
      setEditOpen(false);
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const createRelease = async () => {
    const tag = newTag.trim();
    if (!tag) return;
    try {
      const url = await ghReleaseCreate(
        tag,
        newTitle.trim() || tag,
        newNotes,
        newTarget.trim() || repository?.currentBranch || 'main',
        newDraft,
        newPrerelease,
      );
      notify(url ? `Release created: ${url}` : 'Release created', 'success');
      setNewOpen(false);
      setNewTag('');
      setNewTitle('');
      setNewNotes('');
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const deleteRelease = async () => {
    if (!window.confirm(`Delete release ${d!.tagName}? The tag stays on GitHub.`)) return;
    try {
      await ghReleaseDelete(d!.tagName);
      notify(`Deleted ${d!.tagName}`, 'success');
      setMoreOpen(false);
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const copyTag = async () => {
    try {
      await navigator.clipboard.writeText(d!.tagName);
      notify('Tag copied', 'success');
    } catch {
      notify('Could not access the clipboard', 'error');
    }
  };

  const publishedLabel = d?.publishedAt
    ? `${formatDate(d.publishedAt)} · ${d.publishedAt.slice(11, 16)} UTC`
    : 'Draft — not published yet';

  const draftCount = releases.filter((release) => release.isDraft).length;
  const publishedCount = releases.length - draftCount;
  const showDetail = d !== null && current !== undefined;

  return (
    <div className="screen releases-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Releases</h1>
        <span className="screen-header__count">{REPO_SLUG}</span>
        {live && <span className="screen-header__chip">via gh</span>}
        <span className="screen-header__meta">
          {syncedAt ? `Fetched ${relativeTime(new Date(syncedAt).toISOString())}` : 'Not fetched yet'}
        </span>
        <button
          type="button"
          className="outline-button"
          onClick={() => void loadList()}
          disabled={listLoading}
        >
          <RefreshCw size={12} strokeWidth={1.25} className={listLoading ? 'spin' : ''} />
          Refresh
        </button>
        <button type="button" className="primary-button" onClick={() => setNewOpen(true)}>
          <Plus size={12} strokeWidth={1.25} />
          New release
        </button>
      </header>

      <div className="screen-toolbar">
        <div className="screen-search releases-screen__search">
          <Search size={14} strokeWidth={1.25} />
          <input
            placeholder="Search releases by version or title…"
            aria-label="Search releases"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </div>

        <RelDropdown label={STATUS_LABEL[statusFilter]} active={statusFilter !== 'all'}>
          {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`filter-dd__item${statusFilter === key ? ' filter-dd__item--active' : ''}`}
              onClick={() => setStatusFilter(key)}
            >
              {STATUS_LABEL[key]}
            </button>
          ))}
        </RelDropdown>

        <button type="button" className="chip-button" onClick={() => setSortDesc((value) => !value)}>
          {sortDesc ? '↓ Newest first' : '↑ Oldest first'}
        </button>
        <span className="releases-screen__count">
          {publishedCount} published · {draftCount} draft{draftCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="screen-body">
        <aside className="releases-list" style={{ width: listWidth }}>
          <div className="releases-list__tabs">
            <button
              type="button"
              className={`releases-list__tab${tab === 'releases' ? ' releases-list__tab--active' : ''}`}
              onClick={() => setTab('releases')}
            >
              Releases <span className="releases-list__tab-count">{releases.length}</span>
            </button>
            <button
              type="button"
              className={`releases-list__tab${tab === 'tags' ? ' releases-list__tab--active' : ''}`}
              onClick={() => setTab('tags')}
            >
              Tags <span className="releases-list__tab-count">{tags.length}</span>
            </button>
          </div>

          {tab === 'releases' ? (
            listLoading ? (
              <div className="pr-skeleton-list" aria-label="Loading releases">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="pr-skeleton-row">
                    <div className="pr-skeleton pr-skeleton--title" />
                    <div className="pr-skeleton pr-skeleton--meta" />
                    <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                  </div>
                ))}
              </div>
            ) : listError ? (
              <div className="pr-empty">
                <TagIcon size={22} strokeWidth={1.25} />
                <p>Could not load releases</p>
                <span>{listError}</span>
                <span className="pr-empty__hint">
                  Make sure the GitHub CLI (gh) is installed and signed in.
                </span>
                <button type="button" className="outline-button" onClick={() => void loadList()}>
                  <RefreshCw size={12} strokeWidth={1.25} />
                  Retry
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="pr-empty">
                <TagIcon size={22} strokeWidth={1.25} />
                <p>
                  {releases.length === 0
                    ? 'No releases yet'
                    : query || statusFilter !== 'all'
                      ? 'No releases match this filter.'
                      : 'Nothing here.'}
                </p>
                {releases.length === 0 && (
                  <span>
                    This repository has no releases on GitHub. Create one with "New release".
                  </span>
                )}
              </div>
            ) : (
              visible.map((release) => {
                const display = toDisplayRelease(release);
                return (
                  <button
                    key={release.tagName}
                    type="button"
                    className={`release-row${release.tagName === selected ? ' release-row--selected' : ''}`}
                    onClick={() => setSelected(release.tagName)}
                  >
                    <div className="release-row__tag-line">
                      <TagIcon size={13} strokeWidth={1.25} className="release-row__tag-icon" />
                      <span className="release-row__tag">{display.tag}</span>
                      {display.badge && (
                        <span className={`release-badge release-badge--${display.badge.toLowerCase()}`}>
                          {display.badge}
                        </span>
                      )}
                    </div>
                    {display.title && <p className="release-row__title">{display.title}</p>}
                    <p className="release-row__meta">{display.meta}</p>
                  </button>
                );
              })
            )
          ) : (
            tags.map((tag) => (
              <button
                key={tag.name}
                type="button"
                className={`release-row${tag.name === selected ? ' release-row--selected' : ''}`}
                onClick={() => {
                  setSelected(tag.name);
                  void ghOpenUrl(`https://github.com/${REPO_SLUG}/releases/tag/${tag.name}`);
                }}
                title="Open this tag on GitHub"
              >
                <div className="release-row__tag-line">
                  <TagIcon size={13} strokeWidth={1.25} className="release-row__tag-icon" />
                  <span className="release-row__tag">{tag.name}</span>
                </div>
                <p className="release-row__meta">
                  {tag.timeSeconds ? formatDate(new Date(tag.timeSeconds * 1000).toISOString()) : '—'}
                  {tag.commitOid ? ` · ${tag.commitOid.slice(0, 7)}` : ''}
                </p>
              </button>
            ))
          )}

          <div className="releases-list__footer">
            <span>
              {tab === 'releases'
                ? `Showing ${visible.length} of ${releases.length} releases`
                : `All ${tags.length} tags shown`}
            </span>
            <Rss size={12} strokeWidth={1.5} />
          </div>
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize release list"
          onDelta={(dx) => setListWidth((w) => Math.min(560, Math.max(280, w + dx)))}
        />

        <section className="release-detail">
          {showDetail && d ? (
            <>
              <div className="release-detail__head">
                <div className="release-detail__title-line">
                  <TagIcon size={20} strokeWidth={1.25} className="release-detail__tag-icon" />
                  <h2 className="release-detail__tag">{d.tagName}</h2>
                  {d.isLatest && <span className="release-badge release-badge--latest">Latest</span>}
                  {d.isDraft && <span className="release-badge release-badge--draft">Draft</span>}
                  {d.isPrerelease && <span className="release-badge release-badge--prerelease">Prerelease</span>}
                </div>
                <div className="release-detail__actions">
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => {
                      setEditTitle(d.name);
                      setEditNotes(d.body);
                      setEditOpen(true);
                    }}
                  >
                    <FilePen size={12} strokeWidth={1.25} />
                    Edit release
                  </button>
                  <button type="button" className="release-detail__icon-btn" aria-label="Copy tag" title="Copy tag" onClick={() => void copyTag()}>
                    <Copy size={13} strokeWidth={1.25} />
                  </button>
                  <div className="filter-dd" ref={moreRef}>
                    <button
                      type="button"
                      className="release-detail__icon-btn"
                      aria-label="More options"
                      onClick={() => setMoreOpen((open) => !open)}
                    >
                      ···
                    </button>
                    {moreOpen && (
                      <div className="working-changes__menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="working-changes__menu-item"
                          onClick={() => {
                            if (d.url) void ghOpenUrl(d.url);
                            else notify('No GitHub URL in preview', 'error');
                            setMoreOpen(false);
                          }}
                        >
                          <ExternalLink size={12} strokeWidth={1.5} />
                          Open release on GitHub
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="working-changes__menu-item"
                          onClick={() => void deleteRelease()}
                        >
                          <Trash2 size={12} strokeWidth={1.5} />
                          Delete release…
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <h3 className="release-detail__subtitle">{d.name || d.tagName}</h3>

              <div className="release-detail__meta">
                <span className="release-detail__avatar">{d.author ? d.author.slice(0, 2).toUpperCase() : '—'}</span>
                <span>
                  {d.author ? `${d.author} published ` : ''}
                  {publishedLabel}
                </span>
                <span className="release-detail__chip">
                  <GitBranch size={11} strokeWidth={1.25} />
                  {repository?.currentBranch ?? 'main'}
                </span>
              </div>

              <div className="release-detail__columns">
                <div className="release-notes">
                  <h4>Release notes</h4>
                  {detailLoading && (
                    <div className="pr-skeleton-list" aria-label="Loading release">
                      <div className="pr-skeleton pr-skeleton--title" />
                      <div className="pr-skeleton pr-skeleton--meta" />
                      <div className="pr-skeleton pr-skeleton--meta" />
                      <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                    </div>
                  )}
                  {detailError && <p className="release-notes__loading">{detailError}</p>}
                  {!detailLoading && !detailError && !d.body && (
                    <p className="release-notes__loading">No release notes.</p>
                  )}
                  {d.body
                    .split('\n')
                    .map((line, index) =>
                      line.trim().startsWith('- ') ? (
                        <ul key={index}>
                          <li>{line.trim().slice(2)}</li>
                        </ul>
                      ) : line.startsWith('### ') ? (
                        <h5 key={index}>{line.slice(4)}</h5>
                      ) : line.trim() ? (
                        <p key={index}>{line}</p>
                      ) : null,
                    )}

                  {d.assets.length > 0 && (
                    <div className="release-assets">
                      <div className="release-assets__head">
                        <span className="release-assets__label">Assets</span>
                        <span className="release-assets__count">{d.assets.length}</span>
                        <span className="release-assets__uploaded">{publishedLabel}</span>
                      </div>
                      {d.assets.map((asset) => (
                        <div key={asset.name} className="release-asset">
                          <span className="release-asset__file">{asset.name}</span>
                          <span className="release-asset__platform">{asset.downloadCount} downloads</span>
                          <span className="release-asset__size">{fmtSize(asset.size)}</span>
                          <button
                            type="button"
                            className="release-asset__download"
                            aria-label={`Download ${asset.name}`}
                            title={asset.url ? 'Download in browser' : 'No download URL'}
                            onClick={() => {
                              if (asset.url) void ghOpenUrl(asset.url);
                              else notify('No download URL', 'error');
                            }}
                          >
                            <Download size={13} strokeWidth={1.25} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="release-changes">
                  <h4>{previous ? `Changes since ${previous.tagName}` : 'Changes'}</h4>
                  <div className="release-range">
                    <div className="release-range__tags">
                      <GitBranch size={12} strokeWidth={1.25} />
                      {previous ? `${previous.tagName}…${d.tagName}` : 'previous tag…' + d.tagName}
                      <ChevronRight size={12} strokeWidth={1.25} />
                    </div>
                    <p className="release-range__summary">
                      {rangeCommits
                        ? `${rangeCommits.length} commits`
                        : previous
                          ? 'Loading commits…'
                          : 'No earlier release to compare'}
                    </p>
                  </div>
                  {(rangeCommits ?? []).slice(0, 10).map((commit) => (
                    <div key={commit.oid} className="release-commit">
                      <div className="release-commit__line">
                        <span className="release-commit__title">{commit.summary}</span>
                      </div>
                      <div className="release-commit__line">
                        <span className="release-commit__sha">{commit.oid.slice(0, 7)}</span>
                        <span className="release-commit__author">{commit.authorName}</span>
                      </div>
                    </div>
                  ))}
                  {previous && rangeCommits && rangeCommits.length > 0 && (
                    <button
                      type="button"
                      className="release-changes__all"
                      onClick={() =>
                        void ghOpenUrl(
                          `https://github.com/${REPO_SLUG}/compare/${previous.tagName}...${d.tagName}`,
                        )
                      }
                    >
                      View all {rangeCommits.length} commits →
                    </button>
                  )}
                </div>
              </div>

              <footer className="release-detail__footer">
                <span className="release-detail__published">
                  {d.isDraft ? '⚠ Draft — not published yet' : `✓ Published ${publishedLabel}`}
                </span>
                <button
                  type="button"
                  className="release-detail__view-tag"
                  onClick={() => void ghOpenUrl(`https://github.com/${REPO_SLUG}/releases/tag/${d.tagName}`)}
                >
                  View tag {d.tagName} <ExternalLink size={11} strokeWidth={1.25} />
                </button>
              </footer>
            </>
          ) : (
            <div className="release-detail__placeholder">
              {listLoading ? (
                <>
                  <TagIcon size={26} strokeWidth={1.25} />
                  <p>Loading releases…</p>
                </>
              ) : listError ? (
                <>
                  <TagIcon size={26} strokeWidth={1.25} />
                  <p>Releases unavailable</p>
                  <span>{listError}</span>
                </>
              ) : releases.length === 0 ? (
                <>
                  <TagIcon size={26} strokeWidth={1.25} />
                  <p>No releases yet</p>
                  <span>
                    This repository has no releases on GitHub. Press "New release" to publish the first one.
                  </span>
                </>
              ) : (
                <>
                  <TagIcon size={26} strokeWidth={1.25} />
                  <p>Select a release</p>
                  <span>Pick one from the list to see its notes and assets.</span>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {editOpen && d && (
        <div className="commit-history__overlay" onClick={() => setEditOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit release"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>Edit release {d.tagName}</strong>
            <input
              autoFocus
              placeholder="Release title"
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              aria-label="Release title"
              spellCheck={false}
            />
            <textarea
              placeholder="Release notes…"
              value={editNotes}
              onChange={(event) => setEditNotes(event.target.value)}
              aria-label="Release notes"
              rows={8}
            />
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setEditOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={() => void saveEdit()}>
                <Check size={12} strokeWidth={1.5} />
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}

      {newOpen && (
        <div className="commit-history__overlay" onClick={() => setNewOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New release"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>New release</strong>
            <input
              autoFocus
              placeholder="Tag name (e.g. v0.20.0)"
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
              aria-label="Tag name"
              spellCheck={false}
            />
            <input
              placeholder="Release title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              aria-label="Release title"
              spellCheck={false}
            />
            <input
              placeholder={`Target branch (default: ${repository?.currentBranch ?? 'main'})`}
              value={newTarget}
              onChange={(event) => setNewTarget(event.target.value)}
              aria-label="Target branch"
              spellCheck={false}
            />
            <textarea
              placeholder="Release notes…"
              value={newNotes}
              onChange={(event) => setNewNotes(event.target.value)}
              aria-label="Release notes"
              rows={6}
            />
            <div className="releases-screen__new-flags">
              <label>
                <input type="checkbox" checked={newDraft} onChange={(event) => setNewDraft(event.target.checked)} />
                Save as draft
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={newPrerelease}
                  onChange={(event) => setNewPrerelease(event.target.checked)}
                />
                Prerelease
              </label>
            </div>
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createRelease()}
                disabled={!newTag.trim()}
              >
                <Plus size={12} strokeWidth={1.5} />
                Create release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small chip dropdown with document-level outside close (capture phase). */
function RelDropdown({
  label,
  active,
  children,
}: {
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [open]);

  return (
    <div className="filter-dd" ref={ref}>
      <button
        type="button"
        className={`chip-button${active ? ' chip-button--active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {label}
        <ChevronDown size={12} strokeWidth={1.25} />
      </button>
      {open && (
        <div className="filter-dd__menu" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
