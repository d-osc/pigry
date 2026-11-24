import { useEffect, useState } from 'react';
import { getCommitHistory, getFileTree } from '../../lib/tauriClient';
import type { CodeRef } from '../../lib/codeSnap';
import type { CommitRow } from '../../types/repository';

type Tab = 'file' | 'compare' | 'commit';

interface Props {
  branches: string[];
  currentBranch: string;
  onAdd: (code: CodeRef) => void;
}

const toInt = (value: string): number | undefined => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value) : undefined);

/** Popover body of the Board's "Add code" button: lines of a file, a compare of two refs, or a commit. */
export function BoardCodePicker({ branches, currentBranch, onAdd }: Props) {
  const [tab, setTab] = useState<Tab>('file');
  const [paths, setPaths] = useState<string[]>([]);
  const [commits, setCommits] = useState<CommitRow[]>([]);
  const [path, setPath] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [base, setBase] = useState(branches.find((b) => b !== currentBranch) ?? '');
  const [head, setHead] = useState(currentBranch);
  const [cmpPath, setCmpPath] = useState('');
  const [oid, setOid] = useState('');
  const [commitPath, setCommitPath] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getFileTree().then((tree) => { if (!cancelled) setPaths(tree.entries.slice(0, 5000)); }).catch(() => undefined);
    void getCommitHistory(false).then((history) => { if (!cancelled) { setCommits(history.commits.slice(0, 40)); setOid((current) => current || history.commits[0]?.oid || ''); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const s = toInt(start), e = toInt(end);
  const add = () => {
    if (tab === 'file' && path.trim()) onAdd({ kind: 'file', path: path.trim().replace(/\\/g, '/'), ...(s ? { start: s, end: Math.max(e ?? s, s) } : {}) });
    else if (tab === 'compare' && base && head) onAdd({ kind: 'compare', base, head, ...(cmpPath.trim() ? { path: cmpPath.trim().replace(/\\/g, '/') } : {}) });
    else if (tab === 'commit' && oid.trim()) onAdd({ kind: 'commit', oid: oid.trim(), ...(commitPath.trim() ? { path: commitPath.trim().replace(/\\/g, '/') } : {}) });
  };
  const ready = tab === 'file' ? !!path.trim() : tab === 'compare' ? !!base && !!head : !!oid.trim();

  return (
    <div className="brd-code-picker" onKeyDown={(event) => { if (event.key === 'Enter' && ready && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); add(); } }}>
      <div className="brd-seg" role="tablist" aria-label="Kind of code">
        {(['file', 'compare', 'commit'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{id === 'file' ? 'File lines' : id === 'compare' ? 'Compare' : 'Commit'}</button>
        ))}
      </div>
      <datalist id="brd-code-paths">{paths.map((p) => <option key={p} value={p} />)}</datalist>

      {tab === 'file' && (
        <>
          <label className="brd-field"><span>File</span>
            <input className="brd-input" list="brd-code-paths" aria-label="Code file path" placeholder="src/App.tsx" value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          <div className="brd-grid">
            <label className="brd-num"><span>From line</span><input type="number" min={1} aria-label="First line" placeholder="1" value={start} onChange={(event) => setStart(event.target.value)} /></label>
            <label className="brd-num"><span>To line</span><input type="number" min={1} aria-label="Last line" placeholder="10" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
          </div>
          <p className="brd-tip">Leave the lines empty to show the start of the whole file.</p>
        </>
      )}

      {tab === 'compare' && (
        <>
          <label className="brd-field"><span>Base</span>
            <select className="brd-input" aria-label="Compare base" value={base} onChange={(event) => setBase(event.target.value)}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="brd-field"><span>Head</span>
            <select className="brd-input" aria-label="Compare head" value={head} onChange={(event) => setHead(event.target.value)}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="brd-field"><span>File (optional)</span>
            <input className="brd-input" list="brd-code-paths" aria-label="Compare file path" placeholder="all changed files" value={cmpPath} onChange={(event) => setCmpPath(event.target.value)} />
          </label>
        </>
      )}

      {tab === 'commit' && (
        <>
          <label className="brd-field"><span>Commit</span>
            <select className="brd-input" aria-label="Commit" value={commits.some((c) => c.oid === oid) ? oid : ''} onChange={(event) => setOid(event.target.value)}>
              <option value="">Other…</option>
              {commits.map((c) => <option key={c.oid} value={c.oid}>{c.shortOid} {c.summary.slice(0, 48)}</option>)}
            </select>
          </label>
          <label className="brd-field"><span>Or hash / ref</span>
            <input className="brd-input" aria-label="Commit hash" placeholder="1a2b3c4" value={oid} onChange={(event) => setOid(event.target.value)} />
          </label>
          <label className="brd-field"><span>File (optional)</span>
            <input className="brd-input" list="brd-code-paths" aria-label="Commit file path" placeholder="the commit's files" value={commitPath} onChange={(event) => setCommitPath(event.target.value)} />
          </label>
        </>
      )}

      <button type="button" className="brd-btn brd-btn--primary" disabled={!ready} onClick={add}>Add to board</button>
    </div>
  );
}
