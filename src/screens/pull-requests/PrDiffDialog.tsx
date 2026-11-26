import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { DiffWorkbench } from './DiffWorkbench';
import './PrDiffDialog.css';

interface PrDiffFile {
  path: string;
  original: string;
  modified: string;
  language: string;
}

function fileStat(file: PrDiffFile): { added: number; removed: number } {
  // Empty string = "no lines" (new/deleted file); a trailing newline does not
  // create an extra line (GitHub-style counting).
  const splitLines = (content: string) => {
    if (!content) return [];
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const origLines = splitLines(file.original);
  const modLines = splitLines(file.modified);
  const counts = new Map<string, number>();
  for (const line of origLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of modLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      common += 1;
      counts.set(line, remaining - 1);
    }
  }
  return {
    added: modLines.length - common,
    removed: origLines.length - common,
  };
}

/**
 * Fullscreen compare dialog for a pull request. Starts on the current code
 * diff; History / Compare / Blame toggle panels on top of it, exactly like the
 * Explorer editor's toggles — History = the PR's commit timeline for this file.
 */
export function PrDiffDialog({
  title,
  files,
  initialPath,
  headRef,
  onClose,
}: {
  title: string;
  files: PrDiffFile[];
  initialPath?: string;
  /** Branch/ref the diff is taken from — history & blame walk this. */
  headRef?: string;
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState(initialPath ?? files[0]?.path ?? '');
  const active = files.find((file) => file.path === selectedPath) ?? files[0];
  const listed = useMemo(
    () => files.map((file) => {
      const stat = fileStat(file);
      return { path: file.path, additions: stat.added, deletions: stat.removed };
    }),
    [files],
  );

  // Escape closes; clicking the dark backdrop also closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Clicking anywhere outside the dialog closes it (capture phase).
  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (document.querySelector('.pr-diff-dialog')?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => document.removeEventListener('mousedown', onDocMouseDown, true);
  }, [onClose]);

  return (
    <div className="pr-diff-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="pr-diff-dialog__inner" onClick={(event) => event.stopPropagation()}>
        <header className="pr-diff-dialog__head">
          <strong>{title}</strong>
          <div className="pr-diff-dialog__actions">
            <span className="pr-diff-dialog__hint">Esc to close</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Close compare view"
              onClick={onClose}
            >
              <X size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        <DiffWorkbench
          files={listed}
          activePath={active?.path ?? ''}
          onSelect={setSelectedPath}
          content={active ? { kind: 'ready', ...active } : null}
          headRef={headRef}
        />
      </div>
    </div>
  );
}
