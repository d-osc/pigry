import { useRequestGate } from '../../hooks/useRequestGate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  FileCode2,
  Loader2,
  Play,
  RefreshCw,
  Search,
  SkipForward,
  X,
  Zap,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import {
  ghOpenUrl,
  ghRunArtifacts,
  ghRunCancel,
  ghRunDownloadArtifact,
  ghRunList,
  ghRunLogs,
  ghRunRerun,
  ghRunView,
  ghWorkflowDispatch,
  ghWorkflowList,
  invalidateGhCache,
  readWorktreeFile,
} from '../../lib/tauriClient';
import type {
  GhRunArtifact,
  GhRunDetail,
  GhRunJob,
  GhWorkflow,
  GhWorkflowRun,
} from '../../types/repository';
import { formatDate, relativeTime } from '../../lib/ghData';
import { useRepository } from '../../hooks/useRepository';
import './ActionsScreen.css';

type RunTone = 'success' | 'failed' | 'running' | 'queued' | 'cancelled' | 'skipped';

const TONE_LABEL: Record<RunTone, string> = {
  success: 'Success',
  failed: 'Failed',
  running: 'In progress',
  queued: 'Queued',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** GitHub status/conclusion pair → the screen's display tone. */
function toneOf(status: string, conclusion: string): RunTone {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'skipped';
  }
}

function ToneIcon({ tone, size = 11 }: { tone: RunTone; size?: number }) {
  switch (tone) {
    case 'success':
      return <Check size={size} strokeWidth={2} />;
    case 'failed':
      return <X size={size} strokeWidth={2} />;
    case 'running':
      return <Loader2 size={size} strokeWidth={2} className="actions-spin" />;
    case 'queued':
      return <Clock size={size} strokeWidth={1.75} />;
    case 'cancelled':
      return <Ban size={size} strokeWidth={1.75} />;
    default:
      return <SkipForward size={size} strokeWidth={2} />;
  }
}

/** "2m 32s" from ISO start/end stamps (client-side, for run rows). */
function durationOf(startedAt: string, updatedAt: string): string {
  if (!startedAt || !updatedAt) return '';
  const start = Date.parse(startedAt);
  const end = Date.parse(updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

/** "Nov 8, 14:42" from an RFC3339 stamp. */
function formatStamp(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

interface LogLine {
  job: string;
  step: string;
  time: string;
  text: string;
}

/**
 * gh emits "<job>\t<step>\t<timestamp> <line>" per log line; plain lines
 * (the truncation marker, blank filler) pass through with empty metadata.
 */
function parseLog(raw: string): LogLine[] {
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const rest = parts.slice(2).join('\t');
        const spaceAt = rest.indexOf(' ');
        const stamp = spaceAt > 0 ? rest.slice(0, spaceAt) : '';
        const text = spaceAt > 0 ? rest.slice(spaceAt + 1) : rest;
        return {
          job: parts[0],
          step: parts[1],
          time: stamp.length >= 19 ? stamp.slice(11, 19) : stamp,
          text,
        };
      }
      return { job: '', step: '', time: '', text: line };
    });
}

function lineTone(text: string): 'ok' | 'fail' | 'info' {
  if (/✓|succeeded|\bpass(ed)?\b/i.test(text)) return 'ok';
  if (/✗|✖|\bFAIL\b|\berror\b|exit code [1-9]|##\[error\]/i.test(text)) return 'fail';
  return 'info';
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function FilterDropdown({
  label,
  active,
  ariaLabel,
  children,
}: {
  label: string;
  active?: boolean;
  ariaLabel?: string;
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
    <div className="actions-dd" ref={ref}>
      <button
        type="button"
        className={`chip-button${active ? ' chip-button--active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
      >
        {label}
        <ChevronDown size={12} strokeWidth={1.25} />
      </button>
      {open && (
        <div className="actions-dd__menu" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function dropdownItem(label: string, selected: boolean, onClick: () => void) {
  return (
    <button
      key={label}
      type="button"
      role="menuitem"
      className={`actions-dd__item${selected ? ' actions-dd__item--active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SkeletonRuns() {
  return (
    <div className="pr-skeleton-list" aria-label="Loading workflow runs">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="pr-skeleton-row">
          <div className="pr-skeleton pr-skeleton--title" />
          <div className="pr-skeleton pr-skeleton--meta" />
          <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
        </div>
      ))}
    </div>
  );
}

function SkeletonDetail() {
  return (
    <div className="pr-skeleton-list actions-detail__skeleton" aria-label="Loading run">
      <div className="pr-skeleton pr-skeleton--title" />
      <div className="pr-skeleton pr-skeleton--meta" />
      <div className="pr-skeleton pr-skeleton--meta" />
      <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
      <div className="pr-skeleton pr-skeleton--title" />
      <div className="pr-skeleton pr-skeleton--meta" />
    </div>
  );
}

export function ActionsScreen() {
  const listGate = useRequestGate();
  const { repository, notify } = useRepository();
  const [runsWidth, setRunsWidth] = useState(300);

  const [workflows, setWorkflows] = useState<GhWorkflow[]>([]);
  const [runs, setRuns] = useState<GhWorkflowRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  // Filters — empty string means "All".
  const [query, setQuery] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<RunTone | ''>('');
  const [eventFilter, setEventFilter] = useState('');

  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<GhRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumped after re-run / refresh so the detail effect refetches the same run.
  const [detailNonce, setDetailNonce] = useState(0);

  const [tab, setTab] = useState<'logs' | 'artifacts'>('logs');
  const [logJob, setLogJob] = useState<number | null>(null);
  const [logText, setLogText] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<GhRunArtifact[]>([]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [artifactsRetry, setArtifactsRetry] = useState(0);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);

  const [wfDialog, setWfDialog] = useState<{ path: string; content: string } | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [dispatching, setDispatching] = useState<string | null>(null);
  const runMenuRef = useRef<HTMLDivElement | null>(null);
  // Mirrors logJob so the detail effect can validate it without depending on it.
  const logJobRef = useRef<number | null>(null);

  useEffect(() => {
    logJobRef.current = logJob;
  }, [logJob]);

  const activeWorkflows = useMemo(
    () => workflows.filter((wf) => wf.state === 'active'),
    [workflows],
  );
  const branches = useMemo(() => [...new Set(runs.map((run) => run.branch))].sort(), [runs]);
  const events = useMemo(() => [...new Set(runs.map((run) => run.event))].sort(), [runs]);

  const filtered = useMemo(
    () =>
      runs.filter((run) => {
        if (workflowFilter && run.workflowName !== workflowFilter) return false;
        if (branchFilter && run.branch !== branchFilter) return false;
        if (eventFilter && run.event !== eventFilter) return false;
        if (statusFilter && toneOf(run.status, run.conclusion) !== statusFilter) return false;
        const q = query.trim().toLowerCase();
        if (
          q &&
          !run.title.toLowerCase().includes(q) &&
          !String(run.number).includes(q.replace('#', '')) &&
          !run.sha.toLowerCase().includes(q) &&
          !run.branch.toLowerCase().includes(q) &&
          !run.workflowName.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      }),
    [runs, query, workflowFilter, branchFilter, statusFilter, eventFilter],
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selected) ?? null,
    [runs, selected],
  );
  const detailWorkflowPath = useMemo(() => {
    if (!detail) return '';
    const match = workflows.find(
      (wf) => wf.id === detail.workflowId || wf.name === detail.workflowName,
    );
    return match?.path ?? '';
  }, [detail, workflows]);

  const loadAll = useCallback(async (silent = false, force = false) => {
    const isCurrent = listGate.begin();
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      if (force) await invalidateGhCache();
      const [wfs, page] = await Promise.all([ghWorkflowList(), ghRunList(50)]);
      if (!isCurrent()) return;
      setWorkflows(wfs);
      setRuns(page.runs);
      setTotal(page.total);
      setSyncedAt(Date.now());
      setSelected((current) => {
        if (current !== null && page.runs.some((run) => run.id === current)) return current;
        return page.runs[0]?.id ?? null;
      });
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrent()) setLoading(false);
      if (isCurrent()) setRefreshing(false);
    }
  }, [listGate]);

  useEffect(() => {
    // Deferred like the other screens — gh shells out synchronously here.
    const timer = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);

  useEffect(() => {
    if (!runMenuOpen) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (runMenuRef.current?.contains(event.target as Node)) return;
      setRunMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [runMenuOpen]);

  // Detail follows the selected run.
  useEffect(() => {
    if (selected === null) {
      const t = window.setTimeout(() => {
        setDetail(null);
        setDetailError(null);
      }, 0);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    const t2 = window.setTimeout(() => setDetailError(null), 0);
    ghRunView(selected)
      .then((result) => {
        window.clearTimeout(t2);
        if (!cancelled) {
          setDetailError(null);
          setDetail(result);
          // A re-run replaces job ids — fall back to the combined log.
          if (logJobRef.current !== null && !result?.jobs.some((job) => job.id === logJobRef.current)) {
            setLogJob(null);
          }
        }
      })
      .catch((err) => {
        window.clearTimeout(t2);
        if (!cancelled) {
          setDetail(null);
          setDetailError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t2);
    };
  }, [selected, detailNonce]);

  // Log console follows the run + chosen job.
  useEffect(() => {
    if (selected === null) {
      const t = window.setTimeout(() => {
        setLogText('');
        setLogError(null);
      }, 0);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    const t2 = window.setTimeout(() => {
      setLogLoading(true);
      setLogError(null);
    }, 0);
    ghRunLogs(selected, logJob ?? undefined)
      .then((text) => {
        if (!cancelled) { setLogError(null); setLogText(text); }
      })
      .catch((err) => {
        if (!cancelled) {
          setLogText('');
          setLogError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        window.clearTimeout(t2);
        if (!cancelled) setLogLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t2);
    };
  }, [selected, logJob, detailNonce]);

  // Artifacts load with the selection (the tab shows the count badge).
  useEffect(() => {
    if (selected === null) {
      const t = window.setTimeout(() => setArtifacts([]), 0);
      return () => window.clearTimeout(t);
    }
    let cancelled = false;
    const t2 = window.setTimeout(() => { setArtifactsLoading(true); setArtifactsError(null); }, 0);
    ghRunArtifacts(selected)
      .then((items) => {
        if (!cancelled) { setArtifactsError(null); setArtifacts(items); }
      })
      .catch((error: unknown) => {
        if (!cancelled) setArtifactsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        window.clearTimeout(t2);
        if (!cancelled) setArtifactsLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(t2);
    };
  }, [selected, detailNonce, artifactsRetry]);

  // While any run is queued/in-progress, poll the list; the selected run's
  // detail refreshes too so jobs/steps tick over live.
  const hasActive = useMemo(() => runs.some((run) => run.status !== 'completed'), [runs]);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const page = await ghRunList(50);
          setRuns(page.runs);
          setTotal(page.total);
          setSyncedAt(Date.now());
          const current = page.runs.find((run) => run.id === selected);
          if (current && current.status !== 'completed') setDetailNonce((n) => n + 1);
        } catch {
          // Poll errors keep the previous state; the next tick retries.
        }
      })();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [hasActive, selected]);

  const rerun = async (failedOnly: boolean) => {
    if (selected === null) return;
    try {
      await ghRunRerun(selected, failedOnly);
      notify(failedOnly ? 'Re-run triggered for failed jobs' : 'Run re-triggered', 'success');
      await loadAll(true);
      setDetailNonce((n) => n + 1);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const cancelRun = async () => {
    if (selected === null) return;
    try {
      await ghRunCancel(selected);
      notify('Run cancelled', 'success');
      await loadAll(true);
      setDetailNonce((n) => n + 1);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const dispatchWorkflow = async (wf: GhWorkflow) => {
    const ref = repository?.currentBranch ?? '';
    if (!ref) {
      notify('Checkout a branch first — workflows need a ref to run on', 'error');
      return;
    }
    setDispatching(wf.path);
    try {
      await ghWorkflowDispatch(wf.path, ref);
      notify(`Workflow "${wf.name}" triggered on ${ref}`, 'success');
      setRunMenuOpen(false);
      // The new run takes a moment to register — poll once shortly after.
      window.setTimeout(() => void loadAll(true), 4000);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDispatching(null);
    }
  };

  const downloadArtifact = async (artifact: GhRunArtifact) => {
    if (!detail) return;
    setDownloading(artifact.id);
    try {
      const dir = await ghRunDownloadArtifact(detail.id, artifact.name);
      notify(`Artifact saved to ${dir}`, 'success');
      await ghOpenUrl(dir); // opens the download folder in Explorer
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDownloading(null);
    }
  };

  const viewWorkflowDefinition = async (path?: string) => {
    const target = path ?? detailWorkflowPath;
    if (!target) {
      notify('Unknown workflow file for this run', 'error');
      return;
    }
    try {
      const file = await readWorktreeFile(target);
      setWfDialog({ path: target, content: file.content });
    } catch {
      notify(`${target} is not in the local worktree — switch branches or pull first`, 'error');
    }
  };

  const clearFilters = () => {
    setQuery('');
    setWorkflowFilter('');
    setBranchFilter('');
    setStatusFilter('');
    setEventFilter('');
  };

  const renderRunRow = (run: GhWorkflowRun) => {
    const tone = toneOf(run.status, run.conclusion);
    return (
      <button
        key={run.id}
        type="button"
        className={`actions-run${run.id === selected ? ' actions-run--selected' : ''}${tone === 'failed' ? ' actions-run--failed' : ''}`}
        onClick={() => {
          // Clear synchronously so the stale run never flashes while loading.
          setSelected(run.id);
          setDetail(null);
          setLogJob(null);
          setLogText('');
          setLogError(null);
        }}
      >
        <div className="actions-run__line">
          <span className="actions-run__id">
            {run.workflowName} #{run.number}
          </span>
          <span className={`actions-run__status actions-run__status--${tone}`}>
            <ToneIcon tone={tone} />
          </span>
        </div>
        <p className="actions-run__title">{run.title}</p>
        <p className="actions-run__branch">
          {run.branch} · {run.sha.slice(0, 7)}
        </p>
        <p className="actions-run__meta">
          {run.event} · {relativeTime(run.createdAt)}
          <span>
            {run.status === 'completed'
              ? `${durationOf(run.startedAt, run.updatedAt)} · ${formatDate(run.updatedAt)}`
              : TONE_LABEL[tone]}
          </span>
        </p>
      </button>
    );
  };

  const jobTone = (job: GhRunJob) => toneOf(job.status, job.conclusion);
  const selectedJob = logJob === null ? null : (detail?.jobs.find((job) => job.id === logJob) ?? null);
  const tone = detail ? toneOf(detail.status, detail.conclusion) : 'queued';
  const jobsOk = detail?.jobs.filter((job) => job.conclusion === 'success').length ?? 0;
  const jobsFailed = detail?.jobs.filter((job) => jobTone(job) === 'failed').length ?? 0;
  const jobsSkipped = detail?.jobs.filter((job) => jobTone(job) === 'skipped').length ?? 0;
  const detailDone = detail !== null && detail.status === 'completed';

  return (
    <div className="screen actions-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">Actions</h1>
        <span className="screen-header__count">Automate, test, ship.</span>
        <span className="screen-header__meta">
          {syncedAt ? `Updated ${relativeTime(new Date(syncedAt).toISOString())}` : ''}
        </span>
        <button
          type="button"
          className="outline-button"
          disabled={!detailWorkflowPath}
          onClick={() => void viewWorkflowDefinition()}
        >
          <FileCode2 size={12} strokeWidth={1.25} />
          View workflow definition
        </button>
        <div className="actions-runwf" ref={runMenuRef}>
          <button
            type="button"
            className="primary-button"
            disabled={activeWorkflows.length === 0}
            onClick={() => setRunMenuOpen((open) => !open)}
          >
            {dispatching ? (
              <Loader2 size={11} strokeWidth={1.5} className="actions-spin" />
            ) : (
              <Play size={11} strokeWidth={1.5} />
            )}
            Run workflow
            <ChevronDown size={12} strokeWidth={1.25} />
          </button>
          {runMenuOpen && (
            <div className="actions-dd__menu actions-runwf__menu" role="menu">
              {activeWorkflows.map((wf) => (
                <button
                  key={wf.path}
                  type="button"
                  role="menuitem"
                  className="actions-dd__item"
                  disabled={dispatching !== null}
                  onClick={() => void dispatchWorkflow(wf)}
                >
                  <Play size={11} strokeWidth={1.5} />
                  {wf.name}
                  <span className="actions-runwf__ref">on {repository?.currentBranch ?? '—'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="screen-toolbar">
        <FilterDropdown
          label={workflowFilter || 'All workflows'}
          active={workflowFilter !== ''}
          ariaLabel="Filter by workflow"
        >
          {dropdownItem('All workflows', workflowFilter === '', () => setWorkflowFilter(''))}
          {workflows.map((wf) =>
            dropdownItem(wf.name, workflowFilter === wf.name, () => setWorkflowFilter(wf.name)),
          )}
        </FilterDropdown>
        <div className="screen-search actions-screen__search">
          <Search size={14} strokeWidth={1.25} />
          <input
            placeholder="Search runs, commits or actors…"
            aria-label="Search runs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </div>
        <FilterDropdown label={branchFilter || 'Branch: All'} active={branchFilter !== ''} ariaLabel="Filter by branch">
          {dropdownItem('Branch: All', branchFilter === '', () => setBranchFilter(''))}
          {branches.map((branch) =>
            dropdownItem(branch, branchFilter === branch, () => setBranchFilter(branch)),
          )}
        </FilterDropdown>
        <FilterDropdown
          label={statusFilter ? `Status: ${TONE_LABEL[statusFilter]}` : 'Status: All'}
          active={statusFilter !== ''}
          ariaLabel="Filter by status"
        >
          {dropdownItem('Status: All', statusFilter === '', () => setStatusFilter(''))}
          {(Object.keys(TONE_LABEL) as RunTone[]).map((key) =>
            dropdownItem(TONE_LABEL[key], statusFilter === key, () => setStatusFilter(key)),
          )}
        </FilterDropdown>
        <FilterDropdown label={eventFilter ? `Event: ${eventFilter}` : 'Event: All'} active={eventFilter !== ''} ariaLabel="Filter by event">
          {dropdownItem('Event: All', eventFilter === '', () => setEventFilter(''))}
          {events.map((event) =>
            dropdownItem(event, eventFilter === event, () => setEventFilter(event)),
          )}
        </FilterDropdown>
        <button
          type="button"
          className="actions-screen__refresh"
          aria-label="Refresh runs"
          onClick={() => void loadAll(true, true)}
        >
          <RefreshCw size={13} strokeWidth={1.25} className={refreshing ? 'actions-spin' : ''} />
        </button>
      </div>

      <div className="screen-body actions-screen__body">
        <aside className="actions-runs" style={{ width: runsWidth }}>
          <div className="actions-runs__head">
            <span>Workflow runs</span>
            <span className="actions-runs__total">
              {loading ? '…' : `${total.toLocaleString()} runs`}
            </span>
          </div>
          {loading ? (
            <SkeletonRuns />
          ) : error ? (
            <div className="pr-empty">
              <Zap size={22} strokeWidth={1.25} />
              <p>Could not load workflow runs</p>
              <span>{error}</span>
              <span className="pr-empty__hint">
                Make sure the GitHub CLI (gh) is installed, signed in, and the
                repository has a GitHub remote.
              </span>
              <button type="button" className="outline-button" onClick={() => void loadAll(false, true)}>
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="pr-empty">
              <Zap size={22} strokeWidth={1.25} />
              <p>No workflow runs</p>
              <span>
                {workflows.length === 0
                  ? 'This repository has no GitHub Actions workflows yet — add a workflow file under .github/workflows and push it.'
                  : 'Workflows exist, but nothing has run yet. Push a commit or use "Run workflow".'}
              </span>
              {workflows.length > 0 && activeWorkflows.length > 0 && (
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setRunMenuOpen(true)}
                >
                  <Play size={12} strokeWidth={1.25} />
                  Run workflow
                </button>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="pr-empty">
              <Zap size={22} strokeWidth={1.25} />
              <p>No runs match the current filters</p>
              <span>Adjust the search or dropdown filters above.</span>
              <button type="button" className="outline-button" onClick={clearFilters}>
                <X size={12} strokeWidth={1.25} />
                Clear filters
              </button>
            </div>
          ) : (
            filtered.map(renderRunRow)
          )}
          <div className="actions-runs__foot">
            <span>
              {loading
                ? 'Loading runs…'
                : `Showing ${filtered.length} of ${total.toLocaleString()}`}
            </span>
            {selectedRun && (
              <span className="actions-runs__foot-hint">
                {selectedRun.workflowName} #{selectedRun.number}
              </span>
            )}
          </div>
        </aside>
        <ResizeHandle
          orientation="v"
          label="Resize workflow runs list"
          onDelta={(dx) => setRunsWidth((w) => Math.min(460, Math.max(240, w + dx)))}
        />

        <section className="actions-detail">
          {loading ? (
            <SkeletonDetail />
          ) : runs.length === 0 && !error ? (
            <div className="actions-detail__empty">
              <Zap size={26} strokeWidth={1.25} />
              <p>
                {workflows.length === 0
                  ? 'GitHub Actions is not set up on this repository'
                  : 'No runs yet'}
              </p>
              <span>
                {workflows.length === 0
                  ? 'There are no workflow files under .github/workflows on GitHub, so there is nothing to display. Add a workflow YAML, push it, and runs will show up here.'
                  : 'Your workflows are set up but have not run yet — push a commit that triggers one, or use "Run workflow".'}
              </span>
              <button
                type="button"
                className="outline-button"
                onClick={() => void ghOpenUrl('https://docs.github.com/actions')}
              >
                <ExternalLink size={12} strokeWidth={1.25} />
                Learn about GitHub Actions
              </button>
            </div>
          ) : error ? (
            <div className="actions-detail__empty">
              <Zap size={22} strokeWidth={1.25} />
              <p>Workflow runs unavailable</p>
              <span>{error}</span>
              <span>Fix the issue above and press Retry on the left.</span>
            </div>
          ) : detailError ? (
            <div className="actions-detail__empty">
              <Zap size={22} strokeWidth={1.25} />
              <p>Could not load this run</p>
              <span>{detailError}</span>
              <button
                type="button"
                className="outline-button"
                onClick={() => setDetailNonce((n) => n + 1)}
              >
                <RefreshCw size={12} strokeWidth={1.25} />
                Retry
              </button>
            </div>
          ) : !detail ? (
            <SkeletonDetail />
          ) : (
            <>
              <div className="actions-detail__head">
                <span className={`actions-detail__state actions-detail__state--${tone}`}>
                  <ToneIcon tone={tone} size={13} />
                  {TONE_LABEL[tone]}
                </span>
                <span className="actions-detail__id">
                  {detail.workflowName} #{detail.number}
                </span>
                <span className="actions-detail__attempt">Attempt {detail.attempt}</span>
                <div className="actions-detail__actions">
                  {!detailDone ? (
                    <button type="button" className="outline-button" onClick={() => void cancelRun()}>
                      <Ban size={11} strokeWidth={1.5} />
                      Cancel run
                    </button>
                  ) : (
                    <>
                      {jobsFailed > 0 && (
                        <button
                          type="button"
                          className="outline-button"
                          onClick={() => void rerun(true)}
                        >
                          <RefreshCw size={11} strokeWidth={1.5} />
                          Re-run failed jobs
                        </button>
                      )}
                      <button
                        type="button"
                        className="outline-button"
                        onClick={() => void rerun(false)}
                      >
                        <RefreshCw size={11} strokeWidth={1.5} />
                        Re-run all jobs
                      </button>
                    </>
                  )}
                  {detail.url && (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => void ghOpenUrl(detail.url)}
                    >
                      <ExternalLink size={11} strokeWidth={1.25} />
                      GitHub
                    </button>
                  )}
                </div>
              </div>
              <h2 className="actions-detail__title">{detail.title}</h2>

              <div className="actions-detail__meta">
                <div>
                  <span>Workflow / event</span>
                  <strong>
                    {detail.workflowName} · {detail.event}
                  </strong>
                </div>
                <div>
                  <span>Branch / commit</span>
                  <strong>
                    {detail.branch} · {detail.sha.slice(0, 7)}
                  </strong>
                </div>
                <div>
                  <span>Started</span>
                  <strong>{formatStamp(detail.startedAt || detail.createdAt)}</strong>
                </div>
                <div>
                  <span>Finished</span>
                  <strong>{detailDone ? formatStamp(detail.updatedAt) : '—'}</strong>
                </div>
                <div>
                  <span>Duration</span>
                  <strong>
                    {durationOf(detail.startedAt, detail.updatedAt) ||
                      (detailDone ? '—' : 'running…')}
                  </strong>
                </div>
              </div>

              {tone !== 'success' && (
                <p className={`actions-detail__banner actions-detail__banner--${tone}`}>
                  <ToneIcon tone={tone} size={12} />
                  {tone === 'failed' ? (
                    <>
                      <strong>
                        {jobsFailed} job{jobsFailed === 1 ? '' : 's'} failed
                      </strong>{' '}
                      · {jobsSkipped} skipped. Logs are below.
                    </>
                  ) : tone === 'running' || tone === 'queued' ? (
                    <>
                      <strong>Run in progress</strong> · this view refreshes automatically.
                    </>
                  ) : tone === 'cancelled' ? (
                    <>
                      <strong>Run cancelled</strong> · re-run to retry it.
                    </>
                  ) : (
                    <>
                      <strong>Jobs were skipped</strong> · nothing ran for this run.
                    </>
                  )}
                </p>
              )}
              {tone === 'success' && jobsSkipped > 0 && (
                <p className="actions-detail__banner actions-detail__banner--ok">
                  <Check size={12} strokeWidth={2} />
                  <strong>All {jobsOk} jobs succeeded</strong> · {jobsSkipped} skipped.
                </p>
              )}

              <div className="actions-detail__tabs">
                <button
                  type="button"
                  className={`actions-tab${tab === 'logs' ? ' actions-tab--active' : ''}`}
                  onClick={() => setTab('logs')}
                >
                  Jobs &amp; logs
                </button>
                <button
                  type="button"
                  className={`actions-tab${tab === 'artifacts' ? ' actions-tab--active' : ''}`}
                  onClick={() => setTab('artifacts')}
                >
                  Artifacts{' '}
                  {!artifactsLoading && artifacts.length > 0 && (
                    <span className="actions-tab__count">{artifacts.length}</span>
                  )}
                </button>
                {detailWorkflowPath && (
                  <button
                    type="button"
                    className="actions-detail__workflow-link"
                    onClick={() => void viewWorkflowDefinition(detailWorkflowPath)}
                  >
                    {detailWorkflowPath} ↗
                  </button>
                )}
              </div>

              {tab === 'logs' ? (
                <div className="actions-detail__split">
                  <div className="actions-jobs">
                    <p className="actions-jobs__head">
                      Jobs <span>{detail.jobs.length} jobs</span>
                    </p>
                    <button
                      type="button"
                      className={`actions-job${logJob === null ? ' actions-job--open' : ''}`}
                      onClick={() => setLogJob(null)}
                    >
                      <span className="actions-job__icon actions-job__icon--all">
                        <FileCode2 size={11} strokeWidth={1.5} />
                      </span>
                      <span className="actions-job__name">All jobs</span>
                      <span className="actions-job__meta">Combined log</span>
                      <span className="actions-job__time">
                        {durationOf(detail.startedAt, detail.updatedAt) || '—'}
                      </span>
                    </button>
                    {detail.jobs.map((job) => {
                      const jt = jobTone(job);
                      return (
                        <div key={job.id}>
                          <button
                            type="button"
                            className={`actions-job${logJob === job.id ? ' actions-job--open' : ''}`}
                            onClick={() => setLogJob(job.id)}
                          >
                            <span className={`actions-job__icon actions-job__icon--${jt}`}>
                              <ToneIcon tone={jt} />
                            </span>
                            <span className="actions-job__name">{job.name}</span>
                            <span
                              className={`actions-job__meta${jt === 'failed' ? ' actions-job__meta--fail' : ''}`}
                            >
                              {TONE_LABEL[jt]}
                            </span>
                            <span className="actions-job__time">{job.duration || '—'}</span>
                          </button>
                          {logJob === job.id &&
                            job.steps.map((step) => {
                              const st = toneOf(step.status, step.conclusion);
                              return (
                                <div
                                  key={step.number}
                                  className={`actions-step actions-step--${st}`}
                                >
                                  <span className={`actions-step__icon actions-step__icon--${st}`}>
                                    <ToneIcon tone={st} size={9} />
                                  </span>
                                  <span className="actions-step__name">{step.name}</span>
                                  <span className="actions-step__time">
                                    {step.duration || (st === 'running' ? '…' : '—')}
                                  </span>
                                </div>
                              );
                            })}
                        </div>
                      );
                    })}
                  </div>

                  <div className="actions-console">
                    <div className="actions-console__head">
                      <span className={`actions-console__title actions-console__title--${tone}`}>
                        <ToneIcon tone={tone} size={11} />
                        {selectedJob ? selectedJob.name : 'All jobs'}
                        <span>{selectedJob?.duration || durationOf(detail.startedAt, detail.updatedAt) || ''}</span>
                      </span>
                      <span className="actions-console__links">
                        {logText ? `${logText.split('\n').length} lines` : ''}
                      </span>
                    </div>
                    <div className="actions-console__sub">
                      <span>
                        {selectedJob
                          ? `gh run view ${detail.id} --job ${selectedJob.id} --log`
                        : `gh run view ${detail.id} --log`}
                      </span>
                      <span>
                        {logLoading ? 'Loading…' : logError ? 'Log unavailable' : 'From GitHub'}
                      </span>
                    </div>
                    <pre className="actions-console__log">
                      {logLoading && !logText ? (
                        <span className="actions-log-line">Loading log…</span>
                      ) : logError ? (
                        <span className="actions-log-line actions-log-line--fail">
                          {logError}
                        </span>
                      ) : logText ? (
                        parseLog(logText).map((line, index) => (
                          <span
                            key={index}
                            className={`actions-log-line actions-log-line--${lineTone(line.text)}`}
                          >
                            {line.time && (
                              <span className="actions-log-line__time">{line.time}</span>
                            )}
                            {line.text}
                          </span>
                        ))
                      ) : (
                        <span className="actions-log-line">
                          No logs available for this run yet.
                        </span>
                      )}
                    </pre>
                    <div className="actions-console__foot">
                      <span>
                        {jobsOk} succeeded · {jobsFailed} failed · {jobsSkipped} skipped
                      </span>
                      <span>
                        {detail.event} · attempt {detail.attempt}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="actions-artifacts">
                  <div className="actions-artifacts__head">
                    <strong>Artifacts</strong>
                    {!artifactsLoading && (
                      <span className="actions-artifacts__count">{artifacts.length}</span>
                    )}
                    <span className="actions-artifacts__retain">
                      Uploaded by this run · downloads land in your temp folder
                    </span>
                  </div>
                  {artifactsError ? (<div role="alert">{artifactsError}<button className="outline-button" onClick={() => setArtifactsRetry((n) => n + 1)}>Try again</button></div>) : artifactsLoading ? (
                    <div className="pr-skeleton-list" aria-label="Loading artifacts">
                      <div className="pr-skeleton-row">
                        <div className="pr-skeleton pr-skeleton--title" />
                        <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                      </div>
                    </div>
                  ) : artifacts.length === 0 ? (
                    <p className="actions-artifacts__none">
                      This run did not upload any artifacts.
                    </p>
                  ) : (
                    artifacts.map((artifact) => (
                      <div key={artifact.id} className="actions-artifact">
                        <span className="actions-artifact__name">{artifact.name}</span>
                        <span className="actions-artifact__meta">
                          uploaded {formatDate(artifact.createdAt)}
                          {artifact.expired ? ' · expired' : ''}
                        </span>
                        <span className="actions-artifact__size">
                          {formatBytes(artifact.size)}
                        </span>
                        <button
                          type="button"
                          className="outline-button"
                          disabled={artifact.expired || downloading !== null}
                          onClick={() => void downloadArtifact(artifact)}
                        >
                          {downloading === artifact.id ? (
                            <Loader2 size={11} strokeWidth={1.5} className="actions-spin" />
                          ) : (
                            <Download size={11} strokeWidth={1.5} />
                          )}
                          Download
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {wfDialog && (
        <div className="actions-wf-overlay" role="dialog" onClick={() => setWfDialog(null)}>
          <div className="actions-wf" onClick={(event) => event.stopPropagation()}>
            <div className="actions-wf__head">
              <FileCode2 size={13} strokeWidth={1.25} />
              <strong>{wfDialog.path}</strong>
              <button
                type="button"
                aria-label="Close workflow definition"
                onClick={() => setWfDialog(null)}
              >
                <X size={13} strokeWidth={1.5} />
              </button>
            </div>
            <pre className="actions-wf__body">{wfDialog.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
