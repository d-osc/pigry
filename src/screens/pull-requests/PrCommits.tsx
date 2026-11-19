import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { ghPrCommitDiff } from '../../lib/tauriClient';
import { parseUnifiedByFile, type PrDiffFile } from '../../lib/ghData';
import type { GhPrCommit } from '../../types/repository';
import { PrInlineDiff } from './PrInlineDiff';

export function PrCommits({ commits }: { commits: GhPrCommit[] }) {
  const request = useRequestGate();
  const [expandedOid, setExpandedOid] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ oid: string; files: PrDiffFile[] } | null>(null);

  const toggleCommit = async (oid: string) => {
    if (expandedOid === oid) {
      request.invalidate();
      setExpandedOid(null);
      return;
    }
    const isCurrent = request.begin();
    setExpandedOid(oid);
    setError(null);
    if (diff?.oid === oid) return;

    try {
      const patch = await ghPrCommitDiff(oid);
      if (!isCurrent()) return;
      const files = parseUnifiedByFile(patch);
      setDiff({ oid, files });
      setExpandedPath(files[0]?.path ?? null);
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="pr-section">
      <h3>{commits.length} {commits.length === 1 ? 'commit' : 'commits'}</h3>
      {commits.map(({ oid, message }) => {
        const expanded = expandedOid === oid;
        const Icon = expanded ? ChevronDown : ChevronRight;
        const files = diff?.oid === oid ? diff.files : null;
        return (
          <div key={oid}>
            <button
              type="button"
              className="pr-file pr-file--clickable"
              title={message}
              aria-expanded={expanded}
              onClick={() => void toggleCommit(oid)}
            >
              <Icon size={12} className="pr-file__icon" />
              <span className="pr-file__path">{message}</span>
              <span className="pr-file__stat">{oid.slice(0, 7)}</span>
            </button>
            {expanded && (
              <div className="pr-commit__files">
                {error && <p className="pr-section__muted" role="alert">{error}</p>}
                {!error && !files && <p className="pr-section__muted" role="status">Loading changed files…</p>}
                {files?.length === 0 && <p className="pr-section__muted">No changed files.</p>}
                {files?.map((file) => {
                  const fileExpanded = expandedPath === file.path;
                  const FileIcon = fileExpanded ? ChevronDown : ChevronRight;
                  return (
                    <div key={file.path}>
                      <button
                        type="button"
                        className="pr-file pr-file--clickable"
                        aria-expanded={fileExpanded}
                        title={file.path}
                        onClick={() => setExpandedPath(fileExpanded ? null : file.path)}
                      >
                        <FileIcon size={12} className="pr-file__icon" />
                        <span className="pr-file__path">{file.path}</span>
                      </button>
                      {fileExpanded && (
                        <div className="pr-file__compare">
                          <PrInlineDiff diff={file} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
