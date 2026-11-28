/** Searchable branch / tag picker for Compare branch: a button that opens a type-to-filter list grouped into local
 * branches, remote branches and tags. Arrow keys move, Enter picks, Esc closes. The value is a full ref name
 * ("refs/heads/main", "refs/remotes/origin/x", "refs/tags/v1.0"). */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Cloud, GitBranch, Search, Tag } from 'lucide-react';
import type { CheckoutRefInfo } from '../../lib/tauriClient';

const GROUPS: { kind: CheckoutRefInfo['kind']; title: string }[] = [
  { kind: 'local', title: 'Local branches' },
  { kind: 'remote', title: 'Remote branches' },
  { kind: 'tag', title: 'Tags' },
];
const ICONS = { local: GitBranch, remote: Cloud, tag: Tag } as const;
/** Large repositories can carry thousands of tags; typing narrows the rest. */
const MAX_OPTIONS = 300;

export function fullRefName(ref: Pick<CheckoutRefInfo, 'kind' | 'name'>): string {
  const prefix = ref.kind === 'local' ? 'refs/heads/' : ref.kind === 'remote' ? 'refs/remotes/' : 'refs/tags/';
  return prefix + ref.name;
}

/** "refs/tags/v1.0" → { kind: 'tag', name: 'v1.0' }, so a value shows even before the list has it. */
function describeRef(value: string): { kind: CheckoutRefInfo['kind']; name: string } {
  if (value.startsWith('refs/remotes/')) return { kind: 'remote', name: value.slice('refs/remotes/'.length) };
  if (value.startsWith('refs/tags/')) return { kind: 'tag', name: value.slice('refs/tags/'.length) };
  return { kind: 'local', name: value.replace(/^refs\/heads\//, '') };
}

function matches(ref: CheckoutRefInfo, terms: string[]): boolean {
  const name = ref.name.toLowerCase();
  return terms.every(term => name.includes(term) || (ref.shortOid !== '' && ref.shortOid.startsWith(term)));
}

interface Props {
  label: string;
  refs: CheckoutRefInfo[];
  value: string;
  onChange: (value: string) => void;
}

export function RefCombobox({ label, refs, value, onChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const q = query.trim();
  const { options, total } = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const found = GROUPS.flatMap(({ kind }) => refs
      .filter(ref => ref.kind === kind && matches(ref, terms))
      // The checked-out branch first, then the backend's order (newest commit first).
      .sort((a, b) => Number(b.isHead) - Number(a.isHead)));
    return { options: found.slice(0, MAX_OPTIONS), total: found.length };
  }, [refs, q]);

  const active = Math.min(activeIndex, Math.max(0, options.length - 1));
  const activeOption = options[active];
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, options]);

  const show = (initialQuery = ''): void => {
    setQuery(initialQuery);
    // Start on the current value, so Enter right away keeps it.
    setActiveIndex(initialQuery ? 0 : Math.max(0, options.findIndex(ref => fullRefName(ref) === value)));
    setOpen(true);
  };

  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (ref: CheckoutRefInfo | undefined): void => {
    if (!ref) return;
    close(true);
    const next = fullRefName(ref);
    if (next !== value) onChange(next);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      show();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on the closed picker starts a search with that character.
      event.preventDefault();
      show(event.key);
    }
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const count = options.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(count ? (active + 1) % count : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(count ? (active - 1 + count) % count : 0);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setActiveIndex(Math.max(0, count - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(activeOption);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  // Focus leaving the picker (Tab, a click elsewhere) closes it.
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
  };

  const current = refs.find(ref => fullRefName(ref) === value) ?? { ...describeRef(value), isHead: false };
  const CurrentIcon = ICONS[current.kind];
  const listId = `${id}-list`;
  const indexed = options.map((ref, at) => ({ ref, at }));

  return (
    <div className="ref-combobox" onBlur={onBlur}>
      <span className="ref-combobox__label" id={`${id}-label`}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="push__search ref-combobox__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        title={value}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKeyDown}
      >
        <CurrentIcon size={13} className={`ref-combobox__icon ref-combobox__icon--${current.kind}`} aria-hidden="true" />
        <span className="ref-combobox__value">{current.name}</span>
        <ChevronDown size={13} className="ref-combobox__chevron" aria-hidden="true" />
      </button>
      {open && (
        // Clicks inside keep focus in the search box, so the list stays open until a pick.
        <div className="ref-combobox__popover" onMouseDown={event => event.preventDefault()}>
          <div className="ref-combobox__search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOption ? optionId(active) : undefined}
              placeholder="Search branches and tags"
              spellCheck={false}
              value={query}
              onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div className="ref-combobox__list" id={listId} role="listbox" aria-labelledby={`${id}-label`} ref={listRef}>
            {GROUPS.map(({ kind, title }) => {
              const group = indexed.filter(({ ref }) => ref.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} role="group" aria-labelledby={`${id}-${kind}`}>
                  <div className="ref-combobox__group" id={`${id}-${kind}`} role="presentation">{title}</div>
                  {group.map(({ ref, at }) => {
                    const Icon = ICONS[kind];
                    const selected = fullRefName(ref) === value;
                    return (
                      <div
                        key={`${kind}:${ref.name}`}
                        id={optionId(at)}
                        role="option"
                        aria-selected={selected}
                        data-active={at === active}
                        className={`ref-combobox__option${at === active ? ' ref-combobox__option--active' : ''}`}
                        onMouseMove={() => { if (at !== active) setActiveIndex(at); }}
                        onClick={() => pick(ref)}
                      >
                        <Icon size={13} className={`ref-combobox__icon ref-combobox__icon--${kind}`} aria-hidden="true" />
                        <span className="ref-combobox__name">{ref.name}</span>
                        {ref.isHead && <span className="ref-combobox__badge">current</span>}
                        {ref.shortOid && <code className="ref-combobox__oid">{ref.shortOid}</code>}
                        {selected && <Check size={12} className="ref-combobox__check" aria-hidden="true" />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {options.length === 0 && (
            <p className="ref-combobox__empty" role="status">
              {q ? <>No branch or tag matches “{q}”.</> : 'No branches or tags.'}
            </p>
          )}
          {total > options.length && (
            <p className="ref-combobox__more">Showing {options.length} of {total} — type to narrow the list.</p>
          )}
        </div>
      )}
    </div>
  );
}
