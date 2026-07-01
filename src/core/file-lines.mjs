const STATUS_PRECEDENCE = { A: 5, D: 4, M: 3, R: 2, C: 1 };

/**
 * Merge multiple file-summary line arrays into a deduped, sorted list.
 * When the same path appears with different statuses, the strongest wins
 * (A > D > M > R > C). Rename lines ("R old -> new") are keyed by their
 * full "old -> new" string and never collide with regular paths.
 *
 * Pure function — backend-agnostic, so both the jj and git backends share it.
 *
 * @param {string[][]} linesArrays
 * @returns {string[]}
 */
export function mergeFileLines(linesArrays) {
  const map = new Map(); // key -> status
  for (const lines of linesArrays) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      const [, status, key] = m;
      const existingRank = STATUS_PRECEDENCE[map.get(key)] ?? -1;
      const newRank = STATUS_PRECEDENCE[status] ?? 0;
      if (newRank > existingRank) map.set(key, status);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, status]) => `${status} ${key}`);
}
