/** Hunk bar: per-hunk rows with Stage/Unstage/Discard hunk buttons. */
import { Minus, Plus, X } from 'lucide-react';
import { useFileHunks } from '../../hooks/useFileHunks';
import { useRepository } from '../../hooks/useRepository';
import './HunkBar.css';

interface HunkBarProps {
  /** selectedFileId = "<path>:staged|unstaged" */
  selectedFileId: string;
  reloadKey: number;
  onMutated: () => void;
}

export function HunkBar({ selectedFileId, reloadKey, onMutated }: HunkBarProps) {
  const { stageHunk, unstageHunk, discardHunk, busy } = useRepository();
  const sep = selectedFileId.lastIndexOf(':');
  const path = selectedFileId.slice(0, sep);
  const staged = selectedFileId.slice(sep + 1) === 'staged';
  const { hunks, loading } = useFileHunks(path, reloadKey, staged);

  if (loading || !hunks || hunks.length === 0) return null;

  return (
    <div className="hunk-bar" aria-label={staged ? 'Staged hunks' : 'Unstaged hunks'}>
      {hunks.map((hunk) => (
        <div key={hunk.index} className="hunk-bar__row">
          <span className="hunk-bar__header">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </span>
          {hunk.context && <span className="hunk-bar__context">{hunk.context}</span>}
          <span className="hunk-bar__preview" title={hunk.preview}>
            {hunk.preview}
          </span>
          <span className="hunk-bar__actions">
            {staged ? (
              <button
                type="button"
                className="hunk-bar__stage hunk-bar__stage--unstage"
                onClick={() => {
                  void unstageHunk(path, hunk.index).then(() => onMutated());
                }}
                disabled={busy}
              >
                <Minus size={11} />
                Unstage hunk
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="hunk-bar__stage"
                  onClick={() => {
                    void stageHunk(path, hunk.index).then(() => onMutated());
                  }}
                  disabled={busy}
                >
                  <Plus size={11} />
                  Stage hunk
                </button>
                <button
                  type="button"
                  className="hunk-bar__stage hunk-bar__stage--discard"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Discard this hunk? The changes in it will be lost.',
                      )
                    ) {
                      void discardHunk(path, hunk.index).then(() => onMutated());
                    }
                  }}
                  disabled={busy}
                >
                  <X size={11} />
                  Discard hunk
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
