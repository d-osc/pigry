import { useEffect, useRef, useState } from 'react';
import { ArrowRight, GitCompare, RefreshCw } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import {
  compareBranches,
  readFileAtCommit,
  type BranchComparison,
} from '../../lib/tauriClient';
import type { RepositoryState } from '../../types/repository';
import { DiffWorkbench, type DiffWorkbenchContent } from '../pull-requests/DiffWorkbench';
import '../push-commits/PushCommitsScreen.css';
import './CompareBranchScreen.css';

const FILE_PAGE_SIZE = 40;

export function CompareBranchScreen() {
  const { repository, mode } = useRepository();
  if (!repository) return null;

  return (
    <div className="push-screen compare-branch">
      <h2 className="compare-branch__title"><GitCompare size={18} /> Compare branch</h2>
      {mode === 'tauri' ? (
        <BranchPicker key={repository.localPath} repository={repository} />
      ) : (
        <p role="status">Open the Pigry desktop app to compare branches.</p>
      )}
    </div>
  );
}

function BranchPicker({ repository }: { repository: RepositoryState }) {
  const local = repository.branches.map(({ name }) => ({ name, ref: `refs/heads/${name}` }));
  const remote = repository.remotes.flatMap(group => group.branches
    .filter(branch => branch !== 'HEAD')
    .map(branch => {
      const name = `${group.remote}/${branch}`;
      return { name, ref: `refs/remotes/${name}` };
    }));
  const branches = [...local, ...remote];
  const [selectedBase, setSelectedBase] = useState('');
  const [selectedCompare, setSelectedCompare] = useState('');
  const [revision, setRevision] = useState(0);
  const base = branches.find(branch => branch.ref === selectedBase)
    ?? local.find(branch => branch.name === repository.currentBranch)
    ?? branches[0];
  const compare = branches.find(branch => branch.ref === selectedCompare)
    ?? branches.find(branch => branch.ref !== base?.ref);

  if (!base || !compare) return <p role="status">At least two branches are required to compare.</p>;

  const sameBranch = base.ref === compare.ref;
  const options = (
    <>
      {local.length > 0 && (
        <optgroup label="Local branches">
          {local.map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
        </optgroup>
      )}
      {remote.length > 0 && (
        <optgroup label="Remote-tracking branches">
          {remote.map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
        </optgroup>
      )}
    </>
  );

  return (
    <>
      <div className="compare-branch__controls">
        <label>
          Base branch
          <select className="push__search" value={base.ref} onChange={event => setSelectedBase(event.target.value)}>
            {options}
          </select>
        </label>
        <ArrowRight size={15} aria-hidden="true" />
        <label>
          Compare branch
          <select className="push__search" value={compare.ref} onChange={event => setSelectedCompare(event.target.value)}>
            {options}
          </select>
        </label>
        <button
          type="button"
          className="settings__btn"
          disabled={sameBranch}
          onClick={() => setRevision(value => value + 1)}
        >
          <RefreshCw size={13} /> Refresh comparison
        </button>
      </div>
      {sameBranch ? (
        <p role="status">Choose two different branches to compare.</p>
      ) : (
        <ComparisonResults
          key={JSON.stringify([base.ref, compare.ref, repository.headOid, revision])}
          baseRef={base.ref}
          compareRef={compare.ref}
        />
      )}
    </>
  );
}

type LoadResult<T> = { data: T } | { error: string };
type FileVersion = Awaited<ReturnType<typeof readFileAtCommit>> | null;
type LoadedFile = { path: string; result: LoadResult<[FileVersion, FileVersion]> };

function ComparisonResults({ baseRef, compareRef }: { baseRef: string; compareRef: string }) {
  const [result, setResult] = useState<LoadResult<BranchComparison> | null>(null);

  useEffect(() => {
    let active = true;
    compareBranches(baseRef, compareRef).then(
      data => { if (active) setResult({ data }); },
      error => { if (active) setResult({ error: String(error) }); },
    );
    return () => { active = false; };
  }, [baseRef, compareRef]);

  if (!result) return <p role="status">Comparing branches…</p>;
  if ('error' in result) return <p role="alert">Could not compare branches. {result.error}</p>;
  return <ComparisonView comparison={result.data} compareRef={compareRef} />;
}

/** Changed files on the left, the selected file's diff on the right — the PR "View full diff" layout, inline. */
function ComparisonView({ comparison, compareRef }: { comparison: BranchComparison; compareRef: string }) {
  const { baseOid, compareOid, baseOnly, compareOnly, files } = comparison;
  const [visibleCount, setVisibleCount] = useState(FILE_PAGE_SIZE);
  const [activePath, setActivePath] = useState(files[0]?.path ?? '');
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const activeFile = files.find(file => file.path === activePath);

  // One request per file: revisiting a file (or StrictMode re-running the effect) reuses it.
  const reads = useRef(new Map<string, Promise<[FileVersion, FileVersion]>>());

  useEffect(() => {
    if (!activeFile) return;
    let live = true;
    const { path, status } = activeFile;
    let read = reads.current.get(path);
    if (!read) {
      read = Promise.all([
        status === 'A' ? null : readFileAtCommit(path, baseOid),
        status === 'D' ? null : readFileAtCommit(path, compareOid),
      ]);
      // A failed read is retried the next time the file is picked.
      read.catch(() => reads.current.delete(path));
      reads.current.set(path, read);
    }
    read.then(
      data => { if (live) setLoaded({ path, result: { data } }); },
      error => { if (live) setLoaded({ path, result: { error: String(error) } }); },
    );
    return () => { live = false; };
  }, [activeFile, baseOid, compareOid]);

  return (
    <section className="push__section compare-branch__results" aria-label="Branch comparison">
      <div className="compare-branch__commits">
        <span>Base <code>{baseOid.slice(0, 7)}</code> · {baseOnly} {baseOnly === 1 ? 'unique commit' : 'unique commits'}</span>
        <span>Compare <code>{compareOid.slice(0, 7)}</code> · {compareOnly} {compareOnly === 1 ? 'unique commit' : 'unique commits'}</span>
      </div>
      {files.length === 0 ? (
        <>
          <h3 className="push__section-title">Files changed (0)</h3>
          <p role="status">No file differences between the selected branches.</p>
        </>
      ) : (
        <div className="compare-branch__workbench">
          <DiffWorkbench
            files={files.slice(0, visibleCount)}
            activePath={activePath}
            onSelect={setActivePath}
            content={activeFile ? fileContent(loaded, activeFile.path) : null}
            headRef={compareRef}
            filesLabel={<h3 className="pr-diff-dialog__files-label">Files changed ({files.length})</h3>}
            filesFooter={files.length > visibleCount && (
              <button
                type="button"
                className="push__show-more"
                onClick={() => setVisibleCount(count => count + FILE_PAGE_SIZE)}
              >
                Show more files ({files.length - visibleCount} remaining)
              </button>
            )}
          />
        </div>
      )}
    </section>
  );
}

function fileContent(loaded: LoadedFile | null, path: string): DiffWorkbenchContent {
  if (!loaded || loaded.path !== path) return { kind: 'loading' };
  if ('error' in loaded.result) return { kind: 'error', message: `Could not compare file. ${loaded.result.error}` };
  const [before, after] = loaded.result.data;
  if (before?.tooLarge || after?.tooLarge) return { kind: 'notice', message: 'This file is too large to compare.' };
  if (before?.binary || after?.binary) return { kind: 'notice', message: 'Binary file comparison is unavailable.' };
  const original = before?.content ?? '';
  const modified = after?.content ?? '';
  if (original === modified) return { kind: 'notice', message: 'No text changes.' };
  return { kind: 'ready', original, modified, language: after?.language ?? before?.language ?? 'plaintext' };
}
