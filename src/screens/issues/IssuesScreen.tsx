import { useRequestGate } from '../../hooks/useRequestGate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  Copy,
  ExternalLink,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Tag as TagIcon,
  UserRound,
  Flag,
  X,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  ghIssueClose,
  ghIssueComment,
  ghIssueCreate,
  ghIssueList,
  invalidateGhCache,
  ghIssueReopen,
  ghIssueView,
  ghOpenUrl,
} from '../../lib/tauriClient';
import { labelTone, relativeTime } from '../../lib/ghData';
import { LoginAvatar } from '../../lib/AuthorAvatar';
import { useRepository } from '../../hooks/useRepository';
import type { GhIssue, GhIssueDetail } from '../../types/repository';
import './IssuesScreen.css';

type LabelTone = 'red' | 'purple' | 'orange' | 'accent';

interface IssueRow {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string;
  comments: number;
  updatedAt: string;
  time: string;
}

const LABEL_TONE_CLASS: Record<LabelTone, string> = {
  red: 'issue-label--red',
  purple: 'issue-label--purple',
  orange: 'issue-label--orange',
  accent: 'issue-label--accent',
};

function toDisplayIssue(gh: GhIssue): IssueRow {
  return {
    number: gh.number,
    title: gh.title,
    state: gh.state,
    author: gh.author,
    labels: gh.labels,
    assignees: gh.assignees,
    milestone: gh.milestone,
    comments: gh.comments,
    updatedAt: gh.updatedAt,
    time: relativeTime(gh.updatedAt, true),
  };
}

export function IssuesScreen() {
  const listGate = useRequestGate();
  const { notify } = useRepository();
  const [listWidth, setListWidth] = useState(400);
  const [issues, setIssues] = useState<GhIssue[]>([]);
  const [live, setLive] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sortDesc, setSortDesc] = useState(true);

  // Filters
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [milestoneFilter, setMilestoneFilter] = useState('');

  // Detail
  const [detail, setDetail] = useState<GhIssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumped by Refresh so the detail effect re-fetches even when the
  // selected issue number did not change.
  const [detailNonce, setDetailNonce] = useState(0);

  // Composer + actions
  const [replyTab, setReplyTab] = useState<'write' | 'preview'>('write');
  const [commentText, setCommentText] = useState('');
  const [commenting, setCommenting] = useState(false);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState('');
  const [newIssueBody, setNewIssueBody] = useState('');
  const [issueMenuOpen, setIssueMenuOpen] = useState(false);
  const issueMenuRef = useRef<HTMLDivElement | null>(null);

  const displayIssues = useMemo(() => issues.map(toDisplayIssue), [issues]);
  const labels = useMemo(
    () => [...new Set(displayIssues.flatMap((issue) => issue.labels))].sort(),
    [displayIssues],
  );
  const assignees = useMemo(
    () => [...new Set(displayIssues.flatMap((issue) => issue.assignees))].sort(),
    [displayIssues],
  );
  const milestones = useMemo(
    () => [...new Set(displayIssues.map((issue) => issue.milestone).filter(Boolean))].sort(),
    [displayIssues],
  );

  const loadList = useCallback(async (force = false) => {
    const isCurrent = listGate.begin();
    setRefreshing(true);
    setListLoading(true);
    setListError(null);
    try {
      if (force) await invalidateGhCache();
      const list = await ghIssueList();
      if (!isCurrent()) return;
      setIssues(list);
      setLive(true);
      setSyncedAt(Date.now());
      setSelected((current) =>
        list.some((issue) => issue.number === current) ? current : (list[0]?.number ?? null),
      );
      setDetailNonce((nonce) => nonce + 1);
    } catch (error) {
      if (!isCurrent()) return;
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setRefreshing(false);
      if (isCurrent()) setListLoading(false);
    }
  }, [listGate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  // Clicking anywhere outside the ⋯ menu closes it (capture phase).
  useEffect(() => {
    if (!issueMenuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (issueMenuRef.current?.contains(event.target as Node)) return;
      setIssueMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [issueMenuOpen]);

  // Detail follows the selected issue (real data via gh).
  useEffect(() => {
    if (!live || selected === null) {
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
    ghIssueView(selected)
      .then((result) => {
        if (!cancelled) { setDetailError(null); setDetail(result); }
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        window.clearTimeout(t2);
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t2);
    };
  }, [selected, live, detailNonce]);

  const visibleIssues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const numberQuery = q.replace('#', '');
    const mapped = displayIssues.filter((issue) => {
      if (tab === 'open' ? issue.state !== 'OPEN' : issue.state === 'OPEN') return false;
      if (
        q &&
        !issue.title.toLowerCase().includes(q) &&
        !String(issue.number).includes(numberQuery) &&
        !issue.labels.some((label) => label.toLowerCase().includes(q))
      ) {
        return false;
      }
      if (labelFilter && !issue.labels.includes(labelFilter)) return false;
      if (assigneeFilter && !issue.assignees.includes(assigneeFilter)) return false;
      if (milestoneFilter && issue.milestone !== milestoneFilter) return false;
      return true;
    });
    return mapped.sort((a, b) =>
      sortDesc
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.updatedAt.localeCompare(b.updatedAt),
    );
  }, [displayIssues, tab, query, labelFilter, assigneeFilter, milestoneFilter, sortDesc]);

  const submitComment = async () => {
    const body = commentText.trim();
    if (!body || selected === null) return;
    setCommenting(true);
    try {
      await ghIssueComment(selected, body);
      setCommentText('');
      setReplyTab('write');
      notify('Comment posted', 'success');
      setDetail(await ghIssueView(selected));
      const list = await ghIssueList();
      setIssues(list);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setCommenting(false);
    }
  };

  const createIssue = async () => {
    const title = newIssueTitle.trim();
    if (!title) return;
    try {
      const url = await ghIssueCreate(title, newIssueBody.trim());
      notify(url ? `Issue created: ${url}` : 'Issue created', 'success');
      setNewIssueOpen(false);
      setNewIssueTitle('');
      setNewIssueBody('');
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const setIssueState = async (close: boolean) => {
    if (selected === null) return;
    if (close && !window.confirm(`Close issue #${selected}?`)) return;
    setIssueMenuOpen(false);
    try {
      if (close) {
        await ghIssueClose(selected);
        notify(`Closed #${selected}`, 'success');
      } else {
        await ghIssueReopen(selected);
        notify(`Reopened #${selected}`, 'success');
      }
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const copyLink = async () => {
    const url = detail?.url;
    if (!url) {
      notify('No GitHub URL for this issue', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied', 'success');
    } catch {
      notify('Could not access the clipboard', 'error');
    }
    setIssueMenuOpen(false);
  };

  const openOnGitHub = () => {
    const url = detail?.url;
    if (!url) {
      notify('No GitHub URL for this issue', 'error');
      return;
    }
    void ghOpenUrl(url);
  };

  const openCount = issues.filter((issue) => issue.state === 'OPEN').length;
  const filtersActive = !!(query || labelFilter || assigneeFilter || milestoneFilter);
  const d = detail;
  const showDetail = selected !== null && d !== null;
  const detailAuthor = d?.author ?? '';
  const detailAssignees = d?.assignees.length ? d.assignees : displayIssues.find((issue) => issue.number === selected)?.assignees ?? [];

  return (
    <div className="screen issues-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Issues</h1>
        <span className="screen-header__count">
          {openCount} open · {issues.length} total
        </span>
        {live && <span className="screen-header__chip">via gh</span>}
        <span className="screen-header__meta">
          {syncedAt ? `Synced ${relativeTime(new Date(syncedAt).toISOString())}` : 'Not synced yet'}
        </span>
        <button
          type="button"
          className="outline-button"
          onClick={() => void loadList(true)}
          disabled={refreshing}
        >
          <RefreshCw size={12} strokeWidth={1.25} className={refreshing ? 'spin' : ''} />
          Refresh
        </button>
        <button type="button" className="primary-button" onClick={() => setNewIssueOpen(true)}>
          <Plus size={12} strokeWidth={1.25} />
          New issue
        </button>
      </header>

      <div className="screen-toolbar">
        <div className="screen-search issues-screen__search">
          <Search size={14} strokeWidth={1.25} />
          <input
            placeholder="Search title, #number, or label…"
            aria-label="Filter issues"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </div>

        <IssueDropdown
          icon={<TagIcon size={13} strokeWidth={1.25} />}
          label={labelFilter || 'Label'}
          active={!!labelFilter}
        >
          <button
            type="button"
            className={`issues-dd__item${!labelFilter ? ' issues-dd__item--active' : ''}`}
            onClick={() => setLabelFilter('')}
          >
            Any label
          </button>
          {labels.map((label) => (
            <button
              key={label}
              type="button"
              className={`issues-dd__item${labelFilter === label ? ' issues-dd__item--active' : ''}`}
              onClick={() => setLabelFilter(label)}
            >
              <TagIcon size={11} strokeWidth={1.25} />
              {label}
            </button>
          ))}
          {labels.length === 0 && <span className="issues-dd__none">No labels</span>}
        </IssueDropdown>

        <IssueDropdown
          icon={<UserRound size={13} strokeWidth={1.25} />}
          label={assigneeFilter || 'Assignee'}
          active={!!assigneeFilter}
        >
          <button
            type="button"
            className={`issues-dd__item${!assigneeFilter ? ' issues-dd__item--active' : ''}`}
            onClick={() => setAssigneeFilter('')}
          >
            Any assignee
          </button>
          {assignees.map((name) => (
            <button
              key={name}
              type="button"
              className={`issues-dd__item${assigneeFilter === name ? ' issues-dd__item--active' : ''}`}
              onClick={() => setAssigneeFilter(name)}
            >
              {name}
            </button>
          ))}
          {assignees.length === 0 && <span className="issues-dd__none">No assignees</span>}
        </IssueDropdown>

        <IssueDropdown
          icon={<Flag size={13} strokeWidth={1.25} />}
          label={milestoneFilter || 'Milestone'}
          active={!!milestoneFilter}
        >
          <button
            type="button"
            className={`issues-dd__item${!milestoneFilter ? ' issues-dd__item--active' : ''}`}
            onClick={() => setMilestoneFilter('')}
          >
            Any milestone
          </button>
          {milestones.map((milestone) => (
            <button
              key={milestone}
              type="button"
              className={`issues-dd__item${milestoneFilter === milestone ? ' issues-dd__item--active' : ''}`}
              onClick={() => setMilestoneFilter(milestone)}
            >
              {milestone}
            </button>
          ))}
          {milestones.length === 0 && <span className="issues-dd__none">No milestones</span>}
        </IssueDropdown>

        <span className="issues-screen__split">
          <SplitSquareHorizontal size={13} strokeWidth={1.25} />
          Split view
        </span>
        <button
          type="button"
          className="issues-screen__sliders"
          aria-label="Toggle sort order"
          onClick={() => setSortDesc((value) => !value)}
        >
          <SlidersHorizontal size={14} strokeWidth={1.25} />
        </button>
      </div>

      <div className="screen-body">
        <aside className="issues-list" style={{ width: listWidth }}>
          <div className="issues-list__tabs">
            <button
              type="button"
              className={`issues-list__tab${tab === 'open' ? ' issues-list__tab--active' : ''}`}
              onClick={() => setTab('open')}
            >
              <CircleDot size={13} strokeWidth={1.5} />
              Open <span className="issues-list__tab-count">{openCount}</span>
            </button>
            <button
              type="button"
              className={`issues-list__tab${tab === 'closed' ? ' issues-list__tab--active' : ''}`}
              onClick={() => setTab('closed')}
            >
              Closed <span className="issues-list__tab-count">{issues.length - openCount}</span>
            </button>
            <button
              type="button"
              className="issues-list__sort"
              onClick={() => setSortDesc((value) => !value)}
              title="Toggle sort order"
            >
              {sortDesc ? 'Updated ↓' : 'Updated ↑'}
            </button>
          </div>

          {listLoading ? (
            <div className="issue-skeleton-list" aria-label="Loading issues">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="issue-skeleton-row">
                  <div className="issue-skeleton issue-skeleton--title" />
                  <div className="issue-skeleton issue-skeleton--meta" />
                  <div className="issue-skeleton issue-skeleton--meta issue-skeleton--short" />
                </div>
              ))}
            </div>
          ) : listError ? (
            <div className="issue-empty">
              <CircleDot size={22} strokeWidth={1.25} />
              <p>Could not load issues</p>
              <span>{listError}</span>
              <span className="issue-empty__hint">
                Make sure the GitHub CLI (gh) is installed and signed in.
              </span>
              <button type="button" className="outline-button" onClick={() => void loadList(true)}>
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>
            </div>
          ) : visibleIssues.length === 0 ? (
            <div className="issue-empty">
              <CircleDot size={22} strokeWidth={1.25} />
              <p>
                {issues.length === 0
                  ? tab === 'open'
                    ? 'No open issues'
                    : 'No closed issues'
                  : filtersActive
                    ? 'No issues match the current filters'
                    : tab === 'open'
                      ? 'No open issues'
                      : 'No closed issues'}
              </p>
              <span>
                {issues.length === 0
                  ? 'This repository has no issues on GitHub yet. Press "New issue" to create the first one.'
                  : filtersActive
                    ? 'Try clearing the search or the label / assignee / milestone filters.'
                    : 'Nothing here.'}
              </span>
              {issues.length === 0 && (
                <button type="button" className="outline-button" onClick={() => setNewIssueOpen(true)}>
                  <Plus size={12} strokeWidth={1.25} />
                  New issue
                </button>
              )}
            </div>
          ) : (
            visibleIssues.map((issue) => {
              const label = issue.labels[0];
              const tone = label ? labelTone(label) : null;
              const extra = issue.labels.slice(1).join(' ');
              const assignee = issue.assignees[0] ?? issue.author;
              const open = issue.state === 'OPEN';
              return (
                <button
                  key={issue.number}
                  type="button"
                  className={`issue-row${issue.number === selected ? ' issue-row--selected' : ''}`}
                  onClick={() => setSelected(issue.number)}
                >
                  <div className="issue-row__line">
                    {open ? (
                      <CircleDot size={13} strokeWidth={1.5} className="issue-row__icon" />
                    ) : (
                      <CircleCheck size={13} strokeWidth={1.5} className="issue-row__icon issue-row__icon--closed" />
                    )}
                    <span className="issue-row__title">{issue.title}</span>
                    <span className="issue-row__time">{issue.time}</span>
                  </div>
                  <div className="issue-row__line issue-row__line--meta">
                    <span className="issue-row__number">#{issue.number}</span>
                    {label && tone && (
                      <span className={`issue-label ${LABEL_TONE_CLASS[tone]}`}>{label}</span>
                    )}
                    {extra && <span className="issue-row__extra">{extra}</span>}
                    <span className="issue-row__comments">
                      <MessageSquare size={11} strokeWidth={1.5} />
                      {issue.comments}
                    </span>
                    <LoginAvatar login={assignee} className="issue-row__avatar" />
                  </div>
                </button>
              );
            })
          )}

          <div className="issues-list__footer">
            <span>
              {listLoading
                ? 'Loading issues…'
                : `Showing ${visibleIssues.length} of ${issues.length} issues`}
            </span>
            <span className="issues-list__footer-hint">↑ ↓ to navigate</span>
          </div>
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize issue list"
          onDelta={(dx) => setListWidth((w) => Math.min(600, Math.max(300, w + dx)))}
        />

        <section className="issue-detail">
          {showDetail ? (
            <>
              <div className="issue-detail__head">
                <div className="issue-detail__meta">
                  <span className={`issue-detail__state${d!.state === 'OPEN' ? '' : ' issue-detail__state--closed'}`}>
                    {d!.state === 'OPEN' ? (
                      <CircleDot size={12} strokeWidth={1.5} />
                    ) : (
                      <CircleCheck size={12} strokeWidth={1.5} />
                    )}
                    {d!.state === 'OPEN'
                      ? 'Open'
                      : d!.stateReason === 'NOT_PLANNED'
                        ? 'Closed (not planned)'
                        : 'Closed'}
                  </span>
                  <div className="issue-detail__meta-actions">
                    <button type="button" className="issue-detail__link" onClick={openOnGitHub}>
                      <ExternalLink size={12} strokeWidth={1.25} />
                      Open on GitHub
                    </button>
                    <div className="issue-detail__more" ref={issueMenuRef}>
                      <button
                        type="button"
                        aria-label="More options"
                        onClick={() => setIssueMenuOpen((open) => !open)}
                      >
                        <MoreHorizontal size={14} strokeWidth={1.25} />
                      </button>
                      {issueMenuOpen && (
                        <div className="issues-dd__menu issues-dd__menu--right" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="issues-dd__item"
                            onClick={() => void copyLink()}
                          >
                            <Copy size={12} strokeWidth={1.5} />
                            Copy link
                          </button>
                          {d!.state === 'OPEN' ? (
                            <button
                              type="button"
                              role="menuitem"
                              className="issues-dd__item"
                              onClick={() => void setIssueState(true)}
                            >
                              <X size={12} strokeWidth={1.5} />
                              Close issue
                            </button>
                          ) : (
                            <button
                              type="button"
                              role="menuitem"
                              className="issues-dd__item"
                              onClick={() => void setIssueState(false)}
                            >
                              <CircleDot size={12} strokeWidth={1.5} />
                              Reopen issue
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <h2 className="issue-detail__title">
                  {d!.title} <span className="issue-detail__number">#{d!.number}</span>
                </h2>
              </div>

              <div className="issue-detail__body">
                <div className="issue-detail__main">
                  {detailLoading && (
                    <div className="issue-skeleton-list" aria-label="Loading issue">
                      <div className="issue-skeleton issue-skeleton--title" />
                      <div className="issue-skeleton issue-skeleton--meta" />
                      <div className="issue-skeleton issue-skeleton--meta" />
                      <div className="issue-skeleton issue-skeleton--meta issue-skeleton--short" />
                    </div>
                  )}

                  {detailError && !detailLoading && (
                    <div className="issue-empty">
                      <p>Could not load this issue</p>
                      <span>{detailError}</span>
                    </div>
                  )}

                  {!detailLoading && !detailError && (
                    <>
                      <div className="issue-detail__status-line">
                        <span className="issue-detail__open">
                          {d!.state === 'OPEN' ? 'Open' : 'Closed'}
                        </span>
                        <span className="issue-detail__status-meta">
                          <strong>{detailAuthor || 'Unknown'}</strong> opened this issue{' '}
                          {relativeTime(d!.createdAt)} · {d!.comments.length} comment
                          {d!.comments.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      <section className="issue-section">
                        <h3>Description</h3>
                        {d!.body.trim() ? (
                          d!.body.split('\n').map((line, index) =>
                            line.trim().startsWith('- ') ? (
                              <ul key={index}>
                                <li>{line.trim().slice(2)}</li>
                              </ul>
                            ) : line.trim() ? (
                              <p key={index}>{line}</p>
                            ) : null,
                          )
                        ) : (
                          <p className="issue-section__muted">No description provided.</p>
                        )}
                      </section>

                      <section className="issue-section">
                        <h3>Activity</h3>
                        {d!.comments.length === 0 && (
                          <p className="issue-section__muted">No comments yet.</p>
                        )}
                        {d!.comments.map((comment, index) => (
                          <div key={`${comment.author}-${index}`} className="issue-comment">
                            <LoginAvatar login={comment.author} className="issue-comment__avatar" size={64} />
                            <div>
                              <p className="issue-comment__head">
                                <strong>{comment.author}</strong> commented{' '}
                                {relativeTime(comment.createdAt)}
                              </p>
                              <p className="issue-comment__body">{comment.body}</p>
                            </div>
                          </div>
                        ))}
                      </section>

                      <div className="issue-reply">
                        <div className="issue-reply__tabs">
                          <button
                            type="button"
                            className={`issue-reply__tab${replyTab === 'write' ? ' issue-reply__tab--active' : ''}`}
                            onClick={() => setReplyTab('write')}
                          >
                            Write
                          </button>
                          <button
                            type="button"
                            className={`issue-reply__tab${replyTab === 'preview' ? ' issue-reply__tab--active' : ''}`}
                            onClick={() => setReplyTab('preview')}
                          >
                            Preview
                          </button>
                        </div>
                        {replyTab === 'write' ? (
                          <textarea
                            placeholder="Leave a comment…"
                            aria-label="Leave a comment"
                            rows={3}
                            value={commentText}
                            onChange={(event) => setCommentText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                void submitComment();
                              }
                            }}
                          />
                        ) : (
                          <div className="issue-reply__preview">
                            {commentText.trim() ? (
                              commentText.split('\n').map((line, index) =>
                                line.trim() ? <p key={index}>{line}</p> : <br key={index} />,
                              )
                            ) : (
                              <p className="issue-section__muted">Nothing to preview.</p>
                            )}
                          </div>
                        )}
                        <div className="issue-reply__foot">
                          <kbd>⌘ ↵</kbd>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => void submitComment()}
                            disabled={commenting || !commentText.trim()}
                          >
                            {commenting ? 'Posting…' : 'Comment'}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <aside className="issue-detail__rail">
                  <section>
                    <h4>Assignees</h4>
                    {detailAssignees.length === 0 && (
                      <p className="issue-rail-note">No assignees yet.</p>
                    )}
                    {detailAssignees.map((name) => (
                      <div key={name} className="issue-rail-row">
                        <LoginAvatar login={name} className="issue-rail-row__avatar" />
                        {name}
                      </div>
                    ))}
                  </section>
                  <section>
                    <h4>Labels</h4>
                    {d!.labels.length === 0 && <p className="issue-rail-note">No labels.</p>}
                    <div className="issue-rail-row issue-rail-row--wrap">
                      {d!.labels.map((label) => (
                        <span key={label} className={`issue-label ${LABEL_TONE_CLASS[labelTone(label)]}`}>
                          {label}
                        </span>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h4>Milestone</h4>
                    {d!.milestone ? (
                      <div className="issue-rail-row">{d!.milestone}</div>
                    ) : (
                      <p className="issue-rail-note">No milestone.</p>
                    )}
                  </section>
                  <section>
                    <h4>Author</h4>
                    <div className="issue-rail-row">
                      <LoginAvatar login={d!.author} className="issue-rail-row__avatar" />
                      {d!.author || 'Unknown'}
                    </div>
                  </section>
                  <section>
                    <h4>Updated</h4>
                    <div className="issue-rail-row">{relativeTime(d!.updatedAt)}</div>
                  </section>
                </aside>
              </div>
            </>
          ) : (
            <div className="issue-detail__placeholder">
              {listLoading ? (
                <>
                  <CircleDot size={26} strokeWidth={1.25} />
                  <p>Loading issues…</p>
                </>
              ) : listError ? (
                <>
                  <CircleDot size={26} strokeWidth={1.25} />
                  <p>Issues unavailable</p>
                  <span>{listError}</span>
                </>
              ) : (
                <>
                  <CircleDot size={26} strokeWidth={1.25} />
                  <p>{issues.length === 0 ? 'No issues' : 'Select an issue'}</p>
                  <span>
                    {issues.length === 0
                      ? 'This repository has no issues on GitHub. Create one with "New issue".'
                      : 'Pick one from the list to see its details.'}
                  </span>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {newIssueOpen && (
        <div className="commit-history__overlay" onClick={() => setNewIssueOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New issue"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>New issue</strong>
            <input
              autoFocus
              placeholder="Issue title"
              value={newIssueTitle}
              onChange={(event) => setNewIssueTitle(event.target.value)}
              aria-label="Issue title"
              spellCheck={false}
            />
            <textarea
              placeholder="Description (optional)…"
              value={newIssueBody}
              onChange={(event) => setNewIssueBody(event.target.value)}
              aria-label="Issue description"
              rows={5}
            />
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setNewIssueOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createIssue()}
                disabled={!newIssueTitle.trim()}
              >
                <Plus size={12} strokeWidth={1.25} />
                Create issue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small chip dropdown with document-level outside close (capture phase). */
function IssueDropdown({
  icon,
  label,
  active,
  children,
}: {
  icon: React.ReactNode;
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
    <div className="issues-dd" ref={ref}>
      <button
        type="button"
        className={`chip-button${active ? ' chip-button--active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {icon}
        {label}
        <ChevronDown size={12} strokeWidth={1.25} />
      </button>
      {open && (
        <div className="issues-dd__menu" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
