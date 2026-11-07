/** Hunk bar: per-hunk rows with "+ Stage hunk" between controls and diff. */
import { Plus } from 'lucide-react';
import { useFileHunks } from '../../hooks/useFileHunks';
import { useRepository } from '../../hooks/useRepository';
import './HunkBar.css';

interface HunkBarProps {
  /** selectedFileId = "<path>:staged|unstaged" */
  selectedFileId: string;
  reloadKey: number;
  onStaged: () => void;
}

export function HunkBar({ selectedFileId, reloadKey, onStaged }: HunkBarProps) {
  const { stageHunk, busy } = useRepository();
  const sep = selectedFileId.lastIndexOf(':');
  const path = selectedFileId.slice(0, sep);
  const staged = selectedFileId.slice(sep + 1) === 'staged';
  const { hunks, loading } = useFileHunks(path, reloadKey);

  if (staged || loading || !hunks || hunks.length === 0) return null;

  return (
    <div className="hunk-bar" aria-label="Unstaged hunks">
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
            className="hunk-bar__stage"
            onClick={() => {
              void stageHunk(path, hunk.index).then(() => onStaged());
            }}
            disabled={busy}
          >
            <Plus size={11} />
            Stage hunk
          </button>
        </div>
      ))}
    </div>
  );
}
