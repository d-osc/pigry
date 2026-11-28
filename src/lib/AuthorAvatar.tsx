/** Author avatar — the author's real profile picture with a tinted-initials
 * fallback. Shared by every Workspace menu that shows a commit, PR, issue or
 * release author (Commit graph, Branches, Cherry Pick, Rebase, Explorer file
 * history, Working changes, Pull requests, Issues, Projects, Releases, Wiki,
 * Insights).
 *
 * Picture sources, best first (see `avatarCandidates`): a URL the backend
 * already has, the repo's email → GitHub avatar map (`commit_avatars`, 7-day
 * localStorage cache), a GitHub noreply email, a GitHub login, Gravatar by
 * email hash. The initials stay underneath until a picture has loaded, and a
 * picture that fails moves on to the next source, then to the initials. */
import { useEffect, useState, type CSSProperties } from 'react';
import { commitAvatars, isTauri } from './tauriClient';
import { useRepository } from '../hooks/useRepository';
import { avatarCandidates } from './avatarUrl';
import { colorOf, initialsOf } from './ghData';

/** Muted avatar tints from the design (cycled by initials) — same palette
 * as the commit-graph screen. */
const TONES = [
  { bg: '#303c55', fg: '#abbcdf' },
  { bg: '#393044', fg: '#c8b1d8' },
  { bg: '#233c42', fg: '#9bcbd3' },
  { bg: '#40372c', fg: '#d7c2a0' },
];

export function avatarTone(initials: string) {
  let hash = 0;
  for (let i = 0; i < initials.length; i += 1) hash = (hash * 31 + initials.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length];
}

const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
const EMPTY_MAP: Record<string, string> = Object.freeze({}) as Record<string, string>;
/** Resolved maps per repository, shared by every mounted avatar list. */
const loadedMaps = new Map<string, Record<string, string>>();
/** In-flight loads per repository, so several screens share one gh call. */
const pendingMaps = new Map<string, Promise<Record<string, string>>>();

function readCachedMap(repoPath: string): Record<string, string> | null {
  try {
    localStorage.removeItem('pigry:avatars'); // legacy global cache
    const cached = localStorage.getItem(`pigry:avatars:${repoPath}`);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as { at: number; map: Record<string, string> };
    const nonEmpty = parsed.map && Object.keys(parsed.map).length > 0;
    return Date.now() - parsed.at < AVATAR_TTL_MS && nonEmpty ? parsed.map : null;
  } catch {
    return null; // cache parse failure — refetch
  }
}

/** Email → GitHub avatar map for one repository (cache, then gh api). */
function loadAvatarMap(repoPath: string): Promise<Record<string, string>> {
  const loaded = loadedMaps.get(repoPath);
  if (loaded) return Promise.resolve(loaded);
  const pending = pendingMaps.get(repoPath);
  if (pending) return pending;
  const request = Promise.resolve()
    .then(() => readCachedMap(repoPath) ?? commitAvatars().then((list) => {
      const next: Record<string, string> = {};
      for (const item of list) next[item.email] = item.avatarUrl;
      // Empty result is not cached — the next mount retries (gh may have
      // been signed out or the remote unavailable the first time).
      if (Object.keys(next).length > 0) {
        try {
          localStorage.setItem(`pigry:avatars:${repoPath}`, JSON.stringify({ at: Date.now(), map: next }));
        } catch {
          // storage full — skip persist
        }
      }
      return next;
    }))
    .then((map) => {
      if (Object.keys(map).length > 0) loadedMaps.set(repoPath, map);
      return map;
    })
    .finally(() => pendingMaps.delete(repoPath));
  pendingMaps.set(repoPath, request);
  return request;
}

/** Author email → GitHub profile image url for the active repository. */
export function useCommitAvatars(): Record<string, string> {
  const { repository } = useRepository();
  const repoPath = repository?.localPath ?? '';
  const [state, setState] = useState<{ path: string; map: Record<string, string> }>({ path: '', map: EMPTY_MAP });
  useEffect(() => {
    if (!isTauri() || !repoPath) return;
    let cancelled = false;
    loadAvatarMap(repoPath)
      .then((map) => {
        if (!cancelled) setState({ path: repoPath, map });
      })
      .catch(() => {
        // gh not signed in / no remote — other sources, then initials
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);
  // A map loaded for another repository never leaks into this one.
  return state.path === repoPath ? state.map : (loadedMaps.get(repoPath) ?? EMPTY_MAP);
}

/** Picture URLs that failed to load this session — skipped by every avatar. */
const brokenUrls = new Set<string>();

interface AuthorAvatarRow {
  authorEmail?: string;
  authorName: string;
  authorInitials?: string;
}

export interface AuthorIdentity {
  /** Display name — tooltip, alt text and the initials source. */
  name: string;
  email?: string;
  /** GitHub login (gh-sourced rows: PRs, issues, releases, projects). */
  login?: string;
  /** A picture URL the backend already resolved. */
  avatarUrl?: string;
  initials?: string;
}

function initialsFrom(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

/** Profile picture when one resolves and loads, tinted initials otherwise. */
export function AuthorAvatar({
  row,
  author,
  avatarMap,
  className = 'commit-avatar',
  style,
  size = 40,
}: {
  /** A commit row (authorName / authorEmail / authorInitials). */
  row?: AuthorAvatarRow;
  /** Or any other author. */
  author?: AuthorIdentity;
  avatarMap?: Record<string, string>;
  /** The screen's own avatar class (size, radius, font). */
  className?: string;
  /** Fallback tint override (defaults to the design's muted tones). */
  style?: CSSProperties;
  /** Requested picture size in px. */
  size?: number;
}) {
  const who: AuthorIdentity = author ?? {
    name: row?.authorName ?? '',
    email: row?.authorEmail,
    initials: row?.authorInitials,
  };
  const initials = who.initials || initialsFrom(who.name);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState('');
  const url = avatarCandidates({ ...who, avatarMap, size }).find(
    (candidate) => !failed.includes(candidate) && !brokenUrls.has(candidate),
  );
  const shown = !!url && loaded === url;
  const tone = avatarTone(initials);
  return (
    <span
      className={`${className} author-avatar${shown ? ' author-avatar--loaded' : ''}`}
      style={style ?? { background: tone.bg, color: tone.fg }}
      title={who.name}
      data-author-avatar=""
    >
      <span className="author-avatar__initials" aria-hidden={shown || undefined}>{initials}</span>
      {url && (
        <img
          key={url}
          className="author-avatar__img"
          src={url}
          alt={who.name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setLoaded(url)}
          onError={() => {
            brokenUrls.add(url);
            setFailed((prev) => [...prev, url]);
          }}
        />
      )}
    </span>
  );
}

/** Avatar for a GitHub login (PR / issue / release / project people): the
 * login's GitHub picture over the screens' login-colored initials. */
export function LoginAvatar({
  login,
  className,
  initials,
  color,
  style,
  size = 40,
}: {
  login: string;
  className: string;
  initials?: string;
  /** Fallback background (defaults to `colorOf(login)`). */
  color?: string;
  /** Extra inline style (e.g. a per-use width/height). */
  style?: CSSProperties;
  size?: number;
}) {
  return (
    <AuthorAvatar
      author={{ name: login, login, initials: initials ?? initialsOf(login) }}
      className={className}
      style={{ background: color ?? colorOf(login), ...style }}
      size={size}
    />
  );
}
