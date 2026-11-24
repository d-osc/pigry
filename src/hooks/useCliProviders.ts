import { useCallback, useEffect, useState } from 'react';
import type { AiProviderEntry } from '../lib/aiProviders';
import { CLI_FOCUS_RESCAN_MIN_MS, isCliScanning, CLI_PROVIDERS_CHANGED, CLI_RESCAN_INTERVAL_MS, isCliCacheFresh, readCliCache, saveCliEffort, saveCliModel, scanCliProviders, withChosenModels } from '../lib/cliProviders';

const cached = (): AiProviderEntry[] => withChosenModels(readCliCache()?.entries ?? []);

/** The "Provider CLI" providers. They come from the cache straight away; a scan only runs when the cache is missing or older than a day
 * (or on `rescan`). Every component using this hook updates when any of them scans or when a CLI model is picked. */
export function useCliProviders(): { providers: AiProviderEntry[]; scanning: boolean; scannedAt: number | null; rescan: () => Promise<void>; setModel: (id: string, model: string) => void; setEffort: (id: string, modelName: string, effort: string | undefined) => void } {
  const [providers, setProviders] = useState<AiProviderEntry[]>(cached);
  const [scannedAt, setScannedAt] = useState<number | null>(() => readCliCache()?.at ?? null);
  const [scanning, setScanning] = useState(isCliScanning);

  useEffect(() => {
    const sync = (): void => { setProviders(cached()); setScannedAt(readCliCache()?.at ?? null); setScanning(isCliScanning()); };
    window.addEventListener(CLI_PROVIDERS_CHANGED, sync);
    return () => window.removeEventListener(CLI_PROVIDERS_CHANGED, sync);
  }, []);

  const rescan = useCallback(async (): Promise<void> => {
    try { await scanCliProviders(); } catch { /* keep what we had */ }
  }, []);

  useEffect(() => {
    if (isCliCacheFresh(readCliCache(), Date.now())) return;
    queueMicrotask(() => { void rescan(); });
  }, [rescan]);

  // Keep the status current without the user asking: a timer, and — when a CLI is shown as not ready (not logged in) —
  // a rescan as soon as the window regains focus (the usual moment right after logging in in a terminal).
  useEffect(() => {
    const timer = window.setInterval(() => { void rescan(); }, CLI_RESCAN_INTERVAL_MS);
    const onFocus = (): void => {
      const cache = readCliCache();
      if (cache && cache.entries.some((e) => e.usable === false) && Date.now() - cache.at > CLI_FOCUS_RESCAN_MIN_MS) void rescan();
    };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [rescan]);

  return { providers, scanning, scannedAt, rescan, setModel: saveCliModel, setEffort: saveCliEffort };
}
