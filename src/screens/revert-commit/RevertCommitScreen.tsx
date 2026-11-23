/** Revert commit screen — browse the current branch, inspect a commit, and undo it with a new "Revert …" commit.
 * A revert that conflicts surfaces the conflicted files with an abort action. */
import { Undo2 } from 'lucide-react';
import { revertAbort, revertCommit } from '../../lib/tauriClient';
import { CommitActionScreen, type CommitActionConfig } from '../cherry-pick/CommitActionScreen';

const CONFIG: CommitActionConfig = {
  title: 'Revert commit',
  Icon: Undo2,
  subtitle: (branch) => `undoes a commit on ${branch} with a new revert commit — history is kept`,
  currentBranchOnly: true,
  source: 'Revert commit',
  actionLabel: (shortOid) => `Revert ${shortOid}`,
  actionBusyLabel: 'Reverting…',
  actionTooltip: (shortOid, branch) => `Create a commit on ${branch} that undoes ${shortOid}`,
  mergeTooltip: 'Merge commits cannot be reverted here',
  success: (shortOid) => `Reverted ${shortOid} — a revert commit was created`,
  run: revertCommit,
  conflictTitle: 'Revert conflicts',
  conflictNotice: 'Revert conflicts — resolve in Working changes or abort',
  conflictHint: 'resolve the files in Working changes, then commit to finish the revert',
  isConflict: (message) => /CONFLICT|could not revert|after resolving the conflicts/i.test(message),
  abortLabel: 'Abort revert',
  abortDone: 'Revert aborted — branch restored',
  abort: revertAbort,
};

export function RevertCommitScreen() {
  return <CommitActionScreen config={CONFIG} />;
}
