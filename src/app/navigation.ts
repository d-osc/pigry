import {
  Activity,
  Bot,
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
  ArrowUpCircle,
  Archive,
} from 'lucide-react';

export type NavId =
  | 'explorer'
  | 'commit-graph'
  | 'working-changes'
  | 'merge-branch'
  | 'push-commits'
  | 'stashes'
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

export interface NavItem {
  id: NavId;
  label: string;
  icon: LucideIcon;
  /** Badge count; undefined = no badge */
  badge?: number;
}

export const workspaceNav: NavItem[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'commit-graph', label: 'Commit graph', icon: Network },
  { id: 'merge-branch', label: 'Merge branch', icon: GitMerge },
  { id: 'push-commits', label: 'Push Commits', icon: ArrowUpCircle },
  { id: 'stashes', label: 'Stashes Code', icon: Archive },
  { id: 'working-changes', label: 'Working changes', icon: FileDiff, badge: 6 },
  { id: 'ai-agent', label: 'Copilot', icon: Bot },
  { id: 'pull-requests', label: 'Pull requests', icon: GitPullRequest, badge: 3 },
  { id: 'releases', label: 'Releases', icon: Tag },
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'actions', label: 'Actions', icon: Zap },
  { id: 'projects', label: 'Projects', icon: LayoutGrid },
  { id: 'wiki', label: 'Wiki', icon: BookOpen },
  { id: 'security', label: 'Security and quality', icon: ShieldCheck },
  { id: 'insights', label: 'Insights', icon: Activity },
];
