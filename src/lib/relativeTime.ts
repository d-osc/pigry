/** Relative time formatting, GitHub-style. */

export function relativeTime(timestampSeconds: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestampSeconds));
  if (seconds < 30) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  // Older than ~2 months: show a compact date.
  return new Date(timestampSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      new Date(timestampSeconds * 1000).getFullYear() ===
      new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  });
}
