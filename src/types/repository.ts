/** Shared repository types — mirrors the Rust payloads in src-tauri/src/git_state.rs. */

export type ChangeStatus = 'M' | 'A' | 'D' | 'R';

export interface AccountInfo {
  initials: string;
  name: string;
  email: string;
}

export interface UpstreamInfo {
  name: string;
  ahead: number;
  behind: number;
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
}

export interface RemoteGroup {
  remote: string;
  branches: string[];
}

export interface StashInfo {
  index: number;
  message: string;
}

export interface ChangedFile {
  /** Stable row id: `<path>:staged|unstaged` */
  id: string;
  path: string;
  name: string;
  directory: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export interface TagInfo {
  name: string;
  commitOid: string | null;
  timeSeconds: number | null;
}

export interface RepositoryState {
  organization: string;
  name: string;
  /** "Local" when the repository has no remote; null otherwise. */
  visibility: string | null;
  localPath: string;
  currentBranch: string;
  upstream: UpstreamInfo | null;
  account: AccountInfo;
  files: ChangedFile[];
  branches: BranchInfo[];
  remotes: RemoteGroup[];
  tags: TagInfo[];
  tagTotal: number;
  stashes: StashInfo[];
}

export interface FileDiffContent {
  original: string | null;
  modified: string | null;
  binary: boolean;
  tooLarge: boolean;
  language: string;
}

export interface AppStatePayload {
  activePath: string | null;
  recent: string[];
  repository: RepositoryState | null;
}

export interface CommitOutcome {
  oid: string;
  state: AppStatePayload;
}

export interface CommitRow {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  authorInitials: string;
  timeSeconds: number;
  /** Lane index this commit sits on. */
  lane: number;
  /** Lane indices of its parents (2+ for merges). */
  parentLanes: number[];
  /** Active lanes entering this row (top edge) — for drawing. */
  activeBefore: number[];
  /** Active lanes leaving this row (bottom edge). */
  activeAfter: number[];
  isHead: boolean;
  isMerge: boolean;
  /** Branch labels pointing at this commit ("main", "origin/main"). */
  refs: string[];
}

export interface CommitHistory {
  total: number;
  truncated: boolean;
  commits: CommitRow[];
}

export interface FileTree {
  /** All visible file paths (tracked + untracked, ignored excluded). */
  entries: string[];
  /** Paths with pending changes, for status dots on the tree. */
  changedPaths: string[];
}

export interface WorktreeFileContent {
  content: string;
  binary: boolean;
  tooLarge: boolean;
  language: string;
}

export interface FileCommitEntry {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  authorInitials: string;
  timeSeconds: number;
}

export interface HunkInfo {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context: string;
  preview: string;
}

export interface NetResult {
  summary: string;
}

export interface CommitFileEntry {
  path: string;
  name: string;
  directory: string;
  /** M | A | D | R */
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitDetail {
  oid: string;
  shortOid: string;
  summary: string;
  /** Full message body. */
  message: string;
  authorName: string;
  authorInitials: string;
  timeSeconds: number;
  isMerge: boolean;
  files: CommitFileEntry[];
}
