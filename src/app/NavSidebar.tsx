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
  Puzzle,
  CircleCheck,
  ChevronsLeft,
  Search,
  X,
} from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { EXTENSIONS_GROUP_LABEL, extensionsNav, workspaceNav, type NavId, type NavItem } from './navigation';
import { useDisabledMenus, useExtensions } from '../hooks/useExtensions';
import { requestOpenExtension, setExtensionEnabled } from '../lib/extensions';
import { CanvasContextMenu, type CanvasMenuEntry } from './CanvasContextMenu';
import './NavSidebar.css';

/** Branch lane colors, cycled in list order (matches the commit graph lanes). */
export const laneColor = (index: number) =>
  `var(--lane-${(index % 4) + 1})`;

interface NavSidebarProps {
  ref?: React.Ref<HTMLElement>;
  width?: number;
  activeScreen: NavId;
  onNavigate: (screen: NavId) => void;
  onOpenSettings: () => void;
  /** Folds the whole side bar away (AppShell keeps the state). */
  onCollapse?: () => void;
  /** Opens the guide of a menu (right-click › Open guide). */
  onOpenGuide?: (screen: NavId) => void;
  /** Opens Settings › Extensions on an installed extension (clicking it in the Extensions group). */
  onOpenExtension?: (id: string) => void;
}

function Section({
  title,
  count,
  defaultOpen = true,
  forceOpen = false,
  action,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** Keeps the section expanded while a search is active. */
  forceOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [openState, setOpen] = useState(defaultOpen);
  const open = forceOpen || openState;
  return (
    <section className="nav-section">
      <div className="nav-section__head-row">
        <button className="nav-section__head" type="button" onClick={() => setOpen(!openState)}>
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

export function NavSidebar({ ref, width, activeScreen, onNavigate, onOpenSettings, onCollapse, onOpenGuide, onOpenExtension }: NavSidebarProps) {
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
    notify,
    busy,
  } = useRepository();
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; entries: CanvasMenuEntry[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [tagCreating, setTagCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newName, setNewName] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [extensionsOpen, setExtensionsOpen] = useState(true);
  const extensions = useExtensions();
  const disabledMenus = useDisabledMenus();
  const [query, setQuery] = useState('');
  if (!repository) return null;

  // Search filters the menu items and every list below (branches, remotes, tags…).
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (...texts: Array<string | undefined>) =>
    !searching || texts.some((text) => text?.toLowerCase().includes(q));
  // Diagram, Design, Board, E2E Testing and Reports are built-in extensions: they sit in the Extensions group
  // (unless switched off) instead of the Workspace group.
  const workspaceItems = workspaceNav.filter(({ label, group }) => group !== 'extension' && matches(label));
  const menuExtensions = workspaceNav.filter(({ id, label, group }) => group === 'extension' && !disabledMenus.has(id) && matches(label));
  const navItems = [...workspaceItems, ...menuExtensions];
  const branchRows = repository.branches
    .map((branch, index) => ({ branch, index }))
    .filter(({ branch }) => matches(branch.name));
  const remoteRows = repository.remotes
    .map(({ remote, branches }) => ({
      remote,
      branches: matches(remote) ? branches : branches.filter((branch) => matches(`${remote}/${branch}`)),
    }))
    .filter(({ branches }) => branches.length > 0 || !searching);
  const extensionRows = extensions.filter((extension) => matches(extension.name, extension.id));
  const showExtensionsGroup = !searching || extensionRows.length > 0 || menuExtensions.length > 0 || matches(extensionsNav.label) || matches(EXTENSIONS_GROUP_LABEL);
  const tagRows = repository.tags.filter((tag) => matches(tag.name));
  const stashRows = repository.stashes.filter((entry) => matches(entry.message));
  const worktreeRows = repository.worktrees.filter((tree) => matches(tree.name, tree.branch, tree.path));
  const submoduleRows = repository.submodules.filter((sub) => matches(sub.name, sub.path));
  const nothingFound = searching && navItems.length + extensionRows.length + (showExtensionsGroup ? 1 : 0) + branchRows.length + remoteRows.length
    + tagRows.length + stashRows.length + worktreeRows.length + submoduleRows.length === 0;

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

  /** Right-click menu for whatever was clicked; the browser's own menu never shows inside the side bar. */
  const openMenu = (event: React.MouseEvent, label: string, entries: CanvasMenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, label, entries });
  };
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => notify(`Copied ${what}`, 'success'),
      () => notify(`Could not copy ${what}`, 'error'),
    );
  };
  const sidebarEntries = (): CanvasMenuEntry[] => [
    ...(onCollapse ? [{ label: 'Collapse side bar', shortcut: 'Ctrl+B', onSelect: onCollapse }] : []),
    { label: 'Preferences', shortcut: '⌘,', onSelect: onOpenSettings },
  ];

  const handleBranchClick = (event: React.MouseEvent, branch: string) => {
    if (branch === repository.currentBranch || busy) return;
    if (event.shiftKey) {
      // Shift+click: delete (backend refuses unmerged and the current branch).
      void deleteBranch(branch);
    } else {
      void checkoutBranch(branch);
    }
  };

  const renderNavItem = ({ id, label, icon: Icon, badge }: NavItem) => (
    <button
      key={id}
      type="button"
      className={`nav-item${activeScreen === id ? ' nav-item--active' : ''}`}
      onClick={() => onNavigate(id)}
      onContextMenu={(event) => openMenu(event, `${label} menu`, [
        { label: 'Open', onSelect: () => onNavigate(id), disabled: activeScreen === id },
        ...(onOpenGuide ? [{ label: 'Open guide', onSelect: () => onOpenGuide(id) }] : []),
        { separator: true as const },
        ...sidebarEntries(),
      ])}
    >
      <Icon size={13} className="nav-item__icon" strokeWidth={1.25} />
      <span className="nav-item__label">{label}</span>
      {id === 'working-changes' && !clean && (
        <span className="nav-item__badge">{repository.files.length}</span>
      )}
      {id === 'pull-commits' && repository.upstream && repository.upstream.behind > 0 && (
        <span className="nav-item__badge">{repository.upstream.behind}</span>
      )}
      {id !== 'working-changes' && badge !== undefined && (
        <span className="nav-item__badge">{badge}</span>
      )}
    </button>
  );

  const staged = repository.files.filter((f) => f.staged).length;
  const unstaged = repository.files.length - staged;
  const clean = repository.files.length === 0;

  return (
    <aside ref={ref} className="nav-sidebar" style={{ width }}
      onContextMenu={(event) => {
        // Keep the native cut/copy/paste menu in the search box.
        if ((event.target as HTMLElement).closest('input, textarea')) return;
        openMenu(event, 'Side bar menu', sidebarEntries());
      }}>
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
      <div className="nav-search" role="search">
        <Search size={12} strokeWidth={1.5} className="nav-search__icon" />
        <input
          className="nav-search__input"
          type="text"
          value={query}
          placeholder="Search menu, branches, tags…"
          aria-label="Search the workspace menu"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
            // Enter jumps to the first matching menu item.
            if (event.key === 'Enter' && navItems.length > 0) onNavigate(navItems[0].id);
          }}
        />
        {query && (
          <button
            type="button"
            className="nav-search__clear"
            aria-label="Clear search"
            title="Clear (Esc)"
            onClick={() => setQuery('')}
          >
            <X size={11} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {nothingFound && <p className="nav-search__empty">No match for “{query.trim()}”</p>}
      {(!searching || workspaceItems.length > 0) && (
      <div className="nav-sidebar__workspace">
        <button
          className="nav-sidebar__heading"
          type="button"
          aria-expanded={workspaceOpen || searching}
          onClick={() => setWorkspaceOpen(!workspaceOpen)}
        >
          <span>Workspace</span>
          <ChevronUp size={10} />
        </button>
        {(workspaceOpen || searching) && (
          <nav>
            {workspaceItems.map(renderNavItem)}
          </nav>
        )}
      </div>
      )}

      {showExtensionsGroup && (
      <div className="nav-sidebar__workspace nav-sidebar__extensions">
        <button
          className="nav-sidebar__heading"
          type="button"
          aria-expanded={extensionsOpen || searching}
          onClick={() => setExtensionsOpen(!extensionsOpen)}
        >
          <span>{EXTENSIONS_GROUP_LABEL}</span>
          <ChevronUp size={10} />
        </button>
        {(extensionsOpen || searching) && (
          <nav aria-label="Extensions">
            <button
              type="button"
              className={`nav-item${activeScreen === 'extensions' ? ' nav-item--active' : ''}`}
              onClick={() => onNavigate('extensions')}
              onContextMenu={(event) => openMenu(event, 'Extensions menu', [
                { label: 'Open', onSelect: () => onNavigate('extensions'), disabled: activeScreen === 'extensions' },
                ...(onOpenGuide ? [{ label: 'Open guide', onSelect: () => onOpenGuide('extensions') }] : []),
                { separator: true as const },
                ...sidebarEntries(),
              ])}
            >
              <extensionsNav.icon size={13} className="nav-item__icon" strokeWidth={1.25} />
              <span className="nav-item__label">{extensionsNav.label}</span>
            </button>
            {menuExtensions.map(renderNavItem)}
            {extensionRows.map((extension) => (
              <button
                key={extension.id}
                type="button"
                className={`nav-item nav-item--extension${extension.enabled ? '' : ' nav-item--off'}`}
                title={`${extension.name} v${extension.version}${extension.enabled ? '' : ' (off)'}`}
                onClick={() => {
                  requestOpenExtension(extension.id);
                  onOpenExtension?.(extension.id);
                }}
                onContextMenu={(event) => openMenu(event, `${extension.name} menu`, [
                  { label: 'Manage in Settings', onSelect: () => { requestOpenExtension(extension.id); onOpenExtension?.(extension.id); } },
                  { label: extension.enabled ? 'Turn off' : 'Turn on', onSelect: () => setExtensionEnabled(extension.id, !extension.enabled) },
                ])}
              >
                <Puzzle size={13} className="nav-item__icon" strokeWidth={1.25} />
                <span className="nav-item__label">{extension.name}</span>
                {!extension.enabled && <span className="nav-item__badge">off</span>}
              </button>
            ))}
          </nav>
        )}
      </div>
      )}

      <div className="nav-sidebar__refs">
        {(!searching || branchRows.length > 0 || creating) && (
        <Section
          title="Local branches"
          count={searching ? branchRows.length : repository.branches.length}
          forceOpen={searching}
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
          {branchRows.map(({ branch, index }) => (
            <button
              key={branch.name}
              type="button"
              className={`nav-branch${branch.isHead ? ' nav-branch--active' : ''}`}
              onClick={(event) => handleBranchClick(event, branch.name)}
              onContextMenu={(event) => openMenu(event, `Branch ${branch.name} menu`, [
                { label: 'Checkout', onSelect: () => void checkoutBranch(branch.name), disabled: branch.isHead || busy },
                { label: 'Copy branch name', onSelect: () => copy(branch.name, 'the branch name') },
                { separator: true },
                { label: 'Delete branch', danger: true, onSelect: () => void deleteBranch(branch.name), disabled: branch.isHead || busy },
              ])}
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
        )}

        {remoteRows.length > 0 && (
          <Section title="Remotes" count={remoteRows.length} forceOpen={searching}>
            {remoteRows.map(({ remote, branches }) => (
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
                    onContextMenu={(event) => openMenu(event, `Remote branch ${remote}/${branch} menu`, [
                      { label: 'Copy branch name', onSelect: () => copy(`${remote}/${branch}`, 'the branch name') },
                    ])}
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

        {(!searching || tagRows.length > 0 || tagCreating) && (
        <Section
          title="Tags"
          count={searching ? tagRows.length : repository.tagTotal}
          forceOpen={searching}
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
            {tagRows.map((tag) => (
              <button
                key={tag.name}
                type="button"
                className="nav-branch nav-branch--tag"
                onContextMenu={(event) => openMenu(event, `Tag ${tag.name} menu`, [
                  { label: 'Copy tag name', onSelect: () => copy(tag.name, 'the tag name') },
                  { separator: true },
                  { label: 'Delete tag', danger: true, onSelect: () => void deleteTag(tag.name), disabled: busy },
                ])}
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
        )}

        {/* The design keeps STASHES visible even when the list is empty. */}
        {(!searching || stashRows.length > 0) && (
        <Section
          title="Stashes"
          count={searching ? stashRows.length : repository.stashes.length}
          forceOpen={searching}
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
            {stashRows.map((stash) => (
              <div
                key={stash.index}
                className="nav-stash"
                onContextMenu={(event) => openMenu(event, `Stash ${stash.index} menu`, [
                  { label: 'Apply (keep the stash)', onSelect: () => void stashApply(stash.index), disabled: busy },
                  { label: 'Pop (apply and remove)', onSelect: () => void stashPop(stash.index), disabled: busy },
                  { label: 'Open in Stashes Code', onSelect: () => onNavigate('stashes') },
                  { label: 'Copy message', onSelect: () => copy(stash.message, 'the stash message') },
                  { separator: true },
                  { label: 'Drop stash', danger: true, onSelect: () => void stashDrop(stash.index), disabled: busy },
                ])}
              >
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
        )}

        {worktreeRows.length > 0 && (
          <Section title="Worktrees" count={worktreeRows.length} forceOpen={searching}>
            {worktreeRows.map((tree) => (
              <button
                key={tree.name}
                type="button"
                className={`nav-branch${tree.isCurrent ? ' nav-branch--current' : ''}`}
                onContextMenu={(event) => openMenu(event, `Worktree ${tree.name} menu`, [
                  { label: 'Open as workspace', onSelect: () => void openRepository(tree.path), disabled: tree.isCurrent || busy },
                  { label: 'Copy path', onSelect: () => copy(tree.path, 'the path') },
                ])}
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

        {submoduleRows.length > 0 && (
          <Section title="Submodules" count={submoduleRows.length} forceOpen={searching}>
            {submoduleRows.map((sub) => (
              <button
                key={sub.name}
                type="button"
                className="nav-branch"
                onContextMenu={(event) => openMenu(event, `Submodule ${sub.name} menu`, [
                  { label: 'Open as workspace', onSelect: () => void openRepository(sub.absPath), disabled: busy },
                  { label: 'Copy path', onSelect: () => copy(sub.path, 'the path') },
                  { label: 'Copy URL', onSelect: () => copy(sub.url, 'the URL') },
                ])}
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
      {menu && <CanvasContextMenu x={menu.x} y={menu.y} entries={menu.entries} label={menu.label} onClose={() => setMenu(null)} />}
    </aside>
  );
}
