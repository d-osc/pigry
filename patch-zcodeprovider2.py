# AiAgentPanel: use shared detectZcodeGlm + add zcode type support
p = 'src/screens/explorer/AiAgentPanel.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# swap imports
rep("import { aiChat, readWorktreeFile, zcodeCredentials } from '../../lib/tauriClient';",
    "import { aiChat, readWorktreeFile } from '../../lib/tauriClient';\nimport { detectZcodeGlm, ZCODE_DEFAULT_MODEL, ZCODE_CHAT_ENDPOINT } from '../../lib/zcode';", 'imports')

# replace inline detection effect with shared helper
rep("""  // ZCode Cloud (GLM) — detected automatically when ZCode desktop is installed.
  const [zcodeProvider, setZcodeProvider] = useState<ProviderEntry | null>(null);
  const [zcodeNote, setZcodeNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    zcodeCredentials()
      .then(async (creds) => {
        if (cancelled || !creds || creds.entries.length === 0) return;
        try {
          const enc = new TextEncoder();
          const keyMat = await crypto.subtle.digest('SHA-256', enc.encode(creds.secret));
          const key = await crypto.subtle.importKey('raw', keyMat, 'AES-GCM', false, ['decrypt']);
          const b64 = (v: string) =>
            Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
          let apiKey = '';
          let planAccount = '';
          for (const entry of creds.entries) {
            try {
              const plain = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: b64(entry.iv) },
                key,
                new Uint8Array([...b64(entry.ct), ...b64(entry.tag)]),
              );
              apiKey = new TextDecoder().decode(plain);
              planAccount = entry.key.split(':account:')[1]?.split(':')[0] ?? '';
              break;
            } catch {
              // try next entry
            }
          }
          if (cancelled || !apiKey) {
            if (!cancelled) setZcodeNote('ZCode detected but the key could not be decrypted');
            return;
          }
          setZcodeProvider({
            id: 'zcode-cloud',
            name: 'ZCode Cloud (GLM)' + (planAccount ? ' · ' + planAccount : ''),
            type: 'zcode',
            model: 'GLM-5.3-Flash',
            baseUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
            apiKey,
          });
        } catch (error) {
          if (!cancelled) setZcodeNote(error instanceof Error ? error.message : String(error));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);""", """  // ZCode Cloud (GLM) — detected automatically when ZCode desktop is installed.
  const [zcodeProvider, setZcodeProvider] = useState<ProviderEntry | null>(null);
  const [zcodeNote, setZcodeNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    detectZcodeGlm()
      .then((provider) => {
        if (!cancelled && provider) setZcodeProvider(provider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);""", 'shared detection')

# resolveEndpoint: zcode type
rep("""  if (entry.type === 'zai') return DEFAULT_ENDPOINTS.zai;""",
    """  if (entry.type === 'zai' || entry.type === 'zcode') return 'https://api.z.ai/api/coding/paas/v4/chat/completions';""", 'endpoint zcode')

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('AiAgentPanel uses shared detection')

# ---------------- AppSettingsScreen: zcode type + detect button ----------------
p = 'src/screens/settings/AppSettingsScreen.tsx'
s = open(p, encoding='utf-8').read()
def rep2(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# provider type select: add zcode option + detect button fills it
rep2("""                    <select
                      className="app-settings__control"
                      value={aiDraft.type}
                      onChange={(event) => setAiDraft({ ...aiDraft, type: event.target.value })}
                      aria-label="Provider type"
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">Ollama (local)</option>
                      <option value="custom">Custom</option>
                    </select>""", """                    <select
                      className="app-settings__control"
                      value={aiDraft.type}
                      onChange={(event) => setAiDraft({ ...aiDraft, type: event.target.value })}
                      aria-label="Provider type"
                    >
                      <option value="zcode">ZCode Cloud (GLM)</option>
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="ollama">Ollama (local)</option>
                      <option value="custom">Custom</option>
                    </select>""", 'type select zcode')

# Detect from ZCode button in the provider list header area
rep2("""                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button"
                    onClick={() => {
                      setAiEditingId(null);
                      setAiDraft({ id: '', name: '', type: 'openai', model: '', baseUrl: '', apiKey: '' });
                    }}
                  >
                    <Plus size={13} strokeWidth={1.5} />
                    Add provider
                  </button>
                </div>""", """                <div className="app-settings__inline">
                  <button
                    type="button"
                    className="app-settings__button"
                    onClick={() => {
                      setAiEditingId(null);
                      setAiDraft({ id: '', name: '', type: 'openai', model: '', baseUrl: '', apiKey: '' });
                    }}
                  >
                    <Plus size={13} strokeWidth={1.5} />
                    Add provider
                  </button>
                  <button
                    type="button"
                    className="app-settings__button app-settings__button--ghost"
                    onClick={async () => {
                      try {
                        const found = await detectZcodeGlm();
                        if (!found) {
                          notify('ZCode desktop not detected', 'error');
                          return;
                        }
                        const entry: AiProviderEntry = {
                          id: 'zcode-cloud',
                          name: found.name,
                          type: 'zcode',
                          model: found.model,
                          baseUrl: found.baseUrl,
                          apiKey: found.apiKey,
                        };
                        setProviders((list) =>
                          list.some((item) => item.id === entry.id)
                            ? list.map((item) => (item.id === entry.id ? entry : item))
                            : [...list, entry],
                        );
                        setActiveAiId(entry.id);
                        notify('ZCode Cloud (GLM) added from ZCode desktop', 'success');
                      } catch (error) {
                        notify(error instanceof Error ? error.message : String(error), 'error');
                      }
                    }}
                  >
                    <Sparkles size={12} strokeWidth={1.5} />
                    Detect from ZCode
                  </button>
                </div>""", 'detect button')

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('settings detect wired')
