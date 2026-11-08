p = 'src/screens/explorer/AiAgentPanel.tsx'
s = open(p, encoding='utf-8').read()
def rep(old, new, what):
    global s
    assert old in s, 'missing: ' + what
    s = s.replace(old, new, 1)

# imports cleanup: drop unused constants from lib/zcode
rep("import { detectZcodeGlm, ZCODE_DEFAULT_MODEL, ZCODE_CHAT_ENDPOINT } from '../../lib/zcode';",
    "import { detectZcodeGlm } from '../../lib/zcode';", 'imports cleanup')

# setZcodeNote → remove (unused); detection: map to ProviderEntry shape
rep("  const [zcodeProvider, setZcodeProvider] = useState<ProviderEntry | null>(null);\n  const [zcodeNote, setZcodeNote] = useState('');",
    "  const [zcodeProvider, setZcodeProvider] = useState<ProviderEntry | null>(null);", 'drop note state')

rep("""          if (cancelled || !apiKey) {
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
          });""", """          if (cancelled || !apiKey) return;
          setZcodeProvider({
            id: 'zcode-cloud',
            name: 'ZCode Cloud (GLM)' + (planAccount ? ' · ' + planAccount : ''),
            type: 'zcode',
            model: 'GLM-5.3-Flash',
            baseUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
            apiKey,
          });""", 'provider entry')

# error catch also unused note → drop
rep("""        } catch (error) {
          if (!cancelled) setZcodeNote(error instanceof Error ? error.message : String(error));
        }
      })
      .catch(() => {});""", """        } catch {
          // decryption failed — leave provider undetected
        }
      })
      .catch(() => {});""", 'catch cleanup')

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('panel cleaned')
