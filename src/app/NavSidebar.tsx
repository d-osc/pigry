import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  FolderGit2,
  GitBranch,
  Settings,
  Tag as TagIcon,
  Archive,
  Plus,
  CircleCheck,
  ChevronsLeft,
} from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { workspaceNav, type NavId } from './navigation';
import './NavSidebar.css';

/** Branch lane colors, cycled in list order (matches the commit graph lanes). */
export const laneColor = (index: number) =>
  `var(--lane-${(index % 4) + 1})`;

interface NavSidebarProps {
  activeScreen: NavId;
  onNavigate: (screen: NavId) => void;
  onOpenSettings: () => void;
  /** Folds the whole side bar away (AppShell keeps the state). */
  onCollapse?: () => void;
}

function Section({
  title,
  count,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="nav-section">
      <div className="nav-section__head-row">
        <button className="nav-section__head" type="button" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span className="nav-section__title">{title}</span>
          {count !== undefined && <span className="nav-section__count">{count}</span>}
        </button>
        {action && <div className="nav-section__action">{action}</div>}
      </div>
      {open && <div className="nav-section__body">{children}</div>}
    </section>
  );
}

export function NavSidebar({ activeScreen, onNavigate, onOpenSettings, onCollapse }: NavSidebarProps) {
  const {
    repository,
    checkoutBranch,
    createBranch,
    deleteBranch,
    createTag,
    deleteTag,
    stashApply,
    stashPop,
    stashDrop,
    stash,
    openRepository,
    busy,
  } = useRepository();
  const [creating, setCreating] = useState(false);
  const [tagCreating, setTagCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newName, setNewName] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  if (!repository) return null;

  const submitNewBranch = () => {
    const name = newName.trim();
    setCreating(false);
    setNewName('');
    if (name) void createBranch(name, true);
  };

  const submitNewTag = () => {
    const name = newTagName.trim();
    setTagCreating(false);
    setNewTagName("");
    if (name) void createTag(name);
  };

  const handleBranchClick = (event: React.MouseEvent, branch: string) => {
    if (branch === repository.currentBranch || busy) return;
    if (event.shiftKey) {
      // Shift+click: delete (backend refuses unmerged and the current branch).
      void deleteBranch(branch);
    } else {
      void checkoutBranch(branch);
    }
  };

  const staged = repository.files.filter((f) => f.staged).length;
  const unstaged = repository.files.length - staged;
  const clean = repository.files.length === 0;

  return (
    <aside className="nav-sidebar">
      <div className="nav-sidebar__topbar">
        {onCollapse && (
          <button
            type="button"
            className="nav-sidebar__collapse"
            aria-label="Collapse side bar"
            title="Collapse side bar (Ctrl+B)"
            onClick={onCollapse}
          >
            <ChevronsLeft size={13} strokeWidth={1.5} />
          </button>
        )}
      </div>
      <div className="nav-sidebar__workspace">
        <button
          className="nav-sidebar__heading"
          type="button"
          onClick={() => setWorkspaceOpen(!workspaceOpen)}
        >
          <span>Workspace</span>
          <ChevronUp size={10} />
        </button>
        {workspaceOpen && (
          <nav>
            {workspaceNav.map(({ id, label, icon: Icon, badge }) => (
              <button
                key={id}
                type="button"
                className={`nav-item${activeScreen === id ? ' nav-item--active' : ''}`}
                onClick={() => onNavigate(id)}
              >
                <Icon size={13} className="nav-item__icon" strokeWidth={1.25} />
                <span className="nav-item__label">{label}</span>
                {id === 'working-changes' && !clean && (
                  <span className="nav-item__badge">{repository.files.length}</span>
                )}
                {id !== 'working-changes' && badge !== undefined && (
                  <span className="nav-item__badge">{badge}</span>
                )}
              </button>
            ))}
          </nav>
        )}
      </div>

      <div className="nav-sidebar__refs">
        <Section
          title="Local branches"
          count={repository.branches.length}
          action={
            <button
              type="button"
              className="nav-section__add"
              aria-label="Create branch"
              onClick={() => setCreating(true)}
            >
              <Plus size={7} />
            </button>
          }
        >
          {creating && (
            <div className="nav-branch-create">
              <input
                autoFocus
                className="nav-branch-create__input"
                placeholder="branch name…"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitNewBranch();
                  if (event.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
                onBlur={submitNewBranch}
                aria-label="New branch name"
                spellCheck={false}
              />
            </div>
          )}
          {repository.branches.map((branch, index) => (
            <button
              key={branch.name}
              type="button"
              className={`nav-branch${branch.isHead ? ' nav-branch--active' : ''}`}
              onClick={(event) => handleBranchClick(event, branch.name)}
              title={
                branch.isHead
                  ? branch.name
                  : `Click to checkout — Shift+click to delete ${branch.name}`
              }
            >
              <GitBranch
                size={10.5}
                className="nav-branch__icon"
                strokeWidth={1.25}
                style={{ color: branch.isHead ? 'var(--accent)' : laneColor(index) }}
              />
              <span className="nav-branch__name">{branch.name}</span>
              {branch.isHead && <Check size={10} className="nav-branch__check" />}
            </button>
          ))}
        </Section>

        {repository.remotes.length > 0 && (
          <Section title="Remotes" count={repository.remotes.length}>
            {repository.remotes.map(({ remote, branches }) => (
              <div key={remote} className="nav-remote">
                <div className="nav-remote__head">
                  <Cloud size={11} strokeWidth={1.25} />
                  <span>{remote}</span>
                </div>
                {branches.map((branch) => (
                  <button
                    key={`${remote}/${branch}`}
                    type="button"
                    className="nav-branch nav-branch--remote"
                  >
                    <GitBranch
                      size={10.5}
                      className="nav-branch__icon"
                      strokeWidth={1.25}
                      style={{
                        color: laneColor(repository.branches.findIndex((b) => b.name === branch)),
                      }}
                    />
                    <span className="nav-branch__name">{branch}</span>
                  </button>
                ))}
              </div>
            ))}
          </Section>
        )}

        <Section
          title="Tags"
          count={repository.tagTotal}
            action={
            <button
                type="button"
                className="nav-section__add"
                aria-label="Create tag"
                onClick={() => setTagCreating(true)}
              >
                <Plus size={7} />
              </button>
            }
        >
          {tagCreating && (
              <div className="nav-branch-create">
                <input
                  autoFocus
                  className="nav-branch-create__input"
                  placeholder="tag name…"
                  value={newTagName}
                  onChange={(event) => setNewTagName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitNewTag();
                    if (event.key === "Escape") {
                      setTagCreating(false);
                      setNewTagName("");
                    }
                  }}
                  onBlur={submitNewTag}
                  aria-label="New tag name"
                  spellCheck={false}
                />
              </div>
            )}
            {repository.tags.map((tag) => (
              <button
                key={tag.name}
                type="button"
                className="nav-branch nav-branch--tag"
                onClick={() => {
                  if (!busy) void deleteTag(tag.name);
                }}
                title={`Tag on ${tag.commitOid ? tag.commitOid.slice(0, 7) : "?"} — click to delete`}
              >
                <TagIcon size={10.5} className="nav-branch__icon" strokeWidth={1.25} />
                <span className="nav-branch__name">{tag.name}</span>
              </button>
            ))}
        </Section>

        {/* The design keeps STASHES visible even when the list is empty. */}
        <Section
          title="Stashes"
          count={repository.stashes.length}
          action={
            <button
              type="button"
              className="nav-section__add"
              aria-label="Stash changes"
              title="Stash working changes"
              disabled={busy || repository.files.length === 0}
              onClick={() => void stash()}
            >
              <Plus size={7} />
            </button>
          }
        >
            {repository.stashes.map((stash) => (
              <div key={stash.index} className="nav-stash">
                <span className="nav-stash__icon">
                  <Archive size={12} strokeWidth={1.25} />
                </span>
                <span className="nav-branch__name" title={stash.message}>
                  {stash.message}
                </span>
                <span className="nav-stash__actions">
                  <button
                    type="button"
                    className="nav-stash__btn"
                    title="Apply stash (keep entry)"
                    disabled={busy}
                    onClick={() => void stashApply(stash.index)}
                  >
                    A
                  </button>
                  <button
                    type="button"
                    className="nav-stash__btn"
                    title="Pop stash (apply and remove)"
                    disabled={busy}
                    onClick={() => void stashPop(stash.index)}
                  >
                    P
                  </button>
                  <button
                    type="button"
                    className="nav-stash__btn nav-stash__btn--danger"
                    title="Drop stash"
                    disabled={busy}
                    onClick={() => void stashDrop(stash.index)}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </Section>

        {repository.worktrees.length > 0 && (
          <Section title="Worktrees" count={repository.worktrees.length}>
            {repository.worktrees.map((tree) => (
              <button
                key={tree.name}
                type="button"
                className={`nav-branch${tree.isCurrent ? ' nav-branch--current' : ''}`}
                onClick={() => {
                  if (!tree.isCurrent && !busy) void openRepository(tree.path);
                }}
                title={`${tree.path} — branch ${tree.branch}${tree.isCurrent ? ' (open)' : ' — click to open as workspace'}`}
              >
                <GitBranch size={10.5} className="nav-branch__icon" strokeWidth={1.25} />
                <span className="nav-branch__name">{tree.name}</span>
                <span className="nav-worktree__branch">{tree.branch}</span>
              </button>
            ))}
          </Section>
        )}

        {repository.submodules.length > 0 && (
          <Section title="Submodules" count={repository.submodules.length}>
            {repository.submodules.map((sub) => (
              <button
                key={sub.name}
                type="button"
                className="nav-branch"
                onClick={() => {
                  if (!busy) void openRepository(sub.absPath);
                }}
                title={`${sub.path}\n${sub.url} — click to open as workspace`}
              >
                <FolderGit2 size={12} className="nav-branch__icon" strokeWidth={1.25} />
                <span className="nav-branch__name">{sub.name}</span>
                <span
                  className={`nav-submodule__dot${sub.dirty ? ' nav-submodule__dot--dirty' : ''}`}
                  title={sub.dirty ? 'Checked-out commit differs from the index' : 'In sync'}
                />
              </button>
            ))}
          </Section>
        )}
      </div>

      <div className="nav-sidebar__footer">
        <div className="repo-health">
          <CircleCheck
            size={15}
            strokeWidth={1.25}
            className={`repo-health__icon${clean ? ' repo-health__icon--clean' : ''}`}
          />
          <div className="repo-health__text">
            {clean ? (
              <>
                <p className="repo-health__line">Working tree clean</p>
                <p className="repo-health__sub">No uncommitted changes</p>
              </>
            ) : (
              <>
                <p className="repo-health__line">
                  {repository.files.length} local change
                  {repository.files.length === 1 ? '' : 's'}
                </p>
                <p className="repo-health__sub">
                  {staged} staged · {unstaged} unstaged
                </p>
              </>
            )}
          </div>
        </div>
        <button type="button" className="nav-preferences" onClick={onOpenSettings}>
          <Settings size={15} strokeWidth={1.25} />
          <span>Preferences</span>
          <kbd>⌘,</kbd>
        </button>
      </div>
    </aside>
  );
}
