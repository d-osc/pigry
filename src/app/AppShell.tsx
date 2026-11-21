import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './TitleBar';
import { NavSidebar } from './NavSidebar';
import { StatusBar, type EditorStatusInfo } from './StatusBar';
import { ToastContainer } from './Toast';
import { SettingsModal } from './settings/SettingsModal';
import { RebaseModal } from './rebase/RebaseModal';
import { ShortcutSheet } from './ShortcutSheet';
import { ChevronLeft, ChevronsRight, Undo2 } from 'lucide-react';
import { workspaceNav, type NavId } from './navigation';
import { buildCommands } from './commands';
import { CommandPalette, type PaletteMode } from './commandPalette/CommandPalette';
import { getFileTree, gitCliStatus, openInBrowser, readWorktreeFile, reportValidationReady } from '../lib/tauriClient';
import { AiAgentPanel } from '../screens/explorer/AiAgentPanel';
import { ResizeHandle } from './ResizeHandle';
import { teamForScreen } from '../lib/agentExtras';
import {
  useRepository,
  RepositoryProvider,
  type RepositoryContextValue,
} from '../hooks/useRepository';
const MergeBranchScreen = lazy(() => import('../screens/merge-branch/MergeBranchScreen').then((module) => ({ default: module.MergeBranchScreen })));
const CompareBranchScreen = lazy(() => import('../screens/compare-branch/CompareBranchScreen').then((module) => ({ default: module.CompareBranchScreen })));
const RebaseBranchScreen = lazy(() => import('../screens/rebase-branch/RebaseBranchScreen').then((module) => ({ default: module.RebaseBranchScreen })));
const PushCommitsScreen = lazy(() => import('../screens/push-commits/PushCommitsScreen').then((module) => ({ default: module.PushCommitsScreen })));
const PullCommitsScreen = lazy(() => import('../screens/pull-commits/PullCommitsScreen').then((module) => ({ default: module.PullCommitsScreen })));
const StashesScreen = lazy(() => import('../screens/stashes/StashesScreen').then((module) => ({ default: module.StashesScreen })));
const CherryPickScreen = lazy(() => import('../screens/cherry-pick/CherryPickScreen').then((module) => ({ default: module.CherryPickScreen })));
const DuplicateCommitScreen = lazy(() => import('../screens/duplicate-commit/DuplicateCommitScreen').then((module) => ({ default: module.DuplicateCommitScreen })));
const EditCommitScreen = lazy(() => import('../screens/edit-commit/EditCommitScreen').then((module) => ({ default: module.EditCommitScreen })));
const BranchesScreen = lazy(() => import('../screens/branches/BranchesScreen').then((module) => ({ default: module.BranchesScreen })));
const WorkingChangesScreen = lazy(() => import('../screens/working-changes/WorkingChangesScreen').then((module) => ({ default: module.WorkingChangesScreen })));
const AppSettingsScreen = lazy(() => import('../screens/settings/AppSettingsScreen').then((module) => ({ default: module.AppSettingsScreen })));
const CommitGraphScreen = lazy(() => import('../screens/commit-graph/CommitGraphScreen').then((module) => ({ default: module.CommitGraphScreen })));
const E2eScreen = lazy(() => import('../screens/e2e/E2eScreen').then((module) => ({ default: module.E2eScreen })));
const BoardScreen = lazy(() => import('../screens/board/BoardScreen').then((module) => ({ default: module.BoardScreen })));
const DesignScreen = lazy(() => import('../screens/design/DesignScreen').then((module) => ({ default: module.DesignScreen })));
const DiagramScreen = lazy(() => import('../screens/diagram/DiagramScreen').then((module) => ({ default: module.DiagramScreen })));
const ExplorerScreen = lazy(() => import('../screens/explorer/ExplorerScreen').then((module) => ({ default: module.ExplorerScreen })));
const ProjectsScreen = lazy(() => import('../screens/projects/ProjectsScreen').then((module) => ({ default: module.ProjectsScreen })));
const PullRequestsScreen = lazy(() => import('../screens/pull-requests/PullRequestsScreen').then((module) => ({ default: module.PullRequestsScreen })));
const AiAgentScreen = lazy(() => import('../screens/ai-agent/AiAgentScreen').then((module) => ({ default: module.AiAgentScreen })));
const ReleasesScreen = lazy(() => import('../screens/releases/ReleasesScreen').then((module) => ({ default: module.ReleasesScreen })));
const IssuesScreen = lazy(() => import('../screens/issues/IssuesScreen').then((module) => ({ default: module.IssuesScreen })));
const ActionsScreen = lazy(() => import('../screens/actions/ActionsScreen').then((module) => ({ default: module.ActionsScreen })));
const InsightsScreen = lazy(() => import('../screens/insights/InsightsScreen').then((module) => ({ default: module.InsightsScreen })));
const WikiScreen = lazy(() => import('../screens/wiki/WikiScreen').then((module) => ({ default: module.WikiScreen })));
const SecurityScreen = lazy(() => import('../screens/security/SecurityScreen').then((module) => ({ default: module.SecurityScreen })));
const HomeScreen = lazy(() => import('../screens/home/HomeScreen').then((module) => ({ default: module.HomeScreen })));
import { ErrorBoundary } from './ErrorBoundary';
import './AppShell.css';

const SIDEBAR_WIDTH_KEY = 'pigry:sidebar-width';
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 420;

/** Workspace screens that show the shared AI Agent rail. Every nav menu has
 * the agent — explorer/commit-graph embed their own panel, 'ai-agent' (the
 * Copilot team) is a full-screen one, the rest share this rail. */
const AI_RAIL_SCREENS = new Set<NavId>(
  workspaceNav.map(({ id }) => id).filter(id => id !== 'explorer' && id !== 'commit-graph' && id !== 'ai-agent' && id !== 'diagram' && id !== 'design' && id !== 'board' && id !== 'e2e'),
);

/** The Tauri webview ignores target="_blank" links — route every external
 * http(s) link click to the OS default browser instead. */
function useExternalLinks() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
      const href = anchor?.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      openInBrowser(href).catch(() => {
        // not running inside the desktop app — fall back to the browser itself
        window.open(href, '_blank', 'noopener');
      });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

function ErrorBanner() {
  const { error } = useRepository();
  if (!error) return null;
  return <div className="error-banner" role="alert">{error}</div>;
}

/** Shown when the external git CLI isn't installed/on PATH — local
 * operations shell out to the user's own git, so nothing works without it. */
function GitMissingBanner() {
  const { state } = useRepository();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    gitCliStatus()
      .then((status) => {
        if (!cancelled && !status.found) setMissing(true);
      })
      .catch(() => {
        // probe failure — assume present (backend errors are surfaced elsewhere)
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!missing || state?.sshWorkspace) return null;
  return (
    <div className="git-missing-banner" role="alert">
      <strong>Git not found.</strong> PIGRY needs the external Git CLI for commits, branches and
      sync. Install it from{' '}
      <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
        git-scm.com
      </a>{' '}
      and restart the app.
    </div>
  );
}

function RebaseBanner({ screen, hasUnsavedFiles, onNavigate }: {
  screen: NavId;
  hasUnsavedFiles: boolean;
  onNavigate: (screen: NavId) => void;
}) {
  const { repository, busy, abortRebase, continueCommitEdit } = useRepository();
  if (!repository?.rebaseInProgress) return null;
  const edit = repository.commitEdit;
  if (edit) {
    const conflicts = repository.files.some(file => file.status === 'C');
    const unstaged = repository.files.some(file => !file.staged && !file.untracked);
    const staged = repository.files.some(file => file.staged);
    return (
      <div className="rebase-banner rebase-banner--edit" role="region" aria-label="Commit edit in progress">
        <span role="status">
          <strong>{edit.editing ? 'Editing' : 'Replaying'} {edit.oid.slice(0, 7)} on {edit.branch}</strong>
          {' · '}
          {conflicts ? 'Resolve and stage conflicts to continue.' : 'Save your files in Explorer, then stage the changes to include.'}
        </span>
        <div className="rebase-banner__actions">
          {screen !== 'explorer' && (
            <button type="button" className="settings__btn settings__btn--small" onClick={() => onNavigate('explorer')} disabled={busy}>
              Open Explorer
            </button>
          )}
          {screen !== 'working-changes' && (
            <button
              type="button"
              className="settings__btn settings__btn--small"
              onClick={() => onNavigate('working-changes')}
              disabled={busy || hasUnsavedFiles}
            >
              Working changes
            </button>
          )}
          {screen !== 'explorer' && (
            <button
              type="button"
              className="settings__btn settings__btn--primary settings__btn--small"
              disabled={busy || conflicts || unstaged || hasUnsavedFiles}
              onClick={() => void continueCommitEdit()}
            >
              {edit.editing && staged ? 'Save and continue' : 'Continue rebase'}
            </button>
          )}
          <button
            type="button"
            className="settings__btn settings__btn--small"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Abort the edit and restore the original branch? Tracked changes made during the edit will be discarded.')) {
                void abortRebase();
              }
            }}
          >
            <Undo2 size={11} /> Abort edit
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="rebase-banner" role="alert">
      <span>
        A rebase is in progress on <strong>{repository.currentBranch}</strong> — resolve conflicts
        and continue in a terminal, or abort to restore the branch.
      </span>
      <button type="button" className="settings__btn settings__btn--small" onClick={() => void abortRebase()} disabled={busy}>
        <Undo2 size={11} />
        Abort rebase
      </button>
    </div>
  );
}

function renderScreen(
  screen: NavId,
  explorerOpenPath: string | null,
  startRebase: (oid: string) => void,
  focusCommit: string | null,
  jumpToCommit: (oid: string) => void,
  openFilePalette: () => void,
  terminalOpen: boolean,
  onToggleTerminal: () => void,
  editorCallbacks: {
    onEditorStatus?: (status: EditorStatusInfo | null) => void;
    onUnsavedFilesChange: (unsaved: boolean) => void;
  },
) {
  switch (screen) {
    case 'working-changes':
      return <WorkingChangesScreen />;
    case 'merge-branch':
      return <MergeBranchScreen />;
    case 'compare-branch':
      return <CompareBranchScreen />;
    case 'rebase-branch':
      return <RebaseBranchScreen />;
    case 'push-commits':
      return <PushCommitsScreen />;
    case 'pull-commits':
      return <PullCommitsScreen />;
    case 'stashes':
      return <StashesScreen />;
    case 'cherry-pick':
      return <CherryPickScreen />;
    case 'duplicate-commit':
      return <DuplicateCommitScreen />;
    case 'edit-commit':
      return <EditCommitScreen />;
    case 'branches':
      return <BranchesScreen />;
    case 'commit-graph':
      return <CommitGraphScreen onStartRebase={startRebase} focusCommit={focusCommit} />;
    case 'explorer':
      return (
        <ExplorerScreen
          openPath={explorerOpenPath}
          onJumpToCommit={jumpToCommit}
          onOpenFilePalette={openFilePalette}
          terminalOpen={terminalOpen}
          onToggleTerminal={onToggleTerminal}
          {...editorCallbacks}
        />
      );
    case 'projects':
      return <ProjectsScreen />;
    case 'pull-requests':
      return <PullRequestsScreen />;
    case 'board':
      return <BoardScreen />;
    case 'e2e':
      return <E2eScreen />;
    case 'design':
      return <DesignScreen />;
    case 'diagram':
      return <DiagramScreen />;
    case 'ai-agent':
      return <AiAgentScreen />;
    case 'releases':
      return <ReleasesScreen />;
    case 'issues':
      return <IssuesScreen />;
    case 'actions':
      return <ActionsScreen />;
    case 'insights':
      return <InsightsScreen />;
    case 'wiki':
      return <WikiScreen />;
    case 'security':
      return <SecurityScreen />;
    default:
      return null;
  }
}

function AppShellInner() {
  useExternalLinks();
  const [screen, setScreen] = useState<NavId>(() => {
    try {
      const stored = localStorage.getItem('pigry:default-screen');
      if (stored === 'explorer' || stored === 'commit-graph' || stored === 'working-changes') {
        return stored;
      }
    } catch {
      // storage unavailable — default
    }
    return 'explorer';
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [visitedAgentScreens, setVisitedAgentScreens] = useState<NavId[]>([]);
  const keepAgentScreen = screen === 'explorer' || screen === 'ai-agent' || screen === 'commit-graph' || screen === 'diagram' || screen === 'design' || screen === 'board' || screen === 'e2e';
  // Adjusting state while rendering (not in an effect) keeps visited screens mounted without a cascading render.
  if (keepAgentScreen && !visitedAgentScreens.includes(screen)) setVisitedAgentScreens([...visitedAgentScreens, screen]);
  // Section the settings page should open on (null = default). Set by
  // TitleBar account actions like "Add account" so users land on the
  // Accounts section instead of the Appearance section.
  const [settingsSection, setSettingsSection] = useState<'accounts' | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const [paletteFilesRequest, setPaletteFilesRequest] = useState<{
    id: number;
    files: string[];
  } | null>(null);
  const [filesRequestId, setFilesRequestId] = useState(0);
  const [explorerOpenPath, setExplorerOpenPath] = useState<string | null>(null);
  // diagram_open (agent tool) asks the shell to show the Diagram editor.
  useEffect(() => {
    const onOpenDiagram = () => setScreen('diagram');
    const onOpenDesign = () => setScreen('design');
    const onOpenBoard = () => setScreen('board');
    const onOpenE2e = () => setScreen('e2e');
    window.addEventListener('pigry:open-diagram', onOpenDiagram);
    window.addEventListener('pigry:open-design', onOpenDesign);
    window.addEventListener('pigry:open-board', onOpenBoard);
    window.addEventListener('pigry:open-e2e', onOpenE2e);
    return () => {
      window.removeEventListener('pigry:open-diagram', onOpenDiagram);
      window.removeEventListener('pigry:open-design', onOpenDesign);
      window.removeEventListener('pigry:open-board', onOpenBoard);
      window.removeEventListener('pigry:open-e2e', onOpenE2e);
    };
  }, []);
  // Chat panels without their own navigation (e.g. the Copilot page) ask the
  // shell to open a file link in the Explorer.
  useEffect(() => {
    const onGoto = (event: Event) => {
      const { path, line } = (event as CustomEvent<{ path: string; line?: number }>).detail;
      setScreen('explorer');
      setExplorerOpenPath(path);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('pigry:open-file', { detail: { path, line } })), 400);
    };
    window.addEventListener('pigry:goto-file', onGoto);
    return () => window.removeEventListener('pigry:goto-file', onGoto);
  }, []);
  const [recentlyOpened, setRecentlyOpened] = useState<string[]>([]);
  const [paletteSeed, setPaletteSeed] = useState('');
  // Left side bar folds away — default open, remembered across restarts.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem('pigry:sidebar-collapsed') !== '1';
    } catch {
      return true;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState<number | undefined>(() => {
    try {
      const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      if (width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) return width;
    } catch {
      // Storage may be unavailable.
    }
    return undefined;
  });
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      if (sidebarWidth === undefined) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Storage may be unavailable.
    }
  }, [sidebarWidth]);
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const [rebaseBase, setRebaseBase] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Live info of the focused editor — merged into the single status bar.
  const [editorStatus, setEditorStatus] = useState<EditorStatusInfo | null>(null);
  const [hasUnsavedFiles, setHasUnsavedFiles] = useState(false);
  // Shared AI Agent rail — shown on the workspace screens listed above.
  // One instance, so chats persist while hopping between those screens.
  const [railOpen, setRailOpen] = useState(false);
  const [railWidth, setRailWidth] = useState(340);
  const repository = useRepository();
  const { mode } = repository;
  const readyReported = useRef(false);
  useEffect(() => {
    if (!repository.state || readyReported.current) return;
    readyReported.current = true;
    // Wait until Home's deferred module has rendered, rather than measuring only the shell.
    const observer = new MutationObserver(() => {
      if (document.querySelector('.home__card')) {
        observer.disconnect(); void reportValidationReady().catch(() => {});
      }
    });
    if (document.querySelector('.home__card')) void reportValidationReady().catch(() => {});
    else observer.observe(document.getElementById('root')!, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, [repository.state]);
  // The landing screen (repository picker) shows at startup; "Go home"
  // re-opens it mid-session while the workspace stays loaded behind it.
  const [showHome, setShowHome] = useState(() => mode === 'tauri');
  const [homeWorkspace, setHomeWorkspace] = useState<'local' | 'server'>('local');
  // Active path at the moment Home was entered; opening a *different*
  // repository from the picker dismisses it (cancel and watcher refreshes
  // keep the same path, so they don't).
  const homePathRef = useRef<string | null>(repository.state?.activePath ?? null);

  useEffect(() => {
    if (!showHome) return;
    homePathRef.current = repository.state?.activePath ?? null;
    // Snapshot only when Home is entered — activePath at that moment is the
    // baseline the dismissal effect compares against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHome]);

  useEffect(() => {
    if (!showHome) return;
    const path = repository.state?.activePath ?? null;
    if (path !== null && path !== homePathRef.current) setShowHome(false);
  }, [repository.state, showHome]);

  useEffect(() => {
    try {
      localStorage.setItem('pigry:sidebar-collapsed', sidebarOpen ? '0' : '1');
    } catch {
      // storage unavailable — session-only state
    }
  }, [sidebarOpen]);

  const jumpToCommit = useCallback((oid: string) => {
    setFocusCommit(oid);
    setScreen('commit-graph');
  }, []);

  // The Board's code cards open their commit in the Commit graph.
  useEffect(() => {
    const onGotoCommit = (event: Event) => jumpToCommit((event as CustomEvent<{ oid: string }>).detail.oid);
    window.addEventListener('pigry:goto-commit', onGotoCommit);
    return () => window.removeEventListener('pigry:goto-commit', onGotoCommit);
  }, [jumpToCommit]);

  // App Settings (gh sign-in) can pop the integrated terminal open.
  useEffect(() => {
    const onToggle = () => setTerminalOpen((open) => !open);
    window.addEventListener('pigry:toggle-terminal', onToggle);
    const show = () => setTerminalOpen(true);
    window.addEventListener('pigry:show-terminal', show);
    return () => {
      window.removeEventListener('pigry:toggle-terminal', onToggle);
      window.removeEventListener('pigry:show-terminal', show);
    };
  }, []);

  // Editor reports its active file so the palette's '@' symbol search knows
  // which file to scan.
  useEffect(() => {
    const onActiveEditor = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string | null }>).detail;
      setActiveEditorPath(detail?.path ?? null);
    };
    window.addEventListener('pigry:active-editor', onActiveEditor);
    return () => window.removeEventListener('pigry:active-editor', onActiveEditor);
  }, []);

  const readFileForPalette = useCallback(
    (path: string) =>
      readWorktreeFile(path)
        .then((content) => (content.binary || content.tooLarge ? '' : content.content))
        .catch(() => ''),
    [],
  );

  const navigate = useCallback((next: NavId) => {
    setScreen(next);
  }, []);

  // Integrated terminal lives inside the Explorer editor layout.
  const toggleTerminal = useCallback(() => {
    setTerminalOpen((open) => !open);
    setScreen((current) => {
      if (current !== 'explorer') {
        setTerminalOpen(true);
        return 'explorer' as NavId;
      }
      return current;
    });
  }, []);

  // Ctrl/Cmd+K toggles the command palette; Ctrl/Cmd+P opens file search;
  // Ctrl/Cmd+, opens repository settings; Ctrl/Cmd+/ shows the shortcut sheet;
  // Ctrl/Cmd+` toggles the integrated terminal; Ctrl/Cmd+1..3 jumps screens.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cmd = event.ctrlKey || event.metaKey;
      if (!cmd) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteSeed('');
        setPaletteMode('quick');
        setPaletteOpen((open) => !open);
      } else if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        setPaletteSeed('');
        setPaletteMode('commands');
        setPaletteOpen(true);
      } else if (key === 'p') {
        event.preventDefault();
        setPaletteSeed('');
        setPaletteMode('files');
        setFilesRequestId((id) => id + 1);
        setPaletteOpen(true);
      } else if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === '/') {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      } else if (key === 'g' && !event.shiftKey) {
        // VS Code-style Go to Line/Column.
        event.preventDefault();
        setPaletteSeed(':');
        setPaletteMode('quick');
        setPaletteOpen(true);
      } else if (event.shiftKey && key === 'f') {
        // VS Code-style Search for Text.
        event.preventDefault();
        setScreen('explorer');
        setPaletteSeed('');
        setPaletteMode('quick');
        setPaletteOpen(false);
        window.setTimeout(
          () => window.dispatchEvent(new CustomEvent('pigry:focus-file-search')),
          150,
        );
      } else if (event.shiftKey && key === 'o') {
        // VS Code-style Go to Symbol in Editor.
        event.preventDefault();
        setPaletteSeed('@');
        setPaletteMode('quick');
        setPaletteOpen(true);
      } else if (key === 't') {
        // VS Code-style Go to Symbol in Workspace.
        event.preventDefault();
        setPaletteSeed('#');
        setPaletteMode('quick');
        setPaletteOpen(true);
      } else if (key === 'b') {
        // VS Code-style toggle of the primary side bar.
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (event.code === 'Backquote') {
        // VS Code-style integrated terminal: Ctrl+` toggles the panel,
        // Ctrl+Shift+` spawns a new terminal session.
        event.preventDefault();
        if (event.shiftKey) window.dispatchEvent(new CustomEvent('pigry:terminal-new'));
        else toggleTerminal();
      } else if (key === '1') {
        event.preventDefault();
        setScreen('working-changes');
      } else if (key === '2') {
        event.preventDefault();
        setScreen('commit-graph');
      } else if (key === '3') {
        event.preventDefault();
        setScreen('explorer');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleTerminal]);

  // Files are (re)loaded each time file-search mode is entered; the request
  // id marks which load is current.
  useEffect(() => {
    if ((paletteMode !== 'files' && paletteMode !== 'quick') || !paletteOpen) return;
    let cancelled = false;
    getFileTree()
      .then((tree) => {
        if (!cancelled) setPaletteFilesRequest({ id: filesRequestId, files: tree.entries });
      })
      .catch(() => {
        if (!cancelled) setPaletteFilesRequest({ id: filesRequestId, files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, paletteMode, filesRequestId]);

  const handleOpenFile = useCallback(
    (path: string) => {
      setScreen('explorer');
      setExplorerOpenPath(path);
      setRecentlyOpened((recent) => [
        path,
        ...recent.filter((item) => item !== path),
      ].slice(0, 8));
    },
    [],
  );

  const handleSwitchToFiles = useCallback(() => {
    setPaletteMode('files');
    setFilesRequestId((id) => id + 1);
  }, []);

  const handleOpenFilePalette = useCallback(() => {
    setPaletteMode('files');
    setFilesRequestId((id) => id + 1);
    setPaletteOpen(true);
  }, []);

  const commands = useMemo(
    () =>
      buildCommands({
        navigate,
        activeScreen: screen,
        repository: repository as RepositoryContextValue,
        openSettings: () => setSettingsOpen(true),
        openShortcuts: () => setShortcutsOpen(true),
        connectSsh: () => {
          setHomeWorkspace('server');
          setShowHome(true);
          if (screen === 'app-settings') setScreen('explorer');
        },
      }),
    [navigate, screen, repository],
  );

  const showWorkspace = repository.repository !== null;
  // The app settings page replaces the whole body — remember where to go back.
  const [prevScreen, setPrevScreen] = useState<NavId>('explorer');
  useEffect(() => {
    if (screen === 'app-settings') return;
    const t = window.setTimeout(() => setPrevScreen(screen), 0);
    return () => window.clearTimeout(t);
  }, [screen]);

  return (
    <div className="app-shell">
      <TitleBar
        onGoHome={() => {
          setHomeWorkspace('local');
          setShowHome(true);
        }}
        onOpenSettings={(section) => {
          setSettingsSection(section ?? null);
          setScreen('app-settings');
        }}
        onOpenPalette={() => {
          setPaletteSeed('');
          setPaletteMode('quick');
          setPaletteOpen(true);
        }}
      />
      <GitMissingBanner />
      <ErrorBoundary><Suspense fallback={<div className="screen-loading" role="status">Loading…</div>}>
      {screen === 'app-settings' && (
        // The app settings page is repo-agnostic — it takes over the whole
        // body from wherever it was opened (workspace or Home picker).
        <main className="app-shell__workspace app-shell__workspace--full">
          <AppSettingsScreen
            key={settingsSection ?? 'default'}
            initialSection={settingsSection ?? undefined}
            onBack={() => {
              setSettingsSection(null);
              setScreen(prevScreen);
            }}
          />
        </main>
      )}
        <div style={{ display: screen === 'app-settings' ? 'none' : 'contents' }}>
          {(showHome || !repository.repository) && (
            <HomeScreen
              workspaceType={homeWorkspace}
              onWorkspaceTypeChange={setHomeWorkspace}
              onBackToWorkspace={
                repository.repository ? () => setShowHome(false) : undefined
              }
            />
          )}
          {!showHome && showWorkspace && (
            <>
              <div className="app-shell__body">
                {sidebarOpen ? (
                  <>
                    <NavSidebar
                      ref={sidebarRef}
                      width={sidebarWidth}
                      activeScreen={screen}
                      onNavigate={setScreen}
                      onOpenSettings={() => setSettingsOpen(true)}
                      onCollapse={() => setSidebarOpen(false)}
                    />
                    <ResizeHandle
                      orientation="v"
                      label="Resize workspace sidebar"
                      onDelta={(dx) => {
                        const width = sidebarRef.current?.offsetWidth;
                        if (width !== undefined) {
                          setSidebarWidth((current) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, (current ?? width) + dx)));
                        }
                      }}
                      onReset={() => setSidebarWidth(undefined)}
                    />
                  </>
                ) : (
                  <button
                    type="button"
                    className="sidebar-strip"
                    aria-label="Show side bar"
                    title="Show side bar (Ctrl+B)"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <ChevronsRight size={14} strokeWidth={1.5} />
                  </button>
                )}
                <main className="app-shell__workspace">
                  <RebaseBanner screen={screen} hasUnsavedFiles={hasUnsavedFiles} onNavigate={navigate} />
                  <ErrorBanner />
                  {[...new Set([...visitedAgentScreens, screen])].filter((id) => id !== 'app-settings').map((id) => (
                    <div
                      key={`${repository.repository?.localPath}:${repository.repository?.currentBranch}:${id}`}
                      style={{ display: id === screen ? 'contents' : 'none' }}
                    >
                      <ErrorBoundary>
                        <Suspense fallback={<div className="screen-loading" role="status">Loading workspace…</div>}>
                          {renderScreen(id, explorerOpenPath, setRebaseBase, focusCommit, jumpToCommit, handleOpenFilePalette, terminalOpen, toggleTerminal, {
                            onEditorStatus: id === screen ? setEditorStatus : undefined,
                            onUnsavedFilesChange: setHasUnsavedFiles,
                          })}
                        </Suspense>
                      </ErrorBoundary>
                    </div>
                  ))}
                </main>
                {AI_RAIL_SCREENS.has(screen) && railOpen && (
                  <ResizeHandle
                    orientation="v"
                    label="Resize AI panel"
                    onDelta={(dx) => setRailWidth((w) => Math.min(window.innerWidth * 0.65, Math.max(280, w - dx)))}
                  />
                )}
                {AI_RAIL_SCREENS.has(screen) &&
                  (railOpen ? (
                    <AiAgentPanel
                      width={railWidth}
                      fileName={repository.repository?.name ?? 'pigry'}
                      defaultTeam={teamForScreen(screen)}
                      onCollapse={() => setRailOpen(false)}
                      onOpenFile={(path, line) => {
                        setScreen('explorer');
                        setExplorerOpenPath(path);
                        // The explorer mounts with the file open; the line
                        // reveal is applied by its open-file listener once
                        // the editor is ready.
                        window.setTimeout(
                          () =>
                            window.dispatchEvent(
                              new CustomEvent('pigry:open-file', { detail: { path, line } }),
                            ),
                          400,
                        );
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ai-rail-strip"
                      title="Show AI Agent panel"
                      onClick={() => setRailOpen(true)}
                    >
                      <ChevronLeft size={14} strokeWidth={1.5} />
                      <span>AI Agent</span>
                    </button>
                  ))}
              </div>
              <StatusBar editorStatus={editorStatus} terminalOpen={terminalOpen} onToggleTerminal={toggleTerminal}
                onDisconnectSsh={() => {
                  if (hasUnsavedFiles) {
                    repository.notify('Save or close unsaved files before disconnecting.', 'error');
                    return;
                  }
                  void repository.closeRepository().then((closed) => {
                    if (closed) setShowHome(true);
                  });
                }} />
            </>
          )}
        </div>
      {paletteOpen && (
        <CommandPalette
          mode={paletteMode}
          commands={commands}
          files={
            paletteFilesRequest && paletteFilesRequest.id === filesRequestId
              ? paletteFilesRequest.files
              : []
          }
          filesLoading={
            paletteFilesRequest?.id !== filesRequestId &&
            (paletteMode === 'files' || paletteMode === 'quick')
          }
          onOpenFile={handleOpenFile}
          onSwitchToFiles={handleSwitchToFiles}
          onSwitchToCommands={() => setPaletteMode('commands')}
          recentlyOpened={recentlyOpened}
          activeEditorPath={activeEditorPath}
          readFile={readFileForPalette}
          onSearchText={(searchQuery) => {
            setScreen('explorer');
            window.setTimeout(
              () => window.dispatchEvent(new CustomEvent('pigry:focus-file-search', { detail: { query: searchQuery } })),
              150,
            );
          }}
          initialQuery={paletteSeed}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} notify={repository.notify} />
      )}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
      {rebaseBase && <RebaseModal baseOid={rebaseBase} onClose={() => setRebaseBase(null)} />}
      <ToastContainer toasts={repository.toasts} />
      </Suspense></ErrorBoundary>
    </div>
  );
}

export function AppShell() {
  return (
    <RepositoryProvider>
      <AppShellInner />
    </RepositoryProvider>
  );
}
