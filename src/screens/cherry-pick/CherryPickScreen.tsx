/** Cherry Pick screen — browse recent commits, inspect one, and pick it onto the current branch (staged, commit to
 * finish). Conflicted picks surface the conflicted files with an abort action. */
import { Cherry } from 'lucide-react';
import { cherryPick, cherryPickAbort } from '../../lib/tauriClient';
import { CommitActionScreen, type CommitActionConfig } from './CommitActionScreen';

const CONFIG: CommitActionConfig = {
  title: 'Cherry Pick',
  Icon: Cherry,
  subtitle: (branch) => `picks onto ${branch} — changes are staged, commit to finish`,
  source: 'Cherry Pick',
  actionLabel: (shortOid) => `Cherry-pick ${shortOid}`,
  actionBusyLabel: 'Picking…',
  actionTooltip: (shortOid, branch) => `Apply ${shortOid} onto ${branch}`,
  mergeTooltip: 'Merge commits cannot be cherry-picked',
  success: (shortOid) => `Cherry-picked ${shortOid} — staged, commit to finish`,
  run: cherryPick,
  conflictTitle: 'Cherry-pick conflicts',
  conflictNotice: 'Cherry-pick conflicts — resolve in Working changes or abort',
  conflictHint: 'resolve the files in Working changes, then commit',
  isConflict: (message) => message.includes('CONFLICT') || message.includes('could not apply'),
  abortLabel: 'Abort cherry-pick',
  abortDone: 'Cherry-pick aborted — branch restored',
  abort: cherryPickAbort,
};

export function CherryPickScreen() {
  return <CommitActionScreen config={CONFIG} />;
}
