/** Fullscreen compare for files read from local git: the changed files on the left, the chosen file's diff on the
 * right (the same DiffWorkbench as "View full diff"). Each file is loaded when it is first picked. Used by "Open a
 * pull request" for a commit's files and for the files changed between the two branches. */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { FileDiffContent, WorktreeFileContent } from '../../types/repository';
import { DiffWorkbench, type DiffWorkbenchContent, type DiffWorkbenchFile } from './DiffWorkbench';
import './PrDiffDialog.css';

/** A commit's file diff (original / modified) as what the compare pane shows. */
export function diffContent(diff: FileDiffContent): DiffWorkbenchContent {
  if (diff.tooLarge) return { kind: 'notice', message: 'This file is too large to compare.' };
  if (diff.binary) return { kind: 'notice', message: 'Binary file comparison is unavailable.' };
  const original = diff.original ?? '';
  const modified = diff.modified ?? '';
  if (original === modified) return { kind: 'notice', message: 'No text changes.' };
  return { kind: 'ready', original, modified, language: diff.language || 'plaintext' };
}

/** Two versions of a file (null: it does not exist on that side) as what the compare pane shows. */
export function versionsContent(before: WorktreeFileContent | null, after: WorktreeFileContent | null): DiffWorkbenchContent {
  if (before?.tooLarge || after?.tooLarge) return { kind: 'notice', message: 'This file is too large to compare.' };
  if (before?.binary || after?.binary) return { kind: 'notice', message: 'Binary file comparison is unavailable.' };
  const original = before?.content ?? '';
  const modified = after?.content ?? '';
  if (original === modified) return { kind: 'notice', message: 'No text changes.' };
  return { kind: 'ready', original, modified, language: after?.language ?? before?.language ?? 'plaintext' };
}

export function RefDiffDialog({
  title, files, initialPath, headRef, load, onClose,
}: {
  title: string;
  files: DiffWorkbenchFile[];
  initialPath: string;
  /** Branch/ref the diff is taken from — history & blame walk this. */
  headRef?: string;
  load: (path: string) => Promise<DiffWorkbenchContent>;
  onClose: () => void;
}) {
  const [activePath, setActivePath] = useState(initialPath);
  const [loaded, setLoaded] = useState<{ path: string; content: DiffWorkbenchContent } | null>(null);
  // One read per file: going back to a file reuses it; a failed read is retried the next time it is picked.
  const reads = useRef(new Map<string, Promise<DiffWorkbenchContent>>());

  useEffect(() => {
    if (!activePath) return;
    let live = true;
    let read = reads.current.get(activePath);
    if (!read) {
      read = load(activePath);
      read.catch(() => reads.current.delete(activePath));
      reads.current.set(activePath, read);
    }
    read.then(
      (content) => { if (live) setLoaded({ path: activePath, content }); },
      (error) => { if (live) setLoaded({ path: activePath, content: { kind: 'error', message: `Could not compare file. ${error instanceof Error ? error.message : String(error)}` } }); },
    );
    return () => { live = false; };
  }, [activePath, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pr-diff-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="pr-diff-dialog__inner" onClick={(event) => event.stopPropagation()}>
        <header className="pr-diff-dialog__head">
          <strong>{title}</strong>
          <div className="pr-diff-dialog__actions">
            <span className="pr-diff-dialog__hint">Esc to close</span>
            <button type="button" className="icon-button" aria-label="Close compare view" onClick={onClose}>
              <X size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>
        <DiffWorkbench
          files={files}
          activePath={activePath}
          onSelect={setActivePath}
          content={loaded?.path === activePath ? loaded.content : { kind: 'loading' }}
          headRef={headRef}
        />
      </div>
    </div>
  );
}
