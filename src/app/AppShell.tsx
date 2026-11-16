import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TitleBar } from './TitleBar';
import { NavSidebar } from './NavSidebar';
import { StatusBar, type EditorStatusInfo } from './StatusBar';
import { ToastContainer } from './Toast';
import { SettingsModal } from './settings/SettingsModal';
import { RebaseModal } from './rebase/RebaseModal';
import { ShortcutSheet } from './ShortcutSheet';
import { ChevronLeft, ChevronsRight, Undo2 } from 'lucide-react';
import type { NavId } from './navigation';
import { buildCommands } from './commands';
import { CommandPalette, type PaletteMode } from './commandPalette/CommandPalette';
import { getFileTree, gitCliStatus, readWorktreeFile, reportValidationReady } from '../lib/tauriClient';
import { AiAgentPanel } from '../screens/explorer/AiAgentPanel';
import { ResizeHandle } from './ResizeHandle';
import { teamForScreen } from '../lib/agentExtras';
import {
  useRepository,
  RepositoryProvider,
  type RepositoryContextValue,
} from '../hooks/useRepository';
const MergeBranchScreen = lazy(() => import('../screens/merge-branch/MergeBranchScreen').then((module) => ({ default: module.MergeBranchScreen })));
const RebaseBranchScreen = lazy(() => import('../screens/rebase-branch/RebaseBranchScreen').then((module) => ({ default: module.RebaseBranchScreen })));
const PushCommitsScreen = lazy(() => import('../screens/push-commits/PushCommitsScreen').then((module) => ({ default: module.PushCommitsScreen })));
const StashesScreen = lazy(() => import('../screens/stashes/StashesScreen').then((module) => ({ default: module.StashesScreen })));
const CherryPickScreen = lazy(() => import('../screens/cherry-pick/CherryPickScreen').then((module) => ({ default: module.CherryPickScreen })));
const BranchesScreen = lazy(() => import('../screens/branches/BranchesScreen').then((module) => ({ default: module.BranchesScreen })));
const WorkingChangesScreen = lazy(() => import('../screens/working-changes/WorkingChangesScreen').then((module) => ({ default: module.WorkingChangesScreen })));
const AppSettingsScreen = lazy(() => import('../screens/settings/AppSettingsScreen').then((module) => ({ default: module.AppSettingsScreen })));
const CommitGraphScreen = lazy(() => import('../screens/commit-graph/CommitGraphScreen').then((module) => ({ default: module.CommitGraphScreen })));
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

/** Workspace screens that show the shared AI Agent rail. Every nav menu has
 * the agent — explorer/commit-graph embed their own panel, 'ai-agent' (the
 * Copilot team) is a full-screen one, the rest share this rail. */
const AI_RAIL_SCREENS: NavId[] = [
  'working-changes',
  'merge-branch',
  'rebase-branch',
  'push-commits',
  'stashes',
  'cherry-pick',
  'branches',
  'actions',
  'pull-requests',
  'releases',
  'issues',
  'projects',
  'wiki',
  'security',
  'insights',
];

function ErrorBanner() {
  const { error } = useRepository();
  if (!error) return null;
  return <div className="error-banner" role="alert">{error}</div>;
}

/** Shown when the external git CLI isn't installed/on PATH — local
 * operations shell out to the user's own git, so nothing works without it. */
function GitMissingBanner() {
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
  if (!missing) return null;
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

function RebaseBanner({ onAbort }: { onAbort: () => void }) {
  const { repository, busy } = useRepository();
  if (!repository?.rebaseInProgress) return null;
  return (
    <div className="rebase-banner" role="alert">
      <span>
        A rebase is in progress on <strong>{repository.currentBranch}</strong> — resolve conflicts
        and continue in a terminal, or abort to restore the branch.
      </span>
      <button type="button" className="settings__btn settings__btn--small" onClick={onAbort} disabled={busy}>
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
  onEditorStatus: (status: EditorStatusInfo | null) => void,
) {
  switch (screen) {
    case 'working-changes':
      return <WorkingChangesScreen />;
    case 'merge-branch':
      return <MergeBranchScreen />;
    case 'rebase-branch':
      return <RebaseBranchScreen />;
    case 'push-commits':
      return <PushCommitsScreen />;
    case 'stashes':
      return <StashesScreen />;
    case 'cherry-pick':
      return <CherryPickScreen />;
    case 'branches':
      return <BranchesScreen />;
    case 'commit-graph':
      return <CommitGraphScreen onStartRebase={startRebase} focusCommit={focusCommit} />;
    case 'explorer':
      return (
        <ExplorerScreen
          key={explorerOpenPath ?? 'explorer'}
          openPath={explorerOpenPath}
          onJumpToCommit={jumpToCommit}
          onOpenFilePalette={openFilePalette}
          terminalOpen={terminalOpen}
          onToggleTerminal={onToggleTerminal}
          onEditorStatus={onEditorStatus}
        />
      );
    case 'projects':
      return <ProjectsScreen />;
    case 'pull-requests':
      return <PullRequestsScreen />;
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
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const [rebaseBase, setRebaseBase] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Live info of the focused editor — merged into the single status bar.
  const [editorStatus, setEditorStatus] = useState<EditorStatusInfo | null>(null);
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

  // App Settings (gh sign-in) can pop the integrated terminal open.
  useEffect(() => {
    const onToggle = () => setTerminalOpen((open) => !open);
    window.addEventListener('pigry:toggle-terminal', onToggle);
    return () => window.removeEventListener('pigry:toggle-terminal', onToggle);
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
        onGoHome={() => setShowHome(true)}
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
      {screen === 'app-settings' ? (
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
      ) : (
        <>
          {(showHome || !repository.repository) && (
            <HomeScreen
              onBackToWorkspace={
                repository.repository ? () => setShowHome(false) : undefined
              }
            />
          )}
          {!showHome && showWorkspace && (
            <>
              <div className="app-shell__body">
                {sidebarOpen ? (
                  <NavSidebar
                    activeScreen={screen}
                    onNavigate={setScreen}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onCollapse={() => setSidebarOpen(false)}
                  />
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
                  <RebaseBanner onAbort={() => void repository.abortRebase()} />
                  <ErrorBanner />
                  <ErrorBoundary key={`${repository.repository?.localPath}:${repository.repository?.currentBranch}:${screen}`}><Suspense fallback={<div className="screen-loading" role="status">Loading workspace…</div>}>
                    {renderScreen(screen, explorerOpenPath, (oid) => setRebaseBase(oid), focusCommit, jumpToCommit, handleOpenFilePalette, terminalOpen, toggleTerminal, setEditorStatus)}
                  </Suspense></ErrorBoundary>
                </main>
                {AI_RAIL_SCREENS.includes(screen) && railOpen && (
                  <ResizeHandle
                    orientation="v"
                    label="Resize AI panel"
                    onDelta={(dx) => setRailWidth((w) => Math.min(480, Math.max(280, w - dx)))}
                  />
                )}
                {AI_RAIL_SCREENS.includes(screen) &&
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
              <StatusBar editorStatus={editorStatus} terminalOpen={terminalOpen} onToggleTerminal={toggleTerminal} />
            </>
          )}
        </>
      )}
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
