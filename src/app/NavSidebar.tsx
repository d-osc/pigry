import { useRef, useState } from 'react';
import {
  ChevronUp,
  Settings,
  Puzzle,
  ChevronsLeft,
  Search,
  X,
  Pin,
  PinOff,
} from 'lucide-react';
import { useRepository } from '../hooks/useRepository';
import { EXTENSIONS_GROUP_LABEL, extensionsNav, workspaceNav, type NavId, type NavItem } from './navigation';
import { useDisabledMenus, useExtensions, useQuickAccess } from '../hooks/useExtensions';
import { movePinnedTo, setPinned } from '../lib/quickAccess';
import { requestOpenExtension, setExtensionEnabled } from '../lib/extensions';
import { CanvasContextMenu, type CanvasMenuEntry } from './CanvasContextMenu';
import './NavSidebar.css';

/** Branch lane colors, cycled in list order (matches the commit graph lanes). */
export const laneColor = (index: number) =>
  `var(--lane-${(index % 4) + 1})`;

/** A menu the side bar lists: a Workspace or Extensions menu, or the Extension Store itself. */
type MenuItem = Omit<NavItem, 'id'> & { id: NavId };

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

export function NavSidebar({ ref, width, activeScreen, onNavigate, onOpenSettings, onCollapse, onOpenGuide, onOpenExtension }: NavSidebarProps) {
  const { repository } = useRepository();
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; entries: CanvasMenuEntry[] } | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [extensionsOpen, setExtensionsOpen] = useState(true);
  const [quickOpen, setQuickOpen] = useState(true);
  const quickIds = useQuickAccess();
  const dragging = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const extensions = useExtensions();
  const disabledMenus = useDisabledMenus();
  const [query, setQuery] = useState('');
  if (!repository) return null;

  // Search filters the menu items.
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = (...texts: Array<string | undefined>) =>
    !searching || texts.some((text) => text?.toLowerCase().includes(q));
  // Diagram, Design, Board, E2E Testing and Reports are built-in extensions: they sit in the Extensions group
  // (unless switched off) instead of the Workspace group.
  const workspaceItems = workspaceNav.filter(({ label, group }) => group !== 'extension' && matches(label));
  const menuExtensions = workspaceNav.filter(({ id, label, group }) => group === 'extension' && !disabledMenus.has(id) && matches(label));
  const pinnable: MenuItem[] = [...workspaceNav, extensionsNav];
  const pinnedItems = quickIds
    .map((id) => pinnable.find((item) => item.id === id))
    .filter((item): item is MenuItem => !!item && !disabledMenus.has(item.id));
  const quickItems = pinnedItems.filter(({ label }) => matches(label));
  const navItems = [...quickItems, ...workspaceItems, ...menuExtensions];
  const extensionRows = extensions.filter((extension) => matches(extension.name, extension.id));
  const showExtensionsGroup = !searching || extensionRows.length > 0 || menuExtensions.length > 0 || matches(extensionsNav.label) || matches(EXTENSIONS_GROUP_LABEL);
  const nothingFound = searching && navItems.length + extensionRows.length + (showExtensionsGroup ? 1 : 0) === 0;

  /** Right-click menu for whatever was clicked; the browser's own menu never shows inside the side bar. */
  const openMenu = (event: React.MouseEvent, label: string, entries: CanvasMenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, label, entries });
  };
  const sidebarEntries = (): CanvasMenuEntry[] => [
    ...(onCollapse ? [{ label: 'Collapse side bar', shortcut: 'Ctrl+B', onSelect: onCollapse }] : []),
    { label: 'Preferences', shortcut: '⌘,', onSelect: onOpenSettings },
  ];

  const renderNavItem = ({ id, label, icon: Icon, badge }: MenuItem, inQuick = false) => {
    const pinned = quickIds.includes(id);
    const at = pinnedItems.findIndex((item) => item.id === id);
    const pinEntries: CanvasMenuEntry[] = inQuick
      ? [
          { label: 'Move up', onSelect: () => movePinnedTo(id, at - 1), disabled: at <= 0 },
          { label: 'Move down', onSelect: () => movePinnedTo(id, at + 1), disabled: at < 0 || at >= pinnedItems.length - 1 },
          { label: 'Unpin from Quick access', onSelect: () => setPinned(id, false) },
        ]
      : [{ label: pinned ? 'Unpin from Quick access' : 'Pin to Quick access', onSelect: () => setPinned(id, !pinned) }];
    return (
    <div
      key={id}
      className={`nav-row${pinned ? ' nav-row--pinned' : ''}${inQuick && dropTarget === id ? ' nav-row--drop' : ''}`}
      draggable={inQuick}
      onDragStart={inQuick ? (event) => { dragging.current = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); } : undefined}
      onDragOver={inQuick ? (event) => { if (dragging.current && dragging.current !== id) { event.preventDefault(); setDropTarget(id); } } : undefined}
      onDragLeave={inQuick ? () => setDropTarget((t) => (t === id ? null : t)) : undefined}
      onDrop={inQuick ? (event) => { event.preventDefault(); const from = dragging.current; dragging.current = null; setDropTarget(null); if (from && from !== id) movePinnedTo(from, at); } : undefined}
      onDragEnd={inQuick ? () => { dragging.current = null; setDropTarget(null); } : undefined}
    >
    <button
      type="button"
      className={`nav-item${activeScreen === id ? ' nav-item--active' : ''}`}
      draggable={inQuick || undefined}
      onClick={() => onNavigate(id)}
      onContextMenu={(event) => openMenu(event, `${label} menu`, [
        { label: 'Open', onSelect: () => onNavigate(id), disabled: activeScreen === id },
        ...(onOpenGuide ? [{ label: 'Open guide', onSelect: () => onOpenGuide(id) }] : []),
        ...pinEntries,
        { separator: true as const },
        ...sidebarEntries(),
      ])}
    >
      <Icon size={13} className="nav-item__icon" strokeWidth={1.25} />
      <span className="nav-item__label">{label}</span>
      {id === 'working-changes' && !clean && (
        <span className="nav-item__badge">{repository.files.length}</span>
      )}
      {id === 'merge-conflicts' && conflictedCount > 0 && (
        <span className="nav-item__badge nav-item__badge--warn" aria-label={`${conflictedCount} conflicted file${conflictedCount === 1 ? '' : 's'}`}>{conflictedCount}</span>
      )}
      {id === 'pull-commits' && repository.upstream && repository.upstream.behind > 0 && (
        <span className="nav-item__badge">{repository.upstream.behind}</span>
      )}
      {id !== 'working-changes' && badge !== undefined && (
        <span className="nav-item__badge">{badge}</span>
      )}
    </button>
    <button
      type="button"
      className="nav-row__pin"
      aria-label={pinned ? 'Unpin from Quick access' : 'Pin to Quick access'}
      aria-pressed={pinned}
      title={pinned ? 'Unpin from Quick access' : 'Pin to Quick access'}
      onClick={() => setPinned(id, !pinned)}
    >
      {inQuick ? <PinOff size={12} strokeWidth={1.5} /> : <Pin size={12} strokeWidth={1.5} fill={pinned ? 'currentColor' : 'none'} />}
    </button>
    </div>
    );
  };

  const clean = repository.files.length === 0;
  const conflictedCount = new Set(repository.files.filter((f) => f.status === 'C').map((f) => f.path)).size;

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
          placeholder="Search menu…"
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
      {(!searching || quickItems.length > 0) && (
      <div className="nav-sidebar__group nav-sidebar__quick">
        <button
          className="nav-sidebar__heading"
          type="button"
          aria-expanded={quickOpen || searching}
          onClick={() => setQuickOpen(!quickOpen)}
        >
          <span>Quick access</span>
          <ChevronUp size={10} />
        </button>
        {(quickOpen || searching) && (
          <nav aria-label="Quick access">
            {quickItems.map((item) => renderNavItem(item, true))}
            {pinnedItems.length === 0 && (
              <p className="nav-quick__empty"><Pin size={11} strokeWidth={1.5} /> Pin a menu from Workspace or Extensions to keep it here.</p>
            )}
          </nav>
        )}
      </div>
      )}
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
            {workspaceItems.map((item) => renderNavItem(item))}
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
            {renderNavItem(extensionsNav)}
            {menuExtensions.map((item) => renderNavItem(item))}
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

      <div className="nav-sidebar__footer">
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
