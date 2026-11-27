import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { browserDevtools, listInstalledBrowsers, type InstalledBrowser } from '../../lib/tauriClient';
import { browserLabel, engineOf, getSelectedBrowser, resolveBrowser, setSelectedBrowser } from './engine/browsers';

/** The backend starts on Auto; tell it the saved choice once per app run. */
let synced = false;

/** Cypress's browser list: which installed browser the specs, the Selector Playground and Studio use. */
export function E2eBrowserPicker({ disabled, onLabel, onKind }: { disabled: boolean; onLabel?: (label: string) => void; onKind?: (family: string, engine: string) => void }) {
  const [list, setList] = useState<InstalledBrowser[] | null>(null);
  const [id, setId] = useState(getSelectedBrowser);

  useEffect(() => {
    let cancelled = false;
    listInstalledBrowsers().then((found) => { if (!cancelled) setList(found); }).catch(() => { if (!cancelled) setList([]); });
    if (!synced) {
      synced = true;
      const saved = getSelectedBrowser();
      if (saved) void browserDevtools('browser', { js: saved }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, []);

  const chosen = list ? resolveBrowser(list, id) : undefined;
  const label = chosen ? browserLabel(chosen) : 'Test browser';
  useEffect(() => { onLabel?.(label); }, [label, onLabel]);
  const family = chosen?.family ?? 'chromium';
  const engine = engineOf(chosen);
  useEffect(() => { onKind?.(family, engine); }, [family, engine, onKind]);

  const pick = (next: string) => {
    setId(next);
    setSelectedBrowser(next);
    // a different browser closes the open test window; the next run or page opens the new one
    void browserDevtools('browser', { js: next }).catch(() => undefined);
  };

  const missing = !!id && !!list && !list.some((b) => b.id === id);
  const auto = list ? resolveBrowser(list, '') : undefined;
  return (
    <label className={`e2e-browser${missing ? ' e2e-browser--missing' : ''}`} title={chosen ? `${chosen.displayName} ${chosen.version}\n${chosen.path}` : 'The browser the specs run in'}>
      <Globe size={12} aria-hidden="true" />
      <select aria-label="Browser" value={id} disabled={disabled || list === null} onChange={(e) => pick(e.target.value)}>
        <option value="">{auto ? `Auto (${browserLabel(auto)})` : 'Auto'}</option>
        {list?.filter((b) => engineOf(b) !== 'playwright').map((b) => <option key={b.id} value={b.id}>{browserLabel(b)}</option>)}
        {list?.some((b) => engineOf(b) === 'playwright') && (
          <optgroup label="Playwright">
            {list.filter((b) => engineOf(b) === 'playwright').map((b) => <option key={b.id} value={b.id}>{browserLabel(b)}</option>)}
          </optgroup>
        )}
        {missing && <option value={id}>{id} (not installed)</option>}
      </select>
    </label>
  );
}
