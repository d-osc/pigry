import {
  ChevronDown,
  CircleUserRound,
  FolderOpen,
  GitFork,
  LogIn,
  LogOut,
  Minus,
  Search,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRepository } from '../hooks/useRepository';
import { PigryMark } from './PigryMark';
import { isMac } from '../lib/platform';
import { ghAccountList, ghAuthStatus, ghLogout, ghSwitchAccount, isTauri } from '../lib/tauriClient';
import { updateGhProfileFromAccounts } from '../lib/ghProfile';
import type { GhAccount } from '../types/repository';
import './TitleBar.css';

const RECENT_REPOS_KEY = 'pigry:recent-repos';

const initialsOf = (name: string) => name.slice(0, 2).toUpperCase() || 'U';

interface TitleBarProps {
  onOpenPalette: () => void;
  /** Goes to the home screen (Explorer). */
  onGoHome: () => void;
  /** Opens the repository settings modal (profile menu). */
  /** Opens app settings; pass a section id to land there (account actions
   * use the Accounts section). */
  onOpenSettings: (section?: 'accounts') => void;
}

export function TitleBar({ onOpenPalette, onGoHome, onOpenSettings }: TitleBarProps) {
  const nativeControls = isMac && isTauri();
  const { repository, openRepository, pickRepository, notify } = useRepository();

  const withWindow = async (action: (win: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    startDragging: () => void;
  }) => void | Promise<void>) => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await action(getCurrentWindow());
    } catch (error) {
      notify('Window action failed: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  };

  // Native-style title-bar context menu (right-click).
  const [winMenu, setWinMenu] = useState<{ x: number; y: number } | null>(null);
  const winMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!winMenu) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (winMenuRef.current?.contains(event.target as Node)) return;
      setWinMenu(null);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [winMenu]);

  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [recentRepos, setRecentRepos] = useState<Array<{ name: string; path: string }>>(
    () => {
      try {
        return JSON.parse(localStorage.getItem(RECENT_REPOS_KEY) ?? '[]') as Array<{
          name: string;
          path: string;
        }>;
      } catch {
        return [];
      }
    },
  );

  // Remember every repository as it gets opened (newest first, max 8).
  useEffect(() => {
    if (!repository) return;
    const entry = { name: repository.name, path: repository.localPath };
    const t = window.setTimeout(() => {
      setRecentRepos((prev) => {
        const next = [entry, ...prev.filter((repo) => repo.path !== entry.path)].slice(0, 8);
        if (prev.length === next.length && prev.every((repo, i) => repo.path === next[i].path)) {
          return prev;
        }
        try {
          localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next));
        } catch {
          // storage unavailable — the in-session list still works
        }
        return next;
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [repository]);

  // App-level sign-in state (local Git client — persisted locally).
  const [signedIn, setSignedIn] = useState(() => {
    try {
      return localStorage.getItem('pigry:signed-in') === '1';
    } catch {
      return false;
    }
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const profileWrapRef = useRef<HTMLSpanElement | null>(null);
  const repoNavRef = useRef<HTMLElement | null>(null);
  const repoMenuOpenRef = useRef(false);
  const [ghAccounts, setGhAccounts] = useState<GhAccount[]>([]);
  const activeAccount = ghAccounts.find((account) => account.active);
  const activeGh = activeAccount?.name ?? '';
  const activeAvatar = activeAccount?.avatarUrl ?? '';

  const markSignedIn = (value: boolean) => {
    try {
      if (value) localStorage.setItem('pigry:signed-in', '1');
      else localStorage.removeItem('pigry:signed-in');
    } catch {
      // storage unavailable — session-only sign-in
    }
    setSignedIn(value);
    window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
  };

  const refreshAccounts = () => {
    ghAccountList()
      .then((list) => {
        setGhAccounts(list);
        // Keep the shared profile cache fresh for every other screen.
        updateGhProfileFromAccounts(list);
        const active = list.find((account) => account.active);
        if (active) markSignedIn(true);
      })
      .catch(() => setGhAccounts([]));
  };

  const toggleProfile = () => {
    const next = !profileOpen;
    setProfileOpen(next);
    if (next) refreshAccounts();
  };

  // Sign in: gh already logged in on this machine → just mark it; otherwise
  // send the user to Settings → Personal access token (token or terminal flow).
  const signIn = async () => {
    try {
      const status = await ghAuthStatus();
      if (status.loggedIn) {
        markSignedIn(true);
        setProfileOpen(false);
        notify('Signed in as ' + (status.account || 'gh account'), 'success');
        return;
      }
    } catch {
      // gh missing — fall through to Settings
    }
    setProfileOpen(false);
    onOpenSettings('accounts');
    notify('Sign in via gh in Settings → Personal access token', 'success');
  };

  // Real gh logout for the active account (also clears the local flag).
  const signOut = async () => {
    setProfileOpen(false);
    const active = ghAccounts.find((account) => account.active);
    if (active) {
      try {
        await ghLogout(active.name);
        notify('Signed out of ' + active.name, 'success');
      } catch {
        notify('gh logout failed', 'error');
      }
    } else {
      notify('Signed out', 'success');
    }
    markSignedIn(false);
    refreshAccounts();
  };

  // A second login adds another account (gh supports multiple): send the user
  // to the token/terminal flow in Settings.
  const addAccount = () => {
    setProfileOpen(false);
    onOpenSettings('accounts');
    notify('Add an account: save a token or run gh auth login --web', 'success');
  };

  const switchAccount = async (name: string) => {
    try {
      await ghSwitchAccount(name);
      notify('Switched to ' + name, 'success');
      refreshAccounts();
    } catch {
      notify('gh switch failed', 'error');
    }
  };

  // The App Settings page can flip auth too — stay in sync.
  useEffect(() => {
    const onAuth = () => {
      try {
        setSignedIn(localStorage.getItem('pigry:signed-in') === '1');
      } catch {
        // ignore
      }
    };
    window.addEventListener('pigry:auth-changed', onAuth);
    return () => window.removeEventListener('pigry:auth-changed', onAuth);
  }, []);

  // Check the real gh auth state at launch (and whenever the window regains
  // focus) so the account button reflects the machine — the localStorage flag
  // alone can go stale, e.g. after signing in or out from another app.
  useEffect(() => {
    if (!isTauri()) return;
    const check = () => {
      refreshAccounts();
      ghAuthStatus()
        .then((status) => setSignedIn(status.loggedIn))
        .catch(() => setSignedIn(false));
    };
    const t = window.setTimeout(check, 0);
    window.addEventListener('focus', check);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('focus', check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click anywhere outside a dropdown closes it (capture phase wins over any
  // stacking-context quirk — overlays alone proved unreliable in the webview).
  useEffect(() => {
    if (!profileOpen && !repoMenuOpenRef.current) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (profileOpen && profileWrapRef.current?.contains(target)) return;
      if (repoMenuOpenRef.current && repoNavRef.current?.contains(target)) return;
      setProfileOpen(false);
      setRepoMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [profileOpen]);

  useEffect(() => {
    repoMenuOpenRef.current = repoMenuOpen;
  }, [repoMenuOpen]);

  const openRepoFromMenu = (path: string) => {
    setRepoMenuOpen(false);
    if (path !== repository?.localPath) void openRepository(path);
  };

  return (
    <header
      className={nativeControls ? 'title-bar title-bar--macos' : 'title-bar'}
      onContextMenu={(event) => {
        if (nativeControls) return;
        event.preventDefault();
        setWinMenu({ x: event.clientX, y: event.clientY });
      }}
      onMouseDown={(event) => {
        // Native title-bar behavior: press-and-hold on any non-control area
        // drags the window. Interactive controls keep their clicks.
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, input, a, [data-no-drag]')) return;
        withWindow((win) => win.startDragging());
      }}
    >
      {/* Drag region: the whole bar except interactive controls */}
      <div className="title-bar__drag" data-tauri-drag-region aria-hidden="true" />

      <button
        type="button"
        className="title-bar__brand title-bar__brand--home"
        title="Home — switch repository"
        aria-label="Go home"
        onClick={onGoHome}
      >
        <span className="title-bar__logo" aria-hidden="true">
          <PigryMark size={20} />
        </span>
        <span className="title-bar__name">PIGRY</span>
        <span className="title-bar__beta">GIT</span>
      </button>

      {repository && (
        <nav
          ref={repoNavRef}
          className="title-bar__breadcrumb"
          aria-label="Repository"
        >
          <button
            type="button"
            className="title-bar__repo-switch"
            title="Switch repository"
            aria-haspopup="menu"
            aria-expanded={repoMenuOpen}
            onClick={() => setRepoMenuOpen((open) => !open)}
          >
            <GitFork size={16} className="title-bar__repo-icon" strokeWidth={1.25} />
            {repository.organization && (
              <span className="title-bar__org">{repository.organization}</span>
            )}
            {repository.organization && (
              <span className="title-bar__sep">/</span>
            )}
            <span className="title-bar__repo">{repository.name}</span>
            <ChevronDown
              size={12}
              className={`title-bar__chevron${repoMenuOpen ? ' title-bar__chevron--open' : ''}`}
              strokeWidth={1.25}
            />
            {repository.visibility && (
              <span className="title-bar__visibility">{repository.visibility}</span>
            )}
          </button>

          {repoMenuOpen && (
            <>
              <div
                className="repo-menu"
                role="menu"
                aria-label="Recent repositories"
                onClick={() => setRepoMenuOpen(false)}
              >
                <p className="repo-menu__label">Recent repositories</p>
                {recentRepos.length === 0 && (
                  <p className="repo-menu__empty">No recent repositories yet</p>
                )}
                {recentRepos.map((repo) => (
                  <button
                    key={repo.path}
                    type="button"
                    role="menuitem"
                    className={`repo-menu__item${repo.path === repository.localPath ? ' repo-menu__item--current' : ''}`}
                    onClick={() => openRepoFromMenu(repo.path)}
                  >
                    <GitFork size={13} strokeWidth={1.25} />
                    <span className="repo-menu__name">{repo.name}</span>
                    <span className="repo-menu__path" title={repo.path}>
                      {repo.path}
                    </span>
                  </button>
                ))}
                <div className="repo-menu__sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="repo-menu__item"
                  onClick={() => {
                    setRepoMenuOpen(false);
                    void pickRepository();
                  }}
                >
                  <FolderOpen size={13} strokeWidth={1.25} />
                  <span className="repo-menu__name">Open new repository…</span>
                </button>
              </div>
            </>
          )}
        </nav>
      )}

      <div className="title-bar__center">
        <button
          type="button"
          className="command-search"
          onClick={onOpenPalette}
          aria-label="Open command palette"
        >
          <Search size={14} className="command-search__icon" strokeWidth={1.25} />
          <span className="command-search__input">Search or jump to…</span>
          <kbd className="command-search__kbd">⌘ K</kbd>
        </button>

        <span ref={profileWrapRef} className="profile-wrap">
          <button
            type="button"
            className={`profile-button${profileOpen ? ' profile-button--open' : ''}`}
            aria-label="Account"
            title="Account"
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            onClick={toggleProfile}
          >
            {signedIn && activeAvatar ? (
              <img className="profile-button__img" src={activeAvatar} alt="" />
            ) : (
              <CircleUserRound size={17} strokeWidth={1.25} />
            )}
          </button>

          {profileOpen && (
            <>
              <div
                className="profile-menu"
                role="menu"
                aria-label="Account"
                onClick={() => setProfileOpen(false)}
              >
                {signedIn ? (
                  <>
                    <div className="profile-menu__account">
                      {activeAvatar ? (
                        <img className="profile-menu__avatar profile-menu__avatar--img" src={activeAvatar} alt="" />
                      ) : (
                        <span className="profile-menu__avatar">
                          {initialsOf(activeGh || repository?.account.name || 'U')}
                        </span>
                      )}
                      <span className="profile-menu__who">
                        <strong>{activeAccount?.fullName || activeGh || repository?.account.name || 'Signed in'}</strong>
                        <span>{activeGh || (repository?.account.email ?? '')}</span>
                      </span>
                    </div>
                    {ghAccounts.filter((account) => !account.active).length > 0 && (
                      <>
                        <p className="profile-menu__label">Switch account</p>
                        {ghAccounts
                          .filter((account) => !account.active)
                          .map((account) => (
                            <button
                              key={account.name}
                              type="button"
                              role="menuitem"
                              className="profile-menu__item"
                              onClick={() => void switchAccount(account.name)}
                            >
                              {account.avatarUrl ? (
                                <img className="profile-menu__item-img" src={account.avatarUrl} alt="" />
                              ) : (
                                <GitFork size={13} strokeWidth={1.5} />
                              )}
                              {account.fullName || account.name}
                            </button>
                          ))}
                      </>
                    )}
                    <div className="profile-menu__sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={() => {
                        setProfileOpen(false);
                        onOpenSettings();
                      }}
                    >
                      <Settings size={13} strokeWidth={1.5} />
                      Settings
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={addAccount}
                    >
                      <CircleUserRound size={13} strokeWidth={1.5} />
                      Add account
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={() => void signOut()}
                    >
                      <LogOut size={13} strokeWidth={1.5} />
                      Sign out
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={() => {
                        setProfileOpen(false);
                        onOpenSettings();
                      }}
                    >
                      <Settings size={13} strokeWidth={1.5} />
                      Settings
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={() => void signIn()}
                    >
                      <LogIn size={13} strokeWidth={1.5} />
                      Sign in with gh
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </span>
      </div>

      <div className="title-bar__actions">
        {!nativeControls && <div className="title-bar__win-controls">
          <button
            type="button"
            className="title-bar__win-button"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => withWindow((win) => win.minimize())}
          >
            <Minus size={14} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="title-bar__win-button"
            aria-label="Maximize"
            title="Maximize / Restore"
            onClick={() => withWindow((win) => win.toggleMaximize())}
          >
            <Square size={12} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="title-bar__win-button title-bar__win-button--close"
            aria-label="Close"
            title="Close"
            onClick={() => void withWindow((win) => win.close())}
          >
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>}

        {winMenu && (
          <div
            ref={winMenuRef}
            className="title-menu"
            role="menu"
            style={{ left: winMenu.x, top: winMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="title-menu__item"
              onClick={() => {
                setWinMenu(null);
                void withWindow((win) => win.toggleMaximize());
              }}
            >
              Maximize
            </button>
            <button
              type="button"
              role="menuitem"
              className="title-menu__item"
              onClick={() => {
                setWinMenu(null);
                void withWindow((win) => win.minimize());
              }}
            >
              Minimize
            </button>
            <div className="title-menu__sep" />
            <button
              type="button"
              role="menuitem"
              className="title-menu__item title-menu__item--danger"
              onClick={() => {
                setWinMenu(null);
                void withWindow((win) => win.close());
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
