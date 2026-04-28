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

/**
 * Pure: decide what the TUI P-key should send.
 *
 * Cursor-independent: walks the chain-state items from `state` and picks the
 * first nextUp VPR. Returns `{ bookmark }` when sendable, `{ message }` when
 * nothing is sendable so the caller can surface a clear footer line instead
 * of falling through to a generic error.
 *
 * @param {{ items: Array<{ vprs: Array<{ bookmark: string, nextUp?: boolean }> }> }} state
 * @returns {{ bookmark: string } | { message: string }}
 */
export function pickSendBookmark(state) {
  const bookmark = findNextUpBookmark(state.items);
  if (bookmark) return { bookmark };
  return { message: 'No sendable VPR — chain is empty or all sent.' };
}
