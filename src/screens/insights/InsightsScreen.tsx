import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CalendarRange,
  ChevronDown,
  Clock,
  Copy,
  Eye,
  GitPullRequest,
  RefreshCw,
} from 'lucide-react';
import {
  getInsights,
  ghDeliveryStats,
  ghTraffic,
} from '../../lib/tauriClient';
import type {
  GhDeliveryStats,
  GhTraffic,
  InsightsData,
  InsightsWeek,
} from '../../types/repository';
import { initialsOf, colorOf, relativeTime } from '../../lib/ghData';
import './InsightsScreen.css';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const DAY = 86_400;
const RANGES = [7, 28, 90];

type Tab = 'overview' | 'activity' | 'contributors' | 'frequency' | 'traffic';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'contributors', label: 'Contributors' },
  { id: 'frequency', label: 'Code frequency' },
  { id: 'traffic', label: 'Traffic' },
];

const MONTH_SHORT = (month: number) => MONTHS[month] ?? '—';

/** "Oct 10" from an epoch-second timestamp, in UTC. */
function fmtDay(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return `${MONTH_SHORT(date.getUTCMonth())} ${date.getUTCDate()}`;
}

function fmtFullDay(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return `${MONTH_SHORT(date.getUTCMonth())} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function weekLabel(week: InsightsWeek): string {
  return `${fmtDay(week.startSeconds)}–${fmtDay(Math.max(week.endSeconds - 1, week.startSeconds))}`;
}

function fmtInt(value: number): string {
  return value.toLocaleString('en-US');
}

function fmtSigned(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toLocaleString('en-US')}`;
}

/** "+20.0%" style comparison; ±0 when flat, "new" when there was nothing before. */
function pctDelta(current: number, previous: number): { text: string; neutral: boolean } {
  if (previous === 0) {
    return { text: current === 0 ? '±0' : 'new', neutral: true };
  }
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return { text: '±0', neutral: true };
  return {
    text: `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`,
    neutral: false,
  };
}

function fmtMedian(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function SkeletonBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="pr-skeleton-list" aria-label="Loading insights">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="pr-skeleton-row">
          <div className="pr-skeleton pr-skeleton--title" />
          <div className="pr-skeleton pr-skeleton--meta" />
          <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
        </div>
      ))}
    </div>
  );
}

export function InsightsScreen() {
  const [days, setDays] = useState(28);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('overview');

  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [delivery, setDelivery] = useState<GhDeliveryStats | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const [traffic, setTraffic] = useState<GhTraffic | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [trafficError, setTrafficError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      // Git statistics first; delivery metrics are best-effort alongside.
      getInsights(days)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      setDelivery(null);
      setDeliveryError(null);
      ghDeliveryStats(days)
        .then((result) => {
          if (!cancelled) setDelivery(result);
        })
        .catch((err) => {
          if (!cancelled) {
            setDeliveryError(err instanceof Error ? err.message : String(err));
          }
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [days]);

  // Traffic is fetched only when its tab opens (REST calls are rate-limited).
  useEffect(() => {
    if (tab !== 'traffic' || traffic !== null || trafficError !== null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setTrafficLoading(true);
      ghTraffic()
        .then((result) => {
          if (!cancelled) setTraffic(result);
        })
        .catch((err) => {
          if (!cancelled) {
            setTrafficError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) setTrafficLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab, traffic, trafficError]);

  useEffect(() => {
    if (!rangeOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rangeRef.current?.contains(event.target as Node)) return;
      setRangeOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [rangeOpen]);

  const isEmpty =
    data !== null && !loading && !error &&
    data.commits === 0 && data.prevCommits === 0 && data.people.length === 0;

  const maxBar = useMemo(() => {
    if (!data) return 1;
    const values = [
      ...data.weekly.map((week) => week.commits),
      ...data.prevWeekly.map((week) => week.commits),
    ];
    return Math.max(1, ...values);
  }, [data]);

  const maxChurn = useMemo(() => {
    if (!data) return 1;
    const values = data.weekly.flatMap((week) => [week.additions, week.deletions]);
    return Math.max(1, ...values);
  }, [data]);

  const maxDayCommits = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.days.map((day) => day.commits));
  }, [data]);

  const focusCards = useMemo(() => {
    const cards: { title: string; body: string }[] = [];
    if (!data) return cards;
    if (delivery && delivery.prOpenNow > 0) {
      cards.push({
        title: 'Keep the review queue moving',
        body: `${delivery.prOpenNow} pull request${delivery.prOpenNow === 1 ? ' is' : 's are'} open right now, against ${delivery.prMerged} merged in this period. Review the open ones before starting new work.`,
      });
    } else if (delivery && delivery.prMerged > 0) {
      cards.push({
        title: 'Delivery is flowing',
        body: `${delivery.prMerged} pull request${delivery.prMerged === 1 ? '' : 's'} merged in this period with nothing waiting. Median time to merge is ${fmtMedian(delivery.medianMergeSeconds)}.`,
      });
    }
    if (delivery && delivery.issueOpenNow > 0) {
      cards.push({
        title: 'Protect the triage cadence',
        body: `${delivery.issueClosed} issue${delivery.issueClosed === 1 ? '' : 's'} closed and ${delivery.issueOpened} opened in this period; ${delivery.issueOpenNow} remain open. Keep triaging the backlog.`,
      });
    }
    if (data.weekly.length > 1) {
      const last = data.weekly[data.weekly.length - 1];
      const totalLines = data.weekly.reduce((sum, week) => sum + week.additions + week.deletions, 0);
      const lastLines = last.additions + last.deletions;
      const share = totalLines > 0 ? (lastLines / totalLines) * 100 : 0;
      if (share >= 25) {
        cards.push({
          title: 'Review the growing change surface',
          body: `The final week changed ${fmtInt(lastLines)} lines — ${share.toFixed(1)}% of all changed lines in the period. Prioritize that week's diffs.`,
        });
      }
    }
    if (cards.length === 0 && data.commits > 0) {
      cards.push({
        title: 'Commit cadence',
        body: `${fmtInt(data.commits)} commit${data.commits === 1 ? '' : 's'} across ${data.contributors} contributor${data.contributors === 1 ? '' : 's'} in ${days} days, with ${fmtSigned(data.additions)} additions and ${fmtSigned(data.deletions)} deletions.`,
      });
    }
    return cards.slice(0, 3);
  }, [data, delivery, days]);

  const renderKpis = (data: InsightsData) => {
    const commitsDelta = pctDelta(data.commits, data.prevCommits);
    const contributorsDelta = pctDelta(data.contributors, data.prevContributors);
    const prDelta = delivery ? pctDelta(delivery.prMerged, delivery.prMergedPrev) : null;
    const medianDelta =
      delivery && delivery.medianMergeSeconds !== null && delivery.medianMergeSecondsPrev !== null
        ? pctDelta(delivery.medianMergeSeconds, delivery.medianMergeSecondsPrev)
        : null;
    const kpis = [
      {
        label: 'Commits in period',
        value: fmtInt(data.commits),
        delta: commitsDelta,
        goodWhenUp: true,
        sub: `${fmtInt(data.prevCommits)} in previous period`,
      },
      {
        label: 'Active contributors',
        value: fmtInt(data.contributors),
        delta: contributorsDelta,
        goodWhenUp: true,
        sub: `${fmtInt(data.prevContributors)} in previous period`,
      },
      {
        label: 'Pull requests merged',
        value: delivery ? fmtInt(delivery.prMerged) : '—',
        delta: prDelta ?? { text: '—', neutral: true },
        goodWhenUp: true,
        sub: delivery
          ? `${fmtInt(delivery.prMergedPrev)} in previous period`
          : 'gh unavailable',
      },
      {
        label: 'Median time to merge',
        value: delivery ? fmtMedian(delivery.medianMergeSeconds) : '—',
        delta: medianDelta ?? { text: '—', neutral: true },
        goodWhenUp: false, // shorter is better
        sub: delivery
          ? `${fmtMedian(delivery.medianMergeSecondsPrev)} in previous period`
          : 'gh unavailable',
      },
    ];
    return (
      <div className="insights-kpis">
        {kpis.map((kpi) => {
          // Default delta chip is green; a direction that contradicts the
          // KPI's "good" direction turns it red (down-bad / up-bad).
          const isDown = kpi.delta.text.startsWith('−');
          const tone = kpi.delta.neutral
            ? ' insights-kpi__delta--neutral'
            : isDown === kpi.goodWhenUp
              ? ' insights-kpi__delta--down'
              : '';
          return (
            <div key={kpi.label} className="insights-kpi">
              <p className="insights-kpi__label">{kpi.label}</p>
              <p className="insights-kpi__value">
                {kpi.value}
                <span className={`insights-kpi__delta${tone}`}>{kpi.delta.text}</span>
              </p>
              <p className="insights-kpi__sub">{kpi.sub}</p>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOverview = (data: InsightsData) => (
    <>
      {renderKpis(data)}

      <div className="insights-screen__row insights-screen__row--top">
        <section className="insights-panel insights-chart">
          <header>
            <h3>Commit activity</h3>
            <p className="insights-panel__sub">Commits / week · previous period aligned by week</p>
            <div className="insights-chart__legend">
              <span>
                <i className="insights-chart__swatch insights-chart__swatch--current" /> Current · {fmtInt(data.commits)}
              </span>
              <span>
                <i className="insights-chart__swatch insights-chart__swatch--previous" /> Previous · {fmtInt(data.prevCommits)}
              </span>
            </div>
          </header>
          <div className="insights-bars">
            {data.weekly.map((week, index) => {
              const previous = data.prevWeekly[index]?.commits ?? 0;
              return (
                <div key={week.startSeconds} className="insights-bars__group">
                  <div className="insights-bars__pair">
                    <div
                      className="insights-bars__bar insights-bars__bar--previous"
                      style={{ height: `${(previous / maxBar) * 100}%` }}
                    />
                    <div
                      className="insights-bars__bar insights-bars__bar--current"
                      style={{ height: `${(week.commits / maxBar) * 100}%` }}
                    >
                      {week.commits > 0 && <span>{week.commits}</span>}
                    </div>
                  </div>
                  <p className="insights-bars__label">{weekLabel(week)}</p>
                </div>
              );
            })}
          </div>
          {data.weekly.length > 1 && (
            <p className="insights-panel__footnote">
              ✦ {data.weekly[data.weekly.length - 1].commits} commits in the final week,
              {' '}vs {data.weekly[0].commits} in the first.
            </p>
          )}
        </section>

        <section className="insights-panel insights-code">
          <header>
            <h3>Code changes</h3>
            <p className="insights-panel__sub">Lines · in period</p>
          </header>
          <div className="insights-code__stats">
            <span className="insights-code__added">
              +{fmtInt(data.additions)} <em>additions</em>
            </span>
            <span className="insights-code__removed">
              −{fmtInt(data.deletions)} <em>deletions</em>
            </span>
          </div>
          {data.weekly.map((week) => (
            <div key={week.startSeconds} className="insights-code__row">
              <span className="insights-code__week">{weekLabel(week)}</span>
              <div className="insights-code__track">
                <div
                  className="insights-code__bar insights-code__bar--add"
                  style={{ width: `${(week.additions / maxChurn) * 100}%` }}
                />
              </div>
              <span className="insights-code__num insights-code__num--add">
                +{fmtInt(week.additions)}
              </span>
              <div className="insights-code__track">
                <div
                  className="insights-code__bar insights-code__bar--del"
                  style={{ width: `${(week.deletions / maxChurn) * 100}%` }}
                />
              </div>
              <span className="insights-code__num insights-code__num--del">
                −{fmtInt(week.deletions)}
              </span>
            </div>
          ))}
          <p className="insights-panel__footnote">
            Net {fmtSigned(data.additions - data.deletions)} lines · merge commits excluded
            from line counts.
            {data.lineCommitsTotal > data.lineCommitsScanned &&
              ` Line stats scanned ${fmtInt(data.lineCommitsScanned)} of ${fmtInt(data.lineCommitsTotal)} commits.`}
          </p>
        </section>
      </div>

      <div className="insights-screen__row insights-screen__row--bottom">
        <section className="insights-panel insights-contributors">
          <header>
            <h3>Contributors</h3>
            <p className="insights-panel__sub">
              {data.people.length} active · ranked by commits
            </p>
          </header>
          <div className="insights-contributors__head">
            <span>Contributor</span><span>Commits</span><span>Share</span><span>Added</span><span>Deleted</span>
          </div>
          {data.people.slice(0, 6).map((person) => {
            const share = data.commits > 0 ? (person.commits / data.commits) * 100 : 0;
            return (
              <div key={person.name} className="insights-contributor">
                <span className="insights-contributor__name">
                  <span className="insights-contributor__avatar" style={{ background: colorOf(person.name) }}>
                    {initialsOf(person.name)}
                  </span>
                  {person.name}
                </span>
                <span>{fmtInt(person.commits)}</span>
                <span className="insights-contributor__share">
                  <i style={{ width: `${share}%` }} />
                  {share.toFixed(1)}%
                </span>
                <span className="insights-diff--add">+{fmtInt(person.additions)}</span>
                <span className="insights-diff--del">−{fmtInt(person.deletions)}</span>
              </div>
            );
          })}
          <div className="insights-contributors__total">
            <span>Period total</span>
            <span>{fmtInt(data.commits)}</span>
            <span>100.0%</span>
            <span className="insights-diff--add">+{fmtInt(data.additions)}</span>
            <span className="insights-diff--del">−{fmtInt(data.deletions)}</span>
          </div>
        </section>

        <section className="insights-panel insights-delivery">
          <header>
            <h3>Delivery &amp; triage</h3>
            <p className="insights-panel__sub">{fmtDay(data.nowSeconds - days * DAY)} → {fmtDay(data.nowSeconds)}</p>
          </header>
          {delivery ? (
            <>
              <div className="insights-delivery__head">
                <span>Period totals</span><span>Opened</span><span>Resolved</span><span>Open now¹</span>
              </div>
              <div className="insights-delivery__row">
                <span><GitPullRequest size={13} strokeWidth={1.25} /> Pull requests</span>
                <span>{fmtInt(delivery.prOpened)}</span>
                <span className="insights-delivery__ok">
                  {fmtInt(delivery.prMerged)} merged
                  {delivery.prClosedUnmerged > 0 && (
                    <em>{fmtInt(delivery.prClosedUnmerged)} closed unmerged</em>
                  )}
                </span>
                <span>{fmtInt(delivery.prOpenNow)}</span>
              </div>
              <div className="insights-delivery__row">
                <span><Clock size={13} strokeWidth={1.25} /> Issues</span>
                <span>{fmtInt(delivery.issueOpened)}</span>
                <span className="insights-delivery__ok">{fmtInt(delivery.issueClosed)} closed</span>
                <span>{fmtInt(delivery.issueOpenNow)}</span>
              </div>
              <p className="insights-panel__footnote">
                ¹ Open inventory is the live count from GitHub, not a period total.
              </p>
            </>
          ) : (
            <div className="insights-delivery__na">
              <GitPullRequest size={16} strokeWidth={1.25} />
              <p>Delivery data unavailable</p>
              <span>{deliveryError ?? 'Loading…'}</span>
              <span className="insights-delivery__na-hint">
                PR and issue metrics come from the GitHub CLI — make sure gh is
                installed, signed in, and the repository has a GitHub remote.
              </span>
            </div>
          )}
        </section>
      </div>

      {focusCards.length > 0 && (
        <section className="insights-focus">
          <header>
            <h3 className="insights-focus__label">What to focus on</h3>
            <p className="insights-panel__sub">Based on this {days}-day window</p>
          </header>
          <div className="insights-focus__cards">
            {focusCards.map((card) => (
              <article key={card.title} className="insights-focus__card">
                <h4>{card.title}</h4>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );

  const renderActivity = (data: InsightsData) => (
    <div className="insights-screen__row insights-screen__row--top">
      <section className="insights-panel insights-chart">
        <header>
          <h3>Commits per day</h3>
          <p className="insights-panel__sub">{fmtDay(data.nowSeconds - days * DAY)} → {fmtDay(data.nowSeconds)} · UTC</p>
        </header>
        <div className="insights-days">
          {data.days.map((day) => (
            <div key={day.daySeconds} className="insights-days__row">
              <span className="insights-days__label">
                {fmtFullDay(day.daySeconds).slice(0, -6)}
              </span>
              <div className="insights-days__track">
                <i style={{ width: `${(day.commits / maxDayCommits) * 100}%` }} />
              </div>
              <span className="insights-days__count">{day.commits}</span>
            </div>
          ))}
        </div>
        {data.days.length === 0 && (
          <p className="insights-panel__footnote">No commit data for this period.</p>
        )}
      </section>

      <section className="insights-panel insights-recent">
        <header>
          <h3>Recent commits</h3>
          <p className="insights-panel__sub">Latest 30 in period · current branch</p>
        </header>
        <div className="insights-recent__list">
          {data.recent.map((entry) => (
            <div key={entry.oid} className="insights-recent__row">
              <span className="insights-recent__sha">{entry.oid.slice(0, 7)}</span>
              <span className="insights-recent__summary">
                {entry.summary}
                {entry.isMerge && <em className="insights-recent__merge">merge</em>}
              </span>
              <span className="insights-recent__author">{entry.author}</span>
              <span className="insights-recent__time">
                {relativeTime(new Date(entry.timeSeconds * 1000).toISOString(), true)}
              </span>
            </div>
          ))}
          {data.recent.length === 0 && (
            <p className="insights-panel__footnote">No commits in this period.</p>
          )}
        </div>
      </section>
    </div>
  );

  const renderContributors = (data: InsightsData) => (
    <section className="insights-panel insights-contributors insights-contributors--full">
      <header>
        <h3>Contributors</h3>
        <p className="insights-panel__sub">
          {data.people.length} active in period · ranked by commits · current branch
        </p>
      </header>
      {data.people.length === 0 ? (
        <p className="insights-panel__footnote">No contributors in this period.</p>
      ) : (
        <>
          <div className="insights-contributors__head">
            <span>Contributor</span><span>Commits</span><span>Share</span><span>Added</span><span>Deleted</span>
          </div>
          {data.people.map((person) => {
            const share = data.commits > 0 ? (person.commits / data.commits) * 100 : 0;
            return (
              <div key={person.name} className="insights-contributor">
                <span className="insights-contributor__name">
                  <span className="insights-contributor__avatar" style={{ background: colorOf(person.name) }}>
                    {initialsOf(person.name)}
                  </span>
                  {person.name}
                </span>
                <span>{fmtInt(person.commits)}</span>
                <span className="insights-contributor__share">
                  <i style={{ width: `${share}%` }} />
                  {share.toFixed(1)}%
                </span>
                <span className="insights-diff--add">+{fmtInt(person.additions)}</span>
                <span className="insights-diff--del">−{fmtInt(person.deletions)}</span>
              </div>
            );
          })}
          <div className="insights-contributors__total">
            <span>Period total</span>
            <span>{fmtInt(data.commits)}</span>
            <span>100.0%</span>
            <span className="insights-diff--add">+{fmtInt(data.additions)}</span>
            <span className="insights-diff--del">−{fmtInt(data.deletions)}</span>
          </div>
        </>
      )}
    </section>
  );

  const renderFrequency = (data: InsightsData) => (
    <section className="insights-panel insights-code insights-code--full">
      <header>
        <h3>Code frequency</h3>
        <p className="insights-panel__sub">
          Added / deleted lines per week · merge commits excluded · current branch
        </p>
      </header>
      <div className="insights-code__stats">
        <span className="insights-code__added">
          +{fmtInt(data.additions)} <em>additions</em>
        </span>
        <span className="insights-code__removed">
          −{fmtInt(data.deletions)} <em>deletions</em>
        </span>
      </div>
      {data.weekly.map((week) => (
        <div key={week.startSeconds} className="insights-code__row insights-code__row--wide">
          <span className="insights-code__week">{weekLabel(week)}</span>
          <span className="insights-code__commits">{fmtInt(week.commits)} commits</span>
          <div className="insights-code__track">
            <div
              className="insights-code__bar insights-code__bar--add"
              style={{ width: `${(week.additions / maxChurn) * 100}%` }}
            />
          </div>
          <span className="insights-code__num insights-code__num--add">+{fmtInt(week.additions)}</span>
          <div className="insights-code__track">
            <div
              className="insights-code__bar insights-code__bar--del"
              style={{ width: `${(week.deletions / maxChurn) * 100}%` }}
            />
          </div>
          <span className="insights-code__num insights-code__num--del">−{fmtInt(week.deletions)}</span>
        </div>
      ))}
      <p className="insights-panel__footnote">
        Net {fmtSigned(data.additions - data.deletions)} lines in {days} days.
        {data.lineCommitsTotal > data.lineCommitsScanned &&
          ` Line stats scanned ${fmtInt(data.lineCommitsScanned)} of ${fmtInt(data.lineCommitsTotal)} commits.`}
      </p>
    </section>
  );

  const renderTraffic = () => {
    if (trafficLoading) {
      return (
        <section className="insights-panel insights-traffic">
          <header>
            <h3>Traffic</h3>
            <p className="insights-panel__sub">Last 14 days · from GitHub</p>
          </header>
          <SkeletonBlock rows={3} />
        </section>
      );
    }
    if (trafficError) {
      return (
        <section className="insights-panel insights-traffic">
          <header>
            <h3>Traffic</h3>
            <p className="insights-panel__sub">Last 14 days · from GitHub</p>
          </header>
          <div className="insights-delivery__na">
            <Eye size={16} strokeWidth={1.25} />
            <p>Traffic data unavailable</p>
            <span>{trafficError}</span>
            <span className="insights-delivery__na-hint">
              GitHub reports traffic only to repositories where you have push
              access, through the GitHub CLI (gh).
            </span>
          </div>
        </section>
      );
    }
    if (!traffic) return null;
    const sides = [
      {
        icon: <Eye size={14} strokeWidth={1.25} />,
        title: 'Views',
        totals: traffic.views,
        daily: traffic.viewsDaily,
      },
      {
        icon: <Copy size={14} strokeWidth={1.25} />,
        title: 'Clones',
        totals: traffic.clones,
        daily: traffic.clonesDaily,
      },
    ];
    return (
      <div className="insights-screen__row insights-screen__row--traffic">
        {sides.map((side) => {
          const maxDaily = Math.max(1, ...side.daily.map((entry) => entry.count));
          return (
            <section key={side.title} className="insights-panel insights-traffic">
              <header>
                <h3>{side.icon} {side.title}</h3>
                <p className="insights-panel__sub">Last 14 days · from GitHub</p>
              </header>
              <div className="insights-traffic__totals">
                <span><strong>{fmtInt(side.totals.count)}</strong> total</span>
                <span><strong>{fmtInt(side.totals.uniques)}</strong> unique</span>
              </div>
              {side.daily.length === 0 ? (
                <p className="insights-panel__footnote">
                  No traffic recorded yet — GitHub needs a few days to collect data.
                </p>
              ) : (
                side.daily.slice().reverse().map((entry) => {
                  const label = fmtDay(new Date(entry.timestamp).getTime() / 1000);
                  return (
                    <div key={entry.timestamp} className="insights-days__row">
                      <span className="insights-days__label">{label}</span>
                      <div className="insights-days__track">
                        <i style={{ width: `${(entry.count / maxDaily) * 100}%` }} />
                      </div>
                      <span className="insights-days__count">
                        {entry.count} · {entry.uniques} uniq
                      </span>
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <div className="screen insights-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Insights</h1>
        <span className="screen-header__count">Repository activity, delivery and code health.</span>
        <span className="screen-header__meta insights-screen__range">
          <div className="insights-range" ref={rangeRef}>
            <button
              type="button"
              className="chip-button"
              onClick={() => setRangeOpen((open) => !open)}
              aria-expanded={rangeOpen}
              aria-haspopup="menu"
            >
              <CalendarRange size={13} strokeWidth={1.25} />
              {data
                ? `${fmtDay(data.nowSeconds - days * DAY)} → ${fmtDay(data.nowSeconds)}, ${new Date(data.nowSeconds * 1000).getUTCFullYear()} · ${days} days`
                : `Last ${days} days`}
              <ChevronDown size={12} strokeWidth={1.25} />
            </button>
            {rangeOpen && (
              <div className="insights-range__menu" role="menu">
                {RANGES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="menuitem"
                    className={`insights-range__item${days === option ? ' insights-range__item--active' : ''}`}
                    onClick={() => {
                      setDays(option);
                      setRangeOpen(false);
                    }}
                  >
                    Last {option} days
                  </button>
                ))}
              </div>
            )}
          </div>
          {data && (
            <span className="insights-screen__range-sub">
              Compared with {fmtDay(data.nowSeconds - days * DAY * 2)} →{' '}
              {fmtDay(data.nowSeconds - days * DAY)} · previous {days} days
            </span>
          )}
        </span>
      </header>

      <div className="insights-screen__tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`insights-tab${tab === entry.id ? ' insights-tab--active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <span className="insights-screen__branches">
          {data
            ? `${data.headBranch || '(no branch)'} · UTC`
            : '… · UTC'}
        </span>
      </div>

      <div className="insights-screen__scroll">
        {loading ? (
          <SkeletonBlock rows={6} />
        ) : error ? (
          <div className="insights-screen__empty">
            <Activity size={24} strokeWidth={1.25} />
            <p>Could not load insights</p>
            <span>{error}</span>
            <button
              type="button"
              className="outline-button"
              onClick={() => setDays((value) => value)}
            >
              <RefreshCw size={12} strokeWidth={1.25} />
              Retry
            </button>
          </div>
        ) : (
          <>
            {tab === 'overview' && data && (isEmpty ? (
              <div className="insights-screen__empty">
                <Activity size={26} strokeWidth={1.25} />
                <p>No insights for this period</p>
                <span>
                  This repository has no commits in the last {days} days on branch{' '}
                  {data.headBranch || '(none)'} — and none in the previous period
                  either. Make a commit or widen the range above. Traffic and
                  delivery data remain available in their tabs.
                </span>
                <button type="button" className="outline-button" onClick={() => setDays(90)}>
                  <CalendarRange size={12} strokeWidth={1.25} />
                  Show last 90 days
                </button>
              </div>
            ) : (
              renderOverview(data)
            ))}
            {tab === 'activity' && data && renderActivity(data)}
            {tab === 'contributors' && data && renderContributors(data)}
            {tab === 'frequency' && data && renderFrequency(data)}
            {tab === 'traffic' && renderTraffic()}
          </>
        )}
      </div>
    </div>
  );
}
