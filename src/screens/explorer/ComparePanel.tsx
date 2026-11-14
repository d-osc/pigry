import { useEffect, useState } from 'react';
import { DiffEditor } from '../../editor/ThemedEditors';
import { GitCompare } from 'lucide-react';
import { readFileAtCommit } from '../../lib/tauriClient';
import { useFileHistory } from '../../hooks/useFileHistory';
import { relativeTime } from '../../lib/relativeTime';
import type { FileCommitEntry } from '../../types/repository';
import '../../editor/monacoSetup';
import './ComparePanel.css';

interface ComparePanelProps {
  path: string;
  /** Current editor buffer — the compare TARGET (includes unsaved changes). */
  workingContent: string;
  language: string;
  baseOid: string | null;
  /** History walks this ref instead of HEAD (e.g. a PR head branch). */
  refName?: string | null;
}

interface BaseEntry {
  oid: string;
  path: string;
  error?: string;
  content: string | null;
}

export function ComparePanel({
  path,
  workingContent,
  language,
  baseOid,
  refName,
}: ComparePanelProps) {
  const { commits, error: historyError, retry: retryHistory } = useFileHistory(path, refName ?? null);
  const [attempt, setAttempt] = useState(0);
  const [base, setBase] = useState<BaseEntry | null>(null);
  // Inline (unified) by default; Split renders side-by-side like the editor.
  const [split, setSplit] = useState(false);
  const fileName = path.split('/').pop() ?? path;

  const baseCommit: FileCommitEntry | undefined = baseOid
    ? commits?.find((commit) => commit.oid === baseOid)
    : commits?.[0];

  // Load the BASE blob whenever the selected commit changes.
  useEffect(() => {
    if (!baseCommit) return;
    let cancelled = false;
    readFileAtCommit(path, baseCommit.oid)
      .then((result) => {
        if (!cancelled) {
          setBase({
            oid: baseCommit.oid,
            path,
            content: result.binary || result.tooLarge ? null : result.content,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setBase({ oid: baseCommit.oid, path, content: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, baseCommit?.oid, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (historyError) return <aside className="compare-panel"><div className="compare-panel__empty" role="alert">{historyError}<button className="outline-button" onClick={retryHistory}>Try again</button></div></aside>;
  if (!baseCommit) {
    return (
      <aside className="compare-panel">
        <header className="compare-panel__head">
          <GitCompare size={12} />
          <span className="compare-panel__title">Compare code</span>
        </header>
        <div className="compare-panel__empty">No commits touch this file</div>
      </aside>
    );
  }

  const baseContent =
    base?.oid === baseCommit.oid && base.path === path ? (base.content ?? '') : undefined;

  return (
    <aside className="compare-panel">
      <header className="compare-panel__head">
        <GitCompare size={12} />
        <span className="compare-panel__title">Compare code</span>
        <span className="compare-panel__file">{fileName}</span>
        <span className="compare-panel__mode">Inline comparison</span>
        <div className="compare-panel__layout" role="group" aria-label="Compare layout">
          <button
            type="button"
            className={`compare-panel__layout-btn${!split ? ' is-active' : ''}`}
            onClick={() => setSplit(false)}
          >
            Unified
          </button>
          <button
            type="button"
            className={`compare-panel__layout-btn${split ? ' is-active' : ''}`}
            onClick={() => setSplit(true)}
          >
            Split
          </button>
        </div>
      </header>
      <div className="compare-panel__meta">
        <div className="compare-panel__side">
          <span className="compare-panel__label">BASE</span>
          <span className="compare-panel__sha">{baseCommit.shortOid}</span>
          <span className="compare-panel__who">
            {baseCommit.authorName} · {relativeTime(baseCommit.timeSeconds)}
          </span>
        </div>
        <div className="compare-panel__side">
          <span className="compare-panel__label compare-panel__label--target">
            TARGET
          </span>
          <span className="compare-panel__sha">CURRENT</span>
          <span className="compare-panel__who">{fileName}</span>
        </div>
      </div>
      <div className="compare-panel__editor">
        {base?.path === path && base.oid === baseCommit.oid && (base.error || base.content === null) ? (
          <div className="compare-panel__empty" role="alert">{base.error ?? 'Binary or oversized file — comparison unavailable.'}<button className="outline-button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>
        ) : baseContent === undefined ? (
          <div className="compare-panel__empty">Loading base…</div>
        ) : (
          <DiffEditor
            key={`${path}:${baseCommit.oid}`}
            original={baseContent}
            modified={workingContent}
            language={language}
            options={{
              readOnly: true,
              renderSideBySide: split,
              fontSize: 11,
              lineHeight: 18,
              fontFamily: "'Fira Code', 'JetBrains Mono', ui-monospace, monospace",
              fontLigatures: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderOverviewRuler: false,
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
              stickyScroll: { enabled: false },
            }}
          />
        )}
      </div>
    </aside>
  );
}
