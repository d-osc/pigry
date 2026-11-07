/** Typed wrappers around the Tauri commands defined in src-tauri/src/commands.rs. */
import { invoke } from '@tauri-apps/api/core';
import type {
  AppStatePayload,
  CommitDetail,
  CommitHistory,
  CommitOutcome,
  FileCommitEntry,
  FileDiffContent,
  FileTree,
  BlameLine,
  HunkInfo,
  LineChange,
  NetResult,
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

export async function getFileHistory(path: string): Promise<FileCommitEntry[]> {
  return invoke('get_file_history', { path });
}

export async function readFileAtCommit(
  path: string,
  oid: string,
): Promise<WorktreeFileContent> {
  return invoke('read_file_at_commit', { path, oid });
}

export type NetResultLike = NetResult;

export async function gitFetch(): Promise<NetResult> {
  return invoke('git_fetch');
}

export async function gitPull(): Promise<NetResult> {
  return invoke('git_pull');
}

export async function gitPush(): Promise<NetResult> {
  return invoke('git_push');
}

export async function getCommitDetail(oid: string): Promise<CommitDetail> {
  return invoke('get_commit_detail', { oid });
}

export async function getCommitFileDiff(
  oid: string,
  path: string,
): Promise<FileDiffContent> {
  return invoke('get_commit_file_diff', { oid, path });
}

export async function createBranch(name: string, checkout: boolean): Promise<AppStatePayload> {
  return invoke('create_branch', { name, checkout });
}

export async function checkoutBranch(name: string): Promise<AppStatePayload> {
  return invoke('checkout_branch', { name });
}

export async function deleteBranch(name: string): Promise<AppStatePayload> {
  return invoke('delete_branch', { name });
}

export async function createTag(name: string): Promise<AppStatePayload> {
  return invoke('create_tag', { name });
}

export async function deleteTag(name: string): Promise<AppStatePayload> {
  return invoke('delete_tag', { name });
}

export async function stashApply(index: number): Promise<AppStatePayload> {
  return invoke("stash_apply", { index });
}

export async function stashPop(index: number): Promise<AppStatePayload> {
  return invoke("stash_pop", { index });
}

export async function stashDrop(index: number): Promise<AppStatePayload> {
  return invoke("stash_drop", { index });
}

export async function getFileHunks(
  path: string,
  staged: boolean,
): Promise<HunkInfo[]> {
  return invoke("get_file_hunks", { path, staged });
}

export async function stageHunk(path: string, hunkIndex: number): Promise<AppStatePayload> {
  return invoke('stage_hunk', { path, hunkIndex });
}

export async function unstageHunk(
  path: string,
  hunkIndex: number,
): Promise<AppStatePayload> {
  return invoke('unstage_hunk', { path, hunkIndex });
}

export async function discardHunk(
  path: string,
  hunkIndex: number,
): Promise<AppStatePayload> {
  return invoke('discard_hunk', { path, hunkIndex });
}

export async function getFileBlame(path: string): Promise<BlameLine[]> {
  return invoke('get_file_blame', { path });
}

export async function getLineChanges(path: string): Promise<LineChange[]> {
  return invoke('get_line_changes', { path });
}

export async function revertCommit(oid: string): Promise<AppStatePayload> {
  return invoke('revert_commit', { oid });
}

export async function cherryPick(oid: string): Promise<AppStatePayload> {
  return invoke('cherry_pick', { oid });
}

export async function mergeBranch(branch: string): Promise<AppStatePayload> {
  return invoke('merge_branch', { branch });
}
