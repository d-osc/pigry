import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Plus, X } from 'lucide-react';
import { terminalRun } from '../lib/tauriClient';
import { ResizeHandle } from './ResizeHandle';
import './TerminalPanel.css';

interface TerminalPanelProps {
  /** Repository root — new terminals start here. */
  cwd: string;
  onClose: () => void;
}

interface TerminalLine {
  kind: 'cmd' | 'out' | 'err' | 'info';
  text: string;
}

interface TerminalSession {
  id: string;
  name: string;
  lines: TerminalLine[];
  cwd: string;
  history: string[];
  historyIndex: number;
}

const WELCOME = 'integrated terminal — commands run in the repository. `cls` clears.';

/** Suggestions for the autocomplete dropdown (busybox built-ins + common commands). */
const COMMANDS = [
  'ls', 'ls -l', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'tree', 'du', 'df', 'stat',
  'touch', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'echo', 'pwd', 'cd', 'date', 'whoami', 'id',
  'hostname', 'uname', 'which', 'env', 'sleep', 'seq', 'help', 'clear', 'cls', 'true', 'false',
  'sort', 'uniq', 'cut', 'printf', 'diff', 'cmp', 'ln', 'chmod', 'test', 'nl', 'tac', 'rev',
  'md5sum', 'sha1sum', 'sha256sum', 'expr',
  'tar -cf backup.tar', 'tar -tf backup.tar', 'tar -xf backup.tar',
  'git status', 'git log', 'git diff', 'git add .', 'git commit', 'git push', 'git pull',
  'git fetch', 'git branch', 'git checkout', 'git merge',
  'npm run dev', 'npm install', 'npm test', 'cargo check', 'cargo build', 'cargo test',
];

function filterCommands(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return COMMANDS.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8);
}

function newSession(cwd: string, index: number): TerminalSession {
  return {
    id: `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: `Terminal ${index + 1}`,
    lines: [{ kind: 'info', text: WELCOME }],
    cwd,
    history: [],
    historyIndex: -1,
  };
}

export function TerminalPanel({ cwd, onClose }: TerminalPanelProps) {
  const [sessions, setSessions] = useState<TerminalSession[]>(() => [
    newSession(cwd, 0),
  ]);
  const [activeId, setActiveId] = useState(sessions[0].id);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  const [height, setHeight] = useState(260);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const suggestions = useMemo(() => filterCommands(input), [input]);

  const updateSession = useCallback((id: string, patch: Partial<TerminalSession>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const copyAll = useCallback(() => {
    const session = active;
    if (!session) return;
    const text = session.lines
      .map((line) => (line.kind === 'cmd' ? `❯ ${line.text}` : line.text))
      .join('\n');
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [active]);

  // Keep the output pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.lines]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId, running, active?.lines.length]);

  const addSession = useCallback(() => {
    // Create the session outside the updater — StrictMode double-invokes
    // updaters, which would desync the active id from the created session.
    const session = newSession(cwd, sessions.length);
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  }, [cwd, sessions.length]);

  const closeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          onClose();
          return prev;
        }
        if (id === activeId) setActiveId(next[next.length - 1].id);
        return next;
      });
    },
    [activeId, onClose],
  );

  const run = useCallback(
    async (command: string) => {
      if (!active) return;
      const session = active;
      updateSession(session.id, {
        lines: [...session.lines, { kind: 'cmd', text: command }],
        history: [...session.history, command],
        historyIndex: -1,
      });

      if (command === 'cls' || command === 'clear') {
        updateSession(session.id, { lines: [{ kind: 'info', text: WELCOME }] });
        return;
      }

      setRunning(true);
      try {
        const result = await terminalRun(command, session.cwd);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session.id
              ? {
                  ...s,
                  cwd: result.cwd,
                  lines: [
                    ...s.lines,
                    ...(result.stdout
                      ? [{ kind: 'out' as const, text: result.stdout.replace(/\n$/, '') }]
                      : []),
                    ...(result.stderr
                      ? [{ kind: 'err' as const, text: result.stderr.replace(/\n$/, '') }]
                      : []),
                    ...(result.code !== 0
                      ? [{ kind: 'err' as const, text: `exit code: ${result.code}` }]
                      : []),
                  ],
                }
              : s,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        updateSession(session.id, {
          lines: [...session.lines, { kind: 'err', text: message }],
        });
      } finally {
        setRunning(false);
        inputRef.current?.focus();
      }
    },
    [active, updateSession],
  );

  const submit = () => {
    const command = input.trim();
    if (!command || running || !active) return;
    setInput('');
    void run(command);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const matches = running ? [] : suggestions;
    const hasHighlight = suggestIdx >= 0 && suggestIdx < matches.length;

    if (event.key === 'Tab' && matches.length > 0) {
      event.preventDefault();
      const idx = hasHighlight ? suggestIdx : 0;
      setInput(matches[idx]);
      setSuggestIdx(idx);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (matches.length > 0) {
        setSuggestIdx(suggestIdx + 1 >= matches.length ? 0 : suggestIdx + 1);
        return;
      }
      if (!active || active.history.length === 0) return;
      const next =
        active.historyIndex < 0
          ? active.history.length - 1
          : Math.max(0, active.historyIndex - 1);
      updateSession(active.id, { historyIndex: next });
      setInput(active.history[next]);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length > 0) {
        setSuggestIdx(suggestIdx <= 0 ? matches.length - 1 : suggestIdx - 1);
        return;
      }
      if (!active || active.history.length === 0) return;
      const next =
        active.historyIndex < 0
          ? active.history.length - 1
          : Math.max(0, active.historyIndex - 1);
      updateSession(active.id, { historyIndex: next });
      setInput(active.history[next]);
      return;
    }
    if (event.key === 'Escape') {
      setSuggestIdx(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (hasHighlight) {
        const chosen = matches[suggestIdx];
        setInput('');
        setSuggestIdx(-1);
        void run(chosen);
        return;
      }
      submit();
    }
  };

  const shortCwd = active ? (active.cwd.length > 44 ? `…${active.cwd.slice(-42)}` : active.cwd) : '';

  return (
    <section className="terminal-panel" role="region" aria-label="Integrated terminal" style={{ height }}>
      <ResizeHandle
        orientation="h"
        label="Resize terminal"
        onDelta={(_dx, dy) => setHeight((h) => Math.min(520, Math.max(140, h - dy)))}
      />
      <header className="terminal-panel__head">
        <div className="terminal-panel__tabs">
          {sessions.map((session, index) => (
            <div
              key={session.id}
              className={`terminal-panel__tab${session.id === activeId ? ' terminal-panel__tab--active' : ''}`}
            >
              <button
                type="button"
                className="terminal-panel__tab-btn"
                onClick={() => setActiveId(session.id)}
                title={session.cwd}
              >
                {index + 1}: {session.name}
              </button>
              <button
                type="button"
                className="terminal-panel__tab-close"
                aria-label={`Close ${session.name}`}
                onClick={() => closeSession(session.id)}
              >
                <X size={11} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal-panel__tab-add"
            aria-label="New terminal"
            title="New terminal"
            onClick={addSession}
          >
            <Plus size={13} strokeWidth={1.5} />
          </button>
        </div>
        <button
          type="button"
          className="terminal-panel__copy"
          aria-label="Copy terminal output"
          title="Copy terminal output"
          onClick={copyAll}
        >
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.5} />}
        </button>
        <span className="terminal-panel__cwd" title={active?.cwd}>
          {shortCwd}
        </span>
        <button type="button" className="terminal-panel__close" aria-label="Close terminal panel" onClick={onClose}>
          <ChevronDown size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className="terminal-panel__scroll" ref={scrollRef}>
        {active?.lines.map((line, index) => (
          <div key={index} className={`terminal-panel__line terminal-panel__line--${line.kind}`}>
            {line.kind === 'cmd' ? <span className="terminal-panel__ps">❯ </span> : null}
            {line.text}
          </div>
        ))}
      </div>

      <div className="terminal-panel__inputrow">
        {suggestions.length > 0 && !running && (
          <div className="terminal-panel__dropdown">
            {suggestions.map((cmd, i) => (
              <button
                key={cmd}
                type="button"
                className={`terminal-panel__option${i === suggestIdx ? ' terminal-panel__option--active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setInput(cmd);
                  setSuggestIdx(i);
                }}
              >
                {cmd}
              </button>
            ))}
            <div className="terminal-panel__dropdown-hint">Tab เติมคำ · Enter รัน · ↑↓ เลือก</div>
          </div>
        )}
        <span className="terminal-panel__ps">{running ? '…' : '❯'}</span>
        <input
          ref={inputRef}
          className="terminal-panel__input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setSuggestIdx(filterCommands(event.target.value).length > 0 ? 0 : -1);
          }}
          onKeyDown={onKeyDown}
          placeholder={running ? 'running…' : 'type a command'}
          spellCheck={false}
          disabled={running}
          aria-label="Terminal command input"
        />
        <button
          type="button"
          className="terminal-panel__kill"
          aria-label="Close terminal panel"
          title="Close panel"
          onClick={onClose}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
    </section>
  );
}
