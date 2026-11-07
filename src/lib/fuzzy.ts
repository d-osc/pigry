/** Tiny fuzzy matcher: subsequence match with simple scoring. */

export interface FuzzyMatch {
  score: number;
  /** Matched character indices, for highlighting. */
  indices: number[];
}

/**
 * Case-insensitive subsequence match. Prefers consecutive matches and
 * word-boundary starts; returns null when the query does not match.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };

  let score = 0;
  const indices: number[] = [];
  let cursor = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const found = t.indexOf(q[qi], cursor);
    if (found === -1) return null;
    const consecutive = indices.length > 0 && found === indices[indices.length - 1] + 1;
    const boundary = found === 0 || /[\s/._-]/.test(t[found - 1] ?? '');
    score += consecutive ? 3 : boundary ? 2 : 1;
    indices.push(found);
    cursor = found + 1;
  }
  // Slightly prefer shorter targets (exact-ish hits rank higher).
  score -= t.length * 0.01;
  return { score, indices };
}

/** Sorts entries by fuzzy score, dropping non-matches. */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  keyOf: (item: T) => string,
): Array<{ item: T; match: FuzzyMatch }> {
  return items
    .map((item) => {
      const match = fuzzyMatch(query, keyOf(item));
      return match ? { item, match } : null;
    })
    .filter((entry): entry is { item: T; match: FuzzyMatch } => entry !== null)
    .sort((a, b) => b.match.score - a.match.score);
}
