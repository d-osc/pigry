import { useEffect, useState } from 'react';
import { EXTENSIONS_CHANGED, listExtensions } from '../lib/extensions';
import type { InstalledExtension } from '../lib/extensionManifest';
import { EXTENSIONS_CHANGED as CHANGED, readDisabledMenus } from '../lib/builtinExtensions';
import { QUICK_ACCESS_CHANGED, readQuickAccess } from '../lib/quickAccess';

/** The installed extensions, kept current when one is installed, switched or removed. */
export function useExtensions(): InstalledExtension[] {
  const [extensions, setExtensions] = useState<InstalledExtension[]>(() => listExtensions());
  useEffect(() => {
    const refresh = () => setExtensions(listExtensions());
    window.addEventListener(EXTENSIONS_CHANGED, refresh);
    return () => window.removeEventListener(EXTENSIONS_CHANGED, refresh);
  }, []);
  return extensions;
}

/** The menus pinned to the side bar's Quick access group, in order. */
export function useQuickAccess(): string[] {
  const [ids, setIds] = useState<string[]>(() => readQuickAccess());
  useEffect(() => {
    const refresh = () => setIds(readQuickAccess());
    window.addEventListener(QUICK_ACCESS_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(QUICK_ACCESS_CHANGED, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return ids;
}

/** The built-in extension menus the user switched off (they disappear from the side bar and the command palette). */
export function useDisabledMenus(): Set<string> {
  const [disabled, setDisabled] = useState<Set<string>>(() => readDisabledMenus());
  useEffect(() => {
    const refresh = () => setDisabled(readDisabledMenus());
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, []);
  return disabled;
}
