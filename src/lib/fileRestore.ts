/** Explorer File history "Restore": pure rules for taking one file back to
 * its content at an earlier commit. */
import type { FileCommitEntry } from '../types/repository';

type CommitRef = Pick<FileCommitEntry, 'shortOid' | 'path' | 'deleted'>;

export interface RestoreDirtyState {
  /** The editor buffer has edits that are not saved to disk. */
  unsavedEdits: boolean;
  /** The file is listed in working changes (staged or unstaged). */
  workingChange: boolean;
}

/** The file's path in that commit (an older name before a rename). */
export function restoreSourcePath(path: string, commit: Pick<FileCommitEntry, 'path'>): string {
  return commit.path || path;
}

/** A commit that deleted the file has no content to restore. */
export function canRestoreFromCommit(commit: Pick<FileCommitEntry, 'deleted'>): boolean {
  return !commit.deleted;
}

/** Restoring overwrites the working file, so ask first when that loses work. */
export function restoreNeedsConfirm(state: RestoreDirtyState): boolean {
  return state.unsavedEdits || state.workingChange;
}

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

export function restoreConfirmMessage(path: string, commit: CommitRef, state: RestoreDirtyState): string {
  const lost = state.unsavedEdits && state.workingChange
    ? 'your unsaved edits and uncommitted changes'
    : state.unsavedEdits
      ? 'your unsaved edits'
      : 'your uncommitted changes';
  return `Restore ${baseName(path)} to ${commit.shortOid}? This replaces ${lost} to this file.`;
}

export function restoreButtonTitle(path: string, commit: CommitRef): string {
  if (!canRestoreFromCommit(commit)) return `${commit.shortOid} deleted this file — nothing to restore`;
  const source = restoreSourcePath(path, commit);
  const from = source === path ? '' : ` (from ${source})`;
  return `Revert ${baseName(path)} to this version${from}. Only this file changes; nothing is committed.`;
}

export function restoreToastMessage(
  path: string,
  result: { sourcePath: string; shortOid: string; binary: boolean },
): string {
  const renamed = result.sourcePath && result.sourcePath !== path ? ` (was ${result.sourcePath})` : '';
  const binary = result.binary ? ' binary file' : '';
  return `Restored${binary} ${baseName(path)} from commit ${result.shortOid}${renamed}. It is now an unstaged change.`;
}
