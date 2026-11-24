import { useRequestGate } from '../../hooks/useRequestGate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  Home,
  Loader2,
  Package,
  Play,
  RefreshCw,
  ScrollText,
  Search,
  SkipForward,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
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
  align = 'left',
  children,
}: {
  label: string;
  active?: boolean;
  ariaLabel?: string;
  /** Which edge of the button the menu lines up with. */
  align?: 'left' | 'right';
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
        <div className={`actions-dd__menu${align === 'right' ? ' actions-dd__menu--right' : ''}`} role="menu" onClick={() => setOpen(false)}>
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

  // GitHub's two levels: the list of runs, and one run opened on its own page.
  const [view, setView] = useState<'list' | 'run'>('list');
  const [pane, setPane] = useState<'summary' | 'logs'>('summary');
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<GhRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumped after re-run / refresh so the detail effect refetches the same run.
  const [detailNonce, setDetailNonce] = useState(0);

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
  const selectedRef = useRef<number | null>(null);

  useEffect(() => {
    logJobRef.current = logJob;
  }, [logJob]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

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
      // Keep the open run when it is still there; otherwise go back to the list.
      setSelected((current) => (current !== null && page.runs.some((run) => run.id === current) ? current : null));
      setView((current) => (current === 'run' && selectedRef.current !== null && page.runs.some((run) => run.id === selectedRef.current) ? 'run' : 'list'));
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

  /** What started the run, in GitHub's words ("Commit abc1234", "Pull request", "Manually run"…). */
  const triggerLabel = (event: string): string => {
    switch (event) {
      case 'push': return 'Commit';
      case 'pull_request':
      case 'pull_request_target': return 'Pull request';
      case 'workflow_dispatch': return 'Manually run';
      case 'schedule': return 'Scheduled';
      case 'release': return 'Release';
      default: return event.replace(/_/g, ' ');
    }
  };

  const openRun = (run: GhWorkflowRun) => {
    // Clear synchronously so the stale run never flashes while loading.
    setSelected(run.id);
    setView('run');
    setPane('summary');
    setDetail(null);
    setLogJob(null);
    setLogText('');
    setLogError(null);
  };

  const backToRuns = () => {
    setView('list');
    setSelected(null);
    setDetail(null);
    setLogJob(null);
  };

  const chooseWorkflow = (name: string) => {
    setWorkflowFilter(name);
    if (view === 'run') backToRuns();
  };

  const jobTone = (job: GhRunJob) => toneOf(job.status, job.conclusion);
  const selectedJob = logJob === null ? null : (detail?.jobs.find((job) => job.id === logJob) ?? null);
  const tone = detail ? toneOf(detail.status, detail.conclusion) : 'queued';
  const jobsOk = detail?.jobs.filter((job) => job.conclusion === 'success').length ?? 0;
  const jobsFailed = detail?.jobs.filter((job) => jobTone(job) === 'failed').length ?? 0;
  const jobsSkipped = detail?.jobs.filter((job) => jobTone(job) === 'skipped').length ?? 0;
  const detailDone = detail !== null && detail.status === 'completed';
  const selectedWorkflow = workflows.find((wf) => wf.name === workflowFilter) ?? null;

  const renderRunRow = (run: GhWorkflowRun) => {
    const runTone = toneOf(run.status, run.conclusion);
    const duration = run.status === 'completed' ? durationOf(run.startedAt, run.updatedAt) : '';
    return (
      <li key={run.id}>
        <button type="button" className="actions-row" onClick={() => openRun(run)}>
          <span className={`actions-status actions-status--${runTone}`} title={TONE_LABEL[runTone]}>
            <ToneIcon tone={runTone} size={13} />
          </span>
          <span className="actions-row__main">
            <strong className="actions-row__title">{run.title}</strong>
            <span className="actions-row__sub">
              {run.workflowName} #{run.number}: {triggerLabel(run.event)} {run.sha.slice(0, 7)}
            </span>
          </span>
          <span className="actions-row__branch" title={run.branch}>
            <GitBranch size={11} strokeWidth={1.5} />
            {run.branch}
          </span>
          <span className="actions-row__when">
            <span>{relativeTime(run.createdAt)}</span>
            <span className="actions-row__duration">
              <Clock size={11} strokeWidth={1.5} />
              {duration || (run.status === 'completed' ? '—' : TONE_LABEL[runTone])}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const renderConsole = () => (
    <div className="actions-console">
      <div className="actions-console__head">
        <span className={`actions-console__title actions-console__title--${selectedJob ? jobTone(selectedJob) : tone}`}>
          <ToneIcon tone={selectedJob ? jobTone(selectedJob) : tone} size={11} />
          {selectedJob ? selectedJob.name : 'All jobs'}
          <span>{selectedJob?.duration || (detail ? durationOf(detail.startedAt, detail.updatedAt) : '') || ''}</span>
        </span>
        <span className="actions-console__links">
          {logText ? `${logText.split('\n').length} lines` : ''}
        </span>
      </div>
      <div className="actions-console__sub">
        <span>
          {selectedJob
            ? `gh run view ${detail?.id} --job ${selectedJob.id} --log`
            : `gh run view ${detail?.id} --log`}
        </span>
        <span>{logLoading ? 'Loading…' : logError ? 'Log unavailable' : 'From GitHub'}</span>
      </div>
      <pre className="actions-console__log">
        {logLoading && !logText ? (
          <span className="actions-log-line">Loading log…</span>
        ) : logError ? (
          <span className="actions-log-line actions-log-line--fail">{logError}</span>
        ) : logText ? (
          parseLog(logText).map((line, index) => (
            <span key={index} className={`actions-log-line actions-log-line--${lineTone(line.text)}`}>
              {line.time && <span className="actions-log-line__time">{line.time}</span>}
              {line.text}
            </span>
          ))
        ) : (
          <span className="actions-log-line">No logs available for this run yet.</span>
        )}
      </pre>
    </div>
  );

  const renderEmpty = (title: string, text: string, action?: React.ReactNode, hint?: string) => (
    <div className="actions-empty">
      <Zap size={26} strokeWidth={1.25} />
      <p>{title}</p>
      <span>{text}</span>
      {hint && <span className="actions-empty__hint">{hint}</span>}
      {action}
    </div>
  );

  const renderRunPage = () => {
    if (detailError) {
      return (
        <>
          <button type="button" className="actions-back" onClick={backToRuns}><ArrowLeft size={13} strokeWidth={1.5} /> {workflowFilter || 'All workflows'}</button>
          {renderEmpty('Could not load this run', detailError, (
            <button type="button" className="outline-button" onClick={() => setDetailNonce((n) => n + 1)}>
              <RefreshCw size={12} strokeWidth={1.25} />
              Retry
            </button>
          ))}
        </>
      );
    }
    if (!detail) {
      return (
        <>
          <button type="button" className="actions-back" onClick={backToRuns}><ArrowLeft size={13} strokeWidth={1.5} /> {workflowFilter || 'All workflows'}</button>
          <SkeletonDetail />
        </>
      );
    }
    return (
      <div className="actions-runpage">
        <button type="button" className="actions-back" onClick={backToRuns}>
          <ArrowLeft size={13} strokeWidth={1.5} /> {workflowFilter || 'All workflows'}
        </button>
        <header className="actions-runpage__head">
          <div className="actions-runpage__titles">
            <h2>
              {detail.title} <span className="actions-runpage__number">#{detail.number}</span>
            </h2>
            <p>
              {detail.workflowName}
              {detail.attempt > 1 ? ` · Attempt #${detail.attempt}` : ''}
            </p>
          </div>
          <div className="actions-runpage__actions">
            {!detailDone ? (
              <button type="button" className="outline-button" onClick={() => void cancelRun()}>
                <Ban size={11} strokeWidth={1.5} />
                Cancel run
              </button>
            ) : (
              <FilterDropdown label="Re-run jobs" ariaLabel="Re-run jobs" align="right">
                <button type="button" role="menuitem" className="actions-dd__item" onClick={() => void rerun(false)}>
                  <RefreshCw size={11} strokeWidth={1.5} />
                  Re-run all jobs
                </button>
                {jobsFailed > 0 && (
                  <button type="button" role="menuitem" className="actions-dd__item" onClick={() => void rerun(true)}>
                    <RefreshCw size={11} strokeWidth={1.5} />
                    Re-run failed jobs
                  </button>
                )}
              </FilterDropdown>
            )}
            {detail.url && (
              <button type="button" className="outline-button" onClick={() => void ghOpenUrl(detail.url)}>
                <ExternalLink size={11} strokeWidth={1.25} />
                GitHub
              </button>
            )}
          </div>
        </header>

        <div className="actions-runpage__layout">
          <nav className="actions-runnav" aria-label="Run navigation">
            <button
              type="button"
              className={`actions-runnav__item${pane === 'summary' ? ' actions-runnav__item--active' : ''}`}
              onClick={() => { setPane('summary'); setLogJob(null); }}
            >
              <Home size={13} strokeWidth={1.5} />
              Summary
            </button>
            <p className="actions-runnav__label">Jobs</p>
            {detail.jobs.map((job) => {
              const jt = jobTone(job);
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`actions-runnav__item${pane === 'logs' && logJob === job.id ? ' actions-runnav__item--active' : ''}`}
                  onClick={() => { setPane('logs'); setLogJob(job.id); }}
                >
                  <span className={`actions-status actions-status--${jt} actions-status--small`}><ToneIcon tone={jt} size={9} /></span>
                  <span className="actions-runnav__name">{job.name}</span>
                </button>
              );
            })}
            {detail.jobs.length === 0 && <p className="actions-runnav__none">No jobs yet</p>}
            <p className="actions-runnav__label">Run details</p>
            <button
              type="button"
              className={`actions-runnav__item${pane === 'logs' && logJob === null ? ' actions-runnav__item--active' : ''}`}
              onClick={() => { setPane('logs'); setLogJob(null); }}
            >
              <ScrollText size={13} strokeWidth={1.5} />
              All logs
            </button>
            {detailWorkflowPath && (
              <button type="button" className="actions-runnav__item" onClick={() => void viewWorkflowDefinition(detailWorkflowPath)}>
                <FileCode2 size={13} strokeWidth={1.5} />
                Workflow file
              </button>
            )}
          </nav>

          <div className="actions-runbody">
            {pane === 'summary' ? (
              <>
                <div className="actions-summary">
                  <div className="actions-summary__cell">
                    <span>Triggered via {detail.event.replace(/_/g, ' ')}</span>
                    <strong>{relativeTime(detail.startedAt || detail.createdAt)}</strong>
                    <small>
                      {detail.branch} · {detail.sha.slice(0, 7)}
                    </small>
                  </div>
                  <div className="actions-summary__cell">
                    <span>Status</span>
                    <strong className={`actions-summary__status actions-summary__status--${tone}`}>
                      <ToneIcon tone={tone} size={13} />
                      {TONE_LABEL[tone]}
                    </strong>
                    <small>
                      Started {formatStamp(detail.startedAt || detail.createdAt)}
                      {detailDone ? ` · finished ${formatStamp(detail.updatedAt)}` : ''}
                    </small>
                  </div>
                  <div className="actions-summary__cell">
                    <span>Total duration</span>
                    <strong>{durationOf(detail.startedAt, detail.updatedAt) || (detailDone ? '—' : 'running…')}</strong>
                  </div>
                  <div className="actions-summary__cell">
                    <span>Artifacts</span>
                    <strong>{artifactsLoading ? '…' : artifacts.length}</strong>
                  </div>
                </div>

                {tone !== 'success' && (
                  <p className={`actions-detail__banner actions-detail__banner--${tone}`}>
                    <ToneIcon tone={tone} size={12} />
                    {tone === 'failed' ? (
                      <>
                        <strong>{jobsFailed} job{jobsFailed === 1 ? '' : 's'} failed</strong> · {jobsSkipped} skipped. Open a job to read its log.
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

                <section className="actions-section" aria-label="Jobs">
                  <h3>
                    Jobs <span className="actions-section__count">{detail.jobs.length}</span>
                  </h3>
                  <div className="actions-jobcards">
                    {detail.jobs.map((job) => {
                      const jt = jobTone(job);
                      return (
                        <button key={job.id} type="button" className="actions-jobcard" onClick={() => { setPane('logs'); setLogJob(job.id); }}>
                          <span className={`actions-status actions-status--${jt}`}><ToneIcon tone={jt} size={12} /></span>
                          <span className="actions-jobcard__name">{job.name}</span>
                          <span className="actions-jobcard__time">{job.duration || '—'}</span>
                        </button>
                      );
                    })}
                    {detail.jobs.length === 0 && <p className="actions-artifacts__none">No jobs have started yet.</p>}
                  </div>
                </section>

                <section className="actions-section" aria-label="Artifacts">
                  <h3>
                    Artifacts{' '}
                    {!artifactsLoading && <span className="actions-section__count">{artifacts.length}</span>}
                  </h3>
                  {artifactsError ? (
                    <div role="alert">
                      {artifactsError}
                      <button className="outline-button" onClick={() => setArtifactsRetry((n) => n + 1)}>Try again</button>
                    </div>
                  ) : artifactsLoading ? (
                    <div className="pr-skeleton-list" aria-label="Loading artifacts">
                      <div className="pr-skeleton-row">
                        <div className="pr-skeleton pr-skeleton--title" />
                        <div className="pr-skeleton pr-skeleton--meta pr-skeleton--short" />
                      </div>
                    </div>
                  ) : artifacts.length === 0 ? (
                    <p className="actions-artifacts__none">This run did not upload any artifacts.</p>
                  ) : (
                    <div className="actions-artifacts__table">
                      {artifacts.map((artifact) => (
                        <div key={artifact.id} className="actions-artifact">
                          <Package size={13} strokeWidth={1.5} className="actions-artifact__icon" />
                          <span className="actions-artifact__name">{artifact.name}</span>
                          <span className="actions-artifact__meta">
                            uploaded {formatDate(artifact.createdAt)}
                            {artifact.expired ? ' · expired' : ''}
                          </span>
                          <span className="actions-artifact__size">{formatBytes(artifact.size)}</span>
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
                      ))}
                    </div>
                  )}
                </section>
              </>
            ) : (
              <>
                {selectedJob && (
                  <section className="actions-section" aria-label="Steps">
                    <h3>
                      <span className={`actions-status actions-status--${jobTone(selectedJob)} actions-status--small`}><ToneIcon tone={jobTone(selectedJob)} size={9} /></span>
                      {selectedJob.name}
                      <span className="actions-section__count">{selectedJob.duration || '—'}</span>
                    </h3>
                    <div className="actions-steps">
                      {selectedJob.steps.map((step) => {
                        const st = toneOf(step.status, step.conclusion);
                        return (
                          <div key={step.number} className={`actions-step actions-step--${st}`}>
                            <span className={`actions-step__icon actions-step__icon--${st}`}>
                              <ToneIcon tone={st} size={9} />
                            </span>
                            <span className="actions-step__name">{step.name}</span>
                            <span className="actions-step__time">{step.duration || (st === 'running' ? '…' : '—')}</span>
                          </div>
                        );
                      })}
                      {selectedJob.steps.length === 0 && <p className="actions-artifacts__none">No steps recorded for this job.</p>}
                    </div>
                  </section>
                )}
                {renderConsole()}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderRunList = () => (
    <>
      <div className="actions-listhead">
        <div className="actions-listhead__titles">
          <h2>{workflowFilter || 'All workflows'}</h2>
          <p>
            {selectedWorkflow ? (
              <>
                Showing runs from <code>{selectedWorkflow.path}</code>
              </>
            ) : (
              'Showing runs from all workflows'
            )}
          </p>
        </div>
        {selectedWorkflow && (
          <button type="button" className="outline-button" onClick={() => void viewWorkflowDefinition(selectedWorkflow.path)}>
            <FileCode2 size={12} strokeWidth={1.25} />
            View workflow file
          </button>
        )}
        <div className="screen-search actions-screen__search">
          <Search size={14} strokeWidth={1.25} />
          <input
            placeholder="Filter workflow runs"
            aria-label="Search runs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="actions-box">
        <div className="actions-box__head">
          <strong>
            {loading ? '…' : filtered.length.toLocaleString()} workflow run{filtered.length === 1 ? '' : 's'}
          </strong>
          <div className="actions-box__filters">
            <FilterDropdown label={eventFilter ? `Event: ${eventFilter}` : 'Event'} active={eventFilter !== ''} ariaLabel="Filter by event" align="right">
              {dropdownItem('All events', eventFilter === '', () => setEventFilter(''))}
              {events.map((event) => dropdownItem(event, eventFilter === event, () => setEventFilter(event)))}
            </FilterDropdown>
            <FilterDropdown label={statusFilter ? `Status: ${TONE_LABEL[statusFilter]}` : 'Status'} active={statusFilter !== ''} ariaLabel="Filter by status" align="right">
              {dropdownItem('All statuses', statusFilter === '', () => setStatusFilter(''))}
              {(Object.keys(TONE_LABEL) as RunTone[]).map((key) => dropdownItem(TONE_LABEL[key], statusFilter === key, () => setStatusFilter(key)))}
            </FilterDropdown>
            <FilterDropdown label={branchFilter ? `Branch: ${branchFilter}` : 'Branch'} active={branchFilter !== ''} ariaLabel="Filter by branch" align="right">
              {dropdownItem('All branches', branchFilter === '', () => setBranchFilter(''))}
              {branches.map((branch) => dropdownItem(branch, branchFilter === branch, () => setBranchFilter(branch)))}
            </FilterDropdown>
          </div>
        </div>
        {loading ? (
          <SkeletonRuns />
        ) : error ? (
          renderEmpty('Could not load workflow runs', error, (
            <button type="button" className="outline-button" onClick={() => void loadAll(false, true)}>
              <RefreshCw size={12} strokeWidth={1.25} />
              Retry
            </button>
          ), 'Make sure the GitHub CLI (gh) is installed, signed in, and the repository has a GitHub remote.')
        ) : runs.length === 0 ? (
          renderEmpty(
            workflows.length === 0 ? 'Get started with GitHub Actions' : 'No workflow runs',
            workflows.length === 0
              ? 'This repository has no GitHub Actions workflows yet — add a workflow file under .github/workflows and push it.'
              : 'Workflows exist, but nothing has run yet. Push a commit or use "Run workflow".',
            <button type="button" className="outline-button" onClick={() => void ghOpenUrl('https://docs.github.com/actions')}>
              <ExternalLink size={12} strokeWidth={1.25} />
              Learn about GitHub Actions
            </button>,
          )
        ) : filtered.length === 0 ? (
          renderEmpty('No runs match the current filters', 'Adjust the search or dropdown filters above.', (
            <button type="button" className="outline-button" onClick={clearFilters}>
              <X size={12} strokeWidth={1.25} />
              Clear filters
            </button>
          ))
        ) : (
          <ul className="actions-rows">{filtered.map(renderRunRow)}</ul>
        )}
      </div>
      <p className="actions-listfoot">
        {loading ? 'Loading runs…' : `Showing ${filtered.length} of ${total.toLocaleString()} runs`}
      </p>
    </>
  );

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
          className="actions-screen__refresh"
          aria-label="Refresh runs"
          title="Refresh runs"
          onClick={() => void loadAll(true, true)}
        >
          <RefreshCw size={13} strokeWidth={1.25} className={refreshing ? 'actions-spin' : ''} />
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

      <div className="screen-body actions-gh">
        <aside className="actions-rail" aria-label="Workflows">
          <button
            type="button"
            className={`actions-rail__item${workflowFilter === '' ? ' actions-rail__item--active' : ''}`}
            aria-pressed={workflowFilter === ''}
            onClick={() => chooseWorkflow('')}
          >
            <Workflow size={14} strokeWidth={1.5} />
            All workflows
          </button>
          {workflows.length > 0 && <p className="actions-rail__label">Workflows</p>}
          {workflows.map((wf) => (
            <button
              key={wf.path}
              type="button"
              className={`actions-rail__item actions-rail__item--workflow${workflowFilter === wf.name ? ' actions-rail__item--active' : ''}${wf.state === 'active' ? '' : ' actions-rail__item--off'}`}
              aria-pressed={workflowFilter === wf.name}
              title={wf.state === 'active' ? wf.path : `${wf.path} (${wf.state})`}
              onClick={() => chooseWorkflow(wf.name)}
            >
              {wf.name}
            </button>
          ))}
        </aside>

        <main className="actions-main">
          {view === 'run' && selected !== null ? renderRunPage() : renderRunList()}
        </main>
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
