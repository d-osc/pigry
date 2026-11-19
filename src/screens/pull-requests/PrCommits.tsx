import { useState } from 'react';
import { CircleDot } from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { ghPrCommitDiff } from '../../lib/tauriClient';
import { parseUnifiedByFile, type PrDiffFile } from '../../lib/ghData';
import type { GhPrCommit } from '../../types/repository';
import { PrDiffDialog } from './PrDiffDialog';

export function PrCommits({ commits }: { commits: GhPrCommit[] }) {
  const request = useRequestGate();
  const [loadingOid, setLoadingOid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ oid: string; files: PrDiffFile[] } | null>(null);

  const openCommit = async (oid: string) => {
    const isCurrent = request.begin();
    setLoadingOid(oid);
    setError(null);
    try {
      const patch = await ghPrCommitDiff(oid);
      if (isCurrent()) setDiff({ oid, files: parseUnifiedByFile(patch) });
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setLoadingOid(null);
    }
  };

  return (
    <section className="pr-section">
      <h3>{commits.length} {commits.length === 1 ? 'commit' : 'commits'}</h3>
      {commits.map(({ oid, message }) => (
        <button
          key={oid}
          type="button"
          className="pr-file pr-file--clickable"
          title={`View changed files for ${oid.slice(0, 7)}`}
          disabled={loadingOid === oid}
          onClick={() => void openCommit(oid)}
        >
          <CircleDot size={11} strokeWidth={1.25} className="pr-file__icon" />
          <span className="pr-file__path">{message}</span>
          <span className="pr-file__stat">{oid.slice(0, 7)}</span>
        </button>
      ))}
      {loadingOid && <p className="pr-section__muted" role="status">Loading changed files…</p>}
      {error && <p className="pr-section__muted" role="alert">{error}</p>}
      {diff && commits.some(({ oid }) => oid === diff.oid) && (
        <PrDiffDialog
          title={`Commit ${diff.oid.slice(0, 7)} · Changed files`}
          files={diff.files}
          showHistoryTools={false}
          onClose={() => setDiff(null)}
        />
      )}
    </section>
  );
}
