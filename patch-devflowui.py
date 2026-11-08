p = 'src/screens/settings/AppSettingsScreen.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

rep("import { ghAccountList, ghAuthStatus, ghInstall, ghLoginWithToken, ghOpenUrl, ghReleaseList, ghSwitchAccount, ghTokenScopes } from '../../lib/tauriClient';",
    "import { ghAccountList, ghAuthStatus, ghDeviceFlowPoll, ghDeviceFlowStart, ghInstall, ghLoginWithToken, ghOpenUrl, ghReleaseList, ghSwitchAccount, ghTokenScopes } from '../../lib/tauriClient';", 'imports')

rep("  const [scopesChecking, setScopesChecking] = useState(false);",
    """  const [scopesChecking, setScopesChecking] = useState(false);
  // GitHub device flow: adds the checked scopes to the gh OAuth token.
  const [deviceFlow, setDeviceFlow] = useState<{
    userCode: string;
    verificationUri: string;
    deviceCode: string;
    interval: number;
  } | null>(null);
  const [flowStatus, setFlowStatus] = useState<'waiting' | 'success' | 'error'>('waiting');
  const [flowError, setFlowError] = useState('');""", 'device flow states')

rep("""  }, [scopes]);

  const checkRealScopes = async () => {""", """  }, [scopes]);

  // Poll the device flow while the modal is open.
  useEffect(() => {
    if (!deviceFlow) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await ghDeviceFlowPoll(deviceFlow.deviceCode);
        if (cancelled) return;
        if (result.status === 'pending') return; // keep polling
        if (result.status === 'success') {
          setFlowStatus('success');
          try {
            localStorage.setItem('orbit:signed-in', '1');
          } catch {
            // session-only
          }
          window.dispatchEvent(new CustomEvent('orbit:auth-changed'));
          notify('gh scopes updated' + (result.account ? ' for ' + result.account : ''), 'success');
          loadAccounts();
          void checkRealScopes();
        } else {
          setFlowStatus('error');
          setFlowError(result.error === 'expired_token' ? 'The code expired — try again.' : result.error);
        }
        setDeviceFlow(null);
      } catch (error) {
        if (!cancelled) {
          setFlowStatus('error');
          setFlowError(error instanceof Error ? error.message : String(error));
        }
        setDeviceFlow(null);
      }
    };
    timer = window.setInterval(() => void tick(), (deviceFlow.interval || 5) * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow, activePath]);

  const checkRealScopes = async () => {""")


rep("""                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    title="Run gh auth refresh with the selected scopes (device flow in the terminal)"
                    onClick={() => {
                      const list = scopes.filter(Boolean);
                      if (list.length === 0) {
                        notify('Select at least one scope first', 'error');
                        return;
                      }
                      const cmd =
                        'gh auth refresh -h github.com ' +
                        list.map((scope) => `-s "${scope}"`).join(' ');
                      window.dispatchEvent(new CustomEvent('orbit:toggle-terminal'));
                      notify('Run "' + cmd + '" in the terminal, then press Check real scopes', 'success');
                    }}
                  >
                    Update gh scopes
                  </button>""", """                  <button
                    type="button"
                    className="app-settings__button"
                    title="Add the selected scopes to the gh token (GitHub device flow)"
                    onClick={async () => {
                      const list = scopes.filter(Boolean);
                      if (list.length === 0) {
                        notify('Select at least one scope first', 'error');
                        return;
                      }
                      try {
                        const start = await ghDeviceFlowStart(list);
                        setFlowStatus('waiting');
                        setFlowError('');
                        setDeviceFlow(start);
                      } catch (error) {
                        notify(error instanceof Error ? error.message : String(error), 'error');
                      }
                    }}
                  >
                    Update gh scopes
                  </button>""", 'button starts device flow')

rep("""      {editOpen && ( """, """      {deviceFlow && (
        <div className="commit-history__overlay" onClick={() => setDeviceFlow(null)} role="presentation">
          <div
            className="commit-history__branch-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Authorize GitHub CLI"
            onClick={(event) => event.stopPropagation()}
          >
            <strong>Add scopes to the gh token</strong>
            <p className="app-settings__flow-step">
              1. Enter this one-time code at{' '}
              <button
                type="button"
                className="pr-section__link"
                onClick={() => void ghOpenUrl(deviceFlow.verificationUri)}
              >
                {deviceFlow.verificationUri}
              </button>
            </p>
            <div className="app-settings__device-code">
              <code>{deviceFlow.userCode}</code>
              <button
                type="button"
                className="app-settings__button app-settings__button--ghost"
                onClick={() => {
                  void navigator.clipboard.writeText(deviceFlow.userCode).catch(() => {});
                  notify('Code copied', 'success');
                }}
              >
                Copy
              </button>
            </div>
            <p className="app-settings__flow-step">
              2. Authorize — requesting:{' '}
              <code>{scopes.filter(Boolean).join(', ')}</code>
            </p>
            <p className="app-settings__flow-status">
              {flowStatus === 'waiting'
                ? 'Waiting for authorization… (usually ~10 seconds)'
                : flowStatus === 'success'
                  ? 'Authorized — gh token scopes updated.'
                  : 'Error: ' + flowError}
            </p>
            <div className="commit-history__branch-actions">
              <button type="button" className="outline-button" onClick={() => setDeviceFlow(null)}>
                {flowStatus === 'waiting' ? 'Cancel' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editOpen && ( """, 'device flow modal')

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('device flow UI added')

p = 'src/screens/settings/AppSettingsScreen.css'
s = open(p, encoding='utf-8').read()
s += '''
.app-settings__device-code {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  width: fit-content;
}

.app-settings__device-code code {
  font-family: 'Fira Code', ui-monospace, monospace;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.35em;
  color: var(--accent);
}

.app-settings__flow-step {
  margin: 4px 0;
  font-size: var(--fs-md);
  color: var(--text-secondary);
}

.app-settings__flow-status {
  margin: 8px 0 0;
  font-size: var(--fs-md);
  color: var(--text-primary);
}
'''
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('flow CSS added')
