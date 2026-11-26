/** Notes building blocks: the note editor (composer and edit dialog), the checklist editor, the colour / reminder /
 * label / more pickers, and a note card. */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  Archive, ArchiveRestore, BellPlus, Check, ChevronDown, ChevronRight, Clock, EllipsisVertical, GripVertical, ImagePlus, Palette, Pin, Plus, RotateCcw, Trash2, X,
} from 'lucide-react';
import {
  BACKGROUNDS, COLORS, REPEATS, backgroundOf, checkedItems, colorOf, editedLabel, formatReminder, isOverdue, localStamp, newItem, presetDate, uncheckedItems,
  type ChecklistItem, type Note, type NoteBackground, type NoteColor, type Reminder, type Repeat,
} from './notes';

export type Pop = 'color' | 'remind' | 'label' | 'more' | null;

/** Closes an open picker on a click outside the pickers and toolbars, or on Esc (which then does nothing else). */
function usePopClose(pop: Pop, setPop: (p: Pop) => void): void {
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => { const t = e.target as Element | null; if (!t?.closest('.nt-pop, .nt-tools__wrap')) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPop(null); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [pop, setPop]);
}

/** Card / editor colours: dark and light variants as CSS variables (the stylesheet picks one by theme). */
export function noteStyle(note: Pick<Note, 'color' | 'background'>): CSSProperties {
  const c = colorOf(note.color), b = backgroundOf(note.background);
  return { '--nt-l': c.light, '--nt-d': c.dark, '--nt-pattern': b.css || 'none' } as CSSProperties;
}
const noteClass = (note: Pick<Note, 'color' | 'background'>, base: string): string => `${base}${note.color === 'default' ? ` ${base}--plain` : ''}${note.background !== 'none' ? ` ${base}--bg` : ''}`;

export function IconBtn({ label, onClick, children, on, className = '', disabled }: { label: string; onClick: () => void; children: ReactNode; on?: boolean; className?: string; disabled?: boolean }) {
  return <button type="button" className={`nt-ib${on ? ' nt-ib--on' : ''} ${className}`} aria-label={label} title={label} aria-pressed={on} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }}>{children}</button>;
}

/* ---------------- pickers ---------------- */

export function ColorPicker({ color, background, onColor, onBackground }: { color: NoteColor; background: NoteBackground; onColor: (c: NoteColor) => void; onBackground: (b: NoteBackground) => void }) {
  return (
    <div className="nt-pop nt-pop--colors" role="dialog" aria-label="Background options" onClick={(e) => e.stopPropagation()}>
      <div className="nt-swatches" role="radiogroup" aria-label="Colour">
        {COLORS.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={color === c.id} aria-label={c.label} title={c.label} className={`nt-swatch${color === c.id ? ' nt-swatch--on' : ''}${c.id === 'default' ? ' nt-swatch--none' : ''}`} style={{ '--nt-l': c.light, '--nt-d': c.dark } as CSSProperties} onClick={() => onColor(c.id)}>
            {color === c.id && <Check size={14} />}
          </button>
        ))}
      </div>
      <hr />
      <div className="nt-swatches" role="radiogroup" aria-label="Background">
        {BACKGROUNDS.map((b) => (
          <button key={b.id} type="button" role="radio" aria-checked={background === b.id} aria-label={b.label} title={b.label} className={`nt-swatch nt-swatch--bg${background === b.id ? ' nt-swatch--on' : ''}`} style={{ '--nt-pattern': b.css || 'none' } as CSSProperties} onClick={() => onBackground(b.id)}>
            <span aria-hidden>{b.glyph || '⌀'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReminderPicker({ reminder, onSet }: { reminder: Reminder | null; onSet: (r: Reminder | null) => void }) {
  const [custom, setCustom] = useState(false);
  const [at, setAt] = useState(reminder?.at ?? '');
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? 'none');
  const preset = (p: 'later' | 'tomorrow' | 'week') => onSet({ at: localStamp(presetDate(p, new Date())), repeat: 'none' });
  return (
    <div className="nt-pop nt-pop--remind" role="dialog" aria-label="Remind me" onClick={(e) => e.stopPropagation()}>
      {!custom ? (
        <>
          <div className="nt-pop__title">Reminder:</div>
          <button type="button" className="nt-pop__item" onClick={() => preset('later')}><span>Later today</span><span className="nt-muted">8:00 PM</span></button>
          <button type="button" className="nt-pop__item" onClick={() => preset('tomorrow')}><span>Tomorrow</span><span className="nt-muted">8:00 AM</span></button>
          <button type="button" className="nt-pop__item" onClick={() => preset('week')}><span>Next week</span><span className="nt-muted">Mon, 8:00 AM</span></button>
          <button type="button" className="nt-pop__item" onClick={() => { setCustom(true); if (!at) { const d = presetDate('tomorrow', new Date()); setAt(localStamp(d)); } }}><span><Clock size={13} /> Pick date &amp; time</span></button>
          {reminder && <button type="button" className="nt-pop__item" onClick={() => onSet(null)}><span><X size={13} /> Remove reminder</span></button>}
        </>
      ) : (
        <div className="nt-pop__form">
          <div className="nt-pop__title"><button type="button" className="nt-ib" aria-label="Back" onClick={() => setCustom(false)}><ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /></button> Pick date &amp; time</div>
          <input type="datetime-local" className="dc-input" aria-label="Reminder date and time" value={at} onChange={(e) => setAt(e.target.value)} />
          <select className="dc-select" aria-label="Repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
            {REPEATS.map((r) => <option key={r} value={r}>{r === 'none' ? 'Does not repeat' : r[0].toUpperCase() + r.slice(1)}</option>)}
          </select>
          <div className="nt-row-end"><button type="button" className="dc-btn dc-btn--primary" disabled={!at} onClick={() => onSet({ at: at.slice(0, 16), repeat })}>Save</button></div>
        </div>
      )}
    </div>
  );
}

export function LabelPicker({ labels, on, onToggle, onCreate }: { labels: string[]; on: string[]; onToggle: (label: string, on: boolean) => void; onCreate: (label: string) => void }) {
  const [q, setQ] = useState('');
  const query = q.trim();
  const shown = labels.filter((l) => l.toLowerCase().includes(query.toLowerCase()));
  const exists = labels.some((l) => l.toLowerCase() === query.toLowerCase());
  return (
    <div className="nt-pop nt-pop--labels" role="dialog" aria-label="Label note" onClick={(e) => e.stopPropagation()}>
      <div className="nt-pop__title">Label note</div>
      <input className="nt-pop__search" aria-label="Enter label name" placeholder="Enter label name" value={q} autoFocus onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && query && !exists) { onCreate(query); setQ(''); } }} />
      <div className="nt-pop__list">
        {shown.map((l) => (
          <label key={l} className="nt-pop__check"><input type="checkbox" checked={on.includes(l)} onChange={(e) => onToggle(l, e.target.checked)} /> <span>{l}</span></label>
        ))}
      </div>
      {query && !exists && <button type="button" className="nt-pop__item nt-pop__create" onClick={() => { onCreate(query); setQ(''); }}><span><Plus size={13} /> Create &quot;{query}&quot;</span></button>}
    </div>
  );
}

export interface MoreItem { label: string; run: () => void }
export function MoreMenu({ items }: { items: MoreItem[] }) {
  return (
    <div className="nt-pop nt-pop--more" role="menu" aria-label="More" onClick={(e) => e.stopPropagation()}>
      {items.map((it) => <button key={it.label} type="button" role="menuitem" className="nt-pop__item" onClick={it.run}><span>{it.label}</span></button>)}
    </div>
  );
}

/* ---------------- note toolbar (cards and editor) ---------------- */

export interface ToolbarProps {
  note: Note;
  pop: Pop;
  setPop: (p: Pop) => void;
  labels: string[];
  more: MoreItem[];
  onColor: (c: NoteColor) => void;
  onBackground: (b: NoteBackground) => void;
  onReminder: (r: Reminder | null) => void;
  onLabel: (label: string, on: boolean) => void;
  onImage: () => void;
  onArchive?: () => void;
  trash?: { onRestore: () => void; onDelete: () => void };
}
export function NoteToolbar({ note, pop, setPop, labels, more, onColor, onBackground, onReminder, onLabel, onImage, onArchive, trash }: ToolbarProps) {
  const toggle = (p: Pop) => setPop(pop === p ? null : p);
  if (trash) {
    return (
      <div className="nt-tools" onClick={(e) => e.stopPropagation()}>
        <IconBtn label="Delete forever" onClick={trash.onDelete}><Trash2 size={15} /></IconBtn>
        <IconBtn label="Restore" onClick={trash.onRestore}><RotateCcw size={15} /></IconBtn>
      </div>
    );
  }
  return (
    <div className="nt-tools" onClick={(e) => e.stopPropagation()}>
      <span className="nt-tools__wrap"><IconBtn label="Remind me" on={pop === 'remind'} onClick={() => toggle('remind')}><BellPlus size={15} /></IconBtn>{pop === 'remind' && <ReminderPicker reminder={note.reminder} onSet={(r) => { onReminder(r); setPop(null); }} />}</span>
      <span className="nt-tools__wrap"><IconBtn label="Background options" on={pop === 'color'} onClick={() => toggle('color')}><Palette size={15} /></IconBtn>{pop === 'color' && <ColorPicker color={note.color} background={note.background} onColor={onColor} onBackground={onBackground} />}</span>
      <IconBtn label="Add image" onClick={onImage}><ImagePlus size={15} /></IconBtn>
      {onArchive && <IconBtn label={note.archived ? 'Unarchive' : 'Archive'} onClick={onArchive}>{note.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</IconBtn>}
      <span className="nt-tools__wrap">
        <IconBtn label="More" on={pop === 'more' || pop === 'label'} onClick={() => toggle('more')}><EllipsisVertical size={15} /></IconBtn>
        {pop === 'more' && <MoreMenu items={[...more.map((it) => ({ ...it, run: () => { setPop(null); it.run(); } })), { label: note.labels.length ? 'Change labels' : 'Add label', run: () => setPop('label') }]} />}
        {pop === 'label' && <LabelPicker labels={labels} on={note.labels} onToggle={onLabel} onCreate={(l) => onLabel(l, true)} />}
      </span>
    </div>
  );
}

/* ---------------- chips ---------------- */

export function Chips({ note, now, onRemoveLabel, onRemoveReminder, onReminder, onLabel }: { note: Note; now: number; onRemoveLabel?: (l: string) => void; onRemoveReminder?: () => void; onReminder?: () => void; onLabel?: (l: string) => void }) {
  if (!note.labels.length && !note.reminder) return null;
  return (
    <div className="nt-chips">
      {note.reminder && (
        <span className={`nt-chip${isOverdue(note.reminder, now) ? ' nt-chip--overdue' : ''}`} data-testid="reminder-chip">
          <button type="button" className="nt-chip__main" onClick={(e) => { e.stopPropagation(); onReminder?.(); }}><Clock size={12} /> {formatReminder(note.reminder, now)}</button>
          {onRemoveReminder && <button type="button" className="nt-chip__x" aria-label="Remove reminder" onClick={(e) => { e.stopPropagation(); onRemoveReminder(); }}><X size={11} /></button>}
        </span>
      )}
      {note.labels.map((l) => (
        <span key={l} className="nt-chip" data-testid="label-chip">
          <button type="button" className="nt-chip__main" onClick={(e) => { e.stopPropagation(); onLabel?.(l); }}>{l}</button>
          {onRemoveLabel && <button type="button" className="nt-chip__x" aria-label={`Remove label ${l}`} onClick={(e) => { e.stopPropagation(); onRemoveLabel(l); }}><X size={11} /></button>}
        </span>
      ))}
    </div>
  );
}

export function Images({ note, onRemove }: { note: Note; onRemove?: (id: string) => void }) {
  if (!note.images.length) return null;
  return (
    <div className={`nt-images nt-images--${Math.min(3, note.images.length)}`}>
      {note.images.map((m) => (
        <figure key={m.id} className="nt-image">
          <img src={m.src} alt={m.alt || 'Note image'} draggable={false} />
          {onRemove && <button type="button" className="nt-image__x" aria-label="Remove image" onClick={(e) => { e.stopPropagation(); onRemove(m.id); }}><Trash2 size={13} /></button>}
        </figure>
      ))}
    </div>
  );
}

/* ---------------- checklist editor ---------------- */

/** Moves the caret to an item's input; call it after flushSync so a new item is already in the DOM (fast typing goes on there). */
function focusItem(root: HTMLElement | null, id: string, caret: 'end' | 'start' | number = 'end'): void {
  const input = root?.querySelector<HTMLInputElement>(`input[data-item="${id}"]`);
  if (!input) return;
  input.focus();
  const at = caret === 'end' ? input.value.length : caret === 'start' ? 0 : caret;
  input.setSelectionRange(at, at);
}

export function ChecklistEditor({ items, onChange, readOnly }: { items: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void; readOnly?: boolean }) {
  const [showChecked, setShowChecked] = useState(true);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const open = items.filter((i) => !i.checked), done = items.filter((i) => i.checked);
  const set = (id: string, patch: Partial<ChecklistItem>) => onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const insertAfter = (id: string | null, item: ChecklistItem) => {
    const next = [...items];
    const at = id ? next.findIndex((i) => i.id === id) + 1 : (() => { const lastOpen = [...next].reverse().find((i) => !i.checked); return lastOpen ? next.indexOf(lastOpen) + 1 : 0; })();
    next.splice(at, 0, item);
    onChange(next);
  };
  const move = (id: string, delta: number) => {
    const list = open.map((i) => i.id);
    const k = list.indexOf(id);
    const target = list[k + delta];
    if (k < 0 || !target) return;
    const next = items.filter((i) => i.id !== id);
    const t = next.findIndex((i) => i.id === target);
    next.splice(delta > 0 ? t + 1 : t, 0, items.find((i) => i.id === id)!);
    onChange(next);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>, item: ChecklistItem) => {
    e.stopPropagation();
    const root = e.currentTarget.closest<HTMLElement>('.nt-list');
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      const at = input.selectionStart ?? item.text.length;
      const fresh = newItem(item.text.slice(at), item.checked);
      const next = items.map((i) => (i.id === item.id ? { ...i, text: item.text.slice(0, at) } : i));
      next.splice(next.findIndex((i) => i.id === item.id) + 1, 0, fresh);
      flushSync(() => onChange(next));
      focusItem(root, fresh.id, 'start');
    } else if (e.key === 'Backspace' && (input.selectionStart ?? 0) === 0 && input.selectionEnd === 0) {
      const peers = item.checked ? done : open;
      const prev = peers[peers.indexOf(item) - 1];
      if (!prev && item.text) return;
      e.preventDefault();
      onChange(items.flatMap((i) => (i.id === item.id ? [] : prev && i.id === prev.id ? [{ ...i, text: i.text + item.text }] : [i])));
      if (prev) focusItem(root, prev.id, prev.text.length);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !item.checked) {
      e.preventDefault();
      flushSync(() => move(item.id, e.key === 'ArrowUp' ? -1 : 1));
      focusItem(root, item.id);
    } else if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const all = [...open, ...(showChecked ? done : [])];
      const other = all[all.indexOf(item) + (e.key === 'ArrowUp' ? -1 : 1)];
      if (other) { e.preventDefault(); focusItem(root, other.id); }
    }
  };
  const onDragOver = (e: ReactDragEvent, id: string) => {
    if (!drag || drag === id) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (drop?.id !== id || drop.after !== after) setDrop({ id, after });
  };
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    if (drag && drop) {
      const item = items.find((i) => i.id === drag)!;
      const next = items.filter((i) => i.id !== drag);
      const t = next.findIndex((i) => i.id === drop.id);
      next.splice(drop.after ? t + 1 : t, 0, item);
      onChange(next);
    }
    setDrag(null); setDrop(null);
  };
  const row = (item: ChecklistItem) => (
    <div key={item.id} className={`nt-item${item.checked ? ' nt-item--done' : ''}${drop?.id === item.id ? (drop.after ? ' nt-item--drop-after' : ' nt-item--drop') : ''}${drag === item.id ? ' nt-item--dragging' : ''}`} data-testid="checklist-item"
      onDragOver={(e) => onDragOver(e, item.id)} onDrop={onDrop}>
      {!readOnly && !item.checked ? (
        <span className="nt-item__grip" draggable aria-label={`Drag ${item.text || 'item'}`} title="Drag to reorder (or Alt+↑ / Alt+↓)"
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); setDrag(item.id); }} onDragEnd={() => { setDrag(null); setDrop(null); }}><GripVertical size={14} /></span>
      ) : <span className="nt-item__grip nt-item__grip--off" />}
      <input type="checkbox" className="nt-item__box" aria-label={`${item.checked ? 'Uncheck' : 'Check'} ${item.text || 'item'}`} checked={item.checked} disabled={readOnly} onChange={(e) => set(item.id, { checked: e.target.checked })} />
      <input className="nt-item__text" data-item={item.id} aria-label="List item" value={item.text} readOnly={readOnly} onChange={(e) => set(item.id, { text: e.target.value })} onKeyDown={(e) => onKey(e, item)} />
      {!readOnly && <button type="button" className="nt-ib nt-item__x" aria-label={`Delete ${item.text || 'item'}`} onClick={() => onChange(items.filter((i) => i.id !== item.id))}><X size={13} /></button>}
    </div>
  );
  return (
    <div className="nt-list">
      {open.map(row)}
      {!readOnly && (
        <div className="nt-item nt-item--new">
          <span className="nt-item__grip nt-item__grip--off" />
          <Plus size={15} className="nt-item__plus" />
          <input className="nt-item__text" aria-label="New list item" placeholder="List item" value=""
            onChange={(e) => { const root = e.currentTarget.closest<HTMLElement>('.nt-list'); const fresh = newItem(e.target.value); flushSync(() => insertAfter(null, fresh)); focusItem(root, fresh.id); }}
            onKeyDown={(e) => e.stopPropagation()} />
        </div>
      )}
      {done.length > 0 && (
        <>
          <button type="button" className="nt-list__checked" aria-expanded={showChecked} onClick={() => setShowChecked((v) => !v)}>
            {showChecked ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {done.length} Checked item{done.length === 1 ? '' : 's'}
          </button>
          {showChecked && done.map(row)}
        </>
      )}
    </div>
  );
}

/* ---------------- note editor (composer and dialog) ---------------- */

export interface EditorProps extends Omit<ToolbarProps, 'note' | 'pop' | 'setPop'> {
  note: Note;
  now: number;
  mode: 'composer' | 'dialog';
  readOnly?: boolean;
  onChange: (patch: Partial<Note>) => void;
  onPin: () => void;
  onClose: () => void;
  onDropImages: (files: File[]) => void;
}
export function NoteEditor(props: EditorProps) {
  const { note, now, mode, readOnly, onChange, onPin, onClose, onDropImages } = props;
  const [pop, setPop] = useState<Pop>(null);
  usePopClose(pop, setPop);
  const takeFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
  return (
    <div className={noteClass(note, 'nt-editor')} style={noteStyle(note)} data-testid={mode === 'composer' ? 'note-composer' : 'note-editor'}
      onClick={() => { if (pop) setPop(null); }}
      onPaste={(e) => { if (readOnly) return; const files = takeFiles(e.clipboardData?.files); if (files.length) { e.preventDefault(); onDropImages(files); } }}
      onDragOver={(e) => { if (!readOnly && [...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); }}
      onDrop={(e) => { const files = takeFiles(e.dataTransfer.files); if (files.length && !readOnly) { e.preventDefault(); onDropImages(files); } }}>
      <Images note={note} onRemove={readOnly ? undefined : (id) => onChange({ images: note.images.filter((m) => m.id !== id) })} />
      <div className="nt-editor__head">
        <input className="nt-editor__title" aria-label="Title" placeholder="Title" value={note.title} readOnly={readOnly} onChange={(e) => onChange({ title: e.target.value })}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter') { e.preventDefault(); const root = e.currentTarget.closest('.nt-editor'); root?.querySelector<HTMLElement>('.nt-editor__body, .nt-item__text')?.focus(); } }} />
        {!readOnly && <IconBtn label={note.pinned ? 'Unpin note' : 'Pin note'} on={note.pinned} onClick={onPin}>{note.pinned ? <Pin size={16} fill="currentColor" /> : <Pin size={16} />}</IconBtn>}
      </div>
      {note.kind === 'checklist'
        ? <ChecklistEditor items={note.items} readOnly={readOnly} onChange={(items) => onChange({ items })} />
        : <textarea className="nt-editor__body" aria-label="Note" placeholder="Take a note…" value={note.body} readOnly={readOnly} autoFocus={mode === 'composer'} rows={Math.min(24, Math.max(mode === 'composer' ? 2 : 3, note.body.split('\n').length + 1))}
          onChange={(e) => onChange({ body: e.target.value })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }} />}
      <Chips note={note} now={now} onRemoveLabel={readOnly ? undefined : (l) => props.onLabel(l, false)} onRemoveReminder={readOnly ? undefined : () => props.onReminder(null)} onReminder={() => setPop('remind')} />
      {mode === 'dialog' && <div className="nt-editor__meta">{readOnly ? "Can't edit in Trash" : editedLabel(note.updated, now)}</div>}
      <div className="nt-editor__foot">
        <NoteToolbar {...props} pop={pop} setPop={setPop} />
        <span className="dc-grow" />
        <button type="button" className="nt-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ---------------- note card ---------------- */

export interface CardProps extends Omit<ToolbarProps, 'pop' | 'setPop'> {
  now: number;
  selected: boolean;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  onOpen: () => void;
  onPin?: () => void;
  onItems: (items: ChecklistItem[]) => void;
  onLabelClick: (label: string) => void;
  onKeyAction: (key: string) => void;
  dragProps: { draggable: boolean; onDragStart: (e: ReactDragEvent) => void; onDragEnd: () => void; onDragOver: (e: ReactDragEvent) => void; onDrop: (e: ReactDragEvent) => void };
}
export function NoteCard(props: CardProps) {
  const { note, now, selected, dragging, drop, onOpen, onPin, onItems, onLabelClick, onKeyAction, dragProps, trash } = props;
  const [pop, setPop] = useState<Pop>(null);
  usePopClose(pop, setPop);
  const open = uncheckedItems(note), done = checkedItems(note);
  const shownItems = open.slice(0, 10);
  const label = note.title || (note.kind === 'checklist' ? open[0]?.text : note.body.split('\n')[0]) || 'Empty note';
  return (
    <article className={`${noteClass(note, 'nt-card')}${selected ? ' nt-card--focus' : ''}${pop ? ' nt-card--pop' : ''}${dragging ? ' nt-card--dragging' : ''}${drop ? ` nt-card--drop-${drop}` : ''}`}
      style={noteStyle(note)} aria-label={`Note ${label}`} data-testid="note-card" data-id={note.id} tabIndex={0}
      onClick={() => { if (pop) { setPop(null); return; } onOpen(); }}
      onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') { e.preventDefault(); onOpen(); } else if (['e', '#', 'f', 'Delete'].includes(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); onKeyAction(e.key); } }}
      {...dragProps}>
      <Images note={note} />
      {onPin && <IconBtn label={note.pinned ? 'Unpin note' : 'Pin note'} on={note.pinned} className="nt-card__pin" onClick={onPin}>{note.pinned ? <Pin size={16} fill="currentColor" /> : <Pin size={16} />}</IconBtn>}
      {note.title && <h3 className="nt-card__title">{note.title}</h3>}
      {note.kind === 'checklist' ? (
        <ul className="nt-card__items">
          {shownItems.map((it) => (
            <li key={it.id} className="nt-card__item">
              <input type="checkbox" aria-label={`Check ${it.text || 'item'}`} checked={false} disabled={!!trash} onClick={(e) => e.stopPropagation()} onChange={() => onItems(note.items.map((x) => (x.id === it.id ? { ...x, checked: true } : x)))} />
              <span>{it.text}</span>
            </li>
          ))}
          {open.length > shownItems.length && <li className="nt-card__more">…</li>}
          {done.length > 0 && <li className="nt-card__more" data-testid="checked-count">+ {done.length} checked item{done.length === 1 ? '' : 's'}</li>}
        </ul>
      ) : note.body ? <div className="nt-card__body">{note.body}</div> : null}
      {!note.title && !note.body.trim() && !note.items.length && !note.images.length && <div className="nt-card__body nt-muted">Empty note</div>}
      <Chips note={note} now={now} onRemoveLabel={trash ? undefined : (l) => props.onLabel(l, false)} onRemoveReminder={trash ? undefined : () => props.onReminder(null)} onReminder={() => setPop('remind')} onLabel={onLabelClick} />
      <NoteToolbar {...props} pop={pop} setPop={setPop} />
    </article>
  );
}
