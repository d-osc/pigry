import { useRequestGate } from '../../hooks/useRequestGate';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  X,
  Tag as TagIcon,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  ghOpenUrl,
  ghPrCheckout,
  ghPrClose,
  ghPrComment,
  ghPrCreate,
  ghPrDetail,
  ghPrList,
  ghPrReview,
} from '../../lib/tauriClient';
import type { GhPrDetail, GhPullRequest } from '../../types/repository';
import { colorOf, initialsOf, relativeTime, reviewDisplay } from '../../lib/ghData';
import { PrCommits } from './PrCommits';
import { PrFiles } from './PrFiles';
import { useRepository } from '../../hooks/useRepository';
import './PullRequestsScreen.css';

type ReviewTone = 'orange' | 'green' | 'red';
type DetailTab = 'overview' | 'files' | 'commits' | 'checks';

interface PullRequest {
  number: number;
  title: string;
  branch: string;
  state: string;
  author: { initials: string; name: string; color: string };
  updatedAt: string;
  time: string;
  review: string;
  reviewTone: ReviewTone;
  checks: string;
  checksOk: boolean;
  comments: number;
  labels: string[];
}

const REVIEW_TONE_CLASS: Record<ReviewTone, string> = {
  orange: 'pr-badge--orange',
  green: 'pr-badge--green',
  red: 'pr-badge--red',
};

const REVIEW_STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
};

function toDisplayPr(gh: GhPullRequest): PullRequest {
  const { review, tone } = reviewDisplay(gh.state, gh.review, gh.draft);
  const checksOk = gh.checksTotal === 0 ? true : gh.checksOk === gh.checksTotal;
  return {
    number: gh.number,
    title: gh.title,
    branch: gh.branch,
    state: gh.state,
    author: { initials: initialsOf(gh.author), name: gh.author, color: colorOf(gh.author) },
    updatedAt: gh.updatedAt,
    time: relativeTime(gh.updatedAt),
    review,
    reviewTone: tone,
    checks:
      gh.checksTotal > 0
        ? `${gh.checksOk} / ${gh.checksTotal} checks`
        : 'No checks',
    checksOk,
    comments: gh.comments,
    labels: gh.labels,
  };
}

export function PullRequestsScreen() {
  const listGate = useRequestGate();
  const { repository, refresh, notify } = useRepository();
  const [prListWidth, setPrListWidth] = useState(440);
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [live, setLive] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [query, setQuery] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [reviewRequestedOnly, setReviewRequestedOnly] = useState(false);
  const [sortDesc, setSortDesc] = useState(true);

  // Detail
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<GhPrDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [commenting, setCommenting] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<'APPROVE' | 'REQUEST_CHANGES'>('APPROVE');
  const [reviewBody, setReviewBody] = useState('');
  const [newPrOpen, setNewPrOpen] = useState(false);
  const [newPrTitle, setNewPrTitle] = useState('');
  const [newPrBody, setNewPrBody] = useState('');
  const [newPrBase, setNewPrBase] = useState('main');
  const [prMenuOpen, setPrMenuOpen] = useState(false);
  // Bumped by Refresh so the detail effect re-fetches even when the
  // selected PR number did not change.
  const [detailNonce, setDetailNonce] = useState(0);
  const prMenuRef = useRef<HTMLDivElement | null>(null);

  const displayPrs = useMemo(() => prs.map(toDisplayPr), [prs]);
  const authors = useMemo(
    () => [...new Set(displayPrs.map((pr) => pr.author.name))].sort(),
    [displayPrs],
  );
  const labels = useMemo(
    () => [...new Set(displayPrs.flatMap((pr) => pr.labels))].sort(),
    [displayPrs],
  );

  const loadList = async () => {
    const isCurrent = listGate.begin();
    setRefreshing(true);
    setListLoading(true);
    setListError(null);
    try {
      const list = await ghPrList();
      if (!isCurrent()) return;
      setPrs(list);
      setLive(true);
      setSyncedAt(Date.now());
      setSelected((current) =>
        list.some((pr) => pr.number === current) ? current : (list[0]?.number ?? null),
      );
      setDetailNonce((nonce) => nonce + 1);
    } catch (error) {
      if (!isCurrent()) return;
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setRefreshing(false);
      if (isCurrent()) setListLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!prMenuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (prMenuRef.current?.contains(event.target as Node)) return;
      setPrMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [prMenuOpen]);

  // Detail follows the selected PR (real data via gh).
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
    ghPrDetail(selected)
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

  const visiblePrs = useMemo(() => {
    const q = query.trim().toLowerCase();
    const mapped = displayPrs.filter((pr) => {
      if (tab === 'open' ? pr.state !== 'OPEN' : pr.state === 'OPEN') return false;
      if (
        q &&
        !pr.title.toLowerCase().includes(q) &&
        !String(pr.number).includes(q.replace('#', '')) &&
        !pr.branch.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (authorFilter && pr.author.name !== authorFilter) return false;
      if (reviewFilter && pr.review !== reviewFilter) return false;
      if (labelFilter && !pr.labels.includes(labelFilter)) return false;
      if (reviewRequestedOnly && pr.review !== 'Review required') return false;
      return true;
    });
    return mapped.sort((a, b) =>
      sortDesc
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.updatedAt.localeCompare(b.updatedAt),
    );
  }, [displayPrs, tab, query, authorFilter, reviewFilter, labelFilter, reviewRequestedOnly, sortDesc]);

  const submitComment = async () => {
    const body = commentText.trim();
    if (!body || selected === null) return;
    setCommenting(true);
    try {
      await ghPrComment(selected, body);
      setCommentText('');
      notify('Comment posted', 'success');
      setDetail(await ghPrDetail(selected));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setCommenting(false);
    }
  };

  const submitReview = async () => {
    if (selected === null) return;
    try {
      await ghPrReview(selected, reviewEvent, reviewBody.trim() || undefined);
      notify(reviewEvent === 'APPROVE' ? 'Review approved' : 'Changes requested', 'success');
      setReviewDialogOpen(false);
      setReviewBody('');
      setDetail(await ghPrDetail(selected));
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const checkoutBranch = async () => {
    if (selected === null) return;
    try {
      const branch = await ghPrCheckout(selected);
      notify(`Checked out ${branch}`, 'success');
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const createPr = async () => {
    const title = newPrTitle.trim();
    if (!title) return;
    const head = repository?.currentBranch ?? '';
    if (!head || head === newPrBase.trim()) {
      notify('Checkout a feature branch first — cannot merge a branch into itself', 'error');
      return;
    }
    try {
      const url = await ghPrCreate(title, newPrBody.trim(), head, newPrBase.trim() || 'main');
      notify(url ? `Pull request created: ${url}` : 'Pull request created', 'success');
      setNewPrOpen(false);
      setNewPrTitle('');
      setNewPrBody('');
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const closePr = async () => {
    if (selected === null) return;
    if (!window.confirm(`Close pull request #${selected}?`)) return;
    try {
      await ghPrClose(selected);
      notify(`Closed #${selected}`, 'success');
      setPrMenuOpen(false);
      await loadList();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const copyLink = async () => {
    const url = detail?.url;
    if (!url) {
      notify('No GitHub URL for this pull request', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied', 'success');
    } catch {
      notify('Could not access the clipboard', 'error');
    }
    setPrMenuOpen(false);
  };

  const d = detail;
  const checksOkCount = d
    ? d.checks.filter((check) => check.conclusion === 'SUCCESS').length
    : 0;
  const openCount = prs.filter((pr) => pr.state === 'OPEN').length;
  const waitingCount = displayPrs.filter((pr) => pr.review === 'Review required').length;
  const readyCount = displayPrs.filter((pr) => pr.review === 'Approved').length;
  const showDetail = selected !== null && d !== null;

  return (
    <div className="screen pr-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Pull requests</h1>
        <span className="screen-header__count">
          {openCount} open · {prs.length} total
        </span>
        {live && <span className="screen-header__chip">via gh</span>}
        <span className="screen-header__meta">
          {syncedAt ? `Synced ${relativeTime(new Date(syncedAt).toISOString())}` : 'Not synced yet'}
        </span>
        <button
          type="button"
          className="outline-button"
          onClick={() => void loadList()}
          disabled={refreshing}
        >
          <RefreshCw size={12} strokeWidth={1.25} className={refreshing ? 'spin' : ''} />
          Refresh
        </button>
        <button type="button" className="primary-button" onClick={() => setNewPrOpen(true)}>
          <GitPullRequest size={12} strokeWidth={1.25} />
          New pull request
        </button>
      </header>

      <div className="screen-toolbar">
        <div className="screen-search pr-screen__search">
          <Search size={14} strokeWidth={1.25} />
          <input
            placeholder="Search title, #number, or branch…"
            aria-label="Search pull requests"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </div>

        <PrDropdown
          icon={<UserRound size={13} strokeWidth={1.25} />}
          label={authorFilter || 'All authors'}
          active={!!authorFilter}
        >
          <button
            type="button"
            className={`filter-dd__item${!authorFilter ? ' filter-dd__item--active' : ''}`}
            onClick={() => setAuthorFilter('')}
          >
            All authors
          </button>
          {authors.map((name) => (
            <button
              key={name}
              type="button"
              className={`filter-dd__item${authorFilter === name ? ' filter-dd__item--active' : ''}`}
              onClick={() => setAuthorFilter(name)}
            >
              {name}
            </button>
          ))}
        </PrDropdown>

        <PrDropdown
          icon={<Check size={13} strokeWidth={1.25} />}
          label={reviewFilter || 'Review status'}
          active={!!reviewFilter}
        >
          <button
            type="button"
            className={`filter-dd__item${!reviewFilter ? ' filter-dd__item--active' : ''}`}
            onClick={() => setReviewFilter('')}
          >
            Any review status
          </button>
          {['Approved', 'Changes requested', 'Review required'].map((status) => (
            <button
              key={status}
              type="button"
              className={`filter-dd__item${reviewFilter === status ? ' filter-dd__item--active' : ''}`}
              onClick={() => setReviewFilter(status)}
            >
              {status}
            </button>
          ))}
        </PrDropdown>

        <PrDropdown
          icon={<TagIcon size={13} strokeWidth={1.25} />}
          label={labelFilter || 'Labels'}
          active={!!labelFilter}
        >
          <button
            type="button"
            className={`filter-dd__item${!labelFilter ? ' filter-dd__item--active' : ''}`}
            onClick={() => setLabelFilter('')}
          >
            Any label
          </button>
          {labels.map((label) => (
            <button
              key={label}
              type="button"
              className={`filter-dd__item${labelFilter === label ? ' filter-dd__item--active' : ''}`}
              onClick={() => setLabelFilter(label)}
            >
              <TagIcon size={11} strokeWidth={1.25} />
              {label}
            </button>
          ))}
        </PrDropdown>

        <label className="pr-screen__toggle">
          <input
            type="checkbox"
            checked={reviewRequestedOnly}
            onChange={(event) => setReviewRequestedOnly(event.target.checked)}
          />
          Review requested
        </label>
        <PrDropdown
          icon={<SlidersHorizontal size={14} strokeWidth={1.25} />}
          label=""
          ariaLabel="Sort pull requests"
        >
          <button
            type="button"
            className={`filter-dd__item${sortDesc ? ' filter-dd__item--active' : ''}`}
            onClick={() => setSortDesc(true)}
          >
            Recently updated
          </button>
          <button
            type="button"
            className={`filter-dd__item${!sortDesc ? ' filter-dd__item--active' : ''}`}
            onClick={() => setSortDesc(false)}
          >
            Oldest updated
          </button>
        </PrDropdown>
      </div>

      <div className="screen-body">
        <aside className="pr-list" style={{ width: prListWidth }}>
          <div className="pr-list__tabs">
            <button
              type="button"
              className={`pr-list__tab${tab === 'open' ? ' pr-list__tab--active' : ''}`}
              onClick={() => setTab('open')}
            >
              Open <span className="pr-list__tab-count">{openCount}</span>
            </button>
            <button
              type="button"
              className={`pr-list__tab${tab === 'closed' ? ' pr-list__tab--active' : ''}`}
              onClick={() => setTab('closed')}
            >
              Closed <span className="pr-list__tab-count">{prs.length - openCount}</span>
            </button>
            <button
              type="button"
              className="pr-list__sort"
              onClick={() => setSortDesc((value) => !value)}
              title="Toggle sort order"
            >
              {sortDesc ? 'Recently updated ↓' : 'Oldest updated ↑'}
            </button>
          </div>

          {listLoading ? (
            <div className="pr-skeleton-list" aria-label="Loading pull requests">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="pr-skeleton-row">
                  <div className="pr-skeleton pr-skeleton--title" />
                  <div className="pr-skeleton pr-skeleton--meta" />
                  <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                </div>
              ))}
            </div>
          ) : listError ? (
            <div className="pr-empty">
              <GitPullRequest size={22} strokeWidth={1.25} />
              <p>Could not load pull requests</p>
              <span>{listError}</span>
              <span className="pr-empty__hint">
                Make sure the GitHub CLI (gh) is installed and signed in.
              </span>
              <button type="button" className="outline-button" onClick={() => void loadList()}>
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>
            </div>
          ) : visiblePrs.length === 0 ? (
            <div className="pr-empty">
              <GitPullRequest size={22} strokeWidth={1.25} />
              <p>
                {prs.length === 0
                  ? 'No pull requests'
                  : tab === 'open'
                    ? 'No open pull requests'
                    : 'No closed pull requests'}
              </p>
              <span>
                {prs.length === 0
                  ? 'This repository has no pull requests on GitHub yet. Push a branch and create one below.'
                  : query || authorFilter || reviewFilter || labelFilter || reviewRequestedOnly
                    ? 'No pull requests match the current filters.'
                    : 'Nothing here.'}
              </span>
              {prs.length === 0 && (
                <button type="button" className="outline-button" onClick={() => setNewPrOpen(true)}>
                  <GitPullRequest size={12} strokeWidth={1.25} />
                  New pull request
                </button>
              )}
            </div>
          ) : (
            visiblePrs.map((pr) => (
              <button
                key={pr.number}
                type="button"
                className={`pr-row${pr.number === selected ? ' pr-row--selected' : ''}`}
                onClick={() => setSelected(pr.number)}
              >
                <div className="pr-row__title-line">
                  <GitPullRequest size={14} strokeWidth={1.25} className="pr-row__icon" />
                  <span className="pr-row__title">{pr.title}</span>
                </div>
                <div className="pr-row__id-line">
                  #{pr.number} · <span className="pr-row__branch">{pr.branch}</span>
                </div>
                <div className="pr-row__meta-line">
                  <span className="pr-row__avatar" style={{ background: pr.author.color }}>
                    {pr.author.initials}
                  </span>
                  <span className="pr-row__author">{pr.author.name}</span>
                  <span className="pr-row__time">{pr.time}</span>
                </div>
                <div className="pr-row__status-line">
                  <span className={`pr-badge ${REVIEW_TONE_CLASS[pr.reviewTone]}`}>{pr.review}</span>
                  <span className={`pr-row__checks${pr.checksOk ? '' : ' pr-row__checks--failed'}`}>
                    {pr.checksOk ? <Check size={11} strokeWidth={1.75} /> : <Clock size={11} strokeWidth={1.5} />}
                    {pr.checks}
                  </span>
                  <span className="pr-row__comments">
                    <MessageSquare size={11} strokeWidth={1.5} />
                    {pr.comments}
                  </span>
                </div>
              </button>
            ))
          )}

          <div className="pr-queue">
            <p className="pr-queue__heading">Your review queue</p>
            <div className="pr-queue__row">
              <span>Waiting for your review</span>
              <span className="pr-queue__count pr-queue__count--orange">{waitingCount}</span>
            </div>
            <div className="pr-queue__row">
              <span>Approved</span>
              <span className="pr-queue__count pr-queue__count--green">{readyCount}</span>
            </div>
          </div>

          <div className="pr-list__footer">
            <span>
              {listLoading
                ? 'Loading pull requests…'
                : `Showing ${visiblePrs.length} of ${prs.length} requests`}
            </span>
            <span className="pr-list__footer-hint">↑ ↓ to navigate</span>
          </div>
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize pull request list"
          onDelta={(dx) => setPrListWidth((w) => Math.min(620, Math.max(320, w + dx)))}
        />

        <section className="pr-detail">
          {showDetail ? (
            <>
              <div className="pr-detail__meta">
                <span className={`pr-badge ${d!.state === 'OPEN' ? 'pr-badge--open' : REVIEW_TONE_CLASS[reviewDisplay(d!.state, d!.reviewDecision, d!.draft).tone]}`}>
                  {d!.draft ? 'Draft' : d!.state === 'OPEN' ? 'Open' : d!.state === 'MERGED' ? 'Merged' : 'Closed'}
                </span>
                <span className="pr-detail__number">#{d!.number}</span>
                <div className="pr-detail__meta-actions">
                  <button
                    type="button"
                    className="pr-detail__link"
                    onClick={() => {
                      if (d!.url) void ghOpenUrl(d!.url);
                      else notify('No GitHub URL for this pull request', 'error');
                    }}
                  >
                    <ExternalLink size={12} strokeWidth={1.25} />
                    Open on GitHub
                  </button>
                  <div className="pr-detail__more" ref={prMenuRef}>
                    <button
                      type="button"
                      aria-label="More options"
                      onClick={() => setPrMenuOpen((open) => !open)}
                    >
                      <MoreHorizontal size={14} strokeWidth={1.25} />
                    </button>
                    {prMenuOpen && (
                      <div className="working-changes__menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="working-changes__menu-item"
                          onClick={() => void copyLink()}
                        >
                          <Copy size={12} strokeWidth={1.5} />
                          Copy link
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="working-changes__menu-item"
                          onClick={() => void closePr()}
                        >
                          <X size={12} strokeWidth={1.5} />
                          Close pull request
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <h2 className="pr-detail__title">{d!.title}</h2>

              <div className="pr-detail__author-line">
                <span className="pr-row__avatar" style={{ background: colorOf(d!.author) }}>
                  {initialsOf(d!.author)}
                </span>
                <strong>{d!.author}</strong>
                <span className="pr-detail__muted">wants to merge</span>
                <span className="pr-detail__branch pr-detail__branch--base">{d!.baseRef}</span>
                <span className="pr-detail__muted">←</span>
                <span className="pr-detail__branch">{d!.headRef}</span>
                <span className="pr-detail__commits">
                  {d!.commits.length} commits · {d!.commits[0]?.oid.slice(0, 7) ?? '—'}
                </span>
              </div>

              <div className="pr-detail__tabs">
                <button
                  type="button"
                  className={`pr-detail__tab${detailTab === 'overview' ? ' pr-detail__tab--active' : ''}`}
                  onClick={() => setDetailTab('overview')}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={`pr-detail__tab${detailTab === 'files' ? ' pr-detail__tab--active' : ''}`}
                  onClick={() => setDetailTab('files')}
                >
                  Files changed <span className="pr-detail__tab-count">{d!.files.length}</span>
                </button>
                <button
                  type="button"
                  className={`pr-detail__tab${detailTab === 'commits' ? ' pr-detail__tab--active' : ''}`}
                  onClick={() => setDetailTab('commits')}
                >
                  Commits <span className="pr-detail__tab-count">{d!.commits.length}</span>
                </button>
                <button
                  type="button"
                  className={`pr-detail__tab${detailTab === 'checks' ? ' pr-detail__tab--active' : ''}`}
                  onClick={() => setDetailTab('checks')}
                >
                  Checks <span className="pr-detail__tab-count">{d!.checks.length}</span>
                </button>
              </div>

              <div className="pr-detail__body">
                <div className="pr-detail__main">
                  {detailLoading && (
                    <div className="pr-skeleton-list" aria-label="Loading pull request">
                      <div className="pr-skeleton pr-skeleton--title" />
                      <div className="pr-skeleton pr-skeleton--meta" />
                      <div className="pr-skeleton pr-skeleton--meta" />
                      <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                    </div>
                  )}

                  {detailError && (
                    <div className="pr-empty">
                      <p>Could not load this pull request</p>
                      <span>{detailError}</span>
                    </div>
                  )}

                  {!detailLoading && !detailError && (
                    <>
                      {detailTab === 'overview' && (
                        <section className="pr-section">
                          <h3>Summary</h3>
                          {d!.body.split('\n').map((line, index) =>
                            line.trim().startsWith('- ') ? (
                              <ul key={index}>
                                <li>{line.trim().slice(2)}</li>
                              </ul>
                            ) : line.trim() ? (
                              <p key={index}>{line}</p>
                            ) : null,
                          )}
                          {d!.labels.length > 0 && (
                            <div className="pr-labels">
                              {d!.labels.map((label) => (
                                <span key={label} className="pr-label pr-label--purple">
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                        </section>
                      )}

                      {detailTab === 'files' && (
                        <PrFiles
                          key={JSON.stringify([repository?.localPath, selected, detailNonce])}
                          detail={d!}
                        />
                      )}

                      {detailTab === 'commits' && (
                        <PrCommits
                          key={JSON.stringify([repository?.localPath, selected])}
                          commits={d!.commits}
                        />
                      )}

                      {detailTab === 'checks' && (
                        <section className="pr-section">
                          <h3>Checks</h3>
                          {d!.checks.length === 0 && (
                            <p className="pr-section__muted">No checks reported.</p>
                          )}
                          {d!.checks.map((check) => {
                            const ok = check.conclusion === 'SUCCESS';
                            const failed = check.conclusion === 'FAILURE';
                            return (
                              <div key={check.name} className="pr-check">
                                {ok ? (
                                  <Check size={11} strokeWidth={1.75} className="pr-check__icon" />
                                ) : failed ? (
                                  <X size={11} strokeWidth={1.75} className="pr-check__icon pr-check__icon--fail" />
                                ) : (
                                  <Clock size={11} strokeWidth={1.5} className="pr-check__icon" />
                                )}
                                <span>{check.name}</span>
                                <span className="pr-check__duration">
                                  {check.duration || check.conclusion || check.status}
                                </span>
                              </div>
                            );
                          })}
                        </section>
                      )}

                      {detailTab === 'overview' && (
                        <section className="pr-section">
                          <div className="pr-section__head">
                            <h3>Discussion</h3>
                            <span className="pr-section__muted">{d!.comments.length} comments</span>
                          </div>
                          {d!.comments.map((comment, index) => (
                            <div key={`${comment.author}-${index}`} className="pr-comment">
                              <div className="pr-comment__head">
                                <span
                                  className="pr-row__avatar"
                                  style={{ background: colorOf(comment.author) }}
                                >
                                  {initialsOf(comment.author)}
                                </span>
                                <strong>{comment.author}</strong>
                                <span className="pr-comment__time">{relativeTime(comment.createdAt)}</span>
                              </div>
                              <p>{comment.body}</p>
                            </div>
                          ))}
                          <div className="pr-comment-input">
                            <input
                              placeholder="Leave a comment…"
                              aria-label="Leave a comment"
                              value={commentText}
                              onChange={(event) => setCommentText(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                  void submitComment();
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="pr-comment-submit"
                              onClick={() => void submitComment()}
                              disabled={commenting || !commentText.trim()}
                              title="Post comment (⌘ ↵)"
                            >
                              {commenting ? 'Posting…' : 'Comment'}
                            </button>
                            <kbd>⌘ ↵</kbd>
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </div>

                <aside className="pr-detail__rail">
                  <section className="pr-rail-section">
                    <h4>Reviewers</h4>
                    <p className="pr-rail-section__sub">
                      {d!.reviews.filter((review) => review.state === 'APPROVED').length} approved
                    </p>
                    {d!.reviews.length === 0 && (
                      <p className="pr-rail-section__note">No reviews yet.</p>
                    )}
                    {d!.reviews.map((review) => (
                      <div key={`${review.author}-${review.submittedAt}`} className="pr-reviewer">
                        <span className="pr-row__avatar" style={{ background: colorOf(review.author) }}>
                          {initialsOf(review.author)}
                        </span>
                        <div>
                          <p className="pr-reviewer__name">{review.author}</p>
                          <p
                            className={`pr-reviewer__status ${
                              review.state === 'APPROVED'
                                ? 'pr-reviewer__status--ok'
                                : review.state === 'CHANGES_REQUESTED'
                                  ? 'pr-reviewer__status--fail'
                                  : 'pr-reviewer__status--waiting'
                            }`}
                          >
                            {REVIEW_STATUS_LABEL[review.state] ?? review.state}
                          </p>
                        </div>
                      </div>
                    ))}
                  </section>

                  <section className="pr-rail-section">
                    <h4>
                      {d!.checks.length > 0 && checksOkCount === d!.checks.length
                        ? 'All checks passed'
                        : `${checksOkCount} / ${d!.checks.length} checks passed`}
                    </h4>
                    <p className="pr-rail-section__sub">
                      {checksOkCount} / {d!.checks.length}
                    </p>
                    {d!.checks.map((check) => {
                      const ok = check.conclusion === 'SUCCESS';
                      const failed = check.conclusion === 'FAILURE';
                      return (
                        <div key={check.name} className="pr-check">
                          {ok ? (
                            <Check size={11} strokeWidth={1.75} className="pr-check__icon" />
                          ) : failed ? (
                            <X size={11} strokeWidth={1.75} className="pr-check__icon pr-check__icon--fail" />
                          ) : (
                            <Clock size={11} strokeWidth={1.5} className="pr-check__icon" />
                          )}
                          <span>{check.name}</span>
                          <span className="pr-check__duration">{check.duration || check.conclusion}</span>
                        </div>
                      );
                    })}
                    <p className={d!.mergeable === 'CONFLICTING' ? 'pr-rail-section__fail' : 'pr-rail-section__ok'}>
                      {d!.mergeable === 'CONFLICTING'
                        ? '⚠ Merge conflicts with the base branch'
                        : '✓ No merge conflicts'}
                    </p>
                    <p className="pr-rail-section__note">
                      {d!.reviewDecision === 'APPROVED'
                        ? 'Approved — ready to merge once checks pass.'
                        : 'Merging is blocked until the required review is complete.'}
                    </p>
                  </section>

                  <section className="pr-rail-section">
                    <h4>Labels</h4>
                    <div className="pr-labels">
                      {d!.labels.length === 0 && <p className="pr-rail-section__note">No labels.</p>}
                      {d!.labels.map((label) => (
                        <span key={label} className="pr-label pr-label--purple">
                          {label}
                        </span>
                      ))}
                    </div>
                  </section>
                </aside>
              </div>

              <footer className="pr-detail__actions">
                <div>
                  <p className="pr-detail__actions-title">
                    <Clock size={13} strokeWidth={1.5} className="pr-detail__actions-icon" />
                    {d!.reviewDecision === 'APPROVED'
                      ? 'Approved'
                      : d!.reviewDecision === 'CHANGES_REQUESTED'
                        ? 'Changes requested'
                        : 'Your review is required'}
                  </p>
                  <p className="pr-detail__actions-sub">
                    {checksOkCount === d!.checks.length
                      ? 'All checks passed'
                      : `${checksOkCount} of ${d!.checks.length} checks passing`}{' '}
                    · merging into {d!.baseRef}
                  </p>
                </div>
                <div className="pr-detail__actions-buttons">
                  <button type="button" className="outline-button" onClick={() => void checkoutBranch()}>
                    <GitBranch size={12} strokeWidth={1.25} />
                    Check out branch
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setReviewDialogOpen(true)}
                  >
                    Review changes
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <div className="pr-detail__placeholder">
              {listLoading ? (
                <>
                  <GitPullRequest size={26} strokeWidth={1.25} />
                  <p>Loading pull requests…</p>
                </>
              ) : listError ? (
                <>
                  <GitPullRequest size={26} strokeWidth={1.25} />
                  <p>Pull requests unavailable</p>
                  <span>{listError}</span>
                </>
              ) : (
                <>
                  <GitPullRequest size={26} strokeWidth={1.25} />
                  <p>{prs.length === 0 ? 'No pull requests' : 'Select a pull request'}</p>
                  <span>
                    {prs.length === 0
                      ? 'This repository has no pull requests on GitHub. Push a branch and press "New pull request".'
                      : 'Pick one from the list to see its details.'}
                  </span>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {reviewDialogOpen && (
        <div className="commit-history__overlay" onClick={() => setReviewDialogOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Submit review"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>Review #{selected}</strong>
            <div className="pr-review-choices">
              <label>
                <input
                  type="radio"
                  name="review-event"
                  checked={reviewEvent === 'APPROVE'}
                  onChange={() => setReviewEvent('APPROVE')}
                />
                Approve
              </label>
              <label>
                <input
                  type="radio"
                  name="review-event"
                  checked={reviewEvent === 'REQUEST_CHANGES'}
                  onChange={() => setReviewEvent('REQUEST_CHANGES')}
                />
                Request changes
              </label>
            </div>
            <textarea
              placeholder="Leave review feedback (optional)…"
              value={reviewBody}
              onChange={(event) => setReviewBody(event.target.value)}
              aria-label="Review comment"
              rows={4}
            />
            <div className="commit-history__branch-actions">
              <button
                type="button"
                className="outline-button"
                onClick={() => setReviewDialogOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={() => void submitReview()}>
                Submit review
              </button>
            </div>
          </div>
        </div>
      )}

      {newPrOpen && (
        <div className="commit-history__overlay" onClick={() => setNewPrOpen(false)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New pull request"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>New pull request</strong>
            <span className="commit-history__branch-base">
              <code>{repository?.currentBranch ?? 'HEAD'}</code> → <code>{newPrBase || 'main'}</code>
            </span>
            <input
              autoFocus
              placeholder="Pull request title"
              value={newPrTitle}
              onChange={(event) => setNewPrTitle(event.target.value)}
              aria-label="Pull request title"
              spellCheck={false}
            />
            <input
              placeholder="Base branch (e.g. main)"
              value={newPrBase}
              onChange={(event) => setNewPrBase(event.target.value)}
              aria-label="Base branch"
              spellCheck={false}
            />
            <textarea
              placeholder="Description (optional)…"
              value={newPrBody}
              onChange={(event) => setNewPrBody(event.target.value)}
              aria-label="Pull request description"
              rows={5}
            />
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setNewPrOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void createPr()}
                disabled={!newPrTitle.trim()}
              >
                <GitPullRequest size={12} strokeWidth={1.25} />
                Create pull request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small chip dropdown with document-level outside close (capture phase). */
function PrDropdown({
  icon,
  label,
  active,
  children,
  ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  children: React.ReactNode;
  ariaLabel?: string;
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
        aria-label={ariaLabel}
      >
        {icon}
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
