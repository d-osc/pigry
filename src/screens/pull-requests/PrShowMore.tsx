import { useState } from 'react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { ghPrItemsPage } from '../../lib/tauriClient';
import type { GhPrCommit, GhPrFile } from '../../types/repository';

type ItemByKind = { files: GhPrFile; commits: GhPrCommit };

export function usePrItems<K extends keyof ItemByKind>(
  number: number, kind: K, initial: ItemByKind[K][], getKey: (item: ItemByKind[K]) => string,
) {
  const request = useRequestGate();
  const [extra, setExtra] = useState<ItemByKind[K][]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const hasMore = cursor !== null && (cursor !== undefined || initial.length >= 100);
  const items = [...new Map([...initial, ...extra].map((item) => [getKey(item), item])).values()];

  const showMore = async () => {
    if (loading || !hasMore) return;
    const isCurrent = request.begin();
    setLoading(true);
    setError('');
    try {
      const page = await ghPrItemsPage(number, kind, cursor ?? null);
      if (!isCurrent()) return;
      setExtra((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  return { items, hasMore, loading, error, showMore };
}

export function PrShowMore({ kind, hasMore, loading, error, showMore }: {
  kind: keyof ItemByKind;
  hasMore: boolean;
  loading: boolean;
  error: string;
  showMore: () => Promise<void>;
}) {
  if (!hasMore) return null;
  return (
    <div className="pr-show-more">
      {error && <p role="alert">{error}</p>}
      <button type="button" className="outline-button" disabled={loading} onClick={() => void showMore()}>
        {loading ? `Loading ${kind}…` : `Show more ${kind}`}
      </button>
    </div>
  );
}
