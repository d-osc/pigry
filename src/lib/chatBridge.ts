/** Workspace → AI-chat context bridge. Workspace screens (Commit graph,
 * Merge branch, Rebase Branch, Push Commits, Cherry Pick, Branches) dispatch
 * `shareCommitWithChat` when the user opens a commit; the AI panel listens
 * for the event and attaches the commit as a context chip. Highlighted code
 * (คลุมดำ) is captured by the panel itself — no dispatch needed. */
export interface SharedCommit {
  oid: string;
  summary: string;
}

/** Attach a commit to the AI chat as context for the next message. */
export function shareCommitWithChat(commit: SharedCommit) {
  window.dispatchEvent(new CustomEvent('pigry:chat-commit', { detail: commit }));
}

/** Attach highlighted text to the AI chat. Used by the Monaco selection
 * bridge (diff editors don't fire DOM selection events). */
export function shareSelectionWithChat(detail: { text: string; path: string; source: string }) {
  window.dispatchEvent(new CustomEvent('pigry:chat-selection', { detail }));
}
