import {
  Archive,
  ArrowDown,
  ArrowUp,
  CloudDownload,
  FileDiff,
  FolderOpen,
  FolderTree,
  ListChecks,
  ListMinus,
  Network,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type { NavId } from './navigation';
import { workspaceNav } from './navigation';
import type { RepositoryContextValue } from '../hooks/useRepository';

export interface Command {
  id: string;
  title: string;
  section: 'Navigate' | 'Repository' | 'Sync';
  icon: LucideIcon;
  hint?: string;
  /** Target screen for navigation commands. */
  nav?: NavId;
  /** Disabled commands stay visible with reduced opacity. */
  enabled: boolean;
  run: () => void | Promise<void>;
}

interface CommandDeps {
  navigate: (screen: NavId) => void;
  activeScreen: NavId;
  repository: RepositoryContextValue;
}

/** Builds the palette command list from current app state. */
export function buildCommands({ navigate, activeScreen, repository }: CommandDeps): Command[] {
  const { repository: repo, refresh, stage, unstage, stash, fetchRemote, pullRemote, pushRemote, pickRepository } =
    repository;

  const navigation: Command[] = workspaceNav.map(({ id, label, icon }) => ({
    id: `nav:${id}`,
    title: `Go to ${label}`,
    section: 'Navigate',
    icon,
    nav: id,
    enabled: true,
    run: () => navigate(id),
  }));

  const repoCommands: Command[] = [
    {
      id: 'repo:open',
      title: 'Open repository…',
      section: 'Repository',
      icon: FolderOpen,
      enabled: true,
      run: () => void pickRepository(),
    },
    {
      id: 'repo:refresh',
      title: 'Refresh repository status',
      section: 'Repository',
      icon: RefreshCw,
      enabled: true,
      run: () => void refresh(),
    },
    {
      id: 'repo:stage-all',
      title: 'Stage all changes',
      section: 'Repository',
      icon: ListChecks,
      hint: repo ? `${repo.files.filter((f) => !f.staged).length} unstaged` : undefined,
      enabled: (repo?.files.filter((f) => !f.staged).length ?? 0) > 0,
      run: () => {
        if (!repo) return;
        void stage(repo.files.filter((f) => !f.staged).map((f) => f.path));
      },
    },
    {
      id: 'repo:unstage-all',
      title: 'Unstage all changes',
      section: 'Repository',
      icon: ListMinus,
      hint: repo ? `${repo.files.filter((f) => f.staged).length} staged` : undefined,
      enabled: (repo?.files.filter((f) => f.staged).length ?? 0) > 0,
      run: () => {
        if (!repo) return;
        void unstage(repo.files.filter((f) => f.staged).map((f) => f.path));
      },
    },
    {
      id: 'repo:stash',
      title: 'Stash changes',
      section: 'Repository',
      icon: Archive,
      enabled: (repo?.files.length ?? 0) > 0,
      run: () => void stash(),
    },
    {
      id: 'screen:working-changes-dirty',
      title: 'Review working changes',
      section: 'Navigate',
      icon: FileDiff,
      hint: repo ? `${repo.files.length} file${repo.files.length === 1 ? '' : 's'}` : undefined,
      enabled: true,
      run: () => navigate('working-changes'),
    },
  ];

  const upstream = repo?.upstream ?? null;
  const hasRemote = (repo?.remotes.length ?? 0) > 0;
  const branchCommands: Command[] = (repo?.branches ?? [])
    .filter((branch) => !branch.isHead)
    .map((branch) => ({
      id: `branch:checkout:${branch.name}`,
      title: `Checkout branch ${branch.name}`,
      section: "Repository" as const,
      icon: FolderTree,
      enabled: true,
      run: () => void repository.checkoutBranch(branch.name),
    }));
  const deleteCommands: Command[] = (repo?.branches ?? [])
    .filter((branch) => !branch.isHead)
    .map((branch) => ({
      id: `branch:delete:${branch.name}`,
      title: `Delete branch ${branch.name} (merged)`,
      section: "Repository" as const,
      icon: ListMinus,
      enabled: true,
      run: () => void repository.deleteBranch(branch.name),
    }));
  const createCommand: Command = {
    id: "branch:create",
    title: "Create branch from HEAD…",
    section: "Repository" as const,
    icon: FolderTree,
    hint: repo?.currentBranch,
    enabled: true,
    run: () => {
      const name = window.prompt("New branch name");
      if (name && name.trim()) void repository.createBranch(name.trim(), true);
    },
  };

  const tagCommands: Command[] = [
    {
      id: "tag:create",
      title: "Create tag at HEAD…",
      section: "Repository" as const,
      icon: FolderTree,
      hint: repo?.currentBranch,
      enabled: true,
      run: () => {
        const name = window.prompt("Tag name");
        if (name && name.trim()) void repository.createTag(name.trim());
      },
    },
    ...(repo?.tags ?? []).map((tag) => ({
      id: `tag:delete:${tag.name}`,
      title: `Delete tag ${tag.name}`,
      section: "Repository" as const,
      icon: ListMinus,
      enabled: true,
      run: () => void repository.deleteTag(tag.name),
    })),
  ];

  const stashCommands: Command[] = (repo?.stashes ?? []).map((stash) => ({
    id: `stash:pop:${stash.index}`,
    title: `Pop stash ${stash.message}`,
    section: "Repository" as const,
    icon: Archive,
    hint: `#${stash.index}`,
    enabled: true,
    run: () => void repository.stashPop(stash.index),
  }));

  const syncCommands: Command[] = [
    {
      id: 'sync:fetch',
      title: 'Fetch from remote',
      section: 'Sync',
      icon: CloudDownload,
      hint: repo?.remotes[0]?.remote,
      enabled: hasRemote,
      run: () => void fetchRemote(),
    },
    {
      id: 'sync:pull',
      title: upstream ? `Pull (behind ${upstream.behind})` : 'Pull',
      section: 'Sync',
      icon: ArrowDown,
      hint: upstream?.name,
      enabled: upstream !== null && upstream.behind > 0,
      run: () => void pullRemote(),
    },
    {
      id: 'sync:push',
      title: upstream
        ? upstream.ahead > 0
          ? `Push (ahead ${upstream.ahead})`
          : 'Push'
        : 'Publish branch to origin',
      section: 'Sync',
      icon: ArrowUp,
      enabled: true,
      run: () => void pushRemote(),
    },
    {
      id: 'sync:graph',
      title: 'Review commit graph',
      section: 'Sync',
      icon: Network,
      hint: activeScreen === 'commit-graph' ? 'current' : undefined,
      enabled: true,
      run: () => navigate('commit-graph'),
    },
    {
      id: 'nav:explorer-tree',
      title: 'Browse files',
      section: 'Navigate',
      icon: FolderTree,
      enabled: true,
      run: () => navigate('explorer'),
    },
  ];

  return [...navigation, ...repoCommands, createCommand, ...branchCommands, ...deleteCommands, ...tagCommands, ...stashCommands, ...syncCommands];
}
