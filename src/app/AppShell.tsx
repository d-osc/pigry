import { useCallback, useEffect, useMemo, useState } from 'react';
import { TitleBar } from './TitleBar';
import { NavSidebar } from './NavSidebar';
import { StatusBar } from './StatusBar';
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

function renderScreen(screen: NavId, explorerOpenPath: string | null) {
  switch (screen) {
    case 'working-changes':
      return <WorkingChangesScreen />;
    case 'commit-graph':
      return <CommitGraphScreen />;
    case 'explorer':
      return <ExplorerScreen key={explorerOpenPath ?? 'explorer'} openPath={explorerOpenPath} />;
    default:
      return <PlaceholderScreen screen={screen} />;
  }
}

function AppShellInner() {
  const [screen, setScreen] = useState<NavId>('working-changes');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const [paletteFilesRequest, setPaletteFilesRequest] = useState<{
    id: number;
    files: string[];
  } | null>(null);
  const [filesRequestId, setFilesRequestId] = useState(0);
  const [explorerOpenPath, setExplorerOpenPath] = useState<string | null>(null);
  const repository = useRepository();
  const { mode } = repository;

  const navigate = useCallback((next: NavId) => {
    setScreen(next);
  }, []);

  // Ctrl/Cmd+K toggles the command palette; Ctrl/Cmd+P opens file search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteMode('commands');
        setPaletteOpen((open) => !open);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteMode('files');
        setFilesRequestId((id) => id + 1);
        setPaletteOpen(true);
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
      }),
    [navigate, screen, repository],
  );

  const showWorkspace = mode === 'tauri' && repository.repository !== null;

  return (
    <div className="app-shell">
      <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
      {mode === 'browser' && <BrowserNotice />}
      {mode === 'tauri' && !repository.repository && <NoRepositoryScreen />}
      {showWorkspace && (
        <>
          <div className="app-shell__body">
            <NavSidebar activeScreen={screen} onNavigate={setScreen} />
            <main className="app-shell__workspace">
              <ErrorBanner />
              {renderScreen(screen, explorerOpenPath)}
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
