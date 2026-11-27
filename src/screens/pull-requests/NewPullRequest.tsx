/** "Open a pull request": GitHub's compare page — pick the base and compare branches, see what changed (open a commit
 * or a file to compare it), resolve conflicts with the base, write the title and description (Write / Preview, or have
 * the AI write it from the branch), choose draft or ready, add reviewers, assignees and labels, then create it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Bold, ChevronDown, ChevronRight, Code, FileDiff, GitMerge, FileText, GitCommitHorizontal, GitCompareArrows, GitPullRequest, GitPullRequestDraft, Italic, Link2, List, Loader2, Quote, Sparkles, X,
} from 'lucide-react';
import { useRequestGate } from '../../hooks/useRequestGate';
import {
  compareBranches, getBranchCommits, getCommitFileDiff, ghPrCreate, prMergeConflicts, prMergeResolved, readFileAtCommit,
  type BranchComparison, type ConflictFileResolution, type PrMergeConflicts,
} from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import { renderMarkdown } from '../../lib/markdown';
import { relativeTime } from '../../lib/ghData';
import { suggestPrTitle } from '../../lib/prTitle';
import { insertDescription, type InsertMode } from '../../lib/prDescription';
import { generatePrDescription, type GeneratedPrDescription } from '../../lib/prDescriptionAi';
import type { CommitDetail, CommitRow, RepositoryState } from '../../types/repository';
import { ConflictResolver } from '../merge-conflicts/ConflictResolver';
import type { DiffWorkbenchContent, DiffWorkbenchFile } from './DiffWorkbench';
import { NprCommitDetails } from './NprCommitDetails';
import { RefDiffDialog, diffContent, versionsContent } from './RefDiffDialog';
import './NewPullRequest.css';

interface Props {
  repository: RepositoryState;
  onCancel: () => void;
  /** Called with the new pull request's number (null when the URL could not be read) and its URL. */
  onCreated: (number: number | null, url: string) => void;
  notify: (message: string, type?: 'success' | 'error') => void;
}

type Tab = 'commits' | 'files';

/** What the compare dialog shows: a commit's files, or the files changed between the two branches. */
interface DiffView {
  title: string;
  files: DiffWorkbenchFile[];
  initialPath: string;
  headRef: string;
  load: (path: string) => Promise<DiffWorkbenchContent>;
}

/** Full refs for the two branches: the base may only exist on a remote, the compare branch is always local. */
function branchRefs(base: string, compare: string, remoteNames: Array<{ remote: string; branch: string }>) {
  const remote = remoteNames.find((entry) => entry.branch === base)?.remote;
  const baseRef = remote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
  return { baseRef, compareRef: `refs/heads/${compare}` };
}

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
  const { refresh, busy } = useRepository();
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
  // Bumped after the conflicts are resolved, so the branches are compared again.
  const [revision, setRevision] = useState(0);
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  // The base merged into the compare branch in memory: the conflicted files, if any, and whether the editor is open.
  const [conflicts, setConflicts] = useState<PrMergeConflicts | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [resolving, setResolving] = useState(false);

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
  // AI description: the run in flight (a newer number cancels it), its error, a result waiting for the user to choose
  // where it goes (when the description already has text) and a better title to offer.
  const generation = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [pending, setPending] = useState<GeneratedPrDescription | null>(null);
  const [suggestedTitle, setSuggestedTitle] = useState('');

  const sameBranch = !!base && base === compare;

  // What changes between the two branches: the files and the commits only the compare branch has.
  useEffect(() => {
    if (!base || !compare || sameBranch) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setComparison(null);
      setCommits([]);
      setCompareError('');
      setConflicts(null);
      setConflictsOpen(false);
      return;
    }
    const isCurrent = gate.begin();
    const remote = remoteNames.find((entry) => entry.branch === base)?.remote;
    const baseRef = remote ? `refs/remotes/${remote}/${base}` : `refs/heads/${base}`;
    const baseName = local.includes(base) ? base : remote ? `${remote}/${base}` : base;
    setComparing(true);
    setCompareError('');
    setOpenCommit(null);
    Promise.all([
      compareBranches(baseRef, `refs/heads/${compare}`), getBranchCommits(compare), getBranchCommits(baseName),
      // A failed conflict check only means no conflict banner; the comparison still shows.
      prMergeConflicts(baseRef, compare).catch(() => null),
    ])
      .then(([result, compareHistory, baseHistory, merge]) => {
        if (!isCurrent()) return;
        const known = new Set(baseHistory.commits.map((row) => row.oid));
        setComparison(result);
        setCommits(compareHistory.commits.filter((row) => !known.has(row.oid)));
        const conflicted = merge && Array.isArray(merge.files) && merge.files.length > 0 ? merge : null;
        setConflicts(conflicted);
        // Conflicts open the editor straight away, the way the user is asked to fix them before the merge.
        setConflictsOpen(!!conflicted && result.compareOnly > 0);
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setComparison(null);
        setCommits([]);
        setConflicts(null);
        setConflictsOpen(false);
        setCompareError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (isCurrent()) setComparing(false); });
    // remoteNames and local are rebuilt each render from the same repository state; base and compare drive the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, compare, sameBranch, gate, revision]);

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
  const canGenerate = !generating && !!comparison && !sameBranch && !comparing && !nothingToCompare && !compareError;

  /** Drops a run in flight and anything it produced (the branches changed, or the user cancelled). */
  const stopGenerating = () => {
    generation.current++;
    setGenerating(false);
    setPending(null);
    setSuggestedTitle('');
  };

  /** A different base or compare branch makes a run in flight, and what it wrote, out of date. */
  const pickBranch = (which: 'base' | 'compare', value: string) => {
    stopGenerating();
    setGenerateError('');
    if (which === 'base') setBase(value);
    else setCompare(value);
  };

  const generate = async () => {
    if (!canGenerate) return;
    const run = ++generation.current;
    setGenerating(true);
    setGenerateError('');
    setPending(null);
    setSuggestedTitle('');
    try {
      const result = await generatePrDescription({ ...branchRefs(base, compare, remoteNames), base, compare, title });
      if (generation.current !== run) return;
      // The description is read-only while generating, so `body` is still what it was when the run started.
      if (body.trim()) setPending(result);
      else setBody(result.body);
      if (result.title && result.title !== title.trim()) setSuggestedTitle(result.title);
      notify(`Description written with ${result.used}${result.templatePath ? ` from ${result.templatePath}` : ''}`, 'success');
    } catch (error) {
      if (generation.current === run) setGenerateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === run) setGenerating(false);
    }
  };

  /** Puts the waiting result into the description: instead of it, at the cursor, or below it. */
  const place = (mode: InsertMode) => {
    if (!pending) return;
    const cursor = bodyRef.current?.selectionStart ?? body.length;
    setBody(insertDescription(body, pending.body, mode, cursor));
    setPending(null);
    setPreview(false);
  };

  /** The compare view of one commit, starting on `path`; the other files of the commit are listed beside it. */
  const openCommitFile = (detail: CommitDetail, path: string) => {
    setDiffView({
      title: `${detail.shortOid} ${detail.summary}`,
      files: detail.files.map(({ path: file, status, additions, deletions }) => ({ path: file, status, additions, deletions })),
      initialPath: path,
      headRef: compare,
      load: (file) => {
        const entry = detail.files.find((item) => item.path === file);
        return getCommitFileDiff(detail.oid, file, entry?.previousPath).then(diffContent);
      },
    });
  };

  /** The compare view of the files changed between the two branches, starting on `path`. */
  const openBranchFile = (path: string) => {
    if (!comparison) return;
    const { baseOid, compareOid, files } = comparison;
    setDiffView({
      title: `${base} ← ${compare}`,
      files,
      initialPath: path,
      headRef: compare,
      load: (file) => {
        const status = files.find((item) => item.path === file)?.status;
        return Promise.all([
          status === 'A' ? null : readFileAtCommit(file, baseOid),
          status === 'D' ? null : readFileAtCommit(file, compareOid),
        ]).then(([before, after]) => versionsContent(before, after));
      },
    });
  };

  /** Commits the base merged into the compare branch with the user's choices, then compares the branches again. */
  const resolveConflicts = async (resolutions: ConflictFileResolution[]) => {
    if (!conflicts || resolving) return;
    setResolving(true);
    try {
      const { baseRef } = branchRefs(base, compare, remoteNames);
      await prMergeResolved(baseRef, compare, conflicts.baseOid, conflicts.compareOid, resolutions);
      notify(`Merged ${base} into ${compare} with ${resolutions.length} resolved file${resolutions.length === 1 ? '' : 's'}. Push ${compare} to update the pull request.`, 'success');
      setConflicts(null);
      setConflictsOpen(false);
      setRevision((value) => value + 1);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setResolving(false);
    }
  };

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
          base: <select aria-label="Base branch" value={base} onChange={(event) => pickBranch('base', event.target.value)}>
            {baseOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <span className="npr-compare__arrow" aria-hidden="true">←</span>
        <label>
          compare: <select aria-label="Compare branch" value={compare} onChange={(event) => pickBranch('compare', event.target.value)}>
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

      {conflicts && !comparing && !conflictsOpen && (
        <div className="npr-conflict" role="group" aria-label="Merge conflicts">
          <AlertTriangle size={14} strokeWidth={1.75} />
          <span><strong>Can’t automatically merge.</strong> {conflicts.files.length} file{conflicts.files.length === 1 ? '' : 's'} conflict{conflicts.files.length === 1 ? 's' : ''} with {base}. You can still create the pull request, or resolve the conflicts first.</span>
          <button type="button" onClick={() => setConflictsOpen(true)}>Resolve conflicts</button>
        </div>
      )}

      {conflicts && conflictsOpen && !comparing ? (
        <div className="npr-resolver">
          <ConflictResolver
            key={`${conflicts.baseOid}:${conflicts.compareOid}`}
            files={conflicts.files}
            label="Pull request conflicts"
            icon={<GitMerge size={18} />}
            title={`${compare} has conflicts with ${base}`}
            description={`${compare} and ${base} changed the same lines. Choose what to keep in each file, then commit the merge: ${base} is merged into ${compare}, like GitHub’s “Resolve conflicts”. Nothing is written until you commit; Abort closes the editor and leaves both branches as they are.`}
            sides={{ current: compare, currentRole: 'your branch', incoming: base, incomingRole: 'base branch' }}
            resultTarget={`committed on ${compare}`}
            completeLabel="Commit merge"
            completeTitle={`Merge ${base} into ${compare} with the resolved files`}
            abortName="merge"
            abortWarning={`Stop resolving? ${compare} and ${base} stay as they are and your choices are lost.`}
            busy={busy || resolving}
            onComplete={(resolutions) => void resolveConflicts(resolutions)}
            onAbort={() => setConflictsOpen(false)}
          />
        </div>
      ) : (<>
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
          {suggestedTitle && (
            <div className="npr-suggest" role="group" aria-label="Suggested title">
              <Sparkles size={12} strokeWidth={1.75} />
              <span className="npr-suggest__text">Suggested title: <strong>{suggestedTitle}</strong></span>
              <button type="button" onClick={() => { setTitle(suggestedTitle); setTitleTouched(true); setSuggestedTitle(''); }}>Use this title</button>
              <button type="button" aria-label="Dismiss the suggested title" onClick={() => setSuggestedTitle('')}><X size={11} strokeWidth={2} /></button>
            </div>
          )}
          <div className="npr-editor">
            <div className="npr-editor__bar">
              <div className="npr-tabs" role="tablist" aria-label="Description editor">
                <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>Write</button>
                <button type="button" role="tab" aria-selected={preview} className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>Preview</button>
              </div>
              <div className="npr-editor__end">
                {generating ? (
                  <button type="button" className="npr-generate" aria-label="Cancel generating the description" onClick={stopGenerating}>
                    <Loader2 size={13} strokeWidth={1.75} className="npr-spin" /> Writing… <span className="npr-generate__stop">Cancel</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="npr-generate"
                    disabled={!canGenerate}
                    title={canGenerate ? 'Write the description from this branch’s commits and changes with AI' : 'Choose two branches with changes to compare first'}
                    onClick={() => void generate()}
                  >
                    <Sparkles size={13} strokeWidth={1.75} /> Generate description
                  </button>
                )}
                {!preview && (
                  <div className="npr-tools" role="toolbar" aria-label="Formatting">
                    {tools.map((tool) => <button key={tool.label} type="button" title={tool.label} aria-label={tool.label} disabled={generating} onClick={() => format(tool.before, tool.after, tool.placeholder, tool.lines)}>{tool.icon}</button>)}
                  </div>
                )}
              </div>
            </div>
            {generating && (
              <p className="npr-gen npr-gen--busy" role="status">
                <Loader2 size={12} strokeWidth={1.75} className="npr-spin" />
                Writing a description from {commits.length} commit{commits.length === 1 ? '' : 's'} and {comparison?.files.length ?? 0} changed file{comparison?.files.length === 1 ? '' : 's'}…
              </p>
            )}
            {generateError && (
              <div className="npr-gen npr-gen--error" role="alert">
                <span>Couldn’t generate the description: {generateError}</span>
                <button type="button" aria-label="Dismiss the error" onClick={() => setGenerateError('')}><X size={11} strokeWidth={2} /></button>
              </div>
            )}
            {pending && (
              <div className="npr-pending" role="alertdialog" aria-label="Use the generated description">
                <p className="npr-pending__lead">The description already has text. Where should the generated one go?</p>
                <div className="npr-pending__preview wiki-md" aria-label="Generated description">{renderMarkdown(pending.body)}</div>
                <div className="npr-pending__actions">
                  <button type="button" className="npr-pending__primary" onClick={() => place('replace')}>Replace</button>
                  <button type="button" onClick={() => place('cursor')}>Insert at cursor</button>
                  <button type="button" onClick={() => place('append')}>Add below</button>
                  <button type="button" onClick={() => setPending(null)}>Discard</button>
                </div>
              </div>
            )}
            {preview ? (
              <div className="npr-preview wiki-md">{body.trim() ? renderMarkdown(body) : <p className="npr-muted">Nothing to preview</p>}</div>
            ) : (
              <textarea ref={bodyRef} className="npr-body" placeholder="Describe your changes" aria-label="Pull request description" aria-busy={generating} readOnly={generating} value={body} rows={9} onChange={(event) => setBody(event.target.value)} />
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
              {commits.map((row) => {
                const open = openCommit === row.oid;
                return (
                  <li key={row.oid}>
                    <button type="button" className="npr-list__row" aria-expanded={open} title={row.summary} onClick={() => setOpenCommit(open ? null : row.oid)}>
                      {open ? <ChevronDown size={13} strokeWidth={1.75} className="npr-open-icon" /> : <ChevronRight size={13} strokeWidth={1.75} className="npr-open-icon" />}
                      <span className="npr-list__main">{row.summary}</span>
                      <span className="npr-list__meta">{row.authorName} · {relativeTime(new Date(row.timeSeconds * 1000).toISOString())}</span>
                      <code>{row.shortOid}</code>
                    </button>
                    {open && <NprCommitDetails oid={row.oid} onOpenFile={openCommitFile} />}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          !comparison || comparison.files.length === 0 ? <p className="npr-muted npr-none">{comparing ? 'Loading…' : 'No files changed.'}</p> : (
            <ul className="npr-list" aria-label="Files changed in this pull request">
              {comparison.files.map((file) => (
                <li key={`${file.status}:${file.path}`}>
                  <button type="button" className="npr-list__row" title={`Compare ${file.path}`} onClick={() => openBranchFile(file.path)}>
                    <span className={`npr-status npr-status--${file.status}`}>{file.status}</span>
                    <span className="npr-list__main">{file.path}</span>
                    <span className="npr-list__meta"><span className="npr-add">+{file.additions}</span> <span className="npr-del">−{file.deletions}</span></span>
                    <FileDiff size={13} strokeWidth={1.5} className="npr-open-icon" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
      </>)}

      {diffView && (
        <RefDiffDialog
          title={diffView.title}
          files={diffView.files}
          initialPath={diffView.initialPath}
          headRef={diffView.headRef}
          load={diffView.load}
          onClose={() => setDiffView(null)}
        />
      )}
    </div>
  );
}
