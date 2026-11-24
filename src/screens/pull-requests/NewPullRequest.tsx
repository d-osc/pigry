/** "Open a pull request": GitHub's compare page — pick the base and compare branches, see what changed, write the title
 * and description (Write / Preview), choose draft or ready, add reviewers, assignees and labels, then create it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bold, ChevronDown, Code, FileText, GitCommitHorizontal, GitCompareArrows, GitPullRequest, GitPullRequestDraft, Italic, Link2, List, Quote, X,
} from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import { compareBranches, getBranchCommits, ghPrCreate, type BranchComparison } from '../../lib/tauriClient';
import { renderMarkdown } from '../../lib/markdown';
import { relativeTime } from '../../lib/ghData';
import { suggestPrTitle } from '../../lib/prTitle';
import type { CommitRow, RepositoryState } from '../../types/repository';
import './NewPullRequest.css';

interface Props {
  repository: RepositoryState;
  onCancel: () => void;
  /** Called with the new pull request's number (null when the URL could not be read) and its URL. */
  onCreated: (number: number | null, url: string) => void;
  notify: (message: string, type?: 'success' | 'error') => void;
}

type Tab = 'commits' | 'files';

/** A list of names (reviewers, assignees, labels) edited as removable chips. */
function TokenField({ label, hint, values, onChange, extra }: {
  label: string; hint: string; values: string[]; onChange: (next: string[]) => void; extra?: React.ReactNode;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const value = text.trim().replace(/^@(?!me$)/, '');
    setText('');
    if (value && !values.includes(value)) onChange([...values, value]);
  };
  return (
    <section className="npr-side" aria-label={label}>
      <h4>{label}</h4>
      {values.length === 0 ? <p className="npr-side__none">None yet</p> : (
        <ul className="npr-chips">
          {values.map((value) => (
            <li key={value}>
              <span>{value}</span>
              <button type="button" aria-label={`Remove ${value} from ${label.toLowerCase()}`} onClick={() => onChange(values.filter((item) => item !== value))}><X size={10} strokeWidth={2} /></button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="npr-side__input"
        aria-label={`Add to ${label.toLowerCase()}`}
        placeholder={hint}
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
        onBlur={add}
      />
      {extra}
    </section>
  );
}

export function NewPullRequest({ repository, onCancel, onCreated, notify }: Props) {
  const gate = useRequestGate();
  const local = repository.branches.map(({ name }) => name);
  const remoteNames = repository.remotes.flatMap((group) => group.branches.filter((branch) => branch !== 'HEAD').map((branch) => ({ remote: group.remote, branch })));
  const baseOptions = useMemo(() => [...new Set([...remoteNames.map(({ branch }) => branch), ...local])].sort(), [remoteNames, local]);

  const current = repository.currentBranch;
  const [base, setBase] = useState(() => (baseOptions.includes('main') ? 'main' : baseOptions.includes('master') ? 'master' : (baseOptions.find((name) => name !== current) ?? 'main')));
  const [compare, setCompare] = useState(() => (current && current !== 'HEAD' ? current : (local[0] ?? '')));

  const [comparison, setComparison] = useState<BranchComparison | null>(null);
  const [commits, setCommits] = useState<CommitRow[]>([]);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [tab, setTab] = useState<Tab>('commits');

  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const sameBranch = !!base && base === compare;

  // What changes between the two branches: the files and the commits only the compare branch has.
  useEffect(() => {
    if (!base || !compare || sameBranch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setComparison(null);
      setCommits([]);
      setCompareError('');
      return;
    }
    const isCurrent = gate.begin();
    const remote = remoteNames.find((entry) => entry.branch === base)?.remote;
    const baseRef = remote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
    const baseName = local.includes(base) ? base : remote ? `${remote}/${base}` : base;
    setComparing(true);
    setCompareError('');
    Promise.all([compareBranches(baseRef, `refs/heads/${compare}`), getBranchCommits(compare), getBranchCommits(baseName)])
      .then(([result, compareHistory, baseHistory]) => {
        if (!isCurrent()) return;
        const known = new Set(baseHistory.commits.map((row) => row.oid));
        setComparison(result);
        setCommits(compareHistory.commits.filter((row) => !known.has(row.oid)));
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setComparison(null);
        setCommits([]);
        setCompareError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (isCurrent()) setComparing(false); });
    // remoteNames and local are rebuilt each render from the same repository state; base and compare drive the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, compare, sameBranch, gate]);

  // The title starts from the branch (or from the commit when there is only one) until the user types their own.
  useEffect(() => {
    if (titleTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(suggestPrTitle(compare, commits.map((row) => row.summary)));
  }, [compare, commits, titleTouched]);

  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [menuOpen]);

  const additions = comparison?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = comparison?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const nothingToCompare = !!comparison && comparison.compareOnly === 0;
  const canCreate = !creating && !!title.trim() && !sameBranch && !comparing && !nothingToCompare && !compareError;

  /** Wraps the selected text in the description (bold, italic, code, link) or prefixes its lines (quote, list). */
  const format = (before: string, after: string, placeholder: string, linePrefix = false) => {
    const field = bodyRef.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = body.slice(start, end) || placeholder;
    const next = linePrefix
      ? selected.split('\n').map((line) => `${before}${line}`).join('\n')
      : `${before}${selected}${after}`;
    setBody(body.slice(0, start) + next + body.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start, start + next.length); });
  };

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const url = await ghPrCreate(title.trim(), body.trim(), compare, base, { draft, reviewers, assignees, labels });
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      notify(url ? `Pull request created: ${url}` : 'Pull request created', 'success');
      onCreated(Number.isFinite(number) && number > 0 ? number : null, url);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setCreating(false);
    }
  };

  const tools = [
    { label: 'Bold', icon: <Bold size={13} strokeWidth={1.75} />, before: '**', after: '**', placeholder: 'bold text', lines: false },
    { label: 'Italic', icon: <Italic size={13} strokeWidth={1.75} />, before: '_', after: '_', placeholder: 'italic text', lines: false },
    { label: 'Quote', icon: <Quote size={13} strokeWidth={1.75} />, before: '> ', after: '', placeholder: 'quote', lines: true },
    { label: 'Code', icon: <Code size={13} strokeWidth={1.75} />, before: '`', after: '`', placeholder: 'code', lines: false },
    { label: 'Link', icon: <Link2 size={13} strokeWidth={1.75} />, before: '[', after: '](https://)', placeholder: 'link text', lines: false },
    { label: 'Bulleted list', icon: <List size={13} strokeWidth={1.75} />, before: '- ', after: '', placeholder: 'item', lines: true },
  ];

  return (
    <div className="npr">
      <button type="button" className="npr-back" onClick={onCancel}><ArrowLeft size={13} strokeWidth={1.5} /> Pull requests</button>
      <h2 className="npr-title">Open a pull request</h2>
      <p className="npr-lead">Create a new pull request by comparing changes across two branches. If you need to, you can also compare across forks on GitHub.</p>

      <div className="npr-compare">
        <GitCompareArrows size={16} strokeWidth={1.5} className="npr-compare__icon" />
        <label>
          base: <select aria-label="Base branch" value={base} onChange={(event) => setBase(event.target.value)}>
            {baseOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <span className="npr-compare__arrow" aria-hidden="true">←</span>
        <label>
          compare: <select aria-label="Compare branch" value={compare} onChange={(event) => setCompare(event.target.value)}>
            {local.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <span className="npr-compare__status" role="status">
          {sameBranch ? 'Choose two different branches to compare.'
            : comparing ? 'Comparing…'
              : compareError ? <span className="npr-compare__bad">{compareError}</span>
                : nothingToCompare ? <span className="npr-compare__bad">There isn’t anything to compare: {compare} has no commits that {base} lacks.</span>
                  : comparison ? <><span className="npr-compare__ok">✓ Able to compare.</span> {comparison.compareOnly} commit{comparison.compareOnly === 1 ? '' : 's'}, {comparison.files.length} file{comparison.files.length === 1 ? '' : 's'} changed <span className="npr-add">+{additions}</span> <span className="npr-del">−{deletions}</span></>
                    : ''}
        </span>
      </div>

      <div className="npr-layout">
        <div className="npr-form">
          <input
            className="npr-input"
            placeholder="Title"
            aria-label="Pull request title"
            value={title}
            spellCheck={false}
            onChange={(event) => { setTitle(event.target.value); setTitleTouched(true); }}
          />
          <div className="npr-editor">
            <div className="npr-editor__bar">
              <div className="npr-tabs" role="tablist" aria-label="Description editor">
                <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>Write</button>
                <button type="button" role="tab" aria-selected={preview} className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>Preview</button>
              </div>
              {!preview && (
                <div className="npr-tools" role="toolbar" aria-label="Formatting">
                  {tools.map((tool) => <button key={tool.label} type="button" title={tool.label} aria-label={tool.label} onClick={() => format(tool.before, tool.after, tool.placeholder, tool.lines)}>{tool.icon}</button>)}
                </div>
              )}
            </div>
            {preview ? (
              <div className="npr-preview wiki-md">{body.trim() ? renderMarkdown(body) : <p className="npr-muted">Nothing to preview</p>}</div>
            ) : (
              <textarea ref={bodyRef} className="npr-body" placeholder="Describe your changes" aria-label="Pull request description" value={body} rows={9} onChange={(event) => setBody(event.target.value)} />
            )}
            <p className="npr-editor__hint"><FileText size={11} strokeWidth={1.5} /> Markdown is supported</p>
          </div>

          <div className="npr-actions">
            <button type="button" className="outline-button" onClick={onCancel}>Cancel</button>
            <div className="npr-split" ref={menuRef}>
              <button type="button" className="npr-split__main" disabled={!canCreate} onClick={() => void create()}>
                {draft ? <GitPullRequestDraft size={13} strokeWidth={1.5} /> : <GitPullRequest size={13} strokeWidth={1.5} />}
                {creating ? 'Creating…' : draft ? 'Create draft pull request' : 'Create pull request'}
              </button>
              <button type="button" className="npr-split__caret" aria-label="Choose how to create the pull request" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
                <ChevronDown size={13} strokeWidth={1.75} />
              </button>
              {menuOpen && (
                <div className="npr-split__menu" role="menu">
                  <button type="button" role="menuitemradio" aria-checked={!draft} onClick={() => { setDraft(false); setMenuOpen(false); }}>
                    <strong>{!draft ? '✓ ' : ''}Create pull request</strong>
                    <span>Open a pull request that is ready for review.</span>
                  </button>
                  <button type="button" role="menuitemradio" aria-checked={draft} onClick={() => { setDraft(true); setMenuOpen(false); }}>
                    <strong>{draft ? '✓ ' : ''}Create draft pull request</strong>
                    <span>Cannot be merged until it is marked ready for review.</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="npr-sidebar" aria-label="Pull request details">
          <TokenField label="Reviewers" hint="GitHub username or org/team" values={reviewers} onChange={setReviewers} />
          <TokenField
            label="Assignees" hint="GitHub username" values={assignees} onChange={setAssignees}
            extra={!assignees.includes('@me') && <button type="button" className="npr-side__link" onClick={() => setAssignees([...assignees, '@me'])}>Assign yourself</button>}
          />
          <TokenField label="Labels" hint="Label name" values={labels} onChange={setLabels} />
          <p className="npr-side__note">Names must exist on GitHub; if one does not, GitHub refuses the pull request and says which.</p>
        </aside>
      </div>

      <div className="npr-changes">
        <div className="npr-tabs npr-tabs--page" role="tablist" aria-label="Changes">
          <button type="button" role="tab" aria-selected={tab === 'commits'} className={tab === 'commits' ? 'is-active' : ''} onClick={() => setTab('commits')}>
            <GitCommitHorizontal size={13} strokeWidth={1.5} /> Commits <span className="npr-count">{commits.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'is-active' : ''} onClick={() => setTab('files')}>
            <FileText size={13} strokeWidth={1.5} /> Files changed <span className="npr-count">{comparison?.files.length ?? 0}</span>
          </button>
        </div>
        {tab === 'commits' ? (
          commits.length === 0 ? <p className="npr-muted npr-none">{comparing ? 'Loading…' : 'No commits to show.'}</p> : (
            <ul className="npr-list" aria-label="Commits in this pull request">
              {commits.map((row) => (
                <li key={row.oid}>
                  <span className="npr-list__main">{row.summary}</span>
                  <span className="npr-list__meta">{row.authorName} · {relativeTime(new Date(row.timeSeconds * 1000).toISOString())}</span>
                  <code>{row.shortOid}</code>
                </li>
              ))}
            </ul>
          )
        ) : (
          !comparison || comparison.files.length === 0 ? <p className="npr-muted npr-none">{comparing ? 'Loading…' : 'No files changed.'}</p> : (
            <ul className="npr-list" aria-label="Files changed in this pull request">
              {comparison.files.map((file) => (
                <li key={`${file.status}:${file.path}`}>
                  <span className={`npr-status npr-status--${file.status}`}>{file.status}</span>
                  <span className="npr-list__main">{file.path}</span>
                  <span className="npr-list__meta"><span className="npr-add">+{file.additions}</span> <span className="npr-del">−{file.deletions}</span></span>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
