/** Interactive rebase planner: reorder / squash / drop commits above a base. */
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import * as client from '../../lib/tauriClient';
import { useRepository } from '../../hooks/useRepository';
import type { RebaseAction, RebaseStep } from '../../types/repository';
import './RebaseModal.css';
interface RebaseModalProps {
  /** The commit the branch will be replayed onto (not itself rewritten). */
  baseOid: string;
  onClose: () => void;
}

interface PlanRow {
  oid: string;
  shortOid: string;
  summary: string;
  action: RebaseAction;
}

const NEXT_ACTION: Record<RebaseAction, RebaseAction> = {
  pick: 'squash',
  squash: 'drop',
  drop: 'pick',
};

export function RebaseModal({ baseOid, onClose }: RebaseModalProps) {
  const { interactiveRebase } = useRepository();
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [baseSummary, setBaseSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Load the commits between base and HEAD (base excluded), newest first.
  useEffect(() => {
    let cancelled = false;
    client
      .getCommitHistory(false)
      .then((history) => {
        if (cancelled) return;
        const index = history.commits.findIndex((c) => c.oid === baseOid);
        if (index === -1) {
          setError('This commit is deeper than the loaded history — it cannot be a rebase base.');
          setRows([]);
          return;
        }
        setBaseSummary(history.commits[index].summary);
        setRows(
          history.commits.slice(0, index).map((row) => ({
            oid: row.oid,
            shortOid: row.shortOid,
            summary: row.summary,
            action: 'pick' as RebaseAction,
          })),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [baseOid]);

  // Escape closes (while not running).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, running]);

  const move = useCallback((index: number, delta: number) => {
    setRows((prev) => {
      if (!prev) return prev;
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const cycleAction = useCallback((index: number) => {
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const row = next[index];
      // The oldest selected row cannot squash into the base — cycle pick/drop only.
      const nextAction =
        index === prev.length - 1 && row.action === 'pick' ? 'drop' : NEXT_ACTION[row.action];
      next[index] = { ...row, action: nextAction };
      return next;
    });
  }, []);

  const execute = useCallback(async () => {
    if (!rows || rows.length === 0) return;
    // Display order is newest first; the todo list git applies is the reverse.
    const steps: RebaseStep[] = [...rows].reverse().map(({ oid, action }) => ({ oid, action }));
    setRunning(true);
    // run() surfaces success/error toasts itself and never throws.
    await interactiveRebase(baseOid, steps);
    onClose();
    setRunning(false);
  }, [rows, baseOid, interactiveRebase, onClose]);

  const planValid =
    rows !== null && rows.length > 0 && rows[rows.length - 1].action !== 'squash';

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="rebase" role="dialog" aria-modal="true" aria-label="Interactive rebase">
        <header className="settings__header">
          <div>
            <h2 className="settings__title">Interactive rebase</h2>
            <p className="rebase__base">
              Replay onto <code>{baseOid.slice(0, 7)}</code>
              {baseSummary && <span className="rebase__base-summary"> {baseSummary}</span>}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close rebase planner">
            <X size={14} />
          </button>
        </header>

        {error && <p className="rebase__error">{error}</p>}

        {rows && rows.length === 0 && !error && (
          <p className="settings__hint rebase__hint-pad">
            No commits between the base and HEAD — nothing to rebase.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="rebase__list">
            {rows.map((row, index) => (
              <li key={row.oid} className={`rebase__row${row.action === 'drop' ? ' rebase__row--drop' : ''}`}>
                <button
                  type="button"
                  className="rebase__action"
                  onClick={() => cycleAction(index)}
                  title="Click to cycle pick → squash → drop"
                  data-action={row.action}
                >
                  {row.action}
                </button>
                <span className="rebase__oid">{row.shortOid}</span>
                <span className="rebase__summary" title={row.summary}>{row.summary}</span>
                <span className="rebase__move">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move commit up (applied later)"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => move(index, 1)}
                    disabled={index === rows.length - 1}
                    aria-label="Move commit down (applied earlier)"
                  >
                    <ArrowDown size={11} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <footer className="rebase__footer">
          <p className="settings__hint">
            Click the action chip to cycle pick → squash → drop; arrows reorder. The plan is
            applied oldest-first.
          </p>
          <div className="rebase__footer-buttons">
            <button type="button" className="settings__btn" onClick={onClose} disabled={running}>
              Cancel
            </button>
            <button
              type="button"
              className="settings__btn settings__btn--primary"
              onClick={execute}
              disabled={running || !planValid}
            >
              {running ? 'Rebasing…' : 'Start rebase'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
