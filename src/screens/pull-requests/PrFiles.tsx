import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { useRequestGate } from '../../hooks/useRequestGate';
import { parseUnifiedByFile, type PrDiffFile } from '../../lib/ghData';
import { ghPrDiff } from '../../lib/tauriClient';
import type { GhPrDetail } from '../../types/repository';
import { PrDiffDialog } from './PrDiffDialog';

export function PrFiles({ detail }: { detail: GhPrDetail }) {
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
      const result = parseUnifiedByFile(await ghPrDiff(detail.number));
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
        <h3>{detail.files.length} {detail.files.length === 1 ? 'file' : 'files'} changed</h3>
        <span className="pr-section__diffstat">
          <span className="pr-diff--added">+{detail.files.reduce((sum, file) => sum + file.additions, 0)}</span>{' '}
          <span className="pr-diff--removed">−{detail.files.reduce((sum, file) => sum + file.deletions, 0)}</span>{' '}
          <button type="button" className="pr-section__link" disabled={loading} onClick={() => void loadDiff(true)}>
            View full diff →
          </button>
        </span>
      </div>
      {loading && !expandedPath && <p className="pr-section__muted" role="status">Loading diff…</p>}
      {error && !expandedPath && <p className="pr-section__muted" role="alert">{error}</p>}
      {detail.files.map((file) => {
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
                {diff && (diff.original || diff.modified) ? (
                  <DiffEditor
                    height={280}
                    original={diff.original}
                    modified={diff.modified}
                    language={diff.language}
                    options={{
                      readOnly: true,
                      renderSideBySide: false,
                      ignoreTrimWhitespace: false,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                    }}
                  />
                ) : diffs && (
                  <p className="pr-section__muted">No text diff available for this file.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
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
