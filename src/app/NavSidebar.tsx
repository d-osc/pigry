import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  Settings,
  Tag as TagIcon,
  Archive,
} from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { workspaceNav, type NavId } from './navigation';
import './NavSidebar.css';

interface NavSidebarProps {
  activeScreen: NavId;
  onNavigate: (screen: NavId) => void;
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
      <button className="nav-section__head" type="button" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="nav-section__title">{title}</span>
        {count !== undefined && <span className="nav-section__count">{count}</span>}
      </button>
      {open && action && <div className="nav-section__action">{action}</div>}
      {open && <div className="nav-section__body">{children}</div>}
    </section>
  );
}

export function NavSidebar({ activeScreen, onNavigate }: NavSidebarProps) {
  const { repository, checkoutBranch, createBranch, deleteBranch, busy } = useRepository();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  if (!repository) return null;

  const submitNewBranch = () => {
    const name = newName.trim();
    setCreating(false);
    setNewName('');
    if (name) void createBranch(name, true);
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
      <div className="nav-sidebar__workspace">
        <p className="nav-sidebar__heading">Workspace</p>
        <nav>
          {workspaceNav.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              type="button"
              className={`nav-item${activeScreen === id ? ' nav-item--active' : ''}`}
              onClick={() => onNavigate(id)}
            >
              <Icon size={13} className="nav-item__icon" />
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
              +
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
          {repository.branches.map((branch) => (
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
              <GitBranch size={12} className="nav-branch__icon" />
              <span className="nav-branch__name">{branch.name}</span>
            </button>
          ))}
        </Section>

        {repository.remotes.length > 0 && (
          <Section title="Remotes" count={repository.remotes.length}>
            {repository.remotes.map(({ remote, branches }) => (
              <div key={remote} className="nav-remote">
                <div className="nav-remote__head">
                  <Cloud size={12} />
                  <span>{remote}</span>
                </div>
                {branches.map((branch) => (
                  <button
                    key={`${remote}/${branch}`}
                    type="button"
                    className="nav-branch nav-branch--remote"
                  >
                    <GitBranch size={12} className="nav-branch__icon" />
                    <span className="nav-branch__name">{branch}</span>
                  </button>
                ))}
              </div>
            ))}
          </Section>
        )}

        {repository.tags.length > 0 && (
          <Section title="Tags" count={repository.tagTotal}>
            {repository.tags.map((tag) => (
              <button key={tag} type="button" className="nav-branch">
                <TagIcon size={12} className="nav-branch__icon" />
                <span className="nav-branch__name">{tag}</span>
              </button>
            ))}
          </Section>
        )}

        {repository.stashes.length > 0 && (
          <Section title="Stashes" count={repository.stashes.length}>
            {repository.stashes.map((stash) => (
              <button key={stash.index} type="button" className="nav-branch">
                <Archive size={12} className="nav-branch__icon" />
                <span className="nav-branch__name">{stash.message}</span>
              </button>
            ))}
          </Section>
        )}
      </div>

      <div className="nav-sidebar__footer">
        <div className="repo-health">
          <span
            className={`repo-health__dot ${clean ? 'repo-health__dot--clean' : ''}`}
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
        <button type="button" className="nav-preferences">
          <Settings size={13} />
          <span>Preferences</span>
          <kbd>⌘,</kbd>
        </button>
      </div>
    </aside>
  );
}
