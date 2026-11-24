import { useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Frame, Image as ImageIcon, Lock, Minus, Square, Type, Unlock } from 'lucide-react';
import type { Design, DesignNode, NodeType } from './design';

const ICONS: Record<NodeType, typeof Square> = { frame: Frame, rect: Square, ellipse: Circle, text: Type, line: Minus, image: ImageIcon };

type DropZone = 'before' | 'after' | 'inside';

interface LayersProps {
  design: Design;
  selected: string[];
  onSelect: (id: string, additive: boolean) => void;
  onToggle: (id: string, key: 'visible' | 'locked') => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, targetId: string, zone: DropZone) => void;
}

/** Figma-style layer tree: select, show/hide, lock, rename (double-click), drag to reorder or nest. */
export function DesignLayers({ design, selected, onSelect, onToggle, onRename, onMove }: LayersProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; zone: DropZone } | null>(null);

  const finishRename = () => {
    if (renaming && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  };

  const zoneFor = (event: React.DragEvent, node: DesignNode): DropZone => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const t = (event.clientY - rect.top) / rect.height;
    if (node.type === 'frame' && t > 0.28 && t < 0.72) return 'inside';
    return t < 0.5 ? 'before' : 'after';
  };

  const row = (node: DesignNode, depth: number): React.ReactNode => {
    const Icon = ICONS[node.type];
    const hasKids = (node.children?.length ?? 0) > 0;
    const open = !collapsed.has(node.id);
    const target = over?.id === node.id ? over.zone : null;
    return (
      <li key={node.id} role="treeitem" aria-selected={selected.includes(node.id)} aria-expanded={hasKids ? open : undefined}>
        <div
          className={`dgn-layer${selected.includes(node.id) ? ' dgn-layer--on' : ''}${node.visible === false ? ' dgn-layer--hidden' : ''}${target ? ` dgn-layer--drop-${target}` : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={renaming !== node.id}
          onClick={(event) => onSelect(node.id, event.shiftKey || event.ctrlKey || event.metaKey)}
          onDragStart={(event) => { setDrag(node.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.id); }}
          onDragOver={(event) => { if (drag && drag !== node.id) { event.preventDefault(); setOver({ id: node.id, zone: zoneFor(event, node) }); } }}
          onDragLeave={() => setOver((current) => (current?.id === node.id ? null : current))}
          onDrop={(event) => { event.preventDefault(); if (drag && drag !== node.id) onMove(drag, node.id, zoneFor(event, node)); setDrag(null); setOver(null); }}
          onDragEnd={() => { setDrag(null); setOver(null); }}
        >
          <button
            type="button"
            className="dgn-layer__chev"
            aria-label={open ? 'Collapse' : 'Expand'}
            tabIndex={-1}
            style={{ visibility: hasKids ? 'visible' : 'hidden' }}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; });
            }}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
          <Icon size={12} strokeWidth={1.5} className="dgn-layer__icon" />
          {renaming === node.id ? (
            <input
              className="dgn-layer__input"
              autoFocus
              aria-label="Layer name"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={finishRename}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => { if (event.key === 'Enter') finishRename(); if (event.key === 'Escape') setRenaming(null); event.stopPropagation(); }}
            />
          ) : (
            <span className="dgn-layer__name" onDoubleClick={() => { setRenaming(node.id); setDraft(node.name); }} title={`${node.name} (double-click to rename)`}>{node.name}</span>
          )}
          <span className="dgn-layer__actions">
            <button type="button" aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`} className={node.locked ? 'is-on' : ''} onClick={(event) => { event.stopPropagation(); onToggle(node.id, 'locked'); }}>
              {node.locked ? <Lock size={11} /> : <Unlock size={11} />}
            </button>
            <button type="button" aria-label={node.visible === false ? `Show ${node.name}` : `Hide ${node.name}`} className={node.visible === false ? 'is-on' : ''} onClick={(event) => { event.stopPropagation(); onToggle(node.id, 'visible'); }}>
              {node.visible === false ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </span>
        </div>
        {hasKids && open && <ul role="group" className="dgn-layers__list">{[...node.children!].reverse().map((kid) => row(kid, depth + 1))}</ul>}
      </li>
    );
  };

  if (design.nodes.length === 0) return <p className="dgn-empty">No layers yet — draw a frame with F.</p>;
  // Figma lists the top-most layer first.
  return <ul role="tree" aria-label="Layers" className="dgn-layers__list">{[...design.nodes].reverse().map((node) => row(node, 0))}</ul>;
}
