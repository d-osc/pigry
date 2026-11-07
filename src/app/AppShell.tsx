import { useCallback, useEffect, useMemo, useState } from 'react';
import { TitleBar } from './TitleBar';
import { NavSidebar } from './NavSidebar';
import { StatusBar } from './StatusBar';
import { ToastContainer } from './Toast';
import { SettingsModal } from './settings/SettingsModal';
import { RebaseModal } from './rebase/RebaseModal';
import { WorkspaceBar } from './WorkspaceBar';
import { ShortcutSheet } from './ShortcutSheet';
import { Undo2 } from 'lucide-react';
import type { NavId } from './navigation';
import { buildCommands } from './commands';
import { CommandPalette, type PaletteMode } from './commandPalette/CommandPalette';
import { getFileTree } from '../lib/tauriClient';
import {
  useRepository,
  RepositoryProvider,
  type RepositoryContextValue,
} from '../hooks/useRepository';
import { WorkingChangesScreen } from '../screens/working-changes/WorkingChangesScreen';
import { CommitGraphScreen } from '../screens/commit-graph/CommitGraphScreen';
import { ExplorerScreen } from '../screens/explorer/ExplorerScreen';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { NoRepositoryScreen } from '../screens/NoRepositoryScreen';
import './AppShell.css';

function BrowserNotice() {
  return (
    <div className="no-repo">
      <div className="no-repo__card">
        <h1 className="no-repo__title">Desktop mode required</h1>
        <p className="no-repo__subtitle">
          orbit needs the Tauri desktop shell to read repositories.
          <br />
          Run <code>npm run tauri dev</code> to launch the app.
        </p>
      </div>
    </div>
  );
}

function ErrorBanner() {
  const { error } = useRepository();
  if (!error) return null;
  return <div className="error-banner" role="alert">{error}</div>;
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
) {
  switch (screen) {
    case 'working-changes':
      return <WorkingChangesScreen />;
    case 'commit-graph':
      return <CommitGraphScreen onStartRebase={startRebase} focusCommit={focusCommit} />;
    case 'explorer':
      return (
        <ExplorerScreen
          key={explorerOpenPath ?? 'explorer'}
          openPath={explorerOpenPath}
          onJumpToCommit={jumpToCommit}
        />
      );
    default:
      return <PlaceholderScreen screen={screen} />;
  }
}

function AppShellInner() {
  const [screen, setScreen] = useState<NavId>('working-changes');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const [paletteFilesRequest, setPaletteFilesRequest] = useState<{
    id: number;
    files: string[];
  } | null>(null);
  const [filesRequestId, setFilesRequestId] = useState(0);
  const [explorerOpenPath, setExplorerOpenPath] = useState<string | null>(null);
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const [rebaseBase, setRebaseBase] = useState<string | null>(null);
  const repository = useRepository();
  const { mode } = repository;

  const jumpToCommit = useCallback((oid: string) => {
    setFocusCommit(oid);
    setScreen('commit-graph');
  }, []);

  const navigate = useCallback((next: NavId) => {
    setScreen(next);
  }, []);

  // Ctrl/Cmd+K toggles the command palette; Ctrl/Cmd+P opens file search;
  // Ctrl/Cmd+, opens repository settings; Ctrl/Cmd+/ shows the shortcut sheet;
  // Ctrl/Cmd+1..3 jumps between the main screens.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cmd = event.ctrlKey || event.metaKey;
      if (!cmd) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteMode('commands');
        setPaletteOpen((open) => !open);
      } else if (key === 'p') {
        event.preventDefault();
        setPaletteMode('files');
        setFilesRequestId((id) => id + 1);
        setPaletteOpen(true);
      } else if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === '/') {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
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
  }, []);

  // Files are (re)loaded each time file-search mode is entered; the request
  // id marks which load is current.
  useEffect(() => {
    if (paletteMode !== 'files' || !paletteOpen) return;
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
    },
    [],
  );

  const handleSwitchToFiles = useCallback(() => {
    setPaletteMode('files');
    setFilesRequestId((id) => id + 1);
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

  const showWorkspace = mode === 'tauri' && repository.repository !== null;

  return (
    <div className="app-shell">
      <TitleBar onOpenPalette={() => setPaletteOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
      <WorkspaceBar />
      {mode === 'browser' && <BrowserNotice />}
      {mode === 'tauri' && !repository.repository && <NoRepositoryScreen />}
      {showWorkspace && (
        <>
          <div className="app-shell__body">
            <NavSidebar activeScreen={screen} onNavigate={setScreen} onOpenSettings={() => setSettingsOpen(true)} />
            <main className="app-shell__workspace">
              <RebaseBanner onAbort={() => void repository.abortRebase()} />
              <ErrorBanner />
              {renderScreen(screen, explorerOpenPath, (oid) => setRebaseBase(oid), focusCommit, jumpToCommit)}
            </main>
          </div>
          <StatusBar />
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
            paletteFilesRequest?.id !== filesRequestId && paletteMode === 'files'
          }
          onOpenFile={handleOpenFile}
          onSwitchToFiles={handleSwitchToFiles}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} notify={repository.notify} />
      )}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
      {rebaseBase && <RebaseModal baseOid={rebaseBase} onClose={() => setRebaseBase(null)} />}
      <ToastContainer toasts={repository.toasts} />
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
