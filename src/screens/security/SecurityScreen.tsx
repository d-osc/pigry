import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  FileCode2,
  GitBranch,
  Loader2,
  Package,
  Search,
  Settings,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  ghBranchCheckRuns,
  ghCodeScanningAlerts,
  ghDependabotAlerts,
  ghDismissCodeAlert,
  ghOpenUrl,
  ghSecretScanningAlerts,
  readWorktreeFile,
} from '../../lib/tauriClient';
import { relativeTime } from '../../lib/ghData';
import { useRepository } from '../../hooks/useRepository';
import type {
  GhCheckRun,
  GhCodeAlert,
  GhDependabotAlert,
  GhSecretAlert,
} from '../../types/repository';
import './SecurityScreen.css';

type SourceKey = 'code' | 'deps' | 'secrets' | 'checks';
type SourceStatus = 'loading' | 'ok' | 'error';

interface SourceState<T> {
  status: SourceStatus;
  items: T[];
  error: string;
}

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function asSeverity(raw: string): Severity {
  return (SEVERITIES as string[]).includes(raw) ? (raw as Severity) : 'low';
}

const LOADING: SourceState<never> = { status: 'loading', items: [], error: '' };

/** Failed / cancelled conclusions count as failing checks. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'stale', 'cancelled']);

function checkState(run: GhCheckRun): { label: string; tone: 'ok' | 'fail' | 'warn' | 'pending' } {
  if (run.status !== 'completed' || !run.conclusion) {
    return { label: run.status === 'completed' ? 'Completed' : run.status.replace('_', ' '), tone: 'pending' };
  }
  switch (run.conclusion) {
    case 'success':
      return { label: 'Passing', tone: 'ok' };
    case 'skipped':
    case 'neutral':
      return { label: run.conclusion, tone: 'warn' };
    default:
      return { label: run.conclusion.replace('_', ' '), tone: 'fail' };
  }
}

/** "2m 14s" from ISO timestamps ("" when incomplete). */
function fmtDuration(startedAt: string, completedAt: string): string {
  if (!startedAt || !completedAt) return '';
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '';
  const secs = Math.round((end - start) / 1000);
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${secs}s`;
}

/* ---- State panels (no real data available) ---- */

function StatePanel({
  tone,
  icon,
  title,
  description,
  hints,
  errorText,
  onRetry,
}: {
  tone: 'empty' | 'error' | 'clean';
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  hints?: string[];
  errorText?: string;
  onRetry: () => void;
}) {
  return (
    <div className="security-state">
      <div className={`security-state__icon security-state__icon--${tone}`}>{icon}</div>
      <h2 className="security-state__title">{title}</h2>
      <div className="security-state__desc">{description}</div>
      {errorText && <pre className="security-state__error">{errorText}</pre>}
      {hints && hints.length > 0 && (
        <ul className="security-state__hints">
          {hints.map((hint) => (
            <li key={hint}><code>{hint}</code></li>
          ))}
        </ul>
      )}
      <button type="button" className="projects__action" onClick={onRetry}>
        <span>Retry</span>
      </button>
    </div>
  );
}

/* ---- Skeletons ---- */

function HeaderSkeleton() {
  return (
    <div className="security-screen__summary">
      <div className="security-summary__main">
        <span className="security-skel security-skel--big" />
        <div className="security-skel-stack">
          <span className="security-skel security-skel--line" style={{ width: 120 }} />
          <span className="security-skel security-skel--line security-skel--thin" style={{ width: 180 }} />
        </div>
      </div>
      <div className="security-skel-stack">
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className="security-skel security-skel--line security-skel--thin" style={{ width: 92 }} />
        ))}
      </div>
      <div className="security-skel-stack">
        <span className="security-skel security-skel--line" style={{ width: 210 }} />
        <span className="security-skel security-skel--line security-skel--thin" style={{ width: 260 }} />
      </div>
    </div>
  );
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="security-skel-list" aria-label="Loading findings">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="security-skel-row">
          <span className="security-skel security-skel--dot" />
          <div className="security-skel-stack">
            <span className="security-skel security-skel--line" style={{ width: `${78 - (row % 3) * 10}%` }} />
            <span className="security-skel security-skel--line security-skel--thin" style={{ width: `${55 + (row % 2) * 15}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="security-skel-detail" aria-label="Loading details">
      <span className="security-skel security-skel--line security-skel--thin" style={{ width: 180 }} />
      <span className="security-skel security-skel--line security-skel--h2" style={{ width: '62%' }} />
      <div className="security-skel security-skel--code" />
      <div className="security-skel security-skel--code security-skel--code-short" />
    </div>
  );
}

/* ---- Snippet model ---- */

interface Snippet {
  key: string;
  lines: { n: number; text: string; flagged: boolean }[];
  error?: string;
}

function buildSnippet(content: string, alert: GhCodeAlert, key: string): Snippet {
  const all = content.split('\n');
  const start = Math.max(1, alert.startLine - 3);
  const end = Math.min(all.length, Math.max(alert.endLine, alert.startLine) + 3);
  const lines: Snippet['lines'] = [];
  for (let n = start; n <= end; n += 1) {
    lines.push({
      n,
      text: all[n - 1] ?? '',
      flagged: n >= alert.startLine && n <= Math.max(alert.endLine, alert.startLine),
    });
  }
  return { key, lines };
}

export function SecurityScreen() {
  const { repository, notify, mode } = useRepository();
  const [findingsWidth, setFindingsWidth] = useState(420);
  const [tab, setTab] = useState<SourceKey>('code');
  const [query, setQuery] = useState('');
  const [severityMin, setSeverityMin] = useState<'all' | 'high' | 'medium'>('all');
  const [selected, setSelected] = useState<Partial<Record<SourceKey, string>>>({});
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const [code, setCode] = useState<SourceState<GhCodeAlert>>(LOADING);
  const [deps, setDeps] = useState<SourceState<GhDependabotAlert>>(LOADING);
  const [secrets, setSecrets] = useState<SourceState<GhSecretAlert>>(LOADING);
  const [checks, setChecks] = useState<SourceState<GhCheckRun>>(LOADING);

  const fetchSecurityData = useCallback(() => {
    // setState only inside async callbacks — safe for the initial-load effect.
    ghCodeScanningAlerts()
      .then((items) => setCode({ status: 'ok', items, error: '' }))
      .catch((error) => setCode({ status: 'error', items: [], error: String(error) }));
    ghDependabotAlerts()
      .then((items) => setDeps({ status: 'ok', items, error: '' }))
      .catch((error) => setDeps({ status: 'error', items: [], error: String(error) }));
    ghSecretScanningAlerts()
      .then((items) => setSecrets({ status: 'ok', items, error: '' }))
      .catch((error) => setSecrets({ status: 'error', items: [], error: String(error) }));
  }, []);

  // Initial load (setState happens in async callbacks only).
  useEffect(() => {
    fetchSecurityData();
  }, [fetchSecurityData]);

  /** Manual reload (event handler — may set state synchronously). */
  const retryLoad = () => {
    setCode(LOADING);
    setDeps(LOADING);
    setSecrets(LOADING);
    setChecks(LOADING);
    setSnippet(null);
    fetchSecurityData();
  };

  const branch = repository?.currentBranch ?? null;

  // Check runs follow the repository context (branch loads async).
  useEffect(() => {
    if (!branch) return;
    let cancelled = false;
    ghBranchCheckRuns(branch)
      .then((items) => {
        if (!cancelled) setChecks({ status: 'ok', items, error: '' });
      })
      .catch((error) => {
        if (!cancelled) setChecks({ status: 'error', items: [], error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [branch]);

  const repoBase =
    repository?.organization && repository?.name
      ? `https://github.com/${repository.organization}/${repository.name}`
      : null;

  const openInBrowser = async (url: string, what: string) => {
    try {
      await ghOpenUrl(url);
    } catch (error) {
      notify(`Could not open ${what}: ${String(error)}`, 'error');
    }
  };

  /* ---- derived counts ---- */

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const alert of code.items) counts[asSeverity(alert.severity)] += 1;
    for (const alert of deps.items) counts[asSeverity(alert.severity)] += 1;
    return counts;
  }, [code.items, deps.items]);

  const totalFindings = code.items.length + deps.items.length + secrets.items.length;
  const failingChecks = checks.items.filter((run) => FAILING_CONCLUSIONS.has(run.conclusion)).length;
  const passingChecks = checks.items.filter(
    (run) => run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral'),
  ).length;

  const allLoading =
    code.status === 'loading' && deps.status === 'loading' && secrets.status === 'loading';
  const allError =
    code.status === 'error' && deps.status === 'error' && secrets.status === 'error';
  const everythingClean =
    code.status === 'ok' &&
    deps.status === 'ok' &&
    secrets.status === 'ok' &&
    totalFindings === 0 &&
    checks.status === 'ok' &&
    failingChecks === 0;

  /* ---- current tab list ---- */

  const rankOf = (severity: Severity) => SEVERITIES.indexOf(severity);
  const severityVisible = (severity: string) => {
    const rank = rankOf(asSeverity(severity));
    if (severityMin === 'high') return rank <= rankOf('high');
    if (severityMin === 'medium') return rank <= rankOf('medium');
    return true;
  };

  interface Row {
    key: string;
    title: string;
    sub: string;
    severity: Severity | null;
    stateLabel: string;
  }

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (haystack: string) => !q || haystack.toLowerCase().includes(q);
    if (tab === 'code') {
      return code.items
        .filter((alert) => severityVisible(alert.severity))
        .filter((alert) =>
          matches(`${alert.ruleDescription} ${alert.ruleId} ${alert.path} #${alert.number}`),
        )
        .map((alert) => ({
          key: String(alert.number),
          title: alert.ruleDescription || alert.ruleId,
          sub: alert.path
            ? `${alert.path}:${alert.startLine} · ${alert.ruleId}`
            : alert.ruleId,
          severity: asSeverity(alert.severity),
          stateLabel: 'Open',
        }));
    }
    if (tab === 'deps') {
      return deps.items
        .filter((alert) => severityVisible(alert.severity))
        .filter((alert) => matches(`${alert.summary} ${alert.package} ${alert.ecosystem} #${alert.number}`))
        .map((alert) => ({
          key: String(alert.number),
          title: alert.summary || alert.package,
          sub: `${alert.package}${alert.manifestPath ? ` · ${alert.manifestPath}` : ''}`,
          severity: asSeverity(alert.severity),
          stateLabel: 'Open',
        }));
    }
    if (tab === 'secrets') {
      return secrets.items
        .filter((alert) => matches(`${alert.secretType} #${alert.number}`))
        .map((alert) => ({
          key: String(alert.number),
          title: alert.secretType || 'Secret',
          sub: `#${alert.number} · detected ${relativeTime(alert.createdAt, true)}`,
          severity: null,
          stateLabel: 'Open',
        }));
    }
    return checks.items.map((run, index) => {
      const state = checkState(run);
      return {
        key: `${run.name}:${index}`,
        title: run.name,
        sub: `${run.app || 'check'} · ${fmtDuration(run.startedAt, run.completedAt) || 'running…'}`,
        severity: null,
        stateLabel: state.label,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, code.items, deps.items, secrets.items, checks.items, query, severityMin]);

  const activeKey = selected[tab] && rows.some((row) => row.key === selected[tab])
    ? selected[tab]!
    : rows[0]?.key ?? null;

  const activeCode = tab === 'code' && activeKey
    ? code.items.find((alert) => String(alert.number) === activeKey) ?? null
    : null;
  const activeDep = tab === 'deps' && activeKey
    ? deps.items.find((alert) => String(alert.number) === activeKey) ?? null
    : null;
  const activeSecret = tab === 'secrets' && activeKey
    ? secrets.items.find((alert) => String(alert.number) === activeKey) ?? null
    : null;
  const activeCheck = tab === 'checks' && activeKey
    ? checks.items.find((run, index) => `${run.name}:${index}` === activeKey) ?? null
    : null;

  const snippetKey = activeCode?.path
    ? `${activeCode.number}:${activeCode.path}:${activeCode.startLine}`
    : null;
  const activeSnippet =
    snippet && snippetKey && snippet.key === snippetKey ? snippet : null;

  // Local snippet for the selected code alert (desktop only — browser preview
  // has no working tree).
  useEffect(() => {
    if (mode !== 'tauri' || !activeCode?.path || !snippetKey) return;
    let cancelled = false;
    const key = snippetKey;
    readWorktreeFile(activeCode.path)
      .then((file) => {
        if (cancelled) return;
        if (file.binary || file.tooLarge) {
          setSnippet({ key, lines: [], error: 'File not shown (binary or too large).' });
          return;
        }
        setSnippet({ key, lines: buildSnippet(file.content, activeCode, key).lines });
      })
      .catch((error) => {
        if (!cancelled) setSnippet({ key, lines: [], error: String(error) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, snippetKey, activeCode?.path]);

  const dismissActiveCode = () => {
    if (!activeCode) return;
    setDismissing(true);
    ghDismissCodeAlert(activeCode.number, 'false_positive')
      .then(() => {
        setCode((current) => ({
          ...current,
          items: current.items.filter((alert) => alert.number !== activeCode.number),
        }));
        setSnippet(null);
        notify(`Dismissed alert #${activeCode.number} as false positive`, 'success');
      })
      .catch((error) => {
        notify(`Could not dismiss alert: ${String(error)}`, 'error');
      })
      .finally(() => {
        setDismissing(false);
      });
  };

  const sourceOf = (key: SourceKey) =>
    key === 'code' ? code : key === 'deps' ? deps : key === 'secrets' ? secrets : checks;

  const tabCount = (key: SourceKey): React.ReactNode => {
    const source = sourceOf(key);
    if (source.status === 'loading') return '…';
    if (source.status === 'error') return '!';
    if (key === 'checks') {
      if (failingChecks > 0) {
        return (
          <span className="security-tab__count security-tab__count--warn">
            {failingChecks} failing
          </span>
        );
      }
      return <span className="security-tab__count security-tab__count--pass">passing</span>;
    }
    return <span className="security-tab__count">{source.items.length}</span>;
  };

  const renderListBody = () => {
    const source = sourceOf(tab);
    if (source.status === 'loading') return <ListSkeleton />;
    if (source.status === 'error') {
      return (
        <div className="security-inline-note security-inline-note--error">
          <TriangleAlert size={13} strokeWidth={1.25} />
          <p>{source.error}</p>
          <p className="security-inline-note__hint">
            GitHub returns this per-feature — the source may be disabled on the repository or
            the token lacks the required scope.
          </p>
        </div>
      );
    }
    if (rows.length === 0) {
      const emptyText: Record<SourceKey, string> = {
        code: 'No open code scanning alerts — code scanning is passing.',
        deps: 'No open dependency alerts — Dependabot has nothing to report.',
        secrets: 'No open secret scanning alerts.',
        checks: 'No check runs reported for this branch on GitHub yet.',
      };
      return (
        <div className="security-inline-note">
          <ShieldCheck size={13} strokeWidth={1.25} />
          <p>{query || severityMin !== 'all' ? 'No findings match the current filters.' : emptyText[tab]}</p>
        </div>
      );
    }
    return rows.map((row) => (
      <button
        key={row.key}
        type="button"
        className={`security-finding${row.key === activeKey ? ' security-finding--selected' : ''}`}
        onClick={() => setSelected((current) => ({ ...current, [tab]: row.key }))}
      >
        {row.severity ? (
          <i className={`security-dot security-dot--${row.severity}`} />
        ) : (
          <StateDot run={tab === 'checks' ? activeCheckRunOf(row.key) : null} />
        )}
        <div className="security-finding__text">
          <p className="security-finding__title">{row.title}</p>
          <p className="security-finding__path">{row.sub}</p>
        </div>
        <div className="security-finding__right">
          {row.severity && (
            <span className={`security-level security-level--${row.severity}`}>
              {SEVERITY_LABEL[row.severity]}
            </span>
          )}
          <span className="security-finding__status">{row.stateLabel}</span>
        </div>
      </button>
    ));
  };

  const activeCheckRunOf = (key: string): GhCheckRun | null => {
    const index = checks.items.findIndex((run, i) => `${run.name}:${i}` === key);
    return index >= 0 ? checks.items[index] : null;
  };

  const renderDetail = () => {
    const source = sourceOf(tab);
    if (source.status === 'loading') return <DetailSkeleton />;
    if (source.status === 'error' || rows.length === 0) {
      return (
        <div className="security-detail security-detail--placeholder">
          <ShieldCheck size={22} strokeWidth={1.25} />
          <p>
            {source.status === 'error'
              ? 'This source is unavailable — see the note in the list.'
              : 'Nothing to show. Select a finding from the list.'}
          </p>
        </div>
      );
    }
    if (tab === 'code' && activeCode) {
      return (
        <CodeDetail
          alert={activeCode}
          snippet={activeSnippet}
          expectingSnippet={!!snippetKey}
          dismissing={dismissing}
          onDismiss={dismissActiveCode}
          onOpen={() => openInBrowser(activeCode.htmlUrl, 'the alert')}
        />
      );
    }
    if (tab === 'deps' && activeDep) {
      return (
        <DepDetail alert={activeDep} onOpen={() => openInBrowser(activeDep.htmlUrl, 'the alert')} />
      );
    }
    if (tab === 'secrets' && activeSecret) {
      return (
        <SecretDetail
          alert={activeSecret}
          onOpen={() => openInBrowser(activeSecret.htmlUrl, 'the alert')}
        />
      );
    }
    if (tab === 'checks' && activeCheck) {
      const state = checkState(activeCheck);
      return (
        <div className="security-detail">
          <div className="security-detail__meta">
            <span className={`security-checkchip security-checkchip--${state.tone}`}>
              {state.tone === 'pending' ? (
                <Loader2 size={11} strokeWidth={1.5} />
              ) : state.tone === 'ok' ? (
                <CheckCircle2 size={11} strokeWidth={1.5} />
              ) : state.tone === 'fail' ? (
                <XCircle size={11} strokeWidth={1.5} />
              ) : (
                <CircleDashed size={11} strokeWidth={1.5} />
              )}
              {state.label}
            </span>
            <span className="security-detail__rule">{activeCheck.app || 'check run'}</span>
            <span className="security-detail__id">#{activeCheck.name}</span>
          </div>
          <h2 className="security-detail__title">{activeCheck.name}</h2>
          <div className="security-detail__kv">
            <div>
              <p className="security-detail__kv-label">Status</p>
              <p className="security-detail__kv-value">{activeCheck.status.replace('_', ' ')}</p>
            </div>
            <div>
              <p className="security-detail__kv-label">Duration</p>
              <p className="security-detail__kv-value">
                {fmtDuration(activeCheck.startedAt, activeCheck.completedAt) || '—'}
              </p>
            </div>
            <div>
              <p className="security-detail__kv-label">Started</p>
              <p className="security-detail__kv-value">
                {activeCheck.startedAt ? relativeTime(activeCheck.startedAt) : '—'}
              </p>
            </div>
            <div>
              <p className="security-detail__kv-label">Branch</p>
              <p className="security-detail__kv-value">{branch ?? '—'}</p>
            </div>
          </div>
          {activeCheck.detailsUrl && (
            <div className="security-detail__actions">
              <button
                type="button"
                className="projects__action"
                onClick={() => openInBrowser(activeCheck.detailsUrl, 'the check run')}
              >
                <ExternalLink size={11} strokeWidth={1.25} />
                <span>Open run on GitHub</span>
              </button>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  /* ---- global states ---- */

  if (mode === 'browser') {
    return (
      <div className="screen security-screen">
        <header className="screen-header">
          <h1 className="screen-header__title">Security and quality</h1>
        </header>
        <StatePanel
          tone="empty"
          icon={<ShieldCheck size={26} strokeWidth={1.25} />}
          title="Desktop app required"
          description={
            <p>
              Security findings load from GitHub through the gh CLI. Browser preview cannot call
              it — run the desktop app against a GitHub repository.
            </p>
          }
          onRetry={() => {}}
        />
      </div>
    );
  }

  if (allError) {
    const firstError = code.error || deps.error || secrets.error;
    // Private repos without GitHub Advanced Security can never serve this
    // data (HTTP 403) — no token scope or retry fixes it.
    const needsAdvancedSecurity = /Advanced Security must be enabled/i.test(firstError);
    return (
      <div className="screen security-screen">
        <header className="screen-header">
          <h1 className="screen-header__title">Security and quality</h1>
        </header>
        <StatePanel
          tone={needsAdvancedSecurity ? 'empty' : 'error'}
          icon={
            needsAdvancedSecurity ? (
              <ShieldCheck size={26} strokeWidth={1.25} />
            ) : (
              <TriangleAlert size={26} strokeWidth={1.25} />
            )
          }
          title={
            needsAdvancedSecurity
              ? 'Code scanning unavailable for this repository'
              : "Couldn't load security data"
          }
          description={
            needsAdvancedSecurity ? (
              <p>
                This repository is private and doesn't have GitHub Advanced Security, so code
                scanning, Dependabot and secret scanning alerts aren't available. Code scanning is
                free for public repositories — enable it under the repo's Settings → Code
                security, or keep this screen as reference.
              </p>
            ) : (
              <p>
                The gh CLI failed for every security source. Check that gh is signed in and the
                repository is hosted on GitHub. Code scanning, Dependabot and secret scanning must
                also be enabled on the repository.
              </p>
            )
          }
          errorText={needsAdvancedSecurity ? undefined : firstError}
          hints={
            needsAdvancedSecurity
              ? ['Code scanning is free for public repos — repo Settings → Code security']
              : /scope|security_events|403|404/i.test(firstError)
                ? ['gh auth refresh -s security_events']
                : undefined
          }
          onRetry={needsAdvancedSecurity ? () => {} : retryLoad}
        />
      </div>
    );
  }

  return (
    <div className="screen security-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Security and quality</h1>
        {everythingClean && (
          <span className="security-screen__badge security-screen__badge--ok">All clear</span>
        )}
        <div className="security-screen__header-actions">
          <button type="button" className="chip-button">
            <GitBranch size={13} strokeWidth={1.25} />
            {branch ?? 'no branch'}
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() =>
              repoBase
                ? openInBrowser(`${repoBase}/settings/security_analysis`, 'the settings')
                : notify('This working copy has no GitHub remote', 'error')
            }
          >
            <Settings size={13} strokeWidth={1.25} />
            Configure checks
          </button>
        </div>
      </header>

      {allLoading ? (
        <HeaderSkeleton />
      ) : (
        <div className="security-screen__summary">
          <div className="security-summary__main">
            <span className="security-summary__big">{totalFindings}</span>
            <div>
              <p className="security-summary__label">open findings</p>
              <p className="security-summary__sub">Code scanning · dependencies · secrets</p>
            </div>
          </div>
          <div className="security-summary__levels">
            <span><i className="security-dot security-dot--critical" /> Critical <strong>{severityCounts.critical}</strong></span>
            <span><i className="security-dot security-dot--high" /> High <strong className="security-level--high">{severityCounts.high}</strong></span>
            <span><i className="security-dot security-dot--medium" /> Medium <strong className="security-level--medium">{severityCounts.medium}</strong></span>
            <span><i className="security-dot security-dot--low" /> Low <strong>{severityCounts.low}</strong></span>
          </div>
          <div className="security-summary__suites">
            <p className="security-summary__suites-line">
              {checks.status === 'ok'
                ? `${passingChecks} of ${checks.items.length} checks passing`
                : checks.status === 'loading'
                  ? 'Loading checks…'
                  : 'Checks unavailable'}
            </p>
            <p className="security-summary__sub">
              {branch ? `on ${branch}` : 'branch unknown'} · via gh CLI
            </p>
            {repoBase && (
              <button
                type="button"
                className="security-summary__rules"
                onClick={() => openInBrowser(`${repoBase}/security`, 'the security tab')}
              >
                View on GitHub ↗
              </button>
            )}
          </div>
        </div>
      )}

      <div className="security-screen__tabs">
        {(['code', 'deps', 'secrets', 'checks'] as SourceKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`security-tab${tab === key ? ' security-tab--active' : ''}`}
            onClick={() => setTab(key)}
          >
            {key === 'code' && 'Code scanning'}
            {key === 'deps' && 'Dependencies'}
            {key === 'secrets' && 'Secret scanning'}
            {key === 'checks' && 'Quality checks'}
            {tabCount(key)}
          </button>
        ))}
      </div>

      <div className="screen-body security-screen__body">
        <section className="security-findings" style={{ width: findingsWidth }}>
          <div className="security-findings__toolbar">
            <div className="screen-search security-findings__search">
              <Search size={14} strokeWidth={1.25} />
              <input
                placeholder="Search findings, rules or paths…"
                aria-label="Search findings"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {(tab === 'code' || tab === 'deps') && (
              <>
                <button
                  type="button"
                  className={`chip-button${severityMin === 'all' ? ' chip-button--active' : ''}`}
                  onClick={() => setSeverityMin('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`chip-button${severityMin === 'high' ? ' chip-button--active' : ''}`}
                  onClick={() => setSeverityMin('high')}
                >
                  High+
                </button>
                <button
                  type="button"
                  className={`chip-button${severityMin === 'medium' ? ' chip-button--active' : ''}`}
                  onClick={() => setSeverityMin('medium')}
                >
                  Medium+
                </button>
              </>
            )}
            <span className="security-findings__meta">
              {sourceOf(tab).status === 'ok'
                ? `${rows.length} shown · Severity ↓`
                : sourceOf(tab).status === 'loading'
                  ? 'Loading…'
                  : 'Unavailable'}
            </span>
          </div>

          {renderListBody()}

          <div className="security-findings__footer">
            <span>
              {sourceOf(tab).status === 'ok'
                ? `${rows.length} of ${sourceOf(tab).items.length} items`
                : '—'}
            </span>
            <span>{tab === 'code' && code.items[0]?.tool ? code.items[0].tool : 'GitHub Security'}</span>
          </div>
        </section>
        <ResizeHandle
          orientation="v"
          label="Resize findings list"
          onDelta={(dx) => setFindingsWidth((w) => Math.min(560, Math.max(320, w + dx)))}
        />

        {renderDetail()}
      </div>
    </div>
  );
}

function StateDot({ run }: { run: GhCheckRun | null }) {
  if (!run) return <i className="security-dot security-dot--muted" />;
  const state = checkState(run);
  if (state.tone === 'ok') return <CheckCircle2 size={12} strokeWidth={1.5} className="security-dot-icon security-dot-icon--ok" />;
  if (state.tone === 'fail') return <XCircle size={12} strokeWidth={1.5} className="security-dot-icon security-dot-icon--fail" />;
  if (state.tone === 'pending') return <Loader2 size={12} strokeWidth={1.5} className="security-dot-icon security-dot-icon--pending" />;
  return <CircleDashed size={12} strokeWidth={1.5} className="security-dot-icon" />;
}

function CodeDetail({
  alert,
  snippet,
  expectingSnippet,
  dismissing,
  onDismiss,
  onOpen,
}: {
  alert: GhCodeAlert;
  snippet: Snippet | null;
  expectingSnippet: boolean;
  dismissing: boolean;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const severity = asSeverity(alert.severity);
  return (
    <section className="security-detail">
      <div className="security-detail__meta">
        <span className={`security-level security-level--${severity}`}>{SEVERITY_LABEL[severity]}</span>
        <span className="security-detail__status">Open</span>
        <span className="security-detail__rule">{alert.ruleId}</span>
        {alert.ruleTags.slice(0, 3).map((tag) => (
          <span key={tag} className="security-detail__rule">{tag}</span>
        ))}
        <span className="security-detail__id">#{alert.number}</span>
      </div>
      <h2 className="security-detail__title">{alert.ruleDescription || alert.ruleId}</h2>
      <div className="security-detail__author">
        <span className="security-detail__avatar">
          <ShieldCheck size={11} strokeWidth={1.5} />
        </span>
        <strong>{alert.tool || 'Code scanning'}</strong>
        <span className="security-detail__muted">detected {relativeTime(alert.createdAt)}</span>
        <span className="security-detail__dates">{alert.path ? `Last: ${relativeTime(alert.createdAt, true)}` : ''}</span>
      </div>

      {alert.path && (
        <div className="security-code">
          <div className="security-code__head">
            <span>
              <FileCode2 size={12} strokeWidth={1.25} /> {alert.path}
              {alert.startLine > 0 ? ` : ${alert.startLine}${alert.endLine > alert.startLine ? `–${alert.endLine}` : ''}` : ''}
            </span>
            <button type="button" className="security-code__link security-code__link--button" onClick={onOpen}>
              Open alert ↗
            </button>
          </div>
          {expectingSnippet && !snippet ? (
            <div className="security-code__loading">
              <span className="security-skel security-skel--line" style={{ width: '72%' }} />
              <span className="security-skel security-skel--line security-skel--thin" style={{ width: '58%' }} />
              <span className="security-skel security-skel--line security-skel--thin" style={{ width: '64%' }} />
            </div>
          ) : snippet?.error ? (
            <p className="security-detail__helper security-code__note">{snippet.error}</p>
          ) : snippet && snippet.lines.length > 0 ? (
            <pre>
              {snippet.lines.map((line) => (
                <span key={line.n} className={line.flagged ? 'security-code__line--flagged' : undefined}>
                  <span className="security-code__ln">{line.n}</span>
                  {' '}
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : null}
          <p className="security-detail__helper security-code__note">
            Snippet read from the local working tree — lines may have drifted since the scan.
          </p>
        </div>
      )}

      <h3 className="security-detail__heading">Why this matters</h3>
      <p className="security-detail__text">
        {alert.ruleDescription || alert.ruleId} — flagged by{' '}
        {alert.tool || 'the code scanning tool'} on {relativeTime(alert.createdAt)}. Open the
        alert on GitHub for the full data-flow trace and rule documentation.
      </p>

      <div className="security-detail__actions">
        <button type="button" className="projects__action" onClick={onOpen}>
          <ExternalLink size={11} strokeWidth={1.25} />
          <span>Open on GitHub</span>
        </button>
        <button
          type="button"
          className="projects__action"
          onClick={onDismiss}
          disabled={dismissing}
          title="Dismisses the alert on GitHub as false positive"
        >
          {dismissing ? 'Dismissing…' : 'Dismiss as false positive'}
        </button>
      </div>
    </section>
  );
}

function DepDetail({
  alert,
  onOpen,
}: {
  alert: GhDependabotAlert;
  onOpen: () => void;
}) {
  const severity = asSeverity(alert.severity);
  return (
    <section className="security-detail">
      <div className="security-detail__meta">
        <span className={`security-level security-level--${severity}`}>{SEVERITY_LABEL[severity]}</span>
        <span className="security-detail__status">Open</span>
        <span className="security-detail__rule">{alert.ecosystem || 'dependency'}</span>
        <span className="security-detail__id">#{alert.number}</span>
      </div>
      <h2 className="security-detail__title">{alert.summary || alert.package}</h2>
      <div className="security-detail__author">
        <span className="security-detail__avatar">
          <Package size={11} strokeWidth={1.5} />
        </span>
        <strong>{alert.package}</strong>
        <span className="security-detail__muted">{alert.scope || 'dependency'}</span>
        <span className="security-detail__dates">detected {relativeTime(alert.createdAt)}</span>
      </div>

      <div className="security-detail__kv">
        <div>
          <p className="security-detail__kv-label">Vulnerable range</p>
          <p className="security-detail__kv-value">{alert.vulnerableRange || '—'}</p>
        </div>
        <div>
          <p className="security-detail__kv-label">Patched version</p>
          <p className="security-detail__kv-value">{alert.patchedVersion || 'no fix yet'}</p>
        </div>
        <div>
          <p className="security-detail__kv-label">Manifest</p>
          <p className="security-detail__kv-value">{alert.manifestPath || '—'}</p>
        </div>
        <div>
          <p className="security-detail__kv-label">Ecosystem</p>
          <p className="security-detail__kv-value">{alert.ecosystem || '—'}</p>
        </div>
      </div>

      <div className="security-detail__actions">
        <button type="button" className="projects__action" onClick={onOpen}>
          <ExternalLink size={11} strokeWidth={1.25} />
          <span>Open on GitHub</span>
        </button>
      </div>
    </section>
  );
}

function SecretDetail({
  alert,
  onOpen,
}: {
  alert: GhSecretAlert;
  onOpen: () => void;
}) {
  return (
    <section className="security-detail">
      <div className="security-detail__meta">
        <span className="security-level security-level--high">Secret</span>
        <span className="security-detail__status">Open</span>
        <span className="security-detail__id">#{alert.number}</span>
      </div>
      <h2 className="security-detail__title">{alert.secretType || 'Exposed secret'}</h2>
      <div className="security-detail__author">
        <span className="security-detail__muted">detected {relativeTime(alert.createdAt)}</span>
      </div>
      <p className="security-detail__text">
        Secret scanning found a credential pattern in this repository. The secret value is never
        displayed here — review and revoke it on GitHub.
      </p>
      <div className="security-detail__actions">
        <button type="button" className="projects__action" onClick={onOpen}>
          <ExternalLink size={11} strokeWidth={1.25} />
          <span>Open on GitHub</span>
        </button>
      </div>
    </section>
  );
}
