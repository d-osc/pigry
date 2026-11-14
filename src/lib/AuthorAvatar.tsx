/** Author avatar for commit rows — GitHub profile image (email-mapped,
 * 7-day localStorage cache, gh api via the backend) with a tinted-initials
 * fallback. Shared by the Branches / Cherry Pick / Rebase Branch row lists. */
import { useEffect, useState } from 'react';
import { commitAvatars, isTauri } from './tauriClient';
import { useRepository } from '../hooks/useRepository';

/** Muted avatar tints from the design (cycled by initials) — same palette
 * as the commit-graph screen. */
const TONES = [
  { bg: '#303c55', fg: '#abbcdf' },
  { bg: '#393044', fg: '#c8b1d8' },
  { bg: '#233c42', fg: '#9bcbd3' },
  { bg: '#40372c', fg: '#d7c2a0' },
];

function avatarTone(initials: string) {
  let hash = 0;
  for (let i = 0; i < initials.length; i += 1) hash = (hash * 31 + initials.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length];
}

/** Author email → GitHub profile image url for the active repository. */
export function useCommitAvatars(): Record<string, string> {
  const { repository } = useRepository();
  const repoPath = repository?.localPath ?? '';
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isTauri() || !repoPath) return;
    let cancelled = false;
    const cacheKey = `pigry:avatars:${repoPath}`;
    Promise.resolve()
      .then(() => {
        try {
          localStorage.removeItem('pigry:avatars'); // legacy global cache
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const parsed = JSON.parse(cached) as { at: number; map: Record<string, string> };
            const nonEmpty = parsed.map && Object.keys(parsed.map).length > 0;
            if (Date.now() - parsed.at < 7 * 24 * 3600 * 1000 && nonEmpty) return parsed.map;
          }
        } catch {
          // cache parse failure — refetch
        }
        return null;
      })
      .then((cachedMap) => {
        if (cancelled) return null;
        if (cachedMap) {
          setMap(cachedMap);
          return null;
        }
        return commitAvatars();
      })
      .then((list) => {
        if (cancelled || !list) return;
        const next: Record<string, string> = {};
        for (const item of list) next[item.email] = item.avatarUrl;
        // Empty result is not cached — the next mount retries (gh may have
        // been signed out or the remote unavailable the first time).
        if (Object.keys(next).length > 0) {
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), map: next }));
          } catch {
            // storage full — skip persist
          }
        }
        setMap(next);
      })
      .catch(() => {
        // gh not signed in / no remote — initials fallback
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);
  return map;
}

interface AuthorAvatarRow {
  authorEmail?: string;
  authorName: string;
  authorInitials?: string;
}

/** Profile image when the email is mapped, tinted initials otherwise. */
export function AuthorAvatar({
  row,
  avatarMap,
}: {
  row: AuthorAvatarRow;
  avatarMap: Record<string, string>;
}) {
  const url = row.authorEmail ? avatarMap[row.authorEmail] : undefined;
  if (url) {
    return <img className="commit-avatar commit-avatar--img" src={url} alt={row.authorName} title={row.authorName} />;
  }
  const tone = avatarTone(row.authorInitials ?? '');
  return (
    <span className="commit-avatar" style={{ background: tone.bg, color: tone.fg }} title={row.authorName}>
      {row.authorInitials ?? ''}
    </span>
  );
}
