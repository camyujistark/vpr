/**
 * Pure: walk chain-state items and return the bookmark of the first VPR
 * marked `nextUp`. Returns null when no VPR is sendable.
 *
 * Used by the TUI P-key handler to pick the next-unsent VPR regardless of
 * where the cursor sits — same source-of-truth as `vpr send` no-args.
 *
 * @param {Array<{ vprs: Array<{ bookmark: string, nextUp?: boolean }> }>} items
 * @returns {string|null}
 */
export function findNextUpBookmark(items) {
  for (const item of items) {
    for (const vpr of item.vprs) {
      if (vpr.nextUp) return vpr.bookmark;
    }
  }
  return null;
}
