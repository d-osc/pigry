import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, KeyRound, Loader2, LogIn, LogOut, Search, X } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import { PigryMark } from '../../app/PigryMark';
import { ghAccountList, ghAuthStatus, ghDeviceFlowPoll, ghDeviceFlowStart, ghInstall, ghLoginWithToken, ghOpenUrl, ghReleaseList, ghSwitchAccount, ghTokenScopes } from '../../lib/tauriClient';
import { check as checkUpdater } from '@tauri-apps/plugin-updater';
import { relaunch as relaunchApp } from '@tauri-apps/plugin-process';
import { readThemePreference, writeThemePreference, type ThemePreference } from '../../lib/theme';
import { ProviderManager } from './ProviderManager';
import { ImportAgentsPanel } from './ImportAgentsPanel';
import { IMPORT_AGENTS_ENABLED } from '../../lib/featureFlags';
import { InstalledExtensionsPanel } from '../extensions/InstalledExtensionsPanel';
import appPackage from '../../../package.json';
import type { GhAccount } from '../../types/repository';
import './AppSettingsScreen.css';

type DefaultScreen = 'explorer' | 'commit-graph' | 'working-changes';
export type SectionId = 'appearance' | 'text-editor' | 'ai-provider' | 'import' | 'extensions' | 'token' | 'accounts' | 'update' | 'about';
type GhStatus = 'unknown' | 'checking' | 'in' | 'out' | 'missing';

const ALL_SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'text-editor', label: 'Text Editor' },
  { id: 'ai-provider', label: 'AI Provider' },
  { id: 'import', label: 'Import agents' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'token', label: 'Personal access token' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'update', label: 'Update' },
  { id: 'about', label: 'About' },
];
/** Sections that are switched off for now (featureFlags.ts) are left out of the list and never shown. */
const SECTIONS = ALL_SECTIONS.filter((section) => section.id !== 'import' || IMPORT_AGENTS_ENABLED);

const readBool = (key: string, fallback: boolean) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
};

const SUGGESTED_SCOPES = ['repo', 'workflow', 'read:org', 'gist'];

/** GitHub classic PAT scopes relevant to pigry, rendered as checkboxes. */
/** Scopes valid for classic OAuth tokens (gh token, device flow). */
const KNOWN_SCOPES = [
  'repo',
  'repo:status',
  'security_events',
  'workflow',
  'read:org',
  'write:org',
  'admin:org',
  'gist',
  'notifications',
  'user',
  'read:user',
  'user:email',
  'read:packages',
  'write:packages',
  'delete:packages',
  'delete_repo',
  'read:repo_hook',
  'write:repo_hook',
  'admin:repo_hook',
  'read:discussion',
  'write:discussion',
  'read:gpg_key',
  'write:gpg_key',
  'read:ssh_signing_key',
  'write:ssh_signing_key',
  'codespace',
];

/** Fine-grained PAT permissions — NOT valid for the gh OAuth token. */
const PROJECT_SCOPES = ['read:project', 'write:project', 'admin:project'];

const OAUTH_SCOPES = new Set(KNOWN_SCOPES);

/** App-level settings — VS Code style editor with a section menu on the left. */
export function AppSettingsScreen({
  onBack,
  initialSection,
}: {
  onBack: () => void;
  /** Opens the page on a specific section (e.g. the token/accounts section
   * when the user came from "Add account"). */
  initialSection?: SectionId;
}) {
  const { notify } = useRepository();
  const [activeSection, setActiveSection] = useState<SectionId>(
    initialSection && SECTIONS.some((section) => section.id === initialSection) ? initialSection : 'appearance',
  );
  const [search, setSearch] = useState('');

  // Appearance / startup
  const [defaultScreen, setDefaultScreen] = useState<DefaultScreen>(() => {
    try {
      const raw = localStorage.getItem('pigry:default-screen');
      if (raw === 'commit-graph' || raw === 'working-changes') return raw;
    } catch {
      // fall through
    }
    return 'explorer';
  });
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  const [sidebarOnLaunch, setSidebarOnLaunch] = useState(() => !readBool('pigry:sidebar-collapsed', false));
  const [fontSize, setFontSize] = useState(() => {
    try {
      return Number(localStorage.getItem('pigry:editor-font-size') ?? 12) || 12;
    } catch {
      return 12;
    }
  });
  const [wordWrap, setWordWrap] = useState(() => readBool('pigry:editor-word-wrap', false));
  const [fontFamily, setFontFamily] = useState(() => {
    try {
      return localStorage.getItem('pigry:editor-font-family') ?? "'Fira Code', ui-monospace, monospace";
    } catch {
      return "'Fira Code', ui-monospace, monospace";
    }
  });
  const [ligatures, setLigatures] = useState(() => readBool('pigry:editor-ligatures', true));
  const [tabSize, setTabSize] = useState(() => {
    try {
      return Number(localStorage.getItem('pigry:editor-tab-size') ?? 2) || 2;
    } catch {
      return 2;
    }
  });
  const [minimap, setMinimap] = useState(() => readBool('pigry:editor-minimap', false));
  const [lineNumbers, setLineNumbers] = useState(() => readBool('pigry:editor-line-numbers', true));

  // GitHub access
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem('pigry:github-token') ?? '';
    } catch {
      return '';
    }
  });
  const [ghStatus, setGhStatus] = useState<GhStatus>('unknown');
  const [accounts, setAccounts] = useState<GhAccount[]>([]);

  const [scopes, setScopes] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('pigry:token-scopes');
      return raw ? raw.split(',').map((scope) => scope.trim()).filter(Boolean) : SUGGESTED_SCOPES;
    } catch {
      return [...SUGGESTED_SCOPES];
    }
  });
  const [scopesChecking, setScopesChecking] = useState(false);
  // GitHub device flow: adds the checked scopes to the gh OAuth token.
  const [deviceFlow, setDeviceFlow] = useState<{
    userCode: string;
    verificationUri: string;
    deviceCode: string;
    interval: number;
  } | null>(null);
  const [flowStatus, setFlowStatus] = useState<'waiting' | 'success' | 'error'>('waiting');
  const [flowError, setFlowError] = useState('');
  // Once the flow reaches success/error, polling stops and the modal stays
  // open showing the result until the user presses OK/Close.
  const flowDoneRef = useRef(false);
  // Poll cadence: GitHub sends `interval` (seconds) and may answer
  // `slow_down` — per RFC 8628 the interval then grows by 5s. The modal
  // shows a live countdown so the wait is visible instead of a black box.
  const [flowCountdown, setFlowCountdown] = useState(0);
  const flowCountdownRef = useRef(0);
  const flowIntervalRef = useRef(5);
  const [customScope, setCustomScope] = useState('');

  const toggleScope = (scope: string) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  };

  const addCustomScope = () => {
    const scope = customScope.trim();
    if (!scope) return;
    setScopes((current) => (current.includes(scope) ? current : [...current, scope]));
    setCustomScope('');
  };

  // Persist the clean list.
  useEffect(() => {
    try {
      localStorage.setItem('pigry:token-scopes', scopes.join(','));
    } catch {
      // session-only
    }
  }, [scopes]);


  /** Starts the GitHub device flow with the given (or currently selected)
   * gh-valid scopes — this is how a new account gets added in-app. */
  const startDeviceFlow = async (requested?: string[]) => {
    const list = (requested ?? scopes).filter(
      (scope) => OAUTH_SCOPES.has(scope) && !PROJECT_SCOPES.includes(scope),
    );
    if (list.length === 0) {
      notify(
        'Select at least one gh-valid scope (repo, workflow, read:org, gist…)',
        'error',
      );
      return;
    }
    try {
      const start = await ghDeviceFlowStart(list);
      flowDoneRef.current = false;
      flowIntervalRef.current = Math.max(5, start.interval || 5);
      flowCountdownRef.current = flowIntervalRef.current;
      setFlowCountdown(flowIntervalRef.current);
      setFlowStatus('waiting');
      setFlowError('');
      setDeviceFlow(start);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const checkRealScopes = async () => {
    setScopesChecking(true);
    try {
      const real = await ghTokenScopes();
      setScopes(real);
      notify(real.length > 0 ? 'Token scopes: ' + real.join(', ') : 'Token has no extra scopes', 'success');
    } catch {
      notify('Could not read scopes — sign in with gh first', 'error');
    } finally {
      setScopesChecking(false);
    }
  };

  const generateOnGitHub = () => {
    const url = 'https://github.com/settings/tokens/new?description=pigry&scopes=' + scopes.map(encodeURIComponent).join(',');
    void ghOpenUrl(url);
    notify('Opened github.com — the scopes are pre-filled, review and generate', 'success');
  };

  const loadAccounts = () => {
    ghAccountList()
      .then((list) => {
        setAccounts(list);
        if (list.some((account) => account.active)) {
          try {
            localStorage.setItem('pigry:signed-in', '1');
          } catch {
            // session-only
          }
          window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
        }
      })
      .catch(() => setAccounts([]));
  };
  const [signedIn, setSignedIn] = useState(() => readBool('pigry:signed-in', false));

  // Update check (compares the app version with the latest GitHub release).
  const appVersion = `v${appPackage.version}`;
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'uptodate' | 'available' | 'none' | 'error'>('idle');
  const [latestTag, setLatestTag] = useState('');
  const [autoCheck, setAutoCheck] = useState(() => readBool('pigry:check-updates', true));
  // Tauri updater — download + install + relaunch (all platforms).
  const [installStatus, setInstallStatus] = useState<'idle' | 'downloading' | 'installing' | 'done' | 'error'>('idle');
  const [installPct, setInstallPct] = useState(0);
  const [installError, setInstallError] = useState('');


  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    try {
      const releases = await ghReleaseList();
      const latest = releases.find((release) => release.isLatest) ?? releases[0];
      if (!latest) {
        setUpdateStatus('none');
        return;
      }
      setLatestTag(latest.tagName);
      const clean = latest.tagName.replace(/^v/, '');
      setUpdateStatus(clean === appPackage.version ? 'uptodate' : 'available');
    } catch {
      setUpdateStatus('error');
    }
  };

  /** Downloads the update (with progress), installs it and relaunches the
   * app — Tauri updater, works on Windows / Linux / macOS (x86_64 + arm64).
   * Errors surface when the release endpoint is unreachable (private repo). */
  const installUpdate = async () => {
    setInstallStatus('downloading');
    setInstallError('');
    try {
      const update = await checkUpdater();
      if (!update) {
        setInstallStatus('done');
        notify('No update package found on the release endpoint', 'error');
        return;
      }
      let total = 0;
      let received = 0;
      await update.downloadAndInstall(function (event) {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength || 0;
          if (total > 0) setInstallPct(Math.min(100, Math.round((received / total) * 100)));
        } else if (event.event === 'Finished') {
          setInstallPct(100);
        }
      });
      setInstallStatus('done');
      notify('Update installed — relaunching…', 'success');
      setTimeout(function () { void relaunchApp(); }, 1200);
    } catch (error) {
      setInstallStatus('error');
      setInstallError(error instanceof Error ? error.message : String(error));
      notify('Update failed', 'error');
    }
  };
  // Auto check on entering the Update section (once per mount).
  useEffect(() => {
    if (activeSection === 'update' && autoCheck && updateStatus === 'idle') {
      const t = window.setTimeout(() => void checkForUpdates(), 0);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  useEffect(() => {
    try {
      localStorage.setItem('pigry:default-screen', defaultScreen);
    } catch {
      // session-only
    }
  }, [defaultScreen]);

  // Theme — persisted and applied to <html> immediately (auto re-checks by clock).
  useEffect(() => {
    writeThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('pigry:sidebar-collapsed', sidebarOnLaunch ? '0' : '1');
    } catch {
      // session-only
    }
  }, [sidebarOnLaunch]);

  useEffect(() => {
    try {
      localStorage.setItem('pigry:editor-font-size', String(fontSize));
      localStorage.setItem('pigry:editor-word-wrap', wordWrap ? '1' : '0');
    } catch {
      // session-only
    }
    window.dispatchEvent(
      new CustomEvent('pigry:editor-prefs', {
        detail: { fontSize, wordWrap, fontFamily, ligatures, tabSize, minimap, lineNumbers },
      }),
    );
  }, [fontSize, wordWrap, fontFamily, ligatures, tabSize, minimap, lineNumbers]);

  // The title-bar profile menu shares this auth state.
  useEffect(() => {
    const onAuth = () => setSignedIn(readBool('pigry:signed-in', false));
    window.addEventListener('pigry:auth-changed', onAuth);
    return () => window.removeEventListener('pigry:auth-changed', onAuth);
  }, []);

  // gh account list on mount and whenever auth changes.
  useEffect(() => {
    loadAccounts();
  }, []);

  // Escape returns to the previous screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const saveToken = () => {
    try {
      localStorage.setItem('pigry:github-token', token);
      localStorage.setItem('pigry:signed-in', token ? '1' : '0');
    } catch {
      // session-only
    }
    window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
    notify(token ? 'Token saved locally' : 'Token cleared', 'success');
  };

  const checkGh = async () => {
    setGhStatus('checking');
    try {
      const result = await ghAuthStatus();
      const ok = result.loggedIn;
      setGhStatus(ok ? 'in' : 'out');
      try {
        localStorage.setItem('pigry:signed-in', ok ? '1' : '0');
      } catch {
        // session-only
      }
      window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
      notify(
        ok ? 'GitHub CLI: signed in' + (result.account ? ' as ' + result.account : '') : 'GitHub CLI: not signed in',
        ok ? 'success' : 'error',
      );
      loadAccounts();
    } catch {
      setGhStatus('missing');
      notify('gh CLI is not installed', 'error');
    }
  };

  // Auto-install gh when the check found nothing on PATH (winget, then scoop).
  const installGh = async () => {
    setGhStatus('checking');
    notify('Installing the GitHub CLI via winget — this can take a few minutes…', 'success');
    try {
      const version = await ghInstall();
      notify('Installed ' + version, 'success');
      await checkGh();
      loadAccounts();
    } catch (error) {
      setGhStatus('missing');
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  // Poll the device flow while the modal is open. A 1s ticker drives both
  // the visible countdown and the actual check (every `interval` seconds;
  // `slow_down` pushes the next check 5s later, per RFC 8628).
  useEffect(() => {
    if (!deviceFlow) return;
    const tick = async () => {
      try {
        const result = await ghDeviceFlowPoll(deviceFlow.deviceCode);
        if (result.status === 'pending') {
          if (result.error === 'slow_down') {
            flowIntervalRef.current = Math.min(30, flowIntervalRef.current + 5);
          }
          flowCountdownRef.current = flowIntervalRef.current;
          setFlowCountdown(flowIntervalRef.current);
          return; // keep polling
        }
        flowDoneRef.current = true;
        if (result.status === 'success') {
          setFlowStatus('success');
          try {
            localStorage.setItem('pigry:signed-in', '1');
          } catch {
            // session-only
          }
          window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
          notify('gh scopes updated' + (result.account ? ' for ' + result.account : ''), 'success');
          window.setTimeout(() => {
            loadAccounts();
            void checkRealScopes();
          }, 0);
          // The modal stays open showing "Authorized" — OK confirms it.
        } else {
          setFlowStatus('error');
          setFlowError(result.error === 'expired_token' ? 'The code expired — try again.' : result.error);
        }
      } catch (error) {
        flowDoneRef.current = true;
        setFlowStatus('error');
        setFlowError(error instanceof Error ? error.message : String(error));
      }
    };
    const timer = window.setInterval(() => {
      if (flowDoneRef.current) return; // terminal state — stop polling
      const next = flowCountdownRef.current - 1;
      if (next > 0) {
        flowCountdownRef.current = next;
        setFlowCountdown(next);
        return;
      }
      // Countdown reached zero — check GitHub now, then restart the wait.
      flowCountdownRef.current = flowIntervalRef.current;
      setFlowCountdown(flowIntervalRef.current);
      void tick();
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow]);

  const ghLogin = () => {
    window.dispatchEvent(new CustomEvent('pigry:toggle-terminal'));
    notify('Run "gh auth login --web" in the terminal, then check status here', 'success');
  };

  const loginGhWithSavedToken = async () => {
    let token = '';
    try {
      token = localStorage.getItem('pigry:github-token') ?? '';
    } catch {
      // ignore
    }
    if (!token) {
      notify('Save a personal access token first, then login gh with it', 'error');
      return;
    }
    try {
      const status = await ghLoginWithToken(token);
      notify('gh logged in as ' + (status.account || 'account'), 'success');
      loadAccounts();
    } catch {
      notify('gh login failed — token invalid or missing scopes', 'error');
    }
  };

  const switchAccount = async (name: string) => {
    try {
      await ghSwitchAccount(name);
      notify('Switched to ' + name, 'success');
      loadAccounts();
    } catch {
      notify('gh switch failed', 'error');
    }
  };

  // Search matches setting titles/descriptions across sections.
  const q = search.trim().toLowerCase();
  const rowMatch = (...texts: string[]) => !q || texts.some((text) => text.toLowerCase().includes(q));
  const showSection = (id: SectionId, matched: boolean) => (q ? matched : activeSection === id);

  const appearanceMatch =
    rowMatch('default screen', 'startup shown when the app launches') ||
    rowMatch('theme', 'appearance dark light auto daytime night clock') ||
    rowMatch('show side bar on launch', 'folded sidebar startup');
  const textEditorMatch =
    rowMatch('editor font size', 'font pixels monaco') ||
    rowMatch('word wrap', 'wrap long lines horizontal scrolling') ||
    rowMatch('font family', 'fira code ligatures monospace') ||
    rowMatch('font ligatures', 'arrow =>') ||
    rowMatch('tab size', 'indent spaces') ||
    rowMatch('minimap', 'overview code map') ||
    rowMatch('line numbers', 'gutter');
  const aiMatch = rowMatch('ai provider', 'model base url api key openai anthropic ollama custom');
  const importMatch = rowMatch('import from other agents', 'claude code codex antigravity gemini agy skills instructions mcp servers claude.md agents.md migrate');
  const extensionsMatch = rowMatch('extensions', 'extension pack install plugin agents skills hooks mcp servers marketplace');
  const tokenMatch = rowMatch('personal access token', 'github token pat');
  const accountsMatch = rowMatch(
    'accounts',
    'github gh cli sign in sign out switch account auth status',
  );
  const updateMatch = rowMatch('update', 'version check release startup github');
  const aboutMatch = rowMatch('about', 'version repository credits tauri react monaco license');

  const menuSections = SECTIONS.filter(({ id }) =>
    q
      ? (id === 'appearance' && appearanceMatch) ||
        (id === 'text-editor' && textEditorMatch) ||
        (id === 'ai-provider' && aiMatch) ||
        (id === 'import' && importMatch) ||
        (id === 'extensions' && extensionsMatch) ||
        (id === 'token' && tokenMatch) ||
        (id === 'accounts' && accountsMatch) ||
        (id === 'update' && updateMatch) ||
        (id === 'about' && aboutMatch)
      : true,
  );

  return (
    <div className="app-settings">
      <header className="app-settings__topbar">
        <button type="button" className="app-settings__back" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={1.5} />
          Back
        </button>
        <h1>Settings</h1>
        <div className="app-settings__search">
          <Search size={13} strokeWidth={1.5} />
          <input
            placeholder="Search settings"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search settings"
            spellCheck={false}
          />
          {search && (
            <button
              type="button"
              className="app-settings__search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div className="app-settings__layout">
        <nav className="app-settings__menu" aria-label="Settings sections">
          <p className="app-settings__menu-label">User</p>
          {menuSections.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`app-settings__menu-item${!q && activeSection === id ? ' app-settings__menu-item--active' : ''}`}
              onClick={() => {
                setActiveSection(id);
                setSearch('');
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="app-settings__content">
          {showSection('appearance', appearanceMatch) && (
            <section className="app-settings__section">
              <h2>Appearance</h2>

              {rowMatch('default screen', 'startup shown when the app launches') && (
                <div className="app-settings__row">
                  <strong>Default screen</strong>
                  <span>Shown when the app launches.</span>
                  <select
                    className="app-settings__control"
                    value={defaultScreen}
                    onChange={(event) => setDefaultScreen(event.target.value as DefaultScreen)}
                    aria-label="Default screen"
                  >
                    <option value="explorer">Explorer</option>
                    <option value="commit-graph">Commit graph</option>
                    <option value="working-changes">Working changes</option>
                  </select>
                </div>
              )}

              {rowMatch('theme', 'appearance dark light auto daytime night clock') && (
                <div className="app-settings__row">
                  <strong>Theme</strong>
                  <span>
                    Auto follows the clock — light from 06:00 to 18:00, dark at night. Applied
                    across the app immediately.
                  </span>
                  <div className="app-settings__seg" role="radiogroup" aria-label="Theme">
                    {(
                      [
                        { value: 'auto', label: 'Auto' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'light', label: 'Light' },
                      ] as Array<{ value: ThemePreference; label: string }>
                    ).map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={theme === choice.value}
                        className={`app-settings__seg-btn${theme === choice.value ? ' app-settings__seg-btn--active' : ''}`}
                        onClick={() => setTheme(choice.value)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {rowMatch('show side bar on launch', 'folded sidebar startup') && (
                <div className="app-settings__row">
                  <strong>Show side bar on launch</strong>
                  <span>Uncheck to start with the side bar folded (Ctrl+B toggles it any time).</span>
                  <label className="app-settings__switch">
                    <input
                      type="checkbox"
                      checked={sidebarOnLaunch}
                      onChange={(event) => setSidebarOnLaunch(event.target.checked)}
                    />
                    <i />
                  </label>
                </div>
              )}

            </section>
          )}

          {showSection('text-editor', textEditorMatch) && (
            <section className="app-settings__section">
              <h2>Text Editor</h2>

              {rowMatch('editor font size', 'font pixels monaco') && (
                <div className="app-settings__row">
                  <strong>Editor: Font Size</strong>
                  <span>Controls the font size in pixels. Applies to open editors immediately.</span>
                  <select
                    className="app-settings__control"
                    value={fontSize}
                    onChange={(event) => setFontSize(Number(event.target.value))}
                    aria-label="Editor font size"
                  >
                    {[11, 12, 13, 14, 15, 16, 18].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {rowMatch('font family', 'fira code ligatures monospace') && (
                <div className="app-settings__row">
                  <strong>Editor: Font Family</strong>
                  <span>Fira Code is bundled; the others fall back to system monospace.</span>
                  <select
                    className="app-settings__control"
                    value={fontFamily}
                    onChange={(event) => setFontFamily(event.target.value)}
                    aria-label="Editor font family"
                  >
                    <option value="'Fira Code', ui-monospace, monospace">Fira Code</option>
                    <option value="Consolas, ui-monospace, monospace">Consolas</option>
                    <option value="'Courier New', ui-monospace, monospace">Courier New</option>
                    <option value="ui-monospace, monospace">System monospace</option>
                  </select>
                </div>
              )}

              {rowMatch('font ligatures', 'arrow =>') && (
                <div className="app-settings__row">
                  <strong>Editor: Font Ligatures</strong>
                  <span>Render {'===, =>, !='} as connected glyph shapes.</span>
                  <label className="app-settings__switch">
                    <input
                      type="checkbox"
                      checked={ligatures}
                      onChange={(event) => setLigatures(event.target.checked)}
                    />
                    <i />
                  </label>
                </div>
              )}

              {rowMatch('word wrap', 'wrap long lines horizontal scrolling') && (
                <div className="app-settings__row">
                  <strong>Editor: Word Wrap</strong>
                  <span>Wrap long lines instead of horizontal scrolling.</span>
                  <label className="app-settings__switch">
                    <input
                      type="checkbox"
                      checked={wordWrap}
                      onChange={(event) => setWordWrap(event.target.checked)}
                    />
                    <i />
                  </label>
                </div>
              )}

              {rowMatch('tab size', 'indent spaces') && (
                <div className="app-settings__row">
                  <strong>Editor: Tab Size</strong>
                  <span>Spaces per indentation level.</span>
                  <select
                    className="app-settings__control"
                    value={tabSize}
                    onChange={(event) => setTabSize(Number(event.target.value))}
                    aria-label="Editor tab size"
                  >
                    {[2, 4, 8].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {rowMatch('minimap', 'overview code map') && (
                <div className="app-settings__row">
                  <strong>Editor: Minimap</strong>
                  <span>Show the code overview strip on the right edge.</span>
                  <label className="app-settings__switch">
                    <input
                      type="checkbox"
                      checked={minimap}
                      onChange={(event) => setMinimap(event.target.checked)}
                    />
                    <i />
                  </label>
                </div>
              )}

              {rowMatch('line numbers', 'gutter') && (
                <div className="app-settings__row">
                  <strong>Editor: Line Numbers</strong>
                  <span>Show line numbers in the gutter.</span>
                  <label className="app-settings__switch">
                    <input
                      type="checkbox"
                      checked={lineNumbers}
                      onChange={(event) => setLineNumbers(event.target.checked)}
                    />
                    <i />
                  </label>
                </div>
              )}
            </section>
          )}

          {showSection('ai-provider', aiMatch) && (
            <section className="app-settings__section">
              <h2>AI Provider</h2>
              <ProviderManager />
            </section>
          )}

          {IMPORT_AGENTS_ENABLED && showSection('import', importMatch) && (
            <section className="app-settings__section">
              <h2>Import from other agents</h2>
              <ImportAgentsPanel />
            </section>
          )}

          {showSection('extensions', extensionsMatch) && (
            <section className="app-settings__section">
              <h2>Extensions</h2>
              <p className="app-settings__lead">
                Manage the extensions you have: switch one off without losing it, remove it with everything it added, or
                upload an extension from a file. To find new ones, open the Extension Store.
              </p>
              <InstalledExtensionsPanel />
            </section>
          )}

          {showSection('token', tokenMatch) && (
            <section className="app-settings__section">
              <h2>Personal access token</h2>

              <div className="app-settings__row">
                <strong>GitHub: Personal access token</strong>
                <span>Used for API calls. Stored locally on this machine only.</span>
                <div className="app-settings__inline">
                  <input
                    className="app-settings__control"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="ghp_… / github_pat_…"
                    aria-label="GitHub personal access token"
                    autoComplete="off"
                  />
                  <button type="button" className="app-settings__button" onClick={saveToken}>
                    Save
                  </button>
                  {token && (
                    <button
                      type="button"
                      className="app-settings__button app-settings__button--ghost"
                      onClick={() => {
                        setToken('');
                        try {
                          localStorage.setItem('pigry:github-token', '');
                          localStorage.setItem('pigry:signed-in', '0');
                        } catch {
                          // session-only
                        }
                        window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
                        notify('Token cleared', 'success');
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="app-settings__row">
                <strong>GitHub: Token scopes</strong>
                <span>
                  Scopes the token should have (comma separated). Suggested for pigry:{' '}
                  <code>repo</code>, <code>workflow</code>, <code>read:org</code>, <code>gist</code>.
                </span>
                <div className="app-settings__scope-grid">
                  {[...new Set([...KNOWN_SCOPES, ...scopes.filter((scope) => !PROJECT_SCOPES.includes(scope))])].map((scope) => (
                    <label key={scope} className="app-settings__scope-check">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>
                <div className="app-settings__scope-grid app-settings__scope-grid--fine">
                  <p className="app-settings__scope-grid-note">
                    Fine-grained PAT only — cannot be added to the gh OAuth token
                  </p>
                  {PROJECT_SCOPES.map((scope) => (
                    <label key={scope} className="app-settings__scope-check">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>
                <div className="app-settings__inline">
                  <input
                    className="app-settings__control app-settings__control--narrow"
                    value={customScope}
                    onChange={(event) => setCustomScope(event.target.value)}
                    placeholder="Add custom scope…"
                    aria-label="Add custom scope"
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addCustomScope();
                    }}
                  />
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={addCustomScope}
                  >
                    Add
                  </button>
                </div>
                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => setScopes([...SUGGESTED_SCOPES])}
                  >
                    Use suggested scopes
                  </button>
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => void checkRealScopes()}
                    disabled={scopesChecking}
                  >
                    {scopesChecking ? 'Checking…' : 'Check real scopes from gh'}
                  </button>
                  <button
                    type="button"
                    className="app-settings__button"
                    title="Add the selected scopes to the gh token (GitHub device flow)"
                    onClick={() => void startDeviceFlow()}
                  >
                    Update gh scopes
                  </button>
                  <button type="button" className="app-settings__button" onClick={generateOnGitHub}>
                    Generate token on GitHub
                  </button>
                </div>
                {scopes.length > 0 && (
                  <div className="app-settings__scope-pills">
                    {scopes.map((scope) => (
                      <span key={scope} className="app-settings__scope-pill">
                        {scope}
                      </span>
                    ))}
                  </div>
                )}
              </div>

            </section>
          )}

          {showSection('accounts', accountsMatch) && (
            <section className="app-settings__section">
              <h2>Accounts</h2>

              <div className="app-settings__row">
                <strong>Sign in with GitHub CLI</strong>
                <span>
                  Runs <code>gh auth login --web</code> in the integrated terminal — complete the
                  device flow in your browser, then check the status below.
                </span>
                <div className="app-settings__inline">
                  <button type="button" className="app-settings__button" onClick={ghLogin}>
                    <LogIn size={13} strokeWidth={1.5} />
                    Open terminal &amp; sign in
                  </button>
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => void loginGhWithSavedToken()}
                  >
                    Login gh with saved token
                  </button>
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => void checkGh()}
                    disabled={ghStatus === 'checking'}
                  >
                    Check gh status
                  </button>
                  <span className={`app-settings__pill app-settings__pill--${ghStatus === 'missing' ? 'out' : ghStatus}`}>
                    {ghStatus === 'unknown' && 'unknown'}
                    {ghStatus === 'checking' && 'checking…'}
                    {ghStatus === 'in' && 'signed in'}
                    {ghStatus === 'out' && 'signed out'}
                    {ghStatus === 'missing' && 'gh not installed'}
                  </span>
                  {ghStatus === 'missing' && (
                    <button
                      type="button"
                      className="app-settings__button"
                      onClick={() => void installGh()}
                    >
                      Install gh automatically
                    </button>
                  )}
                  {signedIn && (
                    <button
                      type="button"
                      className="app-settings__button app-settings__button--ghost"
                      onClick={() => {
                        try {
                          localStorage.setItem('pigry:signed-in', '0');
                        } catch {
                          // session-only
                        }
                        window.dispatchEvent(new CustomEvent('pigry:auth-changed'));
                        notify('Signed out', 'success');
                      }}
                    >
                      <LogOut size={13} strokeWidth={1.5} />
                      Sign out
                    </button>
                  )}
                </div>
              </div>

              <div className="app-settings__row">
                <strong>GitHub: Accounts</strong>
                <span>All accounts known to gh on this machine. The active one is used for API calls.</span>
                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button"
                    title="Add a GitHub account with the device flow — opens github.com/login/device in your browser"
                    onClick={() => void startDeviceFlow([...SUGGESTED_SCOPES])}
                  >
                    <LogIn size={13} strokeWidth={1.5} />
                    Add account with browser
                  </button>
                </div>
                <div className="app-settings__accounts">
                  {accounts.length === 0 && <p className="app-settings__accounts-empty">No gh accounts found — sign in above.</p>}
                  {accounts.map((account) => (
                    <div key={account.name} className="app-settings__account">
                      {account.avatarUrl ? (
                        <img className="app-settings__account-avatar" src={account.avatarUrl} alt="" />
                      ) : (
                        <span className="app-settings__account-avatar app-settings__account-avatar--fallback">
                          {account.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span className="app-settings__account-name">{account.fullName || account.name}</span>
                      {account.active ? (
                        <span className="app-settings__pill app-settings__pill--in">active</span>
                      ) : (
                        <button
                          type="button"
                          className="app-settings__button app-settings__button--ghost"
                          onClick={() => void switchAccount(account.name)}
                        >
                          Switch
                        </button>
                      )}
                      {account.scopes.length > 0 ? (
                        <span className="app-settings__account-scopes">
                          {account.scopes.map((scope) => (
                            <span key={scope} className="app-settings__scope-pill">
                              {scope}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="app-settings__account-scopes app-settings__account-scopes--empty">
                          no scopes on this token
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {showSection('update', updateMatch) && (
            <section className="app-settings__section">
              <h2>Update</h2>

              <div className="app-settings__row">
                <strong>Current version</strong>
                <span>pigry {appVersion} · local build</span>
              </div>

              <div className="app-settings__row">
                <strong>Check for updates</strong>
                <span>Compares the app version with the latest release on GitHub.</span>
                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button"
                    onClick={() => void checkForUpdates()}
                    disabled={updateStatus === 'checking'}
                  >
                    {updateStatus === 'checking' ? 'Checking…' : 'Check now'}
                  </button>
                  {updateStatus === 'uptodate' && (
                    <span className="app-settings__pill app-settings__pill--in">up to date</span>
                  )}
                  {updateStatus === 'available' && (
                    <span className="app-settings__pill app-settings__pill--checking">
                      update available: {latestTag}
                    </span>
                  )}
                  <button
                    type="button"
                    className="app-settings__button"
                    disabled={installStatus === 'downloading' || installStatus === 'installing'}
                    onClick={() => void installUpdate()}
                  >
                    {installStatus === 'downloading'
                      ? installPct > 0 && installPct < 100
                        ? 'Downloading… ' + installPct + '%'
                        : 'Downloading…'
                      : installStatus === 'installing'
                        ? 'Installing…'
                        : 'Download & install'}
                  </button>
                  {installStatus === 'downloading' && installPct > 0 && installPct < 100 && (
                    <span className="app-settings__pill">{installPct}%</span>
                  )}
                  {installStatus === 'done' && (
                    <span className="app-settings__pill app-settings__pill--in">installed — relaunching…</span>
                  )}
                  {installStatus === 'error' && installError && (
                    <span className="app-settings__pill app-settings__pill--out">{installError}</span>
                  )}
                  {updateStatus === 'none' && (
                    <span className="app-settings__pill">no releases on GitHub yet</span>
                  )}
                  {updateStatus === 'error' && (
                    <span className="app-settings__pill app-settings__pill--out">
                      could not check — is gh signed in?
                    </span>
                  )}
                </div>
              </div>

              <label className="app-settings__row app-settings__row--toggle">
                <span className="app-settings__row-text">
                  <strong>Check for updates at startup</strong>
                  <span>Runs an automatic check when the app opens.</span>
                </span>
                <input
                  type="checkbox"
                  checked={autoCheck}
                  onChange={(event) => {
                    setAutoCheck(event.target.checked);
                    try {
                      localStorage.setItem('pigry:check-updates', event.target.checked ? '1' : '0');
                    } catch {
                      // session-only
                    }
                  }}
                />
              </label>

              <div className="app-settings__row">
                <strong>Releases page</strong>
                <span>See all releases and download artifacts on GitHub.</span>
                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => void ghOpenUrl('https://github.com/d-osc/pigry/releases')}
                  >
                    Open releases on GitHub
                  </button>
                </div>
              </div>
            </section>
          )}

          {showSection('about', aboutMatch) && (
            <section className="app-settings__section">
              <h2>About</h2>

              <div className="app-settings__about-brand">
                <span className="app-settings__about-logo">
                  <PigryMark size={34} />
                </span>
                <div>
                  <strong>
                    pigry <span className="app-settings__about-beta">GIT</span>
                  </strong>
                  <span>Version {appVersion}</span>
                </div>
              </div>

              <div className="app-settings__row">
                <strong>About pigry</strong>
                <span>A desktop Git client with a commit graph, inline editor and GitHub integration — built with Tauri, React and Monaco.</span>
              </div>

              <div className="app-settings__row">
                <strong>Repository</strong>
                <span>github.com/d-osc/pigry</span>
                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={() => void ghOpenUrl('https://github.com/d-osc/pigry')}
                  >
                    Open on GitHub
                  </button>
                </div>
              </div>

              <div className="app-settings__row">
                <strong>Credits</strong>
                <span>Tauri · React · Monaco Editor · git2 (libgit2) · GitHub CLI · Fira Code · Material Icon Theme</span>
              </div>
            </section>
          )}
        </div>
      </div>
      {deviceFlow && (
        <div className="commit-history__overlay" onClick={() => setDeviceFlow(null)} role="presentation">
          <div
            className="pr-flow-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Authorize GitHub CLI"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="pr-flow-modal__head">
              <span className="pr-flow-modal__badge">
                <KeyRound size={18} strokeWidth={1.5} />
              </span>
              <div className="pr-flow-modal__head-text">
                <strong>Add scopes to the gh token</strong>
                <span>GitHub device flow — one-time authorization</span>
              </div>
            </header>

            <div className="pr-flow-modal__steps">
              <div className="pr-flow-modal__step">
                <span className="pr-flow-modal__num">1</span>
                <div className="pr-flow-modal__step-body">
                  <p>Open <button type="button" className="pr-section__link" onClick={() => void ghOpenUrl(deviceFlow.verificationUri)}>github.com/login/device</button></p>
                  <div className="pr-flow-modal__code">
                    <code>{deviceFlow.userCode}</code>
                    <button
                      type="button"
                      className="pr-flow-modal__copy"
                      title="Copy code"
                      onClick={() => {
                        void navigator.clipboard.writeText(deviceFlow.userCode).catch(() => {});
                        notify('Code copied', 'success');
                      }}
                    >
                      <Copy size={12} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="pr-flow-modal__step">
                <span className="pr-flow-modal__num">2</span>
                <div className="pr-flow-modal__step-body">
                  <p>Authorize — requesting scopes:</p>
                  <div className="pr-flow-modal__scopes">
                    {scopes.filter(Boolean).map((scope) => (
                      <span key={scope} className="pr-flow-modal__scope-pill">{scope}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className={`pr-flow-modal__status pr-flow-modal__status--${flowStatus}`}>
              {flowStatus === 'waiting' && (
                <>
                  <Loader2 size={13} strokeWidth={1.75} className="pr-flow-modal__spinner" />
                  <span>
                    Waiting for authorization… — checking again in{' '}
                    {flowCountdown}s
                  </span>
                </>
              )}
              {flowStatus === 'success' && (
                <>
                  <Check size={13} strokeWidth={2} />
                  <span>Authorized — gh token scopes updated.</span>
                </>
              )}
              {flowStatus === 'error' && (
                <>
                  <X size={13} strokeWidth={2} />
                  <span>{flowError === 'expired_token' ? 'The code expired — try again.' : flowError}</span>
                </>
              )}
            </div>

            <footer className="pr-flow-modal__foot">
              {flowStatus === 'waiting' ? (
                // Nothing to confirm yet — the user can only cancel while
                // GitHub authorization is pending.
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => {
                    flowDoneRef.current = true;
                    setDeviceFlow(null);
                  }}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className={flowStatus === 'success' ? 'primary-button' : 'outline-button'}
                  onClick={() => setDeviceFlow(null)}
                >
                  {flowStatus === 'success' ? 'OK' : 'Close'}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

