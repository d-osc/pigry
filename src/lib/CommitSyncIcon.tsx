/** Push-state badge for a commit row: cloud = on a remote, disk = local
 * only. `CommitRow.pushed` (oids reachable from refs/remotes/**) drives it. */
import { Cloud, HardDrive } from 'lucide-react';

export function CommitSyncIcon({ pushed }: { pushed: boolean }) {
  return (
    <span
      className={`commit-sync${pushed ? ' commit-sync--pushed' : ' commit-sync--local'}`}
      title={pushed ? 'Pushed to remote' : 'Local only — not pushed yet'}
    >
      {pushed ? (
        <Cloud size={12} strokeWidth={1.5} />
      ) : (
        <HardDrive size={12} strokeWidth={1.5} />
      )}
    </span>
  );
}
