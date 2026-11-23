import {
  Activity,
  Bot,
  FlaskConical,
  CircleDot,
  FileDiff,
  FolderTree,
  GitPullRequest,
  LayoutGrid,
  Network,
  ShieldCheck,
  Tag,
  BookOpen,
  Zap,
  type LucideIcon,
  GitMerge,
  GitCompare,
  History,
  ArrowUpCircle,
  ArrowDownCircle,
  Archive,
  GitBranch,
  Cherry,
  Copy,
  Pencil,
  Workflow,
  PenTool,
  StickyNote,
  ClipboardList,
  Undo2,
} from 'lucide-react';

export type NavId =
  | 'explorer'
  | 'diagram'
  | 'design'
  | 'board'
  | 'e2e'
  | 'reports'
  | 'commit-graph'
  | 'working-changes'
  | 'merge-branch'
  | 'compare-branch'
  | 'rebase-branch'
  | 'push-commits'
  | 'pull-commits'
  | 'stashes'
  | 'cherry-pick'
  | 'revert-commit'
  | 'duplicate-commit'
  | 'edit-commit'
  | 'branches'
  | 'ai-agent'
  | 'pull-requests'
  | 'releases'
  | 'issues'
  | 'actions'
  | 'projects'
  | 'wiki'
  | 'security'
  | 'insights'
  | 'app-settings';

export type WorkspaceNavId = Exclude<NavId, 'app-settings'>;

export interface NavItem {
  id: WorkspaceNavId;
  label: string;
  icon: LucideIcon;
  /** Badge count; undefined = no badge */
  badge?: number;
}

export const workspaceNav: NavItem[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'diagram', label: 'Diagram', icon: Workflow },
  { id: 'design', label: 'Design', icon: PenTool },
  { id: 'board', label: 'Board', icon: StickyNote },
  { id: 'e2e', label: 'E2E Testing', icon: FlaskConical },
  { id: 'reports', label: 'Reports', icon: ClipboardList },
  { id: 'ai-agent', label: 'Copilot', icon: Bot },
  { id: 'working-changes', label: 'Working changes', icon: FileDiff, badge: 6 },
  { id: 'push-commits', label: 'Push Commits', icon: ArrowUpCircle },
  { id: 'pull-commits', label: 'Pull commit', icon: ArrowDownCircle },
  { id: 'merge-branch', label: 'Merge branch', icon: GitMerge },
  { id: 'compare-branch', label: 'Compare branch', icon: GitCompare },
  { id: 'stashes', label: 'Stashes Code', icon: Archive },
  { id: 'cherry-pick', label: 'Cherry Pick', icon: Cherry },
  { id: 'revert-commit', label: 'Revert commit', icon: Undo2 },
  { id: 'duplicate-commit', label: 'Duplicate commit', icon: Copy },
  { id: 'edit-commit', label: 'Edit commit', icon: Pencil },
  { id: 'rebase-branch', label: 'Rebase Branch', icon: History },
  { id: 'pull-requests', label: 'Pull requests', icon: GitPullRequest, badge: 3 },
  { id: 'commit-graph', label: 'Commit graph', icon: Network },
  { id: 'branches', label: 'Branches', icon: GitBranch },
  { id: 'releases', label: 'Releases', icon: Tag },
  { id: 'actions', label: 'Actions', icon: Zap },
  { id: 'security', label: 'Security and quality', icon: ShieldCheck },
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'projects', label: 'Projects', icon: LayoutGrid },
  { id: 'wiki', label: 'Wiki', icon: BookOpen },
  { id: 'insights', label: 'Insights', icon: Activity },
];
