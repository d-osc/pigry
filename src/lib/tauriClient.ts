/** Typed wrappers around the Tauri commands defined in src-tauri/src/commands.rs. */
import { invoke } from '@tauri-apps/api/core';
import type {
  AppStatePayload,
  CommitHistory,
  CommitOutcome,
  FileDiffContent,
  FileTree,
  WorktreeFileContent,
} from '../types/repository';

/** True when running inside the Tauri webview (false in a plain browser). */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export async function getAppState(): Promise<AppStatePayload> {
  return invoke('get_app_state');
}

export async function openRepository(path: string): Promise<AppStatePayload> {
  return invoke('open_repository', { path });
}

/** Opens the OS folder picker; null when the user cancels. */
export async function pickRepository(): Promise<AppStatePayload | null> {
  return invoke('pick_repository');
}

export async function refresh(): Promise<AppStatePayload> {
  return invoke('refresh');
}

export async function stagePaths(paths: string[]): Promise<AppStatePayload> {
  return invoke('stage_paths', { paths });
}

export async function unstagePaths(paths: string[]): Promise<AppStatePayload> {
  return invoke('unstage_paths', { paths });
}

export async function discardFile(path: string): Promise<AppStatePayload> {
  return invoke('discard_file', { path });
}

export async function commitChanges(
  title: string,
  body: string,
  amend: boolean,
): Promise<CommitOutcome> {
  return invoke('commit', { title, body, amend });
}

export async function stashChanges(message?: string): Promise<AppStatePayload> {
  return invoke('stash_changes', { message: message ?? null });
}

export async function getFileDiff(
  path: string,
  staged: boolean,
): Promise<FileDiffContent> {
  return invoke('get_file_diff', { path, staged });
}

export async function getCommitHistory(
  includeRemotes: boolean,
): Promise<CommitHistory> {
  return invoke('get_commit_history', { includeRemotes });
}

export async function getFileTree(): Promise<FileTree> {
  return invoke('get_file_tree');
}

export async function readWorktreeFile(path: string): Promise<WorktreeFileContent> {
  return invoke('read_worktree_file', { path });
}

export async function writeWorktreeFile(path: string, content: string): Promise<void> {
  return invoke('write_worktree_file', { path, content });
}
