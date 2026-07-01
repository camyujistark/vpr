import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { createVcs } from '../core/vcs.mjs';
import { findVpr } from './edit.mjs';

/**
 * Remove a VPR by query (bookmark name, partial bookmark, or partial title).
 *
 * Steps:
 *   1. Find the VPR in meta.
 *   2. Delete the jj bookmark (best-effort — warns if it fails).
 *   3. Remove the VPR from meta.items[itemName].vprs.
 *   4. Clean up empty items (no remaining vprs).
 *   5. Append an event.
 *
 * @param {string} query
 * @returns {Promise<{ bookmark: string, itemName: string }>}
 */
export async function removeVpr(query) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark } = found;

  // Delete the branch/bookmark (best-effort)
  const ok = createVcs().deleteBookmark(bookmark);
  if (!ok) {
    // Not a fatal error — the ref may already be gone or never created
    console.warn(`Warning: could not delete branch "${bookmark}" — it may not exist locally.`);
  }

  // Remove VPR from meta
  delete meta.items[itemName].vprs[bookmark];

  // Clean up item if it now has no VPRs
  if (Object.keys(meta.items[itemName].vprs).length === 0) {
    delete meta.items[itemName];
  }

  await saveMeta(meta);
  await appendEvent('cli', 'vpr.remove', { bookmark, itemName });

  return { bookmark, itemName };
}
