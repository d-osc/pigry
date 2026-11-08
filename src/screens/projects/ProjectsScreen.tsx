import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Columns3,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListFilter,
  Maximize2,
  Milestone,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Table as TableIcon,
  TriangleAlert,
  Users,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ghOpenUrl, ghProjectItemList, ghProjectList } from '../../lib/tauriClient';
import { colorOf, initialsOf, relativeTime } from '../../lib/ghData';
import { useRepository } from '../../hooks/useRepository';
import type { GhProject, GhProjectItem } from '../../types/repository';
import './ProjectsScreen.css';

type View = 'board' | 'table' | 'roadmap';
type Phase = 'loading' | 'ready' | 'empty' | 'error';

const MS_DAY = 86_400_000;
const ROADMAP_WINDOW_DAYS = 21;

const DONE_STATES = new Set(['CLOSED', 'MERGED']);
const isDone = (item: GhProjectItem) => DONE_STATES.has(item.state);

/** Column dot color derived from the status name (deterministic fallback). */
function statusColor(name: string): string {
  const l = name.toLowerCase();
  if (/(done|closed|complete|shipped|released|merged|live)/.test(l)) return 'var(--green)';
  if (/(progress|review|active|doing|wip|building|fix)/.test(l)) return 'var(--orange)';
  if (/(ready|todo|triaged)/.test(l)) return 'var(--cyan)';
  if (/(backlog|no status|icebox|idea)/.test(l)) return 'var(--text-secondary)';
  const palette = ['var(--cyan)', 'var(--purple)', 'var(--orange)', 'var(--green)'];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function stateDisplay(item: GhProjectItem): { text: string; color: string } {
  if (item.state === 'MERGED') return { text: 'Merged', color: 'var(--purple)' };
  if (item.state === 'CLOSED') return { text: 'Closed', color: 'var(--green)' };
  return { text: 'Open', color: 'var(--text-secondary)' };
}

/** "Nov 2" / "Nov 2, 2026" from a day timestamp. */
function fmtDay(ms: number, withYear = false): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** Local-midnight timestamp from "2026-11-02" (null when unset). */
function parseDay(iso: string): number | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  return (
    <span
      className="projects__avatar"
      style={{ width: size, height: size, background: colorOf(login) }}
      title={login}
      aria-hidden="true"
    >
      {initialsOf(login)}
    </span>
  );
}

/** Iteration that contains `now`, else the nearest upcoming, else the latest ended. */
function pickCurrentIteration(
  items: GhProjectItem[],
  now: number,
): { title: string; start: number; end: number } | null {
  const parsed = items
    .map((item) => {
      const start = parseDay(item.iteration?.startDate ?? '');
      const end = parseDay(item.iteration?.endDate ?? '');
      return item.iteration && start != null && end != null
        ? { title: item.iteration.title, start, end }
        : null;
    })
    .filter((entry): entry is { title: string; start: number; end: number } => entry != null);
  if (parsed.length === 0) return null;
  return (
    parsed.find((entry) => now >= entry.start && now <= entry.end) ??
    [...parsed].sort((a, b) => a.start - b.start).find((entry) => entry.start > now) ??
    [...parsed].sort((a, b) => b.end - a.end)[0]
  );
}

/** Type icon for table/roadmap rows. */
function ItemTypeIcon({ item }: { item: GhProjectItem }) {
  const size = 11.5;
  if (item.kind === 'pr' && item.state === 'MERGED') {
    return <GitMerge size={size} strokeWidth={1.5} className="ptable__type-icon" />;
  }
  if (item.kind === 'issue' && item.state === 'CLOSED') {
    return <CircleCheck size={size} strokeWidth={1.5} className="ptable__type-icon" />;
  }
  if (item.kind === 'pr') {
    return <GitPullRequest size={size} strokeWidth={1.5} className="ptable__type-icon" />;
  }
  return <CircleDot size={size} strokeWidth={1.5} className="ptable__type-icon" />;
}

interface StatusGroup {
  name: string;
  color: string;
  items: GhProjectItem[];
}

/** Group by the project's Status field; "No status" leads the board. */
function groupByStatus(items: GhProjectItem[]): StatusGroup[] {
  const groups = new Map<string, GhProjectItem[]>();
  for (const item of items) {
    const key = item.status || 'No status';
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === 'No status') return -1;
      if (b === 'No status') return 1;
      return 0;
    })
    .map(([name, list]) => ({ name, color: statusColor(name), items: list }));
}

/** Dropdown that closes on outside click / Escape. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Filter chip with a checkbox menu (assignee / label / iteration). */
function FilterMenu({
  icon,
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  icon: React.ReactNode;
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const { open, setOpen, ref } = useDropdown();
  return (
    <div className="projects__filter-wrap" ref={ref}>
      <button
        type="button"
        className={`projects__filter${selected.size > 0 ? ' projects__filter--active' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {icon}
        {selected.size > 0 ? `${label}: ${selected.size}` : label}
        <ChevronDown size={12} strokeWidth={1.25} />
      </button>
      {open && (
        <div className="projects__filter-menu" role="menu">
          {options.length === 0 && (
            <span className="projects__filter-empty">No {label.toLowerCase()} options</span>
          )}
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected.has(option)}
              onClick={() => onToggle(option)}
            >
              <span className="projects__filter-check">
                {selected.has(option) && <Check size={11} strokeWidth={2} />}
              </span>
              {option}
            </button>
          ))}
          {selected.size > 0 && (
            <button type="button" className="projects__filter-clear" onClick={onClear}>
              Clear filter
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Project switcher chip in the breadcrumb row. */
function ProjectSwitcher({
  projects,
  activeNumber,
  onSelect,
}: {
  projects: GhProject[];
  activeNumber: number | null;
  onSelect: (number: number) => void;
}) {
  const { open, setOpen, ref } = useDropdown();
  const active = projects.find((p) => p.number === activeNumber);
  return (
    <div className="projects__switcher" ref={ref}>
      <button type="button" className="projects__nav-chip" onClick={() => setOpen(!open)}>
        <Settings size={13} strokeWidth={1.25} />
        <span>{active?.title ?? 'Select project'}</span>
        <ChevronDown size={12} strokeWidth={1.25} />
      </button>
      {open && (
        <div className="projects__filter-menu" role="listbox">
          {projects.map((project) => (
            <button
              key={project.number}
              type="button"
              role="option"
              aria-selected={project.number === activeNumber}
              onClick={() => {
                onSelect(project.number);
                setOpen(false);
              }}
            >
              <span className="projects__filter-check">
                {project.number === activeNumber && <Check size={11} strokeWidth={2} />}
              </span>
              <span className="projects__switcher-title">{project.title}</span>
              <span className="projects__switcher-id">#{project.number}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Skeletons ---- */

function HeaderSkeleton() {
  return (
    <div className="projects__overview">
      <div className="projects__nav">
        <span className="projects__nav-root">Projects</span>
        <span className="projects__nav-sep">/</span>
        <div className="projects__skel projects__skel--chip" />
      </div>
      <div className="projects__heading">
        <div className="projects__heading-text">
          <div className="projects__skel projects__skel--h1" />
          <div className="projects__skel projects__skel--subtitle" />
        </div>
      </div>
      <div className="projects__milestone">
        {[0, 1].map((cell) => (
          <div key={cell} className="projects__milestone-cell">
            <div className="projects__skel-stack">
              <div className="projects__skel projects__skel--meta" />
              <div className="projects__skel projects__skel--meta projects__skel--short" />
            </div>
          </div>
        ))}
        <div className="projects__progress">
          <div className="projects__skel projects__skel--meta" />
          <div className="projects__skel projects__skel--bar" />
        </div>
      </div>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="projects__columns" aria-label="Loading project board">
      {[0, 1, 2, 3].map((column) => (
        <section key={column} className="projects__column">
          <div className="projects__skel projects__skel--colhead" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="projects__skel-card">
              <div className="projects__skel projects__skel--meta" />
              <div
                className="projects__skel projects__skel--title"
                style={{ width: `${88 - row * 12}%` }}
              />
              <div className="projects__skel projects__skel--label" />
              <div className="projects__skel projects__skel--owner" />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="ptable" aria-label="Loading project table">
      <div className="ptable__card">
        <div className="ptable__skel-row ptable__skel-row--head">
          <div className="projects__skel projects__skel--meta projects__skel--short" />
        </div>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <div key={row} className="ptable__skel-row">
            <div className="projects__skel projects__skel--meta" style={{ width: 60 }} />
            <div className="projects__skel projects__skel--title" style={{ width: `${62 - (row % 3) * 8}%` }} />
            <div className="projects__skel projects__skel--meta projects__skel--short" />
            <div className="projects__skel projects__skel--label" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RoadmapSkeleton() {
  return (
    <div className="proad" aria-label="Loading roadmap">
      <div className="proad__controls">
        <div className="projects__skel projects__skel--meta projects__skel--short" />
      </div>
      <div className="proad__card">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} className="proad__skel-row">
            <div className="projects__skel projects__skel--meta" style={{ width: '32%' }} />
            <div
              className="projects__skel projects__skel--bar"
              style={{
                width: `${18 + ((row * 13) % 30)}%`,
                marginLeft: `${(row % 4) * 9}%`,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Roadmap model ---- */

interface RoadmapBar {
  startIndex: number;
  endIndex: number;
  tone: 'ready' | 'active' | 'done';
  label: string;
}

interface RoadmapModel {
  days: number[];
  weekendFlags: boolean[];
  todayIndex: number | null;
  monthLabel: string;
  rangeLabel: string;
  iterations: { title: string; startIndex: number; endIndex: number }[];
  /** Bar per item id, computed against the visible window. */
  bars: Map<string, RoadmapBar | null>;
  scheduledCount: number;
}

function buildRoadmap(
  groups: StatusGroup[],
  windowStart: number | null,
): { model: RoadmapModel | null; rangeStart: number | null; rangeEnd: number | null } {
  const dated = groups
    .flatMap((group) => group.items)
    .filter((item) => item.iteration)
    .map((item) => {
      const start = parseDay(item.iteration!.startDate);
      const end = parseDay(item.iteration!.endDate);
      return start != null && end != null ? { start, end, item } : null;
    })
    .filter((entry): entry is { start: number; end: number; item: GhProjectItem } => entry != null);
  if (dated.length === 0) return { model: null, rangeStart: null, rangeEnd: null };

  const rangeStart = Math.min(...dated.map((entry) => entry.start));
  const rangeEnd = Math.max(...dated.map((entry) => entry.end));
  const totalDays = Math.min(90, Math.round((rangeEnd - rangeStart) / MS_DAY) + 1);

  const viewStart = windowStart ?? rangeStart;
  const days: number[] = [];
  for (let i = 0; i < Math.min(ROADMAP_WINDOW_DAYS, totalDays); i += 1) {
    days.push(viewStart + i * MS_DAY);
  }
  const indexOfDay = new Map(days.map((ms, index) => [ms, index]));
  const today = new Date();
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const weekendFlags = days.map((ms) => {
    const day = new Date(ms).getDay();
    return day === 0 || day === 6;
  });
  const todayIndex = indexOfDay.get(todayMs) ?? null;

  const barFor = (item: GhProjectItem, done: boolean): RoadmapBar | null => {
    const start = parseDay(item.iteration!.startDate);
    const end = parseDay(item.iteration!.endDate);
    if (start == null || end == null) return null;
    const startIndex = Math.max(0, Math.round((Math.max(start, viewStart) - viewStart) / MS_DAY));
    const endIndex = Math.min(
      days.length - 1,
      Math.round((Math.min(end, days[days.length - 1]) - viewStart) / MS_DAY),
    );
    if (end < viewStart || start > days[days.length - 1]) return null;
    const withinToday = todayMs >= start && todayMs <= end;
    return {
      startIndex,
      endIndex,
      tone: done ? 'done' : withinToday ? 'active' : 'ready',
      label: done ? `${item.status || 'Done'} · completed` : item.status || 'Scheduled',
    };
  };

  const bars = new Map<string, RoadmapBar | null>();
  for (const group of groups) {
    for (const item of group.items) {
      bars.set(item.itemId, item.iteration ? barFor(item, isDone(item)) : null);
    }
  }

  const seen = new Set<string>();
  const iterations = dated
    .filter(({ item }) => {
      const title = item.iteration!.title || 'Iteration';
      if (seen.has(title)) return false;
      seen.add(title);
      return true;
    })
    .map(({ start, end, item }) => ({
      title: item.iteration!.title || 'Iteration',
      startIndex: Math.max(0, Math.round((Math.max(start, viewStart) - viewStart) / MS_DAY)),
      endIndex: Math.min(
        days.length - 1,
        Math.round((Math.min(end, days[days.length - 1]) - viewStart) / MS_DAY),
      ),
    }))
    .filter((span) => span.endIndex >= span.startIndex);

  const monthLabel = new Date(days[0]).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  const singleIteration = iterations.length === 1 ? iterations[0] : null;
  const rangeLabel = singleIteration
    ? `${singleIteration.title} · ${fmtDay(days[0])}–${fmtDay(days[days.length - 1])}`
    : `${fmtDay(rangeStart, true)} – ${fmtDay(rangeEnd, true)}`;

  return {
    model: {
      days,
      weekendFlags,
      todayIndex,
      monthLabel,
      rangeLabel,
      iterations,
      bars,
      scheduledCount: dated.length,
    },
    rangeStart,
    rangeEnd,
  };
}

/* ---- Empty / error panels ---- */

function StatePanel({
  tone,
  icon,
  title,
  description,
  hints,
  errorText,
  onRetry,
  onOpenDocs,
}: {
  tone: 'empty' | 'error';
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  hints?: string[];
  errorText?: string;
  onRetry: () => void;
  onOpenDocs: () => void;
}) {
  return (
    <div className="projects__state">
      <div className={`projects__state-icon projects__state-icon--${tone}`}>{icon}</div>
      <h2 className="projects__state-title">{title}</h2>
      <div className="projects__state-desc">{description}</div>
      {errorText && <pre className="projects__state-error">{errorText}</pre>}
      {hints && hints.length > 0 && (
        <ul className="projects__state-hints">
          {hints.map((hint) => (
            <li key={hint}><code>{hint}</code></li>
          ))}
        </ul>
      )}
      <div className="projects__state-actions">
        <button type="button" className="projects__action" onClick={onRetry}>
          <RefreshCw size={11} strokeWidth={1.25} />
          <span>Retry</span>
        </button>
        <button type="button" className="projects__action" onClick={onOpenDocs}>
          <ExternalLink size={11} strokeWidth={1.25} />
          <span>GitHub Projects docs</span>
        </button>
      </div>
    </div>
  );
}

const DOCS_URL = 'https://docs.github.com/en/issues/planning-and-tracking-with-projects';

export function ProjectsScreen() {
  const { repository, notify, mode } = useRepository();
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorText, setErrorText] = useState('');
  const [projects, setProjects] = useState<GhProject[]>([]);
  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [items, setItems] = useState<GhProjectItem[]>([]);
  /** Project number whose items are currently loaded — drives the skeleton. */
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  /** Wall clock captured when items load — avoids Date.now() during render. */
  const [nowMs, setNowMs] = useState(0);
  const [view, setView] = useState<View>('board');
  const [query, setQuery] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
  const [iterationFilter, setIterationFilter] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dayWidth, setDayWidth] = useState(36);
  const [windowStart, setWindowStart] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const itemsLoading = activeNumber != null && loadedFor !== activeNumber;

  const applyProjects = useCallback((open: GhProject[]) => {
    if (open.length === 0) {
      setProjects([]);
      setActiveNumber(null);
      setItems([]);
      setPhase('empty');
      return;
    }
    setProjects(open);
    setActiveNumber(open[0].number);
    setPhase('ready');
  }, []);

  useEffect(() => {
    let cancelled = false;
    ghProjectList()
      .then((list) => {
        if (!cancelled) applyProjects(list.filter((project) => !project.closed));
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorText(String(error));
          setPhase('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyProjects]);

  /** Manual reload (event handler — may set state synchronously). */
  const retryLoad = () => {
    setErrorText('');
    setProjects([]);
    setActiveNumber(null);
    setItems([]);
    setLoadedFor(null);
    setPhase('loading');
    ghProjectList()
      .then((list) => applyProjects(list.filter((project) => !project.closed)))
      .catch((error) => {
        setErrorText(String(error));
        setPhase('error');
      });
  };

  useEffect(() => {
    if (activeNumber == null) return;
    let cancelled = false;
    const number = activeNumber;
    ghProjectItemList(number)
      .then((list) => {
        if (cancelled) return;
        setItems(list.filter((item) => !item.isArchived));
        setLoadedFor(number);
        setNowMs(Date.now());
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorText(String(error));
        setPhase('error');
        setLoadedFor(number);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNumber]);

  /** Switch project (event handler — also resets the roadmap window). */
  const selectProject = (number: number) => {
    if (number === activeNumber) return;
    setWindowStart(null);
    setDayWidth(36);
    setActiveNumber(number);
  };

  // "/" focuses the filter search when nothing else has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeProject = projects.find((project) => project.number === activeNumber) ?? null;

  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortedItems.filter((item) => {
      if (assigneeFilter.size > 0 && !item.assignees.some((a) => assigneeFilter.has(a))) return false;
      if (labelFilter.size > 0 && !item.labels.some((l) => labelFilter.has(l))) return false;
      if (iterationFilter.size > 0) {
        const title = item.iteration?.title ?? '';
        if (!title || !iterationFilter.has(title)) return false;
      }
      if (!q) return true;
      const haystack =
        `${item.title} #${item.number} ${item.repository} ${item.labels.join(' ')} ` +
        `${item.assignees.join(' ')} ${item.status}`
          .toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedItems, query, assigneeFilter, labelFilter, iterationFilter]);

  const groups = useMemo(() => groupByStatus(filtered), [filtered]);

  const assigneeOptions = useMemo(
    () => [...new Set(items.flatMap((item) => item.assignees))].sort(),
    [items],
  );
  const labelOptions = useMemo(
    () => [...new Set(items.flatMap((item) => item.labels))].sort(),
    [items],
  );
  const iterationOptions = useMemo(
    () => [...new Set(items.map((item) => item.iteration?.title).filter((t): t is string => !!t))],
    [items],
  );

  const totalCount = filtered.length;
  const doneCount = filtered.filter(isDone).length;
  const issueCount = filtered.filter((item) => item.kind === 'issue').length;
  const prCount = totalCount - issueCount;
  const donePct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const assignees = useMemo(() => {
    const seen = new Set<string>();
    const logins: string[] = [];
    for (const item of items) {
      for (const login of item.assignees) {
        if (!seen.has(login)) {
          seen.add(login);
          logins.push(login);
        }
        if (logins.length >= 5) break;
      }
      if (logins.length >= 5) break;
    }
    return logins;
  }, [items]);

  const repositories = useMemo(
    () => [...new Set(items.map((item) => item.repository).filter(Boolean))],
    [items],
  );

  /** Iteration that contains today, else the nearest upcoming one. */
  const currentIteration = useMemo(() => pickCurrentIteration(items, nowMs), [items, nowMs]);

  const roadmap = useMemo(() => buildRoadmap(groups, windowStart), [groups, windowStart]);

  /** Slide the 21-day roadmap window by whole weeks, clamped to the range. */
  const shiftWindow = (deltaDays: number) => {
    setWindowStart((current) => {
      const base = roadmap.rangeStart ?? 0;
      const next = (current ?? base) + deltaDays * MS_DAY;
      const maxStart = (roadmap.rangeEnd ?? base) - (ROADMAP_WINDOW_DAYS - 1) * MS_DAY;
      return Math.min(Math.max(next, base), Math.max(base, maxStart));
    });
  };

  const zoomWindow = (delta: number) => {
    setDayWidth((current) => Math.min(48, Math.max(24, current + delta)));
  };

  const fitWindow = () => {
    setWindowStart(null);
    setDayWidth(36);
  };

  const toggleInSet = (setter: typeof setAssigneeFilter) => (value: string) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const openInBrowser = async (url: string, what: string) => {
    try {
      await ghOpenUrl(url);
    } catch (error) {
      notify(`Could not open ${what}: ${String(error)}`, 'error');
    }
  };

  /** Owner projects page for "New project" (project URLs are always owner-scoped). */
  const newProjectUrl = activeProject?.url.match(/^(https:\/\/github\.com\/(?:orgs|users)\/[^/]+)/)?.[1];

  const orgLabel = repository?.organization
    ? `${repository.organization} / ${repository.name}`
    : 'this repository';

  const toggleCollapse = (name: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const renderBody = () => {
    if (itemsLoading) {
      return view === 'table' ? <TableSkeleton /> : view === 'roadmap' ? <RoadmapSkeleton /> : <BoardSkeleton />;
    }
    if (totalCount === 0) {
      return (
        <div className="projects__board-empty">
          <CircleDot size={18} strokeWidth={1.25} />
          <p>
            {items.length === 0
              ? 'This project has no items yet — add issues or pull requests to it on GitHub.'
              : 'No items match the current filters.'}
          </p>
          {items.length > 0 && (
            <button
              type="button"
              className="projects__action"
              onClick={() => {
                setQuery('');
                setAssigneeFilter(new Set());
                setLabelFilter(new Set());
                setIterationFilter(new Set());
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      );
    }
    if (view === 'board') return <BoardView groups={groups} onOpen={openInBrowser} />;
    if (view === 'table') {
      return (
        <TableView
          groups={groups}
          collapsed={collapsedGroups}
          onToggleCollapse={toggleCollapse}
          onOpen={openInBrowser}
        />
      );
    }
    return (
      <RoadmapView
        model={roadmap.model}
        groups={groups}
        dayWidth={dayWidth}
        rangeStart={roadmap.rangeStart}
        onShift={shiftWindow}
        onZoom={zoomWindow}
        onFit={fitWindow}
        onOpen={openInBrowser}
      />
    );
  };

  return (
    <div className="projects">
      {phase === 'loading' ? (
        <>
          <HeaderSkeleton />
          <BoardSkeleton />
        </>
      ) : phase === 'empty' || phase === 'error' ? (
        <div className="projects__state-wrap">
          <StatePanel
            tone={phase === 'empty' ? 'empty' : 'error'}
            icon={
              phase === 'empty' ? (
                <Columns3 size={26} strokeWidth={1.25} />
              ) : (
                <TriangleAlert size={26} strokeWidth={1.25} />
              )
            }
            title={phase === 'empty' ? 'No projects yet' : "Couldn't load projects"}
            description={
              phase === 'empty' ? (
                mode === 'browser' ? (
                  <p>
                    Browser preview cannot call the gh CLI. Run the desktop app to load the
                    GitHub Projects of {orgLabel}.
                  </p>
                ) : (
                  <p>
                    No open GitHub Projects (v2) were found for {orgLabel}. Once a project
                    exists it appears here with its board, table and roadmap.
                  </p>
                )
              ) : (
                <p>
                  The gh CLI failed while reading GitHub Projects. Check that gh is installed
                  and signed in to the account that owns {orgLabel}.
                </p>
              )
            }
            hints={
              phase === 'empty'
                ? mode === 'browser'
                  ? undefined
                  : [
                      'gh project create --title "Roadmap"',
                      'gh auth refresh -s read:project',
                    ]
                : /read:project|scope/i.test(errorText)
                  ? ['gh auth refresh -s read:project']
                  : undefined
            }
            errorText={phase === 'error' ? errorText : undefined}
            onRetry={retryLoad}
            onOpenDocs={() => openInBrowser(DOCS_URL, 'the docs')}
          />
        </div>
      ) : (
        <div className="projects__overview">
          <div className="projects__nav">
            <span className="projects__nav-root">Projects</span>
            <span className="projects__nav-sep">/</span>
            {projects.length > 1 ? (
              <ProjectSwitcher
                projects={projects}
                activeNumber={activeNumber}
                onSelect={selectProject}
              />
            ) : (
              <span className="projects__nav-chip projects__nav-chip--static">
                <Settings size={13} strokeWidth={1.25} />
                <span>{activeProject?.title}</span>
              </span>
            )}
            <span className="projects__nav-id">
              PROJECT {String(activeProject?.number ?? 0).padStart(2, '0')}
            </span>
            <div className="projects__nav-actions">
              <span className="projects__updated">
                Updated {activeProject ? relativeTime(activeProject.updatedAt) : '—'}
              </span>
              <button
                type="button"
                className="projects__icon-button"
                aria-label="Reload projects"
                onClick={retryLoad}
              >
                <RefreshCw size={12} strokeWidth={1.25} />
              </button>
              {newProjectUrl && (
                <button
                  type="button"
                  className="projects__action"
                  onClick={() => openInBrowser(`${newProjectUrl}/projects`, 'GitHub')}
                >
                  <Plus size={9.5} strokeWidth={1.25} />
                  <span>New project</span>
                </button>
              )}
            </div>
          </div>

          <div className="projects__heading">
            <div className="projects__heading-text">
              <div className="projects__title-row">
                <h1 className="projects__title">{activeProject?.title}</h1>
                <span className="projects__badge projects__badge--active">Active</span>
              </div>
              <p className="projects__subtitle">
                {activeProject?.shortDescription || 'No description set for this project.'}
              </p>
            </div>
            {assignees.length > 0 && (
              <div className="projects__members">
                <span className="projects__members-label">Assignees</span>
                <div className="projects__members-stack">
                  {assignees.slice(0, 4).map((login) => (
                    <Avatar key={login} login={login} size={24} />
                  ))}
                  {assignees.length > 4 && (
                    <span className="projects__members-more" title={assignees.slice(4).join(', ')}>
                      +{assignees.length - 4}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="projects__milestone">
            <div className="projects__milestone-cell">
              <Milestone size={15} strokeWidth={1.25} className="projects__milestone-icon" />
              <div>
                <p className="projects__milestone-label">Iteration</p>
                <p className="projects__milestone-value">
                  {currentIteration?.title ?? 'None set'}
                </p>
              </div>
            </div>
            <span className="projects__divider" />
            <div className="projects__milestone-cell">
              <div>
                <p className="projects__milestone-label">Iteration dates</p>
                <p className="projects__milestone-value">
                  {currentIteration
                    ? `${fmtDay(currentIteration.start)} – ${fmtDay(currentIteration.end)}`
                    : '—'}
                </p>
              </div>
              {currentIteration && (
                <span className="projects__ontrack">
                  <span className="projects__ontrack-dot" />
                  {nowMs >= currentIteration.start && nowMs <= currentIteration.end
                    ? 'On track'
                    : 'Upcoming'}
                </span>
              )}
            </div>
            <span className="projects__divider" />
            <div className="projects__progress">
              <div className="projects__progress-labels">
                <span>
                  {doneCount} of {totalCount} item{totalCount === 1 ? '' : 's'} completed
                </span>
                <span className="projects__progress-pct">{donePct}%</span>
              </div>
              <div className="projects__progress-track">
                <span
                  className="projects__progress-fill"
                  style={{ width: `${donePct}%` }}
                />
              </div>
            </div>
            <span className="projects__due">
              {currentIteration ? `Due ${fmtDay(currentIteration.end)}` : 'No due date'}
            </span>
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="projects__board">
          <div className="projects__views" role="tablist" aria-label="Project views">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'board'}
              className={`projects__view-tab${view === 'board' ? ' projects__view-tab--active' : ''}`}
              onClick={() => setView('board')}
            >
              <Columns3 size={14} strokeWidth={1.25} />
              Board
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'table'}
              className={`projects__view-tab${view === 'table' ? ' projects__view-tab--active' : ''}`}
              onClick={() => setView('table')}
            >
              <TableIcon size={14} strokeWidth={1.25} />
              Table
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'roadmap'}
              className={`projects__view-tab${view === 'roadmap' ? ' projects__view-tab--active' : ''}`}
              onClick={() => setView('roadmap')}
            >
              <CalendarDays size={14} strokeWidth={1.25} />
              Roadmap
            </button>
            <button
              type="button"
              className="projects__view-settings"
              onClick={() => activeProject && openInBrowser(activeProject.url, 'the project')}
            >
              <ExternalLink size={14} strokeWidth={1.25} />
              <span>Open on GitHub</span>
            </button>
          </div>

          <div className="projects__filters">
            <div className="projects__search">
              <Search size={14} strokeWidth={1.25} />
              <input
                ref={searchRef}
                placeholder="Search project items…"
                aria-label="Search project items"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>/</kbd>
            </div>
            <FilterMenu
              icon={<Users size={13} strokeWidth={1.25} />}
              label="Assignee"
              options={assigneeOptions}
              selected={assigneeFilter}
              onToggle={toggleInSet(setAssigneeFilter)}
              onClear={() => setAssigneeFilter(new Set())}
            />
            <FilterMenu
              icon={<ListFilter size={13} strokeWidth={1.25} />}
              label="Label"
              options={labelOptions}
              selected={labelFilter}
              onToggle={toggleInSet(setLabelFilter)}
              onClear={() => setLabelFilter(new Set())}
            />
            <FilterMenu
              icon={<CalendarDays size={13} strokeWidth={1.25} />}
              label="Iteration"
              options={iterationOptions}
              selected={iterationFilter}
              onToggle={toggleInSet(setIterationFilter)}
              onClear={() => setIterationFilter(new Set())}
            />
            <span className="projects__count">
              {totalCount} item{totalCount === 1 ? '' : 's'}
            </span>
            <div className="projects__board-actions">
              <span className="projects__group-by">Group by: Status</span>
              {activeProject && (
                <button
                  type="button"
                  className="projects__add-item"
                  onClick={() => openInBrowser(activeProject.url, 'the project')}
                  title="Add items on the GitHub project board"
                >
                  <Plus size={12} strokeWidth={1.25} />
                  Add item
                </button>
              )}
            </div>
          </div>

          {renderBody()}

          {phase === 'ready' && !itemsLoading && totalCount > 0 && (
            <footer className="projects__footer">
              <div className="projects__footer-left">
                <span className="projects__footer-stat">
                  <span className="projects__footer-dot projects__footer-dot--open" />
                  {totalCount - doneCount} open
                </span>
                <span className="projects__footer-stat">
                  <span className="projects__footer-dot projects__footer-dot--done" />
                  {doneCount} completed
                </span>
                <span className="projects__footer-meta">
                  {issueCount} issue{issueCount === 1 ? '' : 's'} · {prCount} pull request
                  {prCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="projects__footer-right">
                <span className="projects__footer-repo">
                  {repositories.length > 0
                    ? repositories.length === 1
                      ? repositories[0]
                      : `${repositories[0]} +${repositories.length - 1} repo${repositories.length - 1 === 1 ? '' : 's'}`
                    : orgLabel}
                </span>
                <span className="projects__footer-meta">
                  {filtered.length === items.length
                    ? 'All project items shown'
                    : `${filtered.length} of ${items.length} items shown`}
                </span>
              </div>
            </footer>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- Board view ---- */

function BoardView({
  groups,
  onOpen,
}: {
  groups: StatusGroup[];
  onOpen: (url: string, what: string) => void;
}) {
  return (
    <div className="projects__columns">
      {groups.map((group) => (
        <section key={group.name} className="projects__column">
          <header className="projects__column-head">
            <span className="projects__column-dot" style={{ background: group.color }} />
            <span className="projects__column-name">{group.name}</span>
            <span className="projects__column-count">{group.items.length}</span>
            <div className="projects__column-controls">
              <button type="button" aria-label={`${group.name} options`}>
                <MoreHorizontal size={12} strokeWidth={1.25} />
              </button>
            </div>
          </header>

          {group.items.map((item) => {
            const state = stateDisplay(item);
            return (
              <article
                key={item.itemId}
                className="projects__item projects__item--link"
                onClick={() => onOpen(item.url, 'the item')}
                title="Open on GitHub"
              >
                <div className="projects__item-identity">
                  <ItemTypeIcon item={item} />
                  <span className="projects__item-id">
                    {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number}
                  </span>
                  <span
                    className="projects__item-status"
                    style={{ color: state.color }}
                  >
                    {state.text}
                  </span>
                </div>
                <p className="projects__item-title">{item.title}</p>
                {item.labels.length > 0 && (
                  <div className="projects__item-labels">
                    {item.labels.slice(0, 3).map((label) => (
                      <span key={label} className="projects__label">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                <div className="projects__item-owner">
                  {item.assignees.length > 0 ? (
                    <>
                      <Avatar login={item.assignees[0]} />
                      <span className="projects__item-assignee">{item.assignees[0]}</span>
                    </>
                  ) : (
                    <span className="projects__item-assignee projects__item-assignee--muted">
                      Unassigned
                    </span>
                  )}
                  {item.iteration && (
                    <span className="projects__item-iteration">{item.iteration.title}</span>
                  )}
                </div>
              </article>
            );
          })}

          <div className="projects__column-add projects__column-add--static">
            <span className="projects__column-note">
              {group.items.length === 1 ? '1 item' : `${group.items.length} items`}
            </span>
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---- Table view ---- */

const TABLE_COLUMNS = [
  { label: '', width: '36px' },
  { label: 'Title', width: 'minmax(0, 1fr)' },
  { label: 'Type / ID', width: '104px' },
  { label: 'State', width: '96px' },
  { label: 'Assignees', width: '130px' },
  { label: 'Status', width: '110px' },
  { label: 'Labels', width: '140px' },
  { label: 'Iteration', width: '126px' },
  { label: 'Repository', width: '150px' },
  { label: 'Updated', width: '96px' },
];

function TableView({
  groups,
  collapsed,
  onToggleCollapse,
  onOpen,
}: {
  groups: StatusGroup[];
  collapsed: Set<string>;
  onToggleCollapse: (name: string) => void;
  onOpen: (url: string, what: string) => void;
}) {
  return (
    <div className="ptable">
      <div className="ptable__card">
        <div className="ptable__head ptable__row">
          {TABLE_COLUMNS.map((column, index) => (
            <span key={column.label || `col-${index}`} className="ptable__cell">
              {column.label}
            </span>
          ))}
        </div>

        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.name);
          return (
            <section key={group.name} className="ptable__group">
              <button
                type="button"
                className="ptable__group-head"
                onClick={() => onToggleCollapse(group.name)}
              >
                <ChevronDown
                  size={10}
                  strokeWidth={1.5}
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : undefined }}
                />
                <span className="ptable__group-dot" style={{ background: group.color }} />
                <span className="ptable__group-name">{group.name}</span>
                <span className="ptable__group-count">{group.items.length}</span>
              </button>
              {!isCollapsed &&
                group.items.map((item) => {
                  const state = stateDisplay(item);
                  return (
                    <div
                      key={item.itemId}
                      className="ptable__row ptable__row--item"
                      onClick={() => onOpen(item.url, 'the item')}
                      title="Open on GitHub"
                    >
                      <span className="ptable__cell ptable__cell--select">
                        <span className="ptable__checkbox" aria-hidden="true" />
                      </span>
                      <span className="ptable__cell ptable__cell--title">{item.title}</span>
                      <span className="ptable__cell ptable__cell--type">
                        <ItemTypeIcon item={item} />
                        <span className="ptable__id">
                          {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number}
                        </span>
                      </span>
                      <span
                        className="ptable__cell ptable__cell--state"
                        style={{ color: state.color }}
                      >
                        {state.text}
                      </span>
                      <span className="ptable__cell ptable__cell--assignee">
                        {item.assignees.length > 0 ? (
                          <>
                            <Avatar login={item.assignees[0]} />
                            <span className="ptable__assignee">{item.assignees[0]}</span>
                          </>
                        ) : (
                          <span className="ptable__assignee ptable__assignee--muted">—</span>
                        )}
                      </span>
                      <span className="ptable__cell ptable__cell--status">
                        {item.status || <span className="ptable__assignee--muted">No status</span>}
                      </span>
                      <span className="ptable__cell">
                        {item.labels.slice(0, 2).map((label) => (
                          <span key={label} className="ptable__label">
                            {label}
                          </span>
                        ))}
                      </span>
                      <span className="ptable__cell ptable__cell--iteration">
                        {item.iteration?.title ?? '—'}
                      </span>
                      <span className="ptable__cell ptable__cell--repo">{item.repository || '—'}</span>
                      <span className="ptable__cell ptable__cell--updated">
                        {relativeTime(item.updatedAt, true)}
                      </span>
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Roadmap view ---- */

function RoadmapView({
  model,
  groups,
  dayWidth,
  rangeStart,
  onShift,
  onZoom,
  onFit,
  onOpen,
}: {
  model: RoadmapModel | null;
  groups: StatusGroup[];
  dayWidth: number;
  rangeStart: number | null;
  onShift: (deltaDays: number) => void;
  onZoom: (delta: number) => void;
  onFit: () => void;
  onOpen: (url: string, what: string) => void;
}) {
  if (!model) {
    return (
      <div className="proad">
        <div className="proad__controls">
          <span className="proad__month">Roadmap</span>
        </div>
        <div className="proad__card proad__card--empty">
          <CalendarDays size={18} strokeWidth={1.25} />
          <p>
            No scheduled items — add an Iteration field (with start and end dates) to project
            items on GitHub to see them on the roadmap.
          </p>
        </div>
      </div>
    );
  }
  const laneWidth = model.days.length * dayWidth;
  return (
    <div className="proad">
      <div className="proad__controls">
        <span className="proad__month">{model.monthLabel}</span>
        <button
          type="button"
          aria-label="Previous week"
          disabled={rangeStart == null}
          onClick={() => onShift(-7)}
        >
          <ChevronLeft size={14} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Next week"
          disabled={rangeStart == null}
          onClick={() => onShift(7)}
        >
          <ChevronRight size={14} strokeWidth={1.5} />
        </button>
        <span className="proad__range">{model.rangeLabel}</span>
        <div className="proad__scale">
          <button type="button" aria-label="Zoom out" onClick={() => onZoom(-6)}>
            <ZoomOut size={14} strokeWidth={1.5} />
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => onZoom(6)}>
            <ZoomIn size={14} strokeWidth={1.5} />
          </button>
          <button type="button" aria-label="Fit timeline" onClick={onFit}>
            <Maximize2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="proad__card">
        <div className="proad__axis">
          <div className="proad__item-cols">
            <span className="proad__col proad__col--id">Type / ID</span>
            <span className="proad__col proad__col--title">Work item</span>
            <span className="proad__col">Assignee</span>
          </div>
          <div className="proad__dateaxis" style={{ width: laneWidth }}>
            <div className="proad__weeks">
              {chunkWeeks(model.days).map((week) => (
                <span key={week.key} className="proad__week" style={{ flex: week.length }}>
                  {week.label}
                </span>
              ))}
            </div>
            <div className="proad__days">
              {model.days.map((day, index) => (
                <span
                  key={day}
                  className={`proad__day${index === model.todayIndex ? ' proad__day--today' : ''}`}
                >
                  {String(new Date(day).getDate()).padStart(2, '0')}
                </span>
              ))}
            </div>
          </div>
        </div>

        {model.iterations.length > 0 && (
          <div className="proad__milestone">
            <div className="proad__milestone-label">
              <Milestone size={10.5} strokeWidth={1.5} />
              <span>Iterations</span>
            </div>
            <div className="proad__lane" style={{ width: laneWidth }}>
              {model.days.map((day, index) => (
                <span
                  key={day}
                  className={`proad__cell${model.weekendFlags[index] ? ' proad__cell--weekend' : ''}`}
                />
              ))}
              {model.iterations.map((span) => (
                <span
                  key={span.title}
                  className="proad__iter-tag"
                  style={{
                    left: span.startIndex * dayWidth + 4,
                    width: (span.endIndex - span.startIndex + 1) * dayWidth - 8,
                  }}
                >
                  {span.title}
                </span>
              ))}
            </div>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.name}>
            <div className="proad__group-head">
              <span className="proad__group-label">
                <ChevronDown size={10} strokeWidth={1.5} />
                <span className="proad__group-dot" style={{ background: group.color }} />
                <span className="proad__group-name">{group.name}</span>
                <span className="proad__group-count">{group.items.length}</span>
              </span>
            </div>
            {group.items.map((item) => {
              const bar = model.bars.get(item.itemId) ?? null;
              return (
              <div key={item.itemId} className="proad__item">
                <div className="proad__item-label">
                  <span className="proad__item-id">
                    <ItemTypeIcon item={item} />
                    <span className="proad__id">
                      {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="proad__item-title"
                    onClick={() => onOpen(item.url, 'the item')}
                    title="Open on GitHub"
                  >
                    {item.title}
                  </button>
                  <span className="proad__item-owner">
                    {item.assignees.length > 0 && <Avatar login={item.assignees[0]} />}
                    <span>{item.assignees[0] ?? 'Unassigned'}</span>
                  </span>
                </div>
                <div className="proad__lane" style={{ width: laneWidth }}>
                  {model.days.map((day, index) => (
                    <span
                      key={day}
                      className={`proad__cell${model.weekendFlags[index] ? ' proad__cell--weekend' : ''}`}
                    />
                  ))}
                  {bar ? (
                    <span
                      className={`proad__bar proad__bar--${bar.tone}`}
                      style={{
                        left: bar.startIndex * dayWidth + 4,
                        width: (bar.endIndex - bar.startIndex + 1) * dayWidth - 8,
                      }}
                    >
                      <i style={{ background: statusColor(item.status || group.name) }} />
                      {bar.label}
                    </span>
                  ) : (
                    <span className="proad__unscheduled">Unscheduled · no iteration</span>
                  )}
                </div>
              </div>
              );
            })}
          </section>
        ))}
      </div>

      <div className="proad__legend">
        <span><i style={{ background: 'var(--cyan)' }} />Scheduled</span>
        <span><i style={{ background: 'var(--orange)' }} />In its active iteration</span>
        <span><i style={{ background: 'var(--green)' }} />Done</span>
        <p>
          Bars show each item&apos;s Iteration field dates on GitHub; dashed bars are completed
          items. Items without an iteration stay unscheduled.
        </p>
      </div>
    </div>
  );
}

/** Group consecutive days into labeled week spans for the axis. */
function chunkWeeks(days: number[]): { key: string; label: string; length: number }[] {
  const weeks: { key: string; label: string; length: number }[] = [];
  for (const day of days) {
    const date = new Date(day);
    const weekStart = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
    const key = weekStart.getTime().toString();
    const label = `Wk ${fmtDay(weekStart.getTime())}`;
    const last = weeks[weeks.length - 1];
    if (last && last.key === key) last.length += 1;
    else weeks.push({ key, label, length: 1 });
  }
  return weeks;
}
