p = 'src/screens/settings/AppSettingsScreen.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# 1) Update button → starts the GitHub device flow (one click, no terminal)
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
                  </button>""", 'update button device flow')

# 2) device flow modal before edit modal
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
print('button + modal wired')
