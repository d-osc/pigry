p = 'src/screens/settings/AppSettingsScreen.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# 1) imports: device flow clients (skip if already imported)
if 'ghDeviceFlowPoll' not in s:
    old = "import { ghAccountList, ghAuthStatus, ghInstall, ghLoginWithToken, ghOpenUrl, ghReleaseList, ghSwitchAccount, ghTokenScopes } from '../../lib/tauriClient';"
    new = "import { ghAccountList, ghAuthStatus, ghDeviceFlowPoll, ghDeviceFlowStart, ghInstall, ghLoginWithToken, ghOpenUrl, ghReleaseList, ghSwitchAccount, ghTokenScopes } from '../../lib/tauriClient';"
    rep(old, new, 'imports')

# 2) device flow states
if 'deviceFlow' not in s:
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
  const [flowError, setFlowError] = useState('');""", 'flow states')

# 3) polling effect anchored right after the scopes persist effect
if 'Poll the device flow while the modal is open' not in s:
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
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceFlow, activePath]);

  const checkRealScopes = async () => {""", 'polling effect')

# 4) "Update gh scopes" button starts the device flow
if 'ghDeviceFlowStart' not in s.split('return (')[0] or 'Authorize GitHub CLI' not in s:
    pass  # handled below in markup step

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('states + polling effect in place')
