import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { languageForPath, parseUnifiedByFile, type PrDiffFile } from '../../lib/ghData';
import { ghPrDiff, ghPrFilePatches } from '../../lib/tauriClient';
import type { GhPrDetail } from '../../types/repository';
import { PrDiffDialog } from './PrDiffDialog';
import { PrInlineDiff } from './PrInlineDiff';
import { PrShowMore, usePrItems } from './PrShowMore';

async function fetchDiffs(number: number): Promise<PrDiffFile[]> {
  try {
    return parseUnifiedByFile(await ghPrDiff(number));
  } catch (error) {
    if (!/HTTP 406|PullRequest\.diff too_large/i.test(String(error))) throw error;
  }
  const patches = await ghPrFilePatches(number);
  return patches.map(({ path, patch }) => {
    const parsed = patch ? parseUnifiedByFile(`diff --git a/file b/file\n${patch}`)[0] : null;
    return {
      path,
      original: parsed?.original ?? '',
      modified: parsed?.modified ?? '',
      language: languageForPath(path),
      additions: parsed?.additions ?? 0,
      deletions: parsed?.deletions ?? 0,
    };
  });
}

export function PrFiles({ detail }: { detail: GhPrDetail }) {
  const page = usePrItems(detail.number, 'files', detail.files, (file) => file.path);
  const files = page.items;
  const request = useRequestGate();
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<PrDiffFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullDiffOpen, setFullDiffOpen] = useState(false);

  const loadDiff = async (showFullDiff = false) => {
    if (diffs) {
      if (showFullDiff) setFullDiffOpen(true);
      return;
    }
    if (loading) return;

    const isCurrent = request.begin();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDiffs(detail.number);
      if (!isCurrent()) return;
      setDiffs(result);
      if (showFullDiff) setFullDiffOpen(true);
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  return (
    <section className="pr-section">
      <div className="pr-section__head">
        <h3>{files.length} {files.length === 1 ? 'file' : 'files'} changed</h3>
        <span className="pr-section__diffstat">
          <span className="pr-diff--added">+{files.reduce((sum, file) => sum + file.additions, 0)}</span>{' '}
          <span className="pr-diff--removed">−{files.reduce((sum, file) => sum + file.deletions, 0)}</span>{' '}
          <button type="button" className="pr-section__link" disabled={loading} onClick={() => void loadDiff(true)}>
            View full diff →
          </button>
        </span>
      </div>
      {loading && !expandedPath && <p className="pr-section__muted" role="status">Loading diff…</p>}
      {error && !expandedPath && <p className="pr-section__muted" role="alert">{error}</p>}
      {files.map((file) => {
        const expanded = expandedPath === file.path;
        const Icon = expanded ? ChevronDown : ChevronRight;
        const diff = expanded ? diffs?.find(({ path }) => path === file.path) : null;
        return (
          <div key={file.path}>
            <button
              type="button"
              className="pr-file pr-file--clickable"
              aria-expanded={expanded}
              title={file.path}
              onClick={() => {
                setExpandedPath(expanded ? null : file.path);
                if (!expanded) void loadDiff();
              }}
            >
              <Icon size={12} className="pr-file__icon" />
              <span className="pr-file__path">{file.path}</span>
              <span className="pr-file__stat">
                <span className="pr-diff--added">+{file.additions}</span>{' '}
                <span className="pr-diff--removed">−{file.deletions}</span>
              </span>
            </button>
            {expanded && (
              <div className="pr-file__compare">
                {loading && <p className="pr-section__muted" role="status">Loading diff…</p>}
                {error && (
                  <div role="alert">
                    <p className="pr-section__muted">{error}</p>
                    <button type="button" className="pr-section__link" onClick={() => void loadDiff()}>Try again</button>
                  </div>
                )}
                {diffs && <PrInlineDiff diff={diff} />}
              </div>
            )}
          </div>
        );
      })}
      <PrShowMore kind="files" {...page} />
      {fullDiffOpen && diffs && (
        <PrDiffDialog
          title={`Full diff · #${detail.number}`}
          files={diffs}
          headRef={detail.headRef}
          onClose={() => setFullDiffOpen(false)}
        />
      )}
    </section>
  );
}
