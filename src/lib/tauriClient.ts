/** Typed wrappers around the Tauri commands defined in src-tauri/src/commands.rs. */
import { invoke } from '@tauri-apps/api/core';
import { memoryScope } from './teamStore';
import type {
  AppStatePayload,
  CodeSearchHit,
  TerminalOutput,
  CommitDetail,
  CommitHistory,
  CommitOutcome,
  FileCommitEntry,
  FileDiffContent,
  FileTree,
  BlameLine,
  HunkInfo,
  LineChange,
  RepoStats,
  NetResult,
  GitUserInfo,
  RemoteEntry,
  RebaseStep,
  ComposedCommitMessage,
  WorktreeFileContent,
  GhAccount,
  GhPrDetail,
  GhReleaseDetail,
  GhAuthStatus,
  GhIssue,
  GhIssueDetail,
  GhPullRequest,
  GhRelease,
  GhProject,
  GhProjectItem,
  GhCodeAlert,
  GhDependabotAlert,
  GhSecretAlert,
  GhCheckRun,
  GhWorkflow,
  GhRunPage,
  GhRunDetail,
  GhRunArtifact,
  WikiCommit,
  WikiPage,
  WikiPageContent,
  WikiStatus,
  InsightsData,
  GhDeliveryStats,
  GhTraffic,
} from '../types/repository';
import {
  demoAppState,
  demoSearchCode,
  demoCommitDetail,
  demoFileContent,
  demoHistory,
  demoStats,
  demoTree,
} from './demoWorkspace';

/** True when running inside the Tauri webview (false in a plain browser). */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * In a plain browser the Tauri bridge does not exist. Read endpoints return
 * the demo fixture from the design file so `npm run dev` previews the UI;
 * mutating endpoints resolve as no-ops against the same fixture.
 */
export async function getAppState(): Promise<AppStatePayload> {
  if (!isTauri()) return demoAppState;
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
  if (!isTauri()) return demoAppState;
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
  if (!isTauri()) return demoHistory;
  return invoke('get_commit_history', { includeRemotes });
}

export async function getFileTree(): Promise<FileTree> {
  if (!isTauri()) return demoTree;
  return invoke('get_file_tree');
}

export async function ghPrList(): Promise<GhPullRequest[]> {
  if (!isTauri()) return [];
  return invoke('gh_pr_list');
}

// ---- GitHub Actions (workflow runs via gh) ----

export async function ghWorkflowList(): Promise<GhWorkflow[]> {
  if (!isTauri()) return [];
  return invoke('gh_workflow_list');
}

export async function ghRunList(limit = 50): Promise<GhRunPage> {
  if (!isTauri()) return { runs: [], total: 0 };
  return invoke('gh_run_list', { limit });
}

export async function ghRunView(runId: number): Promise<GhRunDetail | null> {
  if (!isTauri()) return null;
  return invoke('gh_run_view', { runId });
}

/** Full log of the run, or of a single job (jobId omitted → whole run). */
export async function ghRunLogs(runId: number, jobId?: number): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('gh_run_logs', { runId, jobId: jobId ?? null });
}

export async function ghRunRerun(runId: number, failedOnly: boolean): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot re-run workflows — run the desktop app');
  return invoke('gh_run_rerun', { runId, failedOnly });
}

export async function ghRunCancel(runId: number): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot cancel runs — run the desktop app');
  return invoke('gh_run_cancel', { runId });
}

/** Triggers a `workflow_dispatch` event for the workflow file on the given ref. */
export async function ghWorkflowDispatch(workflowPath: string, refName: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot run workflows — run the desktop app');
  return invoke('gh_workflow_dispatch', { workflowPath, refName });
}

export async function ghRunArtifacts(runId: number): Promise<GhRunArtifact[]> {
  if (!isTauri()) return [];
  return invoke('gh_run_artifacts', { runId });
}

/** Downloads one artifact into the OS temp folder; resolves to the folder path. */
export async function ghRunDownloadArtifact(runId: number, name: string): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot download artifacts — run the desktop app');
  return invoke<string>('gh_run_download_artifact', { runId, name });
}

export async function ghIssueList(): Promise<GhIssue[]> {
  if (!isTauri()) return [];
  return invoke('gh_issue_list');
}

export async function ghIssueView(number: number): Promise<GhIssueDetail> {
  if (!isTauri()) throw new Error('Browser preview cannot view issues — run the desktop app');
  return invoke('gh_issue_view', { number });
}

export async function ghIssueComment(number: number, body: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot post comments — run the desktop app');
  return invoke('gh_issue_comment', { number, body });
}

export async function ghIssueCreate(title: string, body: string): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot create issues — run the desktop app');
  return invoke<string>('gh_issue_create', { title, body });
}

export async function ghIssueClose(number: number): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot close issues — run the desktop app');
  return invoke('gh_issue_close', { number });
}

export async function ghIssueReopen(number: number): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot reopen issues — run the desktop app');
  return invoke('gh_issue_reopen', { number });
}

/* ---- Wiki (git repo at <origin>.wiki.git) ---- */

export async function wikiCheck(): Promise<WikiStatus> {
  if (!isTauri()) return { supported: false, hasWiki: false, url: '', cached: false };
  return invoke('wiki_check');
}

export async function wikiSync(): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot sync the wiki — run the desktop app');
  return invoke('wiki_sync');
}

export async function wikiList(): Promise<WikiPage[]> {
  if (!isTauri()) return [];
  return invoke('wiki_list');
}

export async function wikiRead(file: string): Promise<WikiPageContent> {
  if (!isTauri()) throw new Error('Browser preview cannot read the wiki — run the desktop app');
  return invoke('wiki_read', { file });
}

export async function wikiPageHistory(file: string): Promise<WikiCommit[]> {
  if (!isTauri()) return [];
  return invoke('wiki_page_history', { file });
}

export async function wikiSave(
  file: string,
  content: string,
  message: string,
): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot edit the wiki — run the desktop app');
  return invoke<string>('wiki_save', { file, content, message });
}

export async function wikiCreate(
  file: string,
  content: string,
  message: string,
): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot create the wiki — run the desktop app');
  return invoke<string>('wiki_create', { file, content, message });
}

export async function ghReleaseList(): Promise<GhRelease[]> {
  if (!isTauri()) return [];
  return invoke('gh_release_list');
}

export async function ghProjectList(): Promise<GhProject[]> {
  if (!isTauri()) return [];
  return invoke('gh_project_list');
}

export async function ghProjectItemList(projectNumber: number): Promise<GhProjectItem[]> {
  if (!isTauri()) return [];
  return invoke('gh_project_item_list', { projectNumber });
}

export async function ghCodeScanningAlerts(): Promise<GhCodeAlert[]> {
  if (!isTauri()) return [];
  return invoke('gh_code_scanning_alerts');
}

export async function ghDismissCodeAlert(number: number, reason: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot dismiss alerts — run the desktop app');
  return invoke('gh_code_alert_dismiss', { number, reason });
}

export async function ghDependabotAlerts(): Promise<GhDependabotAlert[]> {
  if (!isTauri()) return [];
  return invoke('gh_dependabot_alerts');
}

export async function ghSecretScanningAlerts(): Promise<GhSecretAlert[]> {
  if (!isTauri()) return [];
  return invoke('gh_secret_scanning_alerts');
}

export async function ghBranchCheckRuns(branch: string): Promise<GhCheckRun[]> {
  if (!isTauri()) return [];
  return invoke('gh_branch_check_runs', { branch });
}

export async function getCommitOidSet(
  refName?: string | null,
  path?: string | null,
  exclude?: string | null,
): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('get_commit_oid_set', {
    refName: refName ?? null,
    path: path ?? null,
    exclude: exclude ?? null,
  });
}

export async function ghReleaseView(tag: string): Promise<GhReleaseDetail | null> {
  if (!isTauri()) return null;
  return invoke('gh_release_view', { tag });
}

export async function ghReleaseCreate(
  tag: string,
  title: string,
  notes: string,
  target: string,
  draft: boolean,
  prerelease: boolean,
): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot create releases — run the desktop app');
  return invoke<string>('gh_release_create', { tag, title, notes, target, draft, prerelease });
}

export async function ghReleaseEdit(tag: string, title: string, notes: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot edit releases — run the desktop app');
  return invoke('gh_release_edit', { tag, title, notes });
}

export async function ghReleaseDelete(tag: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot delete releases — run the desktop app');
  return invoke('gh_release_delete', { tag });
}

export async function ghPrDetail(number: number): Promise<GhPrDetail | null> {
  if (!isTauri()) return null;
  return invoke('gh_pr_detail', { number });
}

export async function ghPrDiff(number: number): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('gh_pr_diff', { number });
}

export async function ghPrComment(number: number, body: string): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot post comments — run the desktop app');
  return invoke('gh_pr_comment', { number, body });
}

export async function ghPrReview(
  number: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body?: string,
): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot submit reviews — run the desktop app');
  return invoke('gh_pr_review', { number, event, body: body ?? null });
}

export async function ghPrCheckout(number: number): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot check out PRs — run the desktop app');
  return invoke<string>('gh_pr_checkout', { number });
}

export async function ghPrCreate(
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<string> {
  if (!isTauri()) throw new Error('Browser preview cannot create PRs — run the desktop app');
  return invoke<string>('gh_pr_create', { title, body, head, base });
}

export async function ghPrClose(number: number): Promise<void> {
  if (!isTauri()) throw new Error('Browser preview cannot close PRs — run the desktop app');
  return invoke('gh_pr_close', { number });
}

export interface GhDeviceStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
}

export interface GhDevicePoll {
  status: 'pending' | 'success' | 'error';
  account: string;
  error: string;
}

export async function ghDeviceFlowStart(scopes: string[]): Promise<GhDeviceStart> {
  if (!isTauri()) throw new Error('Browser preview cannot update gh scopes — run the desktop app');
  return invoke('gh_device_flow_start', { scopes });
}

export async function ghDeviceFlowPoll(deviceCode: string): Promise<GhDevicePoll> {
  return invoke('gh_device_flow_poll', { deviceCode });
}

export async function ghInstall(): Promise<string> {
  return invoke<string>('gh_install');
}

export async function ghTokenScopes(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<{ scopes: string[] }>('gh_token_scopes').then((result) => result.scopes);
}

export async function ghOpenUrl(url: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('gh_open_url', { url });
}

/** Proxies an OpenAI-compatible chat completion through the Rust/curl bridge. */
export interface CliDetectResult {
  claude: boolean;
  codex: boolean;
  claudeVersion: string;
  codexVersion: string;
}

/** Detect installed CLI coding agents (claude / codex). */
export async function cliDetect(): Promise<CliDetectResult> {
  if (!isTauri()) return { claude: false, codex: false, claudeVersion: '', codexVersion: '' };
  return invoke('cli_detect');
}

/** Runs a prompt through claude / codex (blocking until the agent finishes). */
export async function cliAgentRun(cli: 'claude' | 'codex', prompt: string): Promise<string> {
  if (!isTauri()) throw new Error('CLI agents require the desktop app');
  return invoke<string>('cli_agent_run', { cli, prompt });
}

export interface ZcodeEntry {
  key: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface ZcodeCreds {
  secret: string;
  entries: ZcodeEntry[];
  exeFound: boolean;
}

/** Reads ZCode's encrypted credential entries (decrypt in the frontend). */
export async function zcodeCredentials(): Promise<ZcodeCreds | null> {
  if (!isTauri()) return null;
  return invoke('zcode_credentials');
}

export async function aiChat(
  url: string,
  apiKey: string,
  body: string,
  auth?: 'bearer' | 'anthropic',
): Promise<{ ok: boolean; status: number; body: string; error: string }> {
  if (!isTauri()) throw new Error('AI requires the desktop app — browser preview has no backend');
  return invoke('ai_chat', { url, apiKey, body, auth: auth ?? null });
}

export async function ghAccountList(): Promise<GhAccount[]> {
  if (!isTauri()) return [];
  return invoke('gh_account_list');
}

export async function ghSwitchAccount(account: string): Promise<void> {
  return invoke('gh_switch_account', { account });
}

export async function ghLoginWithToken(token: string): Promise<GhAuthStatus> {
  return invoke('gh_login_with_token', { token });
}

export async function ghLogout(account: string): Promise<void> {
  return invoke('gh_logout', { account });
}

export async function ghAuthStatus(): Promise<GhAuthStatus> {
  if (!isTauri()) return { loggedIn: false, account: '' };
  return invoke('gh_auth_status');
}

export async function searchCode(query: string): Promise<CodeSearchHit[]> {
  if (!isTauri()) return demoSearchCode(query);
  return invoke('search_code', { query });
}

export async function terminalRun(command: string, cwd: string): Promise<TerminalOutput> {
  if (!isTauri()) {
    return {
      stdout: `Browser preview cannot run commands — launch the desktop app.
$ ${command}`,
      stderr: '',
      code: 0,
      cwd,
    };
  }
  return invoke('terminal_run', { command, cwd });
}

export async function readBinaryFile(
  path: string,
): Promise<{ data: string; mime: string; size: number }> {
  return invoke('read_binary_file', { path });
}

export async function openPathExternal(path: string): Promise<void> {
  return invoke('open_path_external', { path });
}

export async function readWorktreeFile(path: string): Promise<WorktreeFileContent> {
  if (!isTauri()) return demoFileContent;
  return invoke('read_worktree_file', { path });
}

export async function writeWorktreeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('write_worktree_file', { path, content });
}

export async function deleteWorktreeFile(path: string): Promise<void> {  if (!isTauri()) return;
  return invoke('delete_worktree_file', { path });
}

export async function renameWorktreeFile(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('rename_worktree_file', { oldPath, newPath });
}

export async function deleteWorktreeFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('delete_worktree_folder', { path });
}

export async function renameWorktreeFolder(oldPath: string, newPath: string): Promise<void> {
  if (!isTauri()) return;
  return invoke('rename_worktree_folder', { oldPath, newPath });
}

export async function getFileHistory(
  path: string,
  refName?: string | null,
): Promise<FileCommitEntry[]> {
  if (!isTauri()) return [];
  return invoke('get_file_history', { path, refName: refName ?? null });
}

export async function readFileAtCommit(
  path: string,
  oid: string,
): Promise<WorktreeFileContent> {
  if (!isTauri()) return demoFileContent;
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
  if (!isTauri()) return demoCommitDetail(oid);
  return invoke('get_commit_detail', { oid });
}

export async function getCommitFileDiff(
  oid: string,
  path: string,
): Promise<FileDiffContent> {
  if (!isTauri()) {
    // Design fixture: the keyboard.ts shortcut refactor from the Figma file.
    const filler = [
      '',
      'const isMac = () => navigator.platform.toLowerCase().includes("mac");',
      '',
      'function matchesShortcut(event: KeyboardEvent, shortcut: string) {',
      '  const parts = shortcut.split("+");',
      '  const key = parts[parts.length - 1].toLowerCase();',
      '  const wantsMeta = parts.includes("Mod");',
      '  const modifier = isMac() ? event.metaKey : event.ctrlKey;',
      '  return key === event.key.toLowerCase() && modifier === wantsMeta;',
      '}',
      '',
      'export function shortcutLabel(shortcut: string) {',
      '  return isMac() ? shortcut.replace("Mod", "⌘") : shortcut.replace("Mod", "Ctrl");',
      '}',
      '',
    ];
    const original = [
      'export function isCommandShortcut(event: KeyboardEvent) {',
      '  return event.ctrlKey && event.key === "k";',
      '}',
      ...filler,
      'export function registerShortcuts(commands: Command[]) {',
      '  const handleKeyDown = (event: KeyboardEvent) => {',
      '    if (event.target instanceof HTMLInputElement) return;',
      '    const command = commands.find(({ shortcut }) =>',
      '      matchesShortcut(event, shortcut)',
      '    );',
      '    if (!command) return;',
      '    command.execute();',
      '  };',
      '}',
    ].join('\n');
    const modified = [
      'export function isCommandShortcut(event: KeyboardEvent) {',
      '  const modifier = isMac() ? event.metaKey : event.ctrlKey;',
      '  return modifier && event.key.toLowerCase() === "k";',
      '}',
      ...filler,
      'export function registerShortcuts(commands: Command[]) {',
      '  const handleKeyDown = (event: KeyboardEvent) => {',
      '    const target = event.target as HTMLElement;',
      '    const isEditing = target.matches("input, textarea")',
      '      || target.isContentEditable;',
      '    if (isEditing && !isCommandShortcut(event)) return;',
      '    const command = commands.find(({ shortcut }) =>',
      '      matchesShortcut(event, shortcut)',
      '    );',
      '    if (!command) return;',
      '    event.preventDefault();',
      '    command.execute();',
      '  };',
      '}',
    ].join('\n');
    return {
      original,
      modified,
      binary: false,
      tooLarge: false,
      language: 'TypeScript',
    };
  }
  return invoke('get_commit_file_diff', { oid, path });
}

export async function createBranch(name: string, checkout: boolean): Promise<AppStatePayload> {
  if (!isTauri()) return demoAppState; // browser preview — pretend it worked
  return invoke('create_branch', { name, checkout });
}

export async function checkoutBranch(name: string): Promise<AppStatePayload> {
  if (!isTauri()) return demoAppState;
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

export async function getFileBlame(
  path: string,
  refName?: string | null,
): Promise<BlameLine[]> {
  if (!isTauri()) return [];
  return invoke('get_file_blame', { path, refName: refName ?? null });
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

export async function mergeBranch(
  branch: string,
  strategy?: string,
): Promise<AppStatePayload> {
  return invoke('merge_branch', { branch, strategy: strategy ?? null });
}

export async function mergeAbort(): Promise<AppStatePayload> {
  return invoke('merge_abort');
}

export interface MergeStatusInfo {
  inProgress: boolean;
  conflicted: string[];
}

export interface MergePreviewCommit {
  oid: string;
  shortOid: string;
  summary: string;
  authorName: string;
  timeSeconds: number;
}

export interface MergePreviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface MergePreview {
  upToDate: boolean;
  commits: MergePreviewCommit[];
  files: MergePreviewFile[];
}

export async function mergePreview(branch: string): Promise<MergePreview> {
  return invoke('merge_preview', { branch });
}

export async function mergeStatus(): Promise<MergeStatusInfo> {
  return invoke('merge_status');
}

export async function cloneRepo(url: string, target: string): Promise<AppStatePayload> {
  return invoke('clone_repo', { url, target });
}

export async function rebaseOnto(base: string): Promise<AppStatePayload> {
  return invoke('rebase_onto', { base });
}

export async function getRepoStats(): Promise<RepoStats> {
  if (!isTauri()) return demoStats;
  return invoke('get_repo_stats');
}

export async function verifyCommitSig(oid: string): Promise<string> {
  return invoke('verify_commit_sig', { oid });
}

export async function getUserInfo(): Promise<GitUserInfo> {
  return invoke('get_user_info');
}

export async function setUserInfo(name: string, email: string): Promise<AppStatePayload> {
  return invoke('set_user_info', { name, email });
}

export async function listRemotes(): Promise<RemoteEntry[]> {
  return invoke('list_remotes');
}

export async function addRemote(name: string, url: string): Promise<AppStatePayload> {
  return invoke('add_remote', { name, url });
}

export async function removeRemote(name: string): Promise<AppStatePayload> {
  return invoke('remove_remote', { name });
}

export async function setRemoteUrl(name: string, url: string): Promise<AppStatePayload> {
  return invoke('set_remote_url', { name, url });
}

export async function interactiveRebase(
  base: string,
  steps: RebaseStep[],
): Promise<AppStatePayload> {
  return invoke('interactive_rebase', { base, steps });
}

export async function abortRebase(): Promise<AppStatePayload> {
  return invoke('abort_rebase');
}

export async function stageLines(
  path: string,
  side: 'staged' | 'unstaged',
  selectedOld: number[],
  selectedNew: number[],
): Promise<AppStatePayload> {
  return invoke('stage_lines', { path, side, selectedOld, selectedNew });
}

export async function composeCommitMessage(): Promise<ComposedCommitMessage> {
  return invoke('compose_commit_message');
}

// ---- Insights ----

/** Git-history analytics for the Insights screen (local, offline). */
export async function getInsights(days = 28): Promise<InsightsData> {
  if (!isTauri()) {
    // Browser preview has no git bridge — an empty payload shows the
    // screen's real empty state instead of fixture numbers.
    return {
      headBranch: '',
      nowSeconds: Date.now() / 1000,
      periodDays: days,
      commits: 0,
      prevCommits: 0,
      contributors: 0,
      prevContributors: 0,
      additions: 0,
      deletions: 0,
      weekly: [],
      prevWeekly: [],
      days: [],
      people: [],
      recent: [],
      lineCommitsScanned: 0,
      lineCommitsTotal: 0,
    };
  }
  return invoke('get_insights', { days });
}

/** PR/issue delivery metrics via gh; throws when gh is unavailable. */
export async function ghDeliveryStats(days = 28): Promise<GhDeliveryStats> {
  if (!isTauri()) throw new Error('gh not available in browser preview');
  return invoke('gh_delivery_stats', { days });
}

/** Repository traffic (views/clones, 14 days); needs a GitHub remote + push access. */
export async function ghTraffic(): Promise<GhTraffic> {
  if (!isTauri()) throw new Error('gh not available in browser preview');
  return invoke('gh_traffic');
}

/** ---- Vector-backed project memory (.orbit/memory.vector.json) ---- */

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  createdAt: number;
}

export interface MemoryHit {
  id: string;
  text: string;
  score: number;
  createdAt: number;
}

export async function memoryList(team?: string, agent?: string): Promise<MemoryEntry[]> {
  return invoke('memory_list', { scope: memoryScope(team, agent) ?? null });
}

export async function memoryAdd(
  text: string,
  team?: string,
  agent?: string,
): Promise<MemoryEntry> {
  return invoke('memory_add', { scope: memoryScope(team, agent) ?? null, text });
}

export async function memoryRemove(id: string, team?: string, agent?: string): Promise<void> {
  return invoke('memory_remove', { scope: memoryScope(team, agent) ?? null, id });
}

export async function memorySearch(
  query: string,
  limit = 5,
  team?: string,
  agent?: string,
): Promise<MemoryHit[]> {
  return invoke('memory_search', { scope: memoryScope(team, agent) ?? null, query, limit });
}
