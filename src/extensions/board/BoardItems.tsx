import { useMemo, useState } from 'react';
import { ArrowRight, Code2, Hexagon, Workflow, Lock, PenLine, Search, Smile, SquareStack, StickyNote, Type } from 'lucide-react';
import { COLOR_STYLES, colorOf, type Board, type BoardItem } from './board';
import { describeCode } from '../../lib/codeSnap';

const ICONS = { sticky: StickyNote, text: Type, shape: Hexagon, connector: ArrowRight, section: SquareStack, pen: PenLine, stamp: Smile, embed: Workflow, code: Code2 } as const;

interface Props {
  board: Board;
  selected: string[];
  onSelect: (id: string, additive: boolean) => void;
}

/** Outline of the board — sections with their notes, then loose items — with a search box. */
export function BoardItems({ board, selected, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (item: BoardItem) => !q || (item.text ?? '').toLowerCase().includes(q) || (item.author ?? '').toLowerCase().includes(q);

  const groups = useMemo(() => {
    const sections = board.items.filter((i) => i.type === 'section');
    const rows = (items: BoardItem[]) => items.filter((i) => i.type !== 'section' && matches(i));
    const sectionRows = sections.map((section) => ({ section, items: rows(board.items.filter((i) => i.parent === section.id)) }));
    const loose = rows(board.items.filter((i) => !i.parent));
    return { sectionRows: sectionRows.filter((g) => !q || g.items.length > 0 || matches(g.section)), loose };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, q]);

  const row = (item: BoardItem, depth: number) => {
    const Icon = ICONS[item.type];
    const label = item.type === 'connector'
      ? (item.text || `${board.items.find((i) => i.id === item.from)?.text ?? 'point'} → ${board.items.find((i) => i.id === item.to)?.text ?? 'point'}`)
      : item.type === 'stamp' ? item.emoji ?? '' : item.type === 'pen' ? 'Drawing' : item.type === 'embed' ? (item.text || item.embed?.ref || 'Embed') : item.type === 'code' ? (item.text || (item.code ? describeCode(item.code) : 'Code')) : (item.text || '(empty)');
    return (
      <li key={item.id} role="treeitem" aria-selected={selected.includes(item.id)}>
        <div className={`brd-row${selected.includes(item.id) ? ' brd-row--on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={(event) => onSelect(item.id, event.shiftKey || event.ctrlKey || event.metaKey)}>
          <span className="brd-row__dot" style={{ background: item.type === 'connector' || item.type === 'pen' || item.type === 'embed' || item.type === 'code' ? 'transparent' : colorOf(item).fill, borderColor: COLOR_STYLES[item.color ?? 'gray'].stroke }}>
            {(item.type === 'connector' || item.type === 'pen' || item.type === 'stamp' || item.type === 'text' || item.type === 'embed' || item.type === 'code') && <Icon size={9} strokeWidth={1.75} />}
          </span>
          <span className="brd-row__text" title={label}>{label.replace(/\n/g, ' ')}</span>
          {item.locked && <Lock size={10} className="brd-row__meta" />}
          {item.votes?.length ? <span className="brd-row__votes" title={`${item.votes.length} votes`}>{item.votes.length}</span> : null}
        </div>
      </li>
    );
  };

  const empty = groups.sectionRows.length === 0 && groups.loose.length === 0;
  return (
    <div className="brd-items">
      <label className="brd-search">
        <Search size={12} strokeWidth={1.5} />
        <input aria-label="Search notes" placeholder="Search notes…" value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }} />
      </label>
      {empty ? (
        <p className="brd-empty">{q ? `No notes match “${query.trim()}”.` : 'No items yet — add a sticky with S.'}</p>
      ) : (
        <ul role="tree" aria-label="Board items" className="brd-items__list">
          {groups.sectionRows.map(({ section, items }) => (
            <li key={section.id} role="treeitem" aria-selected={selected.includes(section.id)}>
              <div className={`brd-row brd-row--section${selected.includes(section.id) ? ' brd-row--on' : ''}`} onClick={(event) => onSelect(section.id, event.shiftKey || event.ctrlKey || event.metaKey)}>
                <span className="brd-row__dot brd-row__dot--section" style={{ background: colorOf(section).fill }} />
                <span className="brd-row__text">{section.text || 'Section'}</span>
                <span className="brd-row__count">{items.length}</span>
              </div>
              <ul role="group" className="brd-items__list">{items.map((item) => row(item, 1))}</ul>
            </li>
          ))}
          {groups.loose.length > 0 && (
            <li role="treeitem">
              {groups.sectionRows.length > 0 && <div className="brd-row brd-row--label">Outside sections</div>}
              <ul role="group" className="brd-items__list">{groups.loose.map((item) => row(item, groups.sectionRows.length > 0 ? 1 : 0))}</ul>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
