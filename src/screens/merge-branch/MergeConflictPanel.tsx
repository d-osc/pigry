/** The merge that stopped on conflicts, resolved with the same editor as Duplicate commit: every conflicted file is
 * listed, each conflict gets current / incoming / result with accept buttons, and Commit merge writes and stages every
 * file then finishes the merge. Abort runs `git merge --abort`. */
import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { useRepository } from '../../hooks/useRepository';
import * as client from '../../lib/tauriClient';
import type { ConflictFileResolution, ConflictStateInfo } from '../../lib/tauriClient';
import { ConflictResolver, type ResolverFile } from '../merge-conflicts/ConflictResolver';

interface Loaded { key: string; files: ResolverFile[]; info: ConflictStateInfo | null }

async function loadFile(path: string): Promise<ResolverFile> {
  const [file, versions] = await Promise.all([
    client.readWorktreeFile(path).catch(() => null),
    client.conflictVersions(path).catch(() => null),
  ]);
  const binary = Boolean(versions?.binary || file?.binary);
  const ours = versions?.current ?? null;
  const theirs = versions?.incoming ?? null;
  // Line-by-line only when both sides still have the file and the working copy could be read.
  const bothSides = versions ? ours !== null && theirs !== null : true;
  const merged = !binary && bothSides && file && !file.tooLarge ? file.content : null;
  return { path, ours, theirs, merged, binary };
}

/** "Merge branch 'feature/x' into main" → "feature/x". */
function incomingBranch(info: ConflictStateInfo | null): string | null {
  const match = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(info?.incomingLabel ?? '');
  return match?.[1] ?? null;
}

export function MergeConflictPanel({
  conflicted, currentBranch, fallbackSource, onCommitted, onAbort,
}: {
  conflicted: string[];
  currentBranch: string;
  fallbackSource: string;
  onCommitted: (incoming: string) => void;
  onAbort: () => Promise<void>;
}) {
  const { busy, notify, refresh, conflictContinue } = useRepository();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [working, setWorking] = useState(false);
  // Files leave the conflicted list one by one while Commit merge stages them: keep showing the editor meanwhile.
  const liveKey = [...conflicted].sort().join('\n');
  const key = working && loaded ? loaded.key : liveKey;

  useEffect(() => {
    let off = false;
    const paths = key.split('\n').filter(Boolean);
    void Promise.all([client.conflictState().catch(() => null), Promise.all(paths.map(loadFile))]).then(([info, files]) => {
      if (!off) setLoaded({ key, files, info });
    });
    return () => { off = true; };
  }, [key]);

  if (!loaded || loaded.key !== key) return <p className="merge-branch__empty" role="status">Loading conflicted files…</p>;

  const current = loaded.info?.branch ?? (currentBranch || 'your branch');
  const incoming = incomingBranch(loaded.info) ?? (fallbackSource || 'incoming');

  const complete = async (resolutions: ConflictFileResolution[]): Promise<void> => {
    setWorking(true);
    try {
      for (const resolution of resolutions) {
        try {
          await client.conflictResolveFile(resolution);
        } catch (error) {
          notify(`Could not resolve ${resolution.path}: ${error instanceof Error ? error.message : String(error)}`, 'error');
          await refresh();
          return;
        }
      }
      if (await conflictContinue()) onCommitted(incoming);
    } finally {
      setWorking(false);
    }
  };

  return (
    <ConflictResolver
      key={loaded.key}
      files={loaded.files}
      label="Merge conflicts"
      icon={<GitMerge size={18} />}
      title={`Merging ${incoming} into ${current} needs your help`}
      description={`${incoming} and ${current} changed the same lines. Choose what to keep in each file, then commit the merge. Your choices are written to the files only when you commit; Abort puts ${current} back as it was before the merge.`}
      sides={{ current, currentRole: 'your branch', incoming, incomingRole: 'being merged' }}
      resultTarget={`committed on ${current}`}
      completeLabel="Commit merge"
      completeTitle={`Write the resolved files and create the merge commit on ${current}`}
      abortName="merge"
      abortWarning={`Abort the merge? ${current} goes back to how it was before the merge and your choices are lost.`}
      busy={busy || working}
      onComplete={resolutions => void complete(resolutions)}
      onAbort={() => void onAbort()}
    />
  );
}
