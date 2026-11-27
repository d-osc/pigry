/** The left side of the RESTful API screen: Collections (tree with folders and requests, drag to reorder), Environments
 * (with the globals) and History. */
import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Clock, Folder, FolderOpen, Globe, Layers, MoreHorizontal, Plus, Search, Trash2, X } from 'lucide-react';
import { historyByDay, type ApiItem, type Collection, type Environment, type HistoryEntry } from './api';
import { MethodBadge } from './ApiParts';

export type SideSection = 'collections' | 'environments' | 'history';
export interface DragRef { key: string; id: string }
export type DropPos = 'before' | 'after' | 'inside';
export interface MenuItem { label: string; run: () => void; danger?: boolean }

interface TreeProps {
  collections: Array<{ key: string; collection: Collection }>;
  open: Set<string>;
  onToggle: (id: string) => void;
  activeRequest: { key: string; id: string } | null;
  activeOther: string | null;
  filter: string;
  renaming: { key: string; id: string | null } | null;
  onRename: (key: string, id: string | null, name: string | null) => void;
  onOpenRequest: (key: string, id: string) => void;
  onOpenCollection: (key: string) => void;
  onOpenFolder: (key: string, id: string) => void;
  menuFor: (key: string, item: ApiItem | null) => MenuItem[];
  onDrop: (from: DragRef, to: { key: string; id: string | null }, pos: DropPos) => void;
}

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  return (
    <span className="api-rowmenu" ref={box}>
      <button type="button" className="dc-icon api-row__more" aria-label={`More actions for ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}><MoreHorizontal size={13} /></button>
      {open && (
        <div className="dc__popup api-popup" role="menu" aria-label={`${label} actions`}>
          {items.map((m) => <button key={m.label} type="button" role="menuitem" className={`api-popup__item${m.danger ? ' api-popup__item--danger' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(false); m.run(); }}>{m.label}</button>)}
        </div>
      )}
    </span>
  );
}

function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input className="dc-input api-row__rename" aria-label={label} autoFocus value={value} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim() || null)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onDone(value.trim() || null); } if (e.key === 'Escape') onDone(null); }} />
  );
}

const matches = (item: ApiItem, q: string): boolean => item.name.toLowerCase().includes(q) || (item.type === 'request' ? item.url.toLowerCase().includes(q) || item.method.toLowerCase() === q : item.items.some((c) => matches(c, q)));

export function CollectionTree(p: TreeProps) {
  const [drag, setDrag] = useState<DragRef | null>(null);
  const [drop, setDrop] = useState<{ key: string; id: string | null; pos: DropPos } | null>(null);
  const q = p.filter.trim().toLowerCase();

  const dragProps = (key: string, id: string | null, folderLike: boolean) => ({
    draggable: id !== null && !p.renaming,
    onDragStart: (e: ReactDragEvent) => { if (!id) return; e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-pigry-api', `${key}\n${id}`); setDrag({ key, id }); },
    onDragEnd: () => { setDrag(null); setDrop(null); },
    onDragOver: (e: ReactDragEvent) => {
      if (!drag || (drag.key === key && drag.id === id)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      const pos: DropPos = id === null ? 'inside' : folderLike ? (y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside') : (y < 0.5 ? 'before' : 'after');
      if (drop?.key !== key || drop.id !== id || drop.pos !== pos) setDrop({ key, id, pos });
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const from = drag, to = drop;
      setDrag(null); setDrop(null);
      if (from && to) p.onDrop(from, { key: to.key, id: to.id }, to.pos);
    },
  });
  const dropClass = (key: string, id: string | null) => (drop && drop.key === key && drop.id === id ? ` api-row--drop-${drop.pos}` : '');

  const renderItems = (key: string, items: ApiItem[], depth: number): ReactNode => items.filter((i) => !q || matches(i, q)).map((item) => {
    const pad = { paddingLeft: 8 + depth * 14 };
    const renamingThis = p.renaming?.key === key && p.renaming.id === item.id;
    if (item.type === 'folder') {
      const isOpen = !!q || p.open.has(item.id);
      return (
        <div key={item.id} role="treeitem" aria-expanded={isOpen} aria-label={item.name}>
          <div className={`api-row${p.activeOther === `${key}#${item.id}` ? ' api-row--on' : ''}${dropClass(key, item.id)}`} style={pad} {...dragProps(key, item.id, true)} onClick={() => { p.onToggle(item.id); p.onOpenFolder(key, item.id); }}>
            <button type="button" className="dc-icon api-row__chev" aria-label={isOpen ? `Collapse ${item.name}` : `Expand ${item.name}`} onClick={(e) => { e.stopPropagation(); p.onToggle(item.id); }}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
            {isOpen ? <FolderOpen size={13} className="api-muted" /> : <Folder size={13} className="api-muted" />}
            {renamingThis ? <RenameInput initial={item.name} label="Folder name" onDone={(n) => p.onRename(key, item.id, n)} /> : <span className="api-row__name">{item.name}</span>}
            <RowMenu label={item.name} items={p.menuFor(key, item)} />
          </div>
          {isOpen && <div role="group">{renderItems(key, item.items, depth + 1)}{!item.items.length && !q && <div className="api-row api-row--empty" style={{ paddingLeft: 30 + depth * 14 }}>This folder is empty</div>}</div>}
        </div>
      );
    }
    const on = p.activeRequest?.key === key && p.activeRequest.id === item.id;
    return (
      <div key={item.id} role="treeitem" aria-label={item.name} aria-selected={on} className={`api-row api-row--req${on ? ' api-row--on' : ''}${dropClass(key, item.id)}`} style={{ paddingLeft: 26 + depth * 14 }} {...dragProps(key, item.id, false)} onClick={() => p.onOpenRequest(key, item.id)}>
        <MethodBadge method={item.method} short />
        {renamingThis ? <RenameInput initial={item.name} label="Request name" onDone={(n) => p.onRename(key, item.id, n)} /> : <span className="api-row__name" title={item.url}>{item.name}</span>}
        <RowMenu label={item.name} items={p.menuFor(key, item)} />
      </div>
    );
  });

  if (!p.collections.length) return <div className="api-side__empty"><Layers size={28} className="api-muted" /><p>Create a collection to save and group your requests, or import one from Postman, OpenAPI or cURL.</p></div>;
  return (
    <div role="tree" aria-label="Collections" className="api-tree">
      {p.collections.map(({ key, collection }) => {
        if (q && !collection.name.toLowerCase().includes(q) && !collection.items.some((i) => matches(i, q))) return null;
        const isOpen = !!q || p.open.has(key);
        const renamingThis = p.renaming?.key === key && p.renaming.id === null;
        return (
          <div key={key} role="treeitem" aria-expanded={isOpen} aria-label={collection.name}>
            <div className={`api-row api-row--col${p.activeOther === key ? ' api-row--on' : ''}${dropClass(key, null)}`} {...dragProps(key, null, true)} onClick={() => { p.onToggle(key); p.onOpenCollection(key); }} title={key}>
              <button type="button" className="dc-icon api-row__chev" aria-label={isOpen ? `Collapse ${collection.name}` : `Expand ${collection.name}`} onClick={(e) => { e.stopPropagation(); p.onToggle(key); }}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
              {renamingThis ? <RenameInput initial={collection.name} label="Collection name" onDone={(n) => p.onRename(key, null, n)} /> : <span className="api-row__name">{collection.name}</span>}
              {key.split('/')[0] !== 'user' && <span className="api-owner" title="Owner folder">{key.split('/')[0]}</span>}
              <RowMenu label={collection.name} items={p.menuFor(key, null)} />
            </div>
            {isOpen && <div role="group">{renderItems(key, collection.items, 1)}{!collection.items.length && !q && <div className="api-row api-row--empty" style={{ paddingLeft: 30 }}>This collection is empty — add a request from the ⋯ menu</div>}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function EnvironmentList({ envs, selected, activeTab, onSelect, onOpen, menuFor }: { envs: Array<{ key: string; env: Environment }>; selected: string | null; activeTab: string | null; onSelect: (key: string | null) => void; onOpen: (key: string) => void; menuFor: (key: string) => MenuItem[] }) {
  return (
    <div className="api-envs" role="list" aria-label="Environments">
      <div role="listitem" className={`api-row${activeTab === 'globals' ? ' api-row--on' : ''}`} onClick={() => onOpen('globals')}>
        <Globe size={13} className="api-muted" /><span className="api-row__name">Globals</span>
      </div>
      {envs.map(({ key, env }) => (
        <div key={key} role="listitem" aria-label={env.name} className={`api-row${activeTab === key ? ' api-row--on' : ''}`} onClick={() => onOpen(key)} title={key}>
          <button type="button" className={`dc-icon api-env__check${selected === key ? ' api-env__check--on' : ''}`} aria-label={selected === key ? `${env.name} is active` : `Set ${env.name} active`} aria-pressed={selected === key} onClick={(e) => { e.stopPropagation(); onSelect(selected === key ? null : key); }}><Check size={12} /></button>
          <span className="api-row__name">{env.name}</span>
          <span className="api-muted api-row__count">{env.values.length}</span>
          <RowMenu label={env.name} items={menuFor(key)} />
        </div>
      ))}
      {!envs.length && <div className="api-side__empty"><p>An environment is a set of variables, such as baseUrl and token for dev or production. Create one with +.</p></div>}
    </div>
  );
}

export function HistoryList({ entries, now, onOpen, onRemove, onClear }: { entries: HistoryEntry[]; now: number; onOpen: (e: HistoryEntry) => void; onRemove: (id: string) => void; onClear: () => void }) {
  const [q, setQ] = useState('');
  const shown = q ? entries.filter((e) => `${e.method} ${e.url}`.toLowerCase().includes(q.toLowerCase())) : entries;
  if (!entries.length) return <div className="api-side__empty"><Clock size={28} className="api-muted" /><p>Requests you send appear here. History stays on this computer (.pigry/cache, not committed).</p></div>;
  return (
    <div className="api-history">
      <div className="api-side__tools">
        <div className="api-search api-search--side"><Search size={12} /><input aria-label="Search history" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button type="button" className="dc-link" onClick={onClear}>Clear all</button>
      </div>
      {historyByDay(shown, now).map((g) => (
        <div key={g.label} role="group" aria-label={g.label}>
          <div className="api-side__group">{g.label}</div>
          {g.entries.map((e) => (
            <div key={e.id} className="api-row api-row--req" role="button" tabIndex={0} aria-label={`${e.method} ${e.url}`} onClick={() => onOpen(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpen(e); }} title={`${new Date(e.at).toLocaleString()}${e.status ? ` · ${e.status}` : ''}${e.error ? ` · ${e.error}` : ''}`}>
              <MethodBadge method={e.method} short />
              <span className="api-row__name">{e.url}</span>
              {e.status !== null ? <span className={`api-row__count api-status--text-${e.status >= 400 ? 'bad' : 'ok'}`}>{e.status}</span> : <span className="api-row__count api-fail">ERR</span>}
              <button type="button" className="dc-icon api-row__more" aria-label={`Remove ${e.method} ${e.url} from history`} onClick={(ev) => { ev.stopPropagation(); onRemove(e.id); }}><X size={12} /></button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SideHeader({ section, onSection, onNew, onImport, filter, onFilter }: { section: SideSection; onSection: (s: SideSection) => void; onNew: () => void; onImport: () => void; filter: string; onFilter: (v: string) => void }) {
  return (
    <>
      <div className="api-side__tabs" role="tablist" aria-label="Side bar">
        {([['collections', 'Collections', Layers], ['environments', 'Environments', Globe], ['history', 'History', Clock]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={section === id} className={`api-side__tab${section === id ? ' api-side__tab--on' : ''}`} onClick={() => onSection(id)}><Icon size={14} /> {label}</button>
        ))}
      </div>
      {section !== 'history' && (
        <div className="api-side__tools">
          <button type="button" className="dc-icon" aria-label={section === 'collections' ? 'New collection' : 'New environment'} title={section === 'collections' ? 'New collection' : 'New environment'} onClick={onNew}><Plus size={14} /></button>
          {section === 'collections' && <div className="api-search api-search--side"><Search size={12} /><input aria-label="Filter collections" placeholder="Filter" value={filter} onChange={(e) => onFilter(e.target.value)} />{filter && <button type="button" className="dc-icon" aria-label="Clear filter" onClick={() => onFilter('')}><X size={11} /></button>}</div>}
          <span className="dc-grow" />
          <button type="button" className="dc-btn api-import" onClick={onImport}>Import</button>
        </div>
      )}
    </>
  );
}

export const ConfirmDelete = ({ what, onYes, onNo }: { what: string; onYes: () => void; onNo: () => void }) => (
  <div className="dc-modal__scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onNo(); }}>
    <div className="dc-modal" role="dialog" aria-modal="true" aria-label="Delete" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onNo(); }}>
      <header className="dc-modal__head"><h2>Delete {what}?</h2></header>
      <div className="dc-modal__body"><p>{what} will be deleted. You can get it back from the Git history if it was committed.</p></div>
      <footer className="dc-modal__foot"><span className="dc-grow" /><button type="button" className="dc-btn" autoFocus onClick={onNo}>Cancel</button><button type="button" className="dc-btn dc-btn--danger" onClick={onYes}><Trash2 size={12} /> Delete</button></footer>
    </div>
  </div>
);
