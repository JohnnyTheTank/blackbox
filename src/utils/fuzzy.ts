export interface Rankable {
  relPath: string;
}

export interface RankedEntry<T extends Rankable> {
  entry: T;
  score: number;
}

/**
 * Rank entries by how well they match the query. Returns entries sorted by
 * descending score (higher = better). Empty query returns all entries in
 * their original (alphabetical) order.
 */
export function fuzzyRank<T extends Rankable>(
  entries: T[],
  query: string,
  limit?: number,
): RankedEntry<T>[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    const out = entries.map((e) => ({ entry: e, score: 0 }));
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  const scored: RankedEntry<T>[] = [];
  for (const entry of entries) {
    const rel = entry.relPath.toLowerCase();
    const score = scoreMatch(rel, q);
    if (score <= 0) continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.relPath.length - b.entry.relPath.length;
  });
  return typeof limit === "number" ? scored.slice(0, limit) : scored;
}

export function scoreMatch(haystack: string, needle: string): number {
  if (needle.length === 0) return 1;
  const substringIdx = haystack.indexOf(needle);
  if (substringIdx !== -1) {
    let score = 1000 - substringIdx;
    const base = haystack.slice(haystack.lastIndexOf("/") + 1);
    if (base.startsWith(needle)) score += 500;
    if (haystack === needle) score += 2000;
    return score;
  }
  let hi = 0;
  let ni = 0;
  let score = 0;
  let lastMatch = -2;
  while (hi < haystack.length && ni < needle.length) {
    if (haystack[hi] === needle[ni]) {
      if (lastMatch === hi - 1) score += 5;
      else score += 1;
      lastMatch = hi;
      ni++;
    }
    hi++;
  }
  if (ni < needle.length) return 0;
  return score;
}
