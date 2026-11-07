import { useState } from 'react';
import { TitleBar } from './TitleBar';
import { NavSidebar } from './NavSidebar';
import { StatusBar } from './StatusBar';
import type { NavId } from './navigation';
import { useRepository, RepositoryProvider } from '../hooks/useRepository';
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

function renderScreen(screen: NavId) {
  switch (screen) {
    case 'working-changes':
      return <WorkingChangesScreen />;
    case 'commit-graph':
      return <CommitGraphScreen />;
    case 'explorer':
      return <ExplorerScreen />;
    default:
      return <PlaceholderScreen screen={screen} />;
  }
}

function AppShellInner() {
  const [screen, setScreen] = useState<NavId>('working-changes');
  const { mode, repository } = useRepository();

  const showWorkspace = mode === 'tauri' && repository !== null;

  return (
    <div className="app-shell">
      <TitleBar />
      {mode === 'browser' && <BrowserNotice />}
      {mode === 'tauri' && !repository && <NoRepositoryScreen />}
      {showWorkspace && (
        <>
          <div className="app-shell__body">
            <NavSidebar activeScreen={screen} onNavigate={setScreen} />
            <main className="app-shell__workspace">
              <ErrorBanner />
              {renderScreen(screen)}
            </main>
          </div>
          <StatusBar />
        </>
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
