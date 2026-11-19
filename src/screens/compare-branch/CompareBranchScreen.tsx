import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, GitCompare, RefreshCw } from 'lucide-react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { useRepository } from '../../hooks/useRepository';
import { useRequestGate } from '../../hooks/useRequestGate';
import {
  compareBranches,
  readFileAtCommit,
  type BranchComparison,
  type MergePreviewCommitFile,
} from '../../lib/tauriClient';
import type { RepositoryState } from '../../types/repository';
import '../push-commits/PushCommitsScreen.css';
import './CompareBranchScreen.css';

const FILE_PAGE_SIZE = 40;

export function CompareBranchScreen() {
  const { repository, mode } = useRepository();
  if (!repository) return null;

  return (
    <div className="push-screen">
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

function ComparisonResults({ baseRef, compareRef }: { baseRef: string; compareRef: string }) {
  const [result, setResult] = useState<LoadResult<BranchComparison> | null>(null);
  const [visibleCount, setVisibleCount] = useState(FILE_PAGE_SIZE);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<LoadResult<[FileVersion, FileVersion]> | null>(null);
  const [split, setSplit] = useState(true);
  const fileGate = useRequestGate();

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

  const { baseOid, compareOid, baseOnly, compareOnly, files } = result.data;
  const toggleFile = ({ path, status }: MergePreviewCommitFile) => {
    const isCurrent = fileGate.begin();
    setVersions(null);
    if (openFile === path) {
      setOpenFile(null);
      return;
    }
    setOpenFile(path);
    Promise.all([
      status === 'A' ? null : readFileAtCommit(path, baseOid),
      status === 'D' ? null : readFileAtCommit(path, compareOid),
    ]).then(
      data => { if (isCurrent()) setVersions({ data }); },
      error => { if (isCurrent()) setVersions({ error: String(error) }); },
    );
  };

  return (
    <section className="push__section" aria-label="Branch comparison">
      <div className="compare-branch__commits">
        <span>Base <code>{baseOid.slice(0, 7)}</code> · {baseOnly} {baseOnly === 1 ? 'unique commit' : 'unique commits'}</span>
        <span>Compare <code>{compareOid.slice(0, 7)}</code> · {compareOnly} {compareOnly === 1 ? 'unique commit' : 'unique commits'}</span>
      </div>
      <div className="push__list-head">
        <h3 className="push__section-title">Files changed ({files.length})</h3>
        {files.length > 0 && (
          <div className="push__view-mode" role="group" aria-label="Diff layout">
            <button type="button" className={split ? 'is-active' : ''} aria-pressed={split} onClick={() => setSplit(true)}>Split</button>
            <button type="button" className={!split ? 'is-active' : ''} aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button>
          </div>
        )}
      </div>
      {files.length === 0 ? (
        <p role="status">No file differences between the selected branches.</p>
      ) : (
        <ul className="push__files compare-branch__files">
          {files.slice(0, visibleCount).map(file => {
            const expanded = openFile === file.path;
            const Chevron = expanded ? ChevronDown : ChevronRight;
            return (
              <li key={file.path} className="push__file">
                <button
                  type="button"
                  className="push__file-row"
                  title={file.path}
                  aria-expanded={expanded}
                  onClick={() => toggleFile(file)}
                >
                  <Chevron size={14} aria-hidden="true" />
                  <span className={`push__file-status push__file-status--${file.status}`}>{file.status}</span>
                  <span className="push__file-path">{file.path}</span>
                  <span className="push__file-stats">
                    <span className="stats-add">+{file.additions}</span>
                    <span className="stats-del">−{file.deletions}</span>
                  </span>
                </button>
                {expanded && <FileComparison key={file.path} result={versions} split={split} />}
              </li>
            );
          })}
        </ul>
      )}
      {files.length > visibleCount && (
        <button
          type="button"
          className="push__show-more"
          onClick={() => setVisibleCount(count => count + FILE_PAGE_SIZE)}
        >
          Show more files ({files.length - visibleCount} remaining)
        </button>
      )}
    </section>
  );
}

function FileComparison({ result, split }: {
  result: LoadResult<[FileVersion, FileVersion]> | null;
  split: boolean;
}) {
  if (!result) return <p className="push__empty" role="status">Loading file comparison…</p>;
  if ('error' in result) return <p className="push__empty" role="alert">Could not compare file. {result.error}</p>;
  const [before, after] = result.data;
  if (before?.tooLarge || after?.tooLarge) return <p className="push__empty">This file is too large to compare.</p>;
  if (before?.binary || after?.binary) return <p className="push__empty">Binary file comparison is unavailable.</p>;
  if ((before?.content ?? '') === (after?.content ?? '')) {
    return <p className="push__empty">No text changes.</p>;
  }

  return (
    <div className="compare-branch__diff">
      <DiffEditor
        height={320}
        language={after?.language ?? before?.language ?? 'plaintext'}
        original={before?.content ?? ''}
        modified={after?.content ?? ''}
        options={{
          readOnly: true,
          renderSideBySide: split,
          useInlineViewWhenSpaceIsLimited: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
