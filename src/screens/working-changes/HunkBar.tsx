/** Hunk bar: per-hunk rows with Stage/Unstage hunk buttons. */
import { Minus, Plus } from 'lucide-react';
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
  const { stageHunk, unstageHunk, busy } = useRepository();
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
          <button
            type="button"
            className={`hunk-bar__stage${staged ? ' hunk-bar__stage--unstage' : ''}`}
            onClick={() => {
              const action = staged
                ? unstageHunk(path, hunk.index)
                : stageHunk(path, hunk.index);
              void action.then(() => onMutated());
            }}
            disabled={busy}
          >
            {staged ? <Minus size={11} /> : <Plus size={11} />}
            {staged ? 'Unstage hunk' : 'Stage hunk'}
          </button>
        </div>
      ))}
    </div>
  );
}
