import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
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
}

interface BaseEntry {
  oid: string;
  content: string | null;
}

export function ComparePanel({
  path,
  workingContent,
  language,
  baseOid,
}: ComparePanelProps) {
  const { commits } = useFileHistory(path);
  const [base, setBase] = useState<BaseEntry | null>(null);
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
            content: result.binary || result.tooLarge ? null : result.content,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setBase({ oid: baseCommit.oid, content: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, baseCommit?.oid]); // eslint-disable-line react-hooks/exhaustive-deps

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
    base?.oid === baseCommit.oid ? (base.content ?? '') : undefined;

  return (
    <aside className="compare-panel">
      <header className="compare-panel__head">
        <GitCompare size={12} />
        <span className="compare-panel__title">Compare code</span>
        <span className="compare-panel__file">{fileName}</span>
        <span className="compare-panel__mode">Inline comparison</span>
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
        {baseContent === undefined ? (
          <div className="compare-panel__empty">Loading base…</div>
        ) : (
          <DiffEditor
            key={`${path}:${baseCommit.oid}`}
            original={baseContent}
            modified={workingContent}
            language={language}
            theme="orbit-dark"
            options={{
              readOnly: true,
              renderSideBySide: false,
              fontSize: 11,
              lineHeight: 18,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
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
