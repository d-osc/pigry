/** File watchers must not replace a user-edited buffer. */
export function mayReloadBuffer(path: string, loadedPath: string | undefined, draft: string, saved: string | undefined) {
  return loadedPath !== path || draft === saved;
}
export function savedBufferIsDirty(currentDraft: string, writtenSnapshot: string) {
  return currentDraft !== writtenSnapshot;
}
