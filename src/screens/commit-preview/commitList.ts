import { useMemo, useState } from 'react';

export type CommitSort = 'newest' | 'oldest' | 'account-asc' | 'account-desc' | 'replay';

export const COMMIT_TIME_RANGES = [
  { value: 'all', label: 'All time', days: 0 },
  { value: '24h', label: 'Last 24 hours', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: 'year', label: 'This year', days: 365 },
] as const;

export type CommitTimeRange = typeof COMMIT_TIME_RANGES[number]['value'];

export function useCommitTimeRange() {
  const [range, setRange] = useState<CommitTimeRange>('all');
  const cutoff = useMemo(() => {
    const days = COMMIT_TIME_RANGES.find(option => option.value === range)?.days;
    // eslint-disable-next-line react-hooks/purity -- Snapshot the cutoff when the range changes.
    return days ? Date.now() / 1000 - days * 86400 : null;
  }, [range]);
  return { range, setRange, cutoff };
}

interface CommitListEntry {
  oid: string;
  shortOid: string;
  summary: string;
  body?: string;
  authorName: string;
  authorEmail?: string;
  timeSeconds: number;
}

const accounts = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function browseCommits<T extends CommitListEntry>(
  commits: readonly T[],
  sort: CommitSort,
  query = '',
  account = '',
  cutoff: number | null = null,
): T[] {
  const term = query.trim().toLowerCase();
  const matches = commits.filter(commit =>
    (!account || commit.authorName === account) &&
    (cutoff === null || commit.timeSeconds >= cutoff) &&
    (!term || [commit.oid, commit.shortOid, commit.summary, commit.body, commit.authorName, commit.authorEmail]
      .some(value => value?.toLowerCase().includes(term))));
  if (sort === 'replay') return matches;

  return matches.sort((a, b) => {
    const newestFirst = b.timeSeconds - a.timeSeconds;
    if (sort === 'newest') return newestFirst;
    if (sort === 'oldest') return -newestFirst;
    const byAccount = accounts.compare(a.authorName, b.authorName);
    return (sort === 'account-asc' ? byAccount : -byAccount) || newestFirst;
  });
}
