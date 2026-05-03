import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { hasJj } from '../core/jj-detect.mjs';
import { jjSafe } from '../core/jj.mjs';
import { jjExportIfAvailable } from '../core/jj-detect.mjs';

/**
 * Merge one VPR into another.
 *
 * Both paths (jj and git-only) produce the same meta state:
 *   - src VPR removed
 *   - dst VPR gains src's claims
 *
 * jj path additionally runs `jj squash` to physically squash commits.
 * Git-only path is a pure meta operation (claims transfer).
 *
 * @param {string} src  bookmark name of the VPR to fold in
 * @param {string} dst  bookmark name of the VPR to fold into
 * @returns {Promise<{ src: string, dst: string }>}
 */
export async function mergeVpr(src, dst) {
  const meta = await loadMeta();

  const srcEntry = findVprEntry(meta, src);
  if (!srcEntry) throw new Error(`VPR not found: ${src}`);
  const dstEntry = findVprEntry(meta, dst);
  if (!dstEntry) throw new Error(`VPR not found: ${dst}`);

  const srcMeta = srcEntry.vprMeta;
  const dstMeta = dstEntry.vprMeta;
  const srcClaims = srcMeta.claims ?? [];

  if (hasJj() && srcClaims.length > 0) {
    // jj path: physically squash src commits into dst
    for (const changeId of srcClaims) {
      jjSafe(`squash --from ${changeId} --into ${dst} --quiet`);
    }
  }

  // Meta update: transfer claims, remove src
  const existingDstClaims = dstMeta.claims ?? [];
  const merged = [...new Set([...existingDstClaims, ...srcClaims])];
  if (merged.length > 0) {
    meta.items[srcEntry.itemName].vprs[dst].claims = merged;
  }
  delete meta.items[srcEntry.itemName].vprs[src];

  await saveMeta(meta);
  await appendEvent('cli', 'vpr.merge', { src, dst });
  jjExportIfAvailable();

  return { src, dst };
}

/**
 * Find a VPR entry by bookmark name across all items.
 * @param {object} meta
 * @param {string} bookmark
 * @returns {{ itemName: string, vprMeta: object } | null}
 */
function findVprEntry(meta, bookmark) {
  for (const [itemName, itemData] of Object.entries(meta.items ?? {})) {
    const vprMeta = (itemData.vprs ?? {})[bookmark];
    if (vprMeta) return { itemName, vprMeta };
  }
  return null;
}
