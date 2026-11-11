/** Shared repository types — mirrors the Rust payloads in src-tauri/src/git_state.rs. */

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C';

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
  /** Current HEAD commit oid; null on an unborn branch. */
  headOid: string | null;
  /** True while an interactive/regular rebase is mid-flight. */
  rebaseInProgress: boolean;
  submodules: SubmoduleInfo[];
  worktrees: WorktreeInfo[];
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  /** Absolute path of the submodule worktree, for opening it as a workspace. */
  absPath: string;
  url: string;
  /** True when the checked-out commit differs from the recorded one. */
  dirty: boolean;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  /** True when this worktree is the currently open workspace. */
  isCurrent: boolean;
}

export type RebaseAction = 'pick' | 'squash' | 'drop';

export interface RebaseStep {
  oid: string;
  action: RebaseAction;
}

export interface ComposedCommitMessage {
  title: string;
  body: string;
}

/** Wire protocol an AI provider speaks. */
export type AiApiFormat = 'openai' | 'anthropic';

/** One model inside a provider's model list. */
export interface AiModelEntry {
  id: string;
  name: string;
  /** Capability badge, e.g. "1M" / "128K" — display only. */
  context?: string;
  /** Context window in tokens. */
  contextWindow?: number;
  /** Max output tokens — sent as the request's max_tokens when set. */
  maxOutputTokens?: number;
  /** Supports image attachments. */
  vision: boolean;
  /** Input kinds the model accepts: 'text' (always) | 'image' | 'video' | 'pdf'. */
  inputTypes?: string[];
  /** Capability flags: 'structured-output' | 'native-web-search' | 'mid-conversation-system'. */
  capabilities?: string[];
  /** Reasoning levels, ordered low → high. */
  reasoningLevels?: string[];
  /** JSON mapping reasoning level → provider parameter value. */
  reasoningMapping?: string;
  /** Metadata auto-filled from the built-in model registry. */
  smartConfig?: boolean;
  /** Selectable during chat. */
  enabled: boolean;
}

/** A chat provider: built-in (Z.ai / Start Plan) or user-added custom. */
export interface AiProviderEntry {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  /** Legacy discriminator ('zcode' | 'openai' | 'claude-code' | …). */
  type: string;
  apiFormat: AiApiFormat;
  baseUrl: string;
  apiKey: string;
  /** Legacy mirror of the first enabled model, for older consumers. */
  model: string;
  enabled: boolean;
  models: AiModelEntry[];
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
  /** Per-file pending-change status (M/A/U/D/R/C) for the tree chips. */
  changed: { path: string; status: string }[];
  /** Paths touched by unpushed commits (upstream..HEAD). */
  unpushedPaths: string[];
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

export interface BlameLine {
  line: number;
  shortOid: string;
  /** Full commit oid — used by jump-to-commit in the blame hover. */
  oid: string;
  authorName: string;
  authorEmail: string;
  authorInitials: string;
  timeSeconds: number;
  summary: string;
  /** Full commit message (summary + body). */
  message: string;
  uncommitted: boolean;
}

export interface Contributor {
  name: string;
  initials: string;
  commits: number;
}

export interface LanguageCount {
  language: string;
  files: number;
}

export interface CodeSearchHit {
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column of the match. */
  column: number;
  /** The matched line's text, trimmed for display. */
  text: string;
}

export interface TerminalOutput {
  stdout: string;
  stderr: string;
  code: number;
  /** Working directory after the command (for the next prompt). */
  cwd: string;
}

export interface RepoStats {
  totalCommits: number;
  contributors: Contributor[];
  languages: LanguageCount[];
}

export interface LineChange {
  line: number;
  change: string;
}

export interface NetResult {
  summary: string;
}

export interface GitUserInfo {
  name: string | null;
  email: string | null;
}

export interface RemoteEntry {
  name: string;
  url: string;
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
  /** Short oids of the parent commits (first parent first). */
  parents: string[];
  files: CommitFileEntry[];
}

/** Data fetched from GitHub through the gh CLI (Rust shells out to gh). */
export interface GhPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  branch: string;
  baseRef: string;
  author: string;
  updatedAt: string;
  url: string;
  review: string;
  checksTotal: number;
  checksOk: number;
  comments: number;
  labels: string[];
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  updatedAt: string;
  url: string;
  comments: number;
  labels: string[];
  assignees: string[];
  milestone: string;
}

export interface GhIssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  /** COMPLETED / NOT_PLANNED / REOPENED / '' */
  stateReason: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  labels: string[];
  assignees: string[];
  milestone: string;
  comments: GhComment[];
}

export interface GhRelease {
  tagName: string;
  name: string;
  publishedAt: string;
  isLatest: boolean;
  isDraft: boolean;
  isPrerelease: boolean;
}

export interface GhAuthStatus {
  loggedIn: boolean;
  account: string;
}

/** GitHub wiki — backed by the git repo at <origin>.wiki.git. */
export interface WikiStatus {
  /** True when origin points at github.com. */
  supported: boolean;
  /** True when the wiki repository exists on GitHub. */
  hasWiki: boolean;
  url: string;
  /** True when a local clone already exists. */
  cached: boolean;
}

export interface WikiPage {
  /** File name inside the wiki repo, e.g. "Getting-Started.md". */
  file: string;
  /** Display title, e.g. "Getting Started". */
  title: string;
}

export interface WikiPageContent {
  file: string;
  title: string;
  content: string;
  author: string;
  updatedAt: string;
  commitMessage: string;
}

export interface WikiCommit {
  oid: string;
  author: string;
  date: string;
  message: string;
}

/** GitHub Project (v2) listed via `gh project list`. */
export interface GhProject {
  number: number;
  title: string;
  shortDescription: string;
  owner: string;
  closed: boolean;
  updatedAt: string;
  url: string;
}

export interface GhProjectIteration {
  title: string;
  startDate: string;
  endDate: string;
}

/** One work item of a project, via `gh project item-list`. */
export interface GhProjectItem {
  itemId: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  repository: string;
  /** OPEN / CLOSED / MERGED (PRs) */
  state: string;
  assignees: string[];
  labels: string[];
  /** Value of the project's "Status" field ("" when unset). */
  status: string;
  iteration: GhProjectIteration | null;
  isArchived: boolean;
  updatedAt: string;
  url: string;
}

/** Open code scanning alert, via `gh api /code-scanning/alerts`. */
export interface GhCodeAlert {
  number: number;
  state: string;
  /** critical / high / medium / low */
  severity: string;
  ruleId: string;
  ruleDescription: string;
  ruleTags: string[];
  tool: string;
  path: string;
  startLine: number;
  endLine: number;
  createdAt: string;
  htmlUrl: string;
}

/** Open Dependabot alert, via `gh api /dependabot/alerts`. */
export interface GhDependabotAlert {
  number: number;
  state: string;
  severity: string;
  summary: string;
  package: string;
  ecosystem: string;
  scope: string;
  manifestPath: string;
  vulnerableRange: string;
  patchedVersion: string;
  createdAt: string;
  htmlUrl: string;
}

/** Open secret scanning alert — the secret value itself is never included. */
export interface GhSecretAlert {
  number: number;
  state: string;
  secretType: string;
  createdAt: string;
  htmlUrl: string;
}

/** Check run on a branch head, via `gh api /commits/{ref}/check-runs`. */
export interface GhCheckRun {
  name: string;
  /** queued / in_progress / completed */
  status: string;
  /** success / failure / neutral / skipped / … ("" while pending) */
  conclusion: string;
  startedAt: string;
  completedAt: string;
  detailsUrl: string;
  app: string;
}

export interface GhAccount {
  name: string;
  active: boolean;
  fullName: string;
  avatarUrl: string;
  /** OAuth scopes granted to this account's token. */
  scopes: string[];
}

export interface GhReview {
  author: string;
  state: string;
  submittedAt: string;
}

export interface GhComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface GhPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GhPrCommit {
  oid: string;
  message: string;
}

export interface GhCheck {
  name: string;
  status: string;
  conclusion: string;
  duration: string;
}

export interface GhPrDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  updatedAt: string;
  url: string;
  reviewDecision: string;
  mergeable: string;
  labels: string[];
  reviews: GhReview[];
  comments: GhComment[];
  files: GhPrFile[];
  commits: GhPrCommit[];
  checks: GhCheck[];
}

export interface GhAsset {
  name: string;
  size: number;
  url: string;
  downloadCount: number;
}

export interface GhReleaseDetail {
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  createdAt: string;
  isLatest: boolean;
  isDraft: boolean;
  isPrerelease: boolean;
  author: string;
  url: string;
  assets: GhAsset[];
}

/** GitHub Actions data fetched through the gh CLI. */
export interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GhWorkflowRun {
  id: number;
  number: number;
  title: string;
  workflowName: string;
  workflowId: number;
  event: string;
  branch: string;
  sha: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | cancelled | skipped | ... (empty while running) */
  conclusion: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  url: string;
  attempt: number;
}

export interface GhRunPage {
  runs: GhWorkflowRun[];
  /** Total runs on the repository; falls back to the fetched length. */
  total: number;
}

export interface GhRunStep {
  name: string;
  number: number;
  status: string;
  conclusion: string;
  duration: string;
}

export interface GhRunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  duration: string;
  steps: GhRunStep[];
  url: string;
}

export interface GhRunDetail {
  id: number;
  number: number;
  title: string;
  workflowName: string;
  workflowId: number;
  event: string;
  branch: string;
  sha: string;
  status: string;
  conclusion: string;
  attempt: number;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  url: string;
  jobs: GhRunJob[];
}

export interface GhRunArtifact {
  id: number;
  name: string;
  size: number;
  expired: boolean;
  expiresAt: string;
  createdAt: string;
}

/** Insights screen data — computed from local git history (insights.rs). */
export interface InsightsCommitEntry {
  oid: string;
  summary: string;
  author: string;
  timeSeconds: number;
  isMerge: boolean;
}

export interface InsightsContributor {
  name: string;
  commits: number;
  additions: number;
  deletions: number;
}

export interface InsightsWeek {
  startSeconds: number;
  endSeconds: number;
  commits: number;
  additions: number;
  deletions: number;
}

export interface InsightsDay {
  /** UTC midnight of the day. */
  daySeconds: number;
  commits: number;
}

export interface InsightsData {
  headBranch: string;
  nowSeconds: number;
  periodDays: number;
  commits: number;
  prevCommits: number;
  contributors: number;
  prevContributors: number;
  additions: number;
  deletions: number;
  weekly: InsightsWeek[];
  prevWeekly: InsightsWeek[];
  days: InsightsDay[];
  people: InsightsContributor[];
  recent: InsightsCommitEntry[];
  lineCommitsScanned: number;
  lineCommitsTotal: number;
}

/** Delivery metrics from gh (gh_insights.rs). */
export interface GhDeliveryStats {
  available: boolean;
  prOpened: number;
  prMerged: number;
  prClosedUnmerged: number;
  prOpenNow: number;
  prMergedPrev: number;
  issueOpened: number;
  issueClosed: number;
  issueOpenNow: number;
  medianMergeSeconds: number | null;
  medianMergeSecondsPrev: number | null;
}

export interface GhTrafficDay {
  timestamp: string;
  count: number;
  uniques: number;
}

export interface GhTrafficTotals {
  count: number;
  uniques: number;
}

export interface GhTraffic {
  views: GhTrafficTotals;
  viewsDaily: GhTrafficDay[];
  clones: GhTrafficTotals;
  clonesDaily: GhTrafficDay[];
}
