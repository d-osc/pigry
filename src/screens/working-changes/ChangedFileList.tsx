import { useMemo, useState } from 'react';
import { Minus, Plus, Search } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import type { ChangedFile } from '../../types/repository';
import './ChangedFileList.css';

interface ChangedFileListProps {
  files: ChangedFile[];
  selectedFileId: string | null;
  onSelect: (fileId: string) => void;
}

function statusClass(status: ChangedFile['status']): string {
  switch (status) {
    case 'A':
      return 'changed-file__status--added';
    case 'C':
      return 'changed-file__status--conflicted';
    case 'D':
      return 'changed-file__status--deleted';
    default:
      return 'changed-file__status--modified';
  }
}

export function ChangedFileList({ files, selectedFileId, onSelect }: ChangedFileListProps) {
  const { stage, unstage, busy } = useRepository();
  const [filter, setFilter] = useState('');

  const { unstaged, staged } = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = (file: ChangedFile) =>
      !query || file.path.toLowerCase().includes(query);
    return {
      unstaged: files.filter((f) => !f.staged && matches(f)),
      staged: files.filter((f) => f.staged && matches(f)),
    };
  }, [files, filter]);

  const renderRow = (file: ChangedFile) => (
    <button
      key={file.id}
      type="button"
      className={`changed-file${selectedFileId === file.id ? ' changed-file--selected' : ''}`}
      onClick={() => onSelect(file.id)}
    >
      <span className={`changed-file__status ${statusClass(file.status)}`}>
        {file.status}
      </span>
      <span className="changed-file__meta">
        <span className="changed-file__name">{file.name}</span>
        <span className="changed-file__directory">{file.directory || '—'}</span>
      </span>
      <span className="changed-file__diffstat">
        <span className="changed-file__additions">+{file.additions}</span>
        <span className="changed-file__deletions">−{file.deletions}</span>
      </span>
      <span
        className="changed-file__action"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          const action = file.staged
            ? unstage([file.path])
            : stage([file.path]);
          void action;
        }}
      >
        {file.staged ? <Minus size={12} /> : <Plus size={12} />}
      </span>
    </button>
  );

  return (
    <div className="changed-file-list">
      <div className="file-filter">
        <Search size={12} className="file-filter__icon" />
        <input
          className="file-filter__input"
          placeholder="Filter files…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <kbd className="file-filter__kbd">⌘ F</kbd>
      </div>

      <div className="changed-file-list__scroll">
        {unstaged.length > 0 && (
          <div className="change-group">
            <div className="change-group__head">
              <span>Unstaged changes</span>
              <span className="change-group__count">{unstaged.length}</span>
              <button
                type="button"
                className="change-group__bulk"
                onClick={() => void stage(unstaged.map((f) => f.path))}
                disabled={busy}
              >
                Stage all
              </button>
            </div>
            {unstaged.map(renderRow)}
          </div>
        )}

        {staged.length > 0 && (
          <div className="change-group">
            <div className="change-group__head">
              <span>Staged changes</span>
              <span className="change-group__count">{staged.length}</span>
              <button
                type="button"
                className="change-group__bulk"
                onClick={() => void unstage(staged.map((f) => f.path))}
                disabled={busy}
              >
                Unstage all
              </button>
            </div>
            {staged.map(renderRow)}
          </div>
        )}
      </div>
    </div>
  );
}
