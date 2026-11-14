/** One-time localStorage migration — the app was renamed from pigry to
 * pigry, so every persisted `pigry:*` key (settings, agents, chats,
 * providers, tools, theme, …) moves to its `pigry:*` counterpart.
 * Old entries are kept untouched as a backup; new writes go to pigry keys. */
const LEGACY_PREFIX = 'pigry:';
const NEW_PREFIX = 'pigry:';

export function migrateLegacyStorage(): void {
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }
    for (const oldKey of legacyKeys) {
      const newKey = NEW_PREFIX + oldKey.slice(LEGACY_PREFIX.length);
      // Never overwrite data already written under the new name.
      if (localStorage.getItem(newKey) !== null) continue;
      const value = localStorage.getItem(oldKey);
      if (value !== null) localStorage.setItem(newKey, value);
    }
  } catch {
    // storage unavailable — nothing to migrate
  }
}
