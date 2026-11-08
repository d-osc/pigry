import { useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileCode2,
  GitBranch,
  GitMerge,
  Paperclip,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareTerminal,
  ThumbsUp,
  Undo2,
  ArrowDownToLine,
  GitCommitVertical,
  Plus,
  Clock,
} from 'lucide-react';
import { ResizeHandle } from '../../app/ResizeHandle';
import './AiAgentScreen.css';

const STAGED_FILES = [
  { path: 'src/components/command-menu.tsx', stat: 'M +18 −4', note: 'selected for staging', selected: true },
  { path: 'src/hooks/use-commands.ts', stat: 'M +12 −3', note: 'selected for staging', selected: true },
  { path: 'src/components/graph/minimap.tsx', stat: 'M +2 −2', note: 'excluded', selected: false },
];

const ACTIVITY = [
  { icon: 'ok', text: 'Searched code: 2 matching files', time: '10:54' },
  { icon: 'ok', text: 'Read diffs: 3 modified files', time: '10:55' },
  { icon: 'warn', text: 'Staging proposed · not executed', time: '10:55' },
  { icon: 'idle', text: '0 mutating commands executed this session', time: '' },
];

function OrbitGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="9.5" ry="4.4" transform="rotate(-24 12 12)" />
    </svg>
  );
}

export function AiAgentScreen() {
  const [aiWidth, setAiWidth] = useState(340);
  return (
    <div className="screen agent-screen">
      <header className="screen-header">
        <h1 className="screen-header__title">AI Agent</h1>
        <span className="agent-screen__scope">Repository agent</span>
        <span className="screen-header__meta">
          Understand your code. Review every change. Stay in control.
        </span>
        <button type="button" className="outline-button">
          <ShieldCheck size={12} strokeWidth={1.25} />
          Approval required
        </button>
        <button type="button" className="outline-button">
          <Clock size={12} strokeWidth={1.25} />
          Sessions
        </button>
        <button type="button" className="primary-button">
          <Plus size={12} strokeWidth={1.25} />
          New session
        </button>
      </header>

      <div className="screen-toolbar">
        <button type="button" className="chip-button">
          <BookOpen size={13} strokeWidth={1.25} />
          Understand repo
        </button>
        <button type="button" className="chip-button">
          <Search size={13} strokeWidth={1.25} />
          Search code
        </button>
        <button type="button" className="primary-button agent-screen__toolbar-primary">
          <Plus size={12} strokeWidth={1.25} />
          Stage files
        </button>
        <button type="button" className="chip-button">
          <GitCommitVertical size={13} strokeWidth={1.25} />
          Commit
        </button>
        <button type="button" className="chip-button">
          <ArrowDownToLine size={13} strokeWidth={1.25} />
          Pull
        </button>
        <button type="button" className="chip-button">
          <GitMerge size={13} strokeWidth={1.25} />
          Merge
        </button>
        <button type="button" className="chip-button">
          <SquareTerminal size={13} strokeWidth={1.25} />
          More Git commands
          <ChevronDown size={12} strokeWidth={1.25} />
        </button>
        <span className="agent-screen__branch">main ↑0 ↓0</span>
      </div>

      <div className="screen-body">
        <section className="agent-chat">
          <div className="agent-chat__topic">
            <span>Command menu · search behavior</span>
            <span className="agent-chat__topic-time">Today / 10:54 AM</span>
          </div>

          <div className="agent-chat__scroll">
            <article className="agent-msg agent-msg--user">
              <span className="agent-avatar agent-avatar--user">AL</span>
              <div className="agent-msg__body">
                <p className="agent-msg__name">
                  You <span className="agent-msg__time">10:54</span>
                </p>
                <p className="agent-msg__text">
                  Find how command-menu search reaches repository actions. Review my changes and
                  prepare a commit. Leave the minimap work out; don&apos;t run Git commands yet.
                </p>
              </div>
            </article>

            <article className="agent-msg">
              <span className="agent-avatar agent-avatar--orbit">
                <OrbitGlyph />
              </span>
              <div className="agent-msg__body">
                <p className="agent-msg__name">
                  Orbit <span className="agent-msg__badge">Read-only analysis</span>
                  <span className="agent-msg__matches">2 matches · 2 files</span>
                </p>
                <p className="agent-msg__text">
                  The flow is <code>query → filtered commands → action handler</code>. I searched
                  for <code>useCommands</code> and <code>onSelect</code>, then read the two
                  modified files.
                </p>

                <div className="agent-code-card">
                  <div className="agent-code-card__head">
                    <FileCode2 size={12} strokeWidth={1.25} />
                    <span className="agent-code-card__path">src/components/command-menu.tsx</span>
                    <span className="agent-code-card__lines">L48-49</span>
                  </div>
                  <pre>
                    <span className="agent-code__ln">48</span>{' '}
                    <span className="tok-kw">const</span> commands = useCommands(query);
                    {'\n'}
                    <span className="agent-code__ln">49</span>{' '}
                    <span className="tok-kw">return</span> commands.map(cmd =&gt; {'\u003c'}Item onSelect={'{cmd.run}'} /&gt;);
                  </pre>
                </div>

                <div className="agent-code-card">
                  <div className="agent-code-card__head">
                    <FileCode2 size={12} strokeWidth={1.25} />
                    <span className="agent-code-card__path">src/hooks/use-commands.ts</span>
                    <span className="agent-code-card__lines">L31-32</span>
                  </div>
                  <pre>
                    <span className="agent-code__ln">31</span>{' '}
                    <span className="tok-kw">const</span> matches = fuzzySearch(registry,
                    query.trim());
                    {'\n'}
                    <span className="agent-code__ln">32</span>{' '}
                    <span className="tok-kw">return</span> matches.filter(cmd =&gt;
                    cmd.isAvailable(repo));
                  </pre>
                </div>

                <p className="agent-msg__text agent-msg__text--muted">
                  Your diff trims the query and filters unavailable actions before rendering. The
                  menu keeps each command&apos;s handler. The minimap change is unrelated and stays
                  unstaged.
                </p>

                <div className="agent-plan">
                  <div className="agent-plan__head">
                    <strong>Proposed Git plan</strong>
                    <span className="agent-plan__status">Not executed · review required</span>
                  </div>
                  {[
                    ['Stage 2 selected files', 'Awaiting your approval in the review panel'],
                    ['Review & commit', 'Separate approval after staging; draft prepared'],
                    ['Pull / merge later', 'Clean tree first; inspect incoming diff and conflicts'],
                  ].map(([name, note], index) => (
                    <div key={name} className="agent-plan__step">
                      <span className="agent-plan__number">{index + 1}</span>
                      <span className="agent-plan__name">{name}</span>
                      <span className="agent-plan__note">{note}</span>
                      <ChevronRight size={12} strokeWidth={1.25} className="agent-plan__chevron" />
                    </div>
                  ))}
                  <div className="agent-plan__foot">
                    <span>Files read only · tests not run · no repository changes</span>
                    <span className="agent-plan__votes">
                      <ThumbsUp size={12} strokeWidth={1.25} />
                      <Undo2 size={12} strokeWidth={1.25} />
                    </span>
                  </div>
                </div>

                <div className="agent-suggestions">
                  <button type="button" className="agent-suggestion">
                    <ArrowDownToLine size={14} strokeWidth={1.25} />
                    <span className="agent-suggestion__text">
                      <strong>Pull origin/main</strong>
                      <span>Up to date · preview before pulling</span>
                    </span>
                    <ChevronRight size={13} strokeWidth={1.25} />
                  </button>
                  <button type="button" className="agent-suggestion">
                    <GitBranch size={14} strokeWidth={1.25} />
                    <span className="agent-suggestion__text">
                      <strong>Compare feat/graph-search → main</strong>
                      <span>Review diff · clean tree required to merge</span>
                    </span>
                    <ChevronRight size={13} strokeWidth={1.25} />
                  </button>
                </div>
              </div>
            </article>
          </div>

          <div className="agent-composer">
            <div className="agent-composer__chips">
              <span className="agent-composer__chip">platform / main</span>
              <span className="agent-composer__chip agent-composer__chip--accent">2 files selected</span>
              <span className="agent-composer__chip agent-composer__chip--ghost">@ files, branches, commits</span>
            </div>
            <div className="agent-composer__box">
              <input placeholder="Ask about this repo, search code, or propose a Git action…" aria-label="Message the agent" />
              <div className="agent-composer__controls">
                <span className="agent-composer__left">
                  <Paperclip size={13} strokeWidth={1.25} />
                  Agent
                  <ChevronDown size={12} strokeWidth={1.25} />
                </span>
                <span className="agent-composer__right">
                  ↵ Send
                  <button type="button" className="agent-composer__send" aria-label="Send">
                    <ArrowUp size={14} strokeWidth={2} />
                  </button>
                </span>
              </div>
            </div>
            <p className="agent-composer__hint">Analysis is read-only. Git changes always pause for your approval.</p>
          </div>
        </section>

        <ResizeHandle
          orientation="v"
          label="Resize AI panel"
          onDelta={(dx) => setAiWidth((w) => Math.min(480, Math.max(280, w - dx)))}
        />
        <aside className="agent-rail" style={{ width: aiWidth }}>
          <section className="agent-rail__section">
            <h4>
              Repository context
              <RefreshCw size={11} strokeWidth={1.25} />
            </h4>
            <div className="agent-context__row">
              <GitBranch size={12} strokeWidth={1.25} />
              <span className="agent-context__branch">main → origin/main</span>
              <span className="agent-context__badge">↑0 ↓0</span>
            </div>
            <div className="agent-context__row">
              <span className="agent-dot agent-dot--accent" />
              <span className="agent-context__mono">a8f2291</span>
              <span className="agent-context__note">origin → acme-inc/platform</span>
            </div>
            <div className="agent-context__row">
              <span className="agent-dot agent-dot--orange" />
              <span className="agent-context__note agent-context__note--full">
                3 modified · 0 staged · 0 conflicts
              </span>
            </div>
          </section>

          <section className="agent-rail__section">
            <h4>
              <ShieldCheck size={12} strokeWidth={1.25} />
              Review staging
              <span className="agent-rail__awaiting">Awaiting approval</span>
            </h4>
            <p className="agent-staging__sub">
              2 of 3 files selected <span className="agent-staging__diff">+30 −7</span>
            </p>
            {STAGED_FILES.map((file) => (
              <div key={file.path} className={`agent-file${file.selected ? ' agent-file--selected' : ''}`}>
                <span className={`agent-file__check${file.selected ? ' agent-file__check--on' : ''}`}>
                  {file.selected && <Check size={10} strokeWidth={2.5} />}
                </span>
                <div className="agent-file__body">
                  <p className="agent-file__path">{file.path}</p>
                  <p className={`agent-file__stat${file.selected ? '' : ' agent-file__stat--off'}`}>
                    {file.stat} · {file.note}
                  </p>
                </div>
                <ChevronRight size={12} strokeWidth={1.25} className="agent-file__chevron" />
              </div>
            ))}

            <p className="agent-rail__label">
              Commit message <span className="agent-rail__label-note">Draft · not queued</span>
            </p>
            <div className="agent-commit-input">fix: improve command menu search</div>

            <p className="agent-rail__label">
              Command preview <span className="agent-rail__label-warn">Writes index</span>
            </p>
            <pre className="agent-command">
              git add -- \
              {'\n'}  src/components/command-menu.tsx \
              {'\n'}  src/hooks/use-commands.ts
            </pre>

            <p className="agent-warning">
              <CircleAlert size={12} strokeWidth={1.5} />
              Stages only these files on main. No commit, pull, merge, or push. Working files are
              not changed.
            </p>

            <div className="agent-staging__buttons">
              <button type="button" className="outline-button">Cancel</button>
              <button type="button" className="primary-button">
                <Check size={12} strokeWidth={2} />
                Approve staging · 2 files
              </button>
            </div>
            <p className="agent-staging__foot">
              Commit requires another review. Pull and merge stay blocked until the working tree is
              clean.
            </p>
          </section>

          <section className="agent-rail__section">
            <h4>
              Session activity <span className="agent-rail__all">View all ↗</span>
            </h4>
            {ACTIVITY.map((row) => (
              <div key={row.text} className="agent-activity">
                <span className={`agent-activity__icon agent-activity__icon--${row.icon}`}>
                  {row.icon === 'ok' && <Check size={10} strokeWidth={2.5} />}
                  {row.icon === 'warn' && <CircleAlert size={10} strokeWidth={1.75} />}
                </span>
                <span className="agent-activity__text">{row.text}</span>
                <span className="agent-activity__time">{row.time}</span>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
