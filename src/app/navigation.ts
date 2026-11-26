import {
  Activity,
  AudioLines,
  Sheet,
  FileText,
  Presentation,
  Lightbulb,
  Bot,
  Box,
  Gamepad2,
  Film,
  Brush,
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
  FileWarning,
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
  Store,
} from 'lucide-react';

export type NavId =
  | 'explorer'
  | 'diagram'
  | 'design'
  | 'drawing'
  | 'model3d'
  | 'gameengine'
  | 'videoeditor'
  | 'audioeditor'
  | 'sheet'
  | 'docs'
  | 'slides'
  | 'notes'
  | 'board'
  | 'e2e'
  | 'reports'
  | 'commit-graph'
  | 'working-changes'
  | 'merge-branch'
  | 'merge-conflicts'
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
  | 'extensions'
  | 'app-settings';

/** Workspace menus: each one has its own agents, guide and default screen. */
export type WorkspaceNavId = Exclude<NavId, 'app-settings' | 'extensions'>;

/** The side bar's Extensions group heading. */
export const EXTENSIONS_GROUP_LABEL = 'Extensions';

/** The Extension Store menu, first item of the Extensions group. It is not a workspace menu: it is where packs are found. */
export const extensionsNav = { id: 'extensions' as const, label: 'Extension Store', icon: Store };

/** Menus that have a guide behind the info button. */
export type GuideNavId = WorkspaceNavId | 'extensions';

export interface NavItem {
  id: WorkspaceNavId;
  label: string;
  icon: LucideIcon;
  /** Badge count; undefined = no badge */
  badge?: number;
  /** 'extension': a built-in extension. Its menu is listed in the side bar's Extensions group and can be switched off. */
  group?: 'extension';
}

export const workspaceNav: NavItem[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'diagram', label: 'Diagram', icon: Workflow, group: 'extension' },
  { id: 'design', label: 'Design', icon: PenTool, group: 'extension' },
  { id: 'drawing', label: 'Drawing', icon: Brush, group: 'extension' },
  { id: 'model3d', label: '3D Model', icon: Box, group: 'extension' },
  { id: 'gameengine', label: 'Game Engine', icon: Gamepad2, group: 'extension' },
  { id: 'videoeditor', label: 'Video Editor', icon: Film, group: 'extension' },
  { id: 'audioeditor', label: 'Audio Editor', icon: AudioLines, group: 'extension' },
  { id: 'sheet', label: 'Sheet', icon: Sheet, group: 'extension' },
  { id: 'docs', label: 'Docs', icon: FileText, group: 'extension' },
  { id: 'slides', label: 'Slides', icon: Presentation, group: 'extension' },
  { id: 'notes', label: 'Notes', icon: Lightbulb, group: 'extension' },
  { id: 'board', label: 'Board', icon: StickyNote, group: 'extension' },
  { id: 'e2e', label: 'E2E Testing', icon: FlaskConical, group: 'extension' },
  { id: 'reports', label: 'Reports', icon: ClipboardList, group: 'extension' },
  { id: 'ai-agent', label: 'Copilot', icon: Bot },
  { id: 'working-changes', label: 'Working changes', icon: FileDiff, badge: 6 },
  { id: 'push-commits', label: 'Push Commits', icon: ArrowUpCircle },
  { id: 'pull-commits', label: 'Pull commit', icon: ArrowDownCircle },
  { id: 'merge-branch', label: 'Merge branch', icon: GitMerge },
  { id: 'merge-conflicts', label: 'Merge conflicts', icon: FileWarning },
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
