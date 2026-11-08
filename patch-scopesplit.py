p = 'src/screens/settings/AppSettingsScreen.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# 1) split scope catalog: OAuth-valid vs fine-grained-only (projects)
rep("""const KNOWN_SCOPES = [
  'repo',
  'workflow',
  'read:org',
  'write:org',
  'admin:org',
  'read:project',
  'write:project',
  'admin:project',
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
];""", """/** Scopes valid for classic OAuth tokens (gh token, device flow). */
const KNOWN_SCOPES = [
  'repo',
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

const OAUTH_SCOPES = new Set(KNOWN_SCOPES);""", 'scope split')

# 2) checkbox grid: two labelled groups
rep("""                <div className="app-settings__scope-grid">
                  {[...new Set([...KNOWN_SCOPES, ...scopes])].map((scope) => (
                    <label key={scope} className="app-settings__scope-check">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>""", """                <div className="app-settings__scope-grid">
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
                </div>""", 'grid groups')

# 3) device flow uses only OAuth-valid scopes
rep("""                    onClick={async () => {
                      const list = scopes.filter(Boolean);
                      if (list.length === 0) {
                        notify('Select at least one scope first', 'error');
                        return;
                      }
                      try {
                        const start = await ghDeviceFlowStart(list);""", """                    onClick={async () => {
                      const list = scopes.filter(
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
                        const start = await ghDeviceFlowStart(list);""", 'device flow filter')

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('scope groups wired')
