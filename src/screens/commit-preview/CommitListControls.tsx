import { useMemo } from 'react';
import { CalendarRange, UserRound } from 'lucide-react';
import { COMMIT_TIME_RANGES, type CommitSort, type CommitTimeRange } from './commitList';
import { FilterDropdown } from './FilterDropdown';
import './CommitListControls.css';

export function CommitSortSelect({ sort, onChange, replay = false }: {
  sort: CommitSort;
  onChange: (sort: CommitSort) => void;
  replay?: boolean;
}) {
  return (
    <select className="commit-list-sort" aria-label="Sort commits" value={sort}
      onChange={event => onChange(event.target.value as CommitSort)}>
      {replay && <option value="replay">Replay order</option>}
      <option value="newest">Date · Newest first</option>
      <option value="oldest">Date · Oldest first</option>
      <option value="account-asc">Account · A–Z</option>
      <option value="account-desc">Account · Z–A</option>
    </select>
  );
}

export function CommitSearch({ query, onChange }: {
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <input type="search" className="commit-list-search" aria-label="Search commits"
      placeholder="Search commits by message, SHA or account"
      value={query} onChange={event => onChange(event.target.value)} />
  );
}

export function CommitFilters({ commits, account, onAccountChange, range, onRangeChange }: {
  commits: readonly { authorName: string }[];
  account: string;
  onAccountChange: (account: string) => void;
  range: CommitTimeRange;
  onRangeChange: (range: CommitTimeRange) => void;
}) {
  const authors = useMemo(() => [...new Set(commits.map(commit => commit.authorName))].filter(Boolean).sort(), [commits]);
  const timeLabel = COMMIT_TIME_RANGES.find(option => option.value === range)?.label ?? 'All time';
  return (
    <>
      <FilterDropdown icon={<UserRound size={16} strokeWidth={1.25} />}
        label={account || 'All authors'} active={!!account} closeOnSelect>
        {['', ...authors].map(author => (
          <button key={author} type="button" role="menuitemradio" aria-checked={account === author}
            className={`filter-dd__item${account === author ? ' filter-dd__item--active' : ''}`}
            onClick={() => onAccountChange(author)}>
            {author || 'All authors'}
          </button>
        ))}
      </FilterDropdown>
      <FilterDropdown icon={<CalendarRange size={16} strokeWidth={1.25} />}
        label={timeLabel} active={range !== 'all'} closeOnSelect>
        {COMMIT_TIME_RANGES.map(({ value, label }) => (
          <button key={value} type="button" role="menuitemradio" aria-checked={range === value}
            className={`filter-dd__item${range === value ? ' filter-dd__item--active' : ''}`}
            onClick={() => onRangeChange(value)}>
            {label}
          </button>
        ))}
      </FilterDropdown>
    </>
  );
}
