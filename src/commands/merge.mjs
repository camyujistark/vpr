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
 * @param {{ into: string, title?: string, story?: string }} opts
 * @returns {Promise<{ src: string, dst: string }>}
 */
export async function mergeVpr(src, { into: dst, title, story } = {}) {
  const meta = await loadMeta();

  const srcEntry = findVprEntry(meta, src);
  if (!srcEntry) throw new Error(`VPR not found: ${src}`);
  const dstEntry = findVprEntry(meta, dst);
  if (!dstEntry) throw new Error(`VPR not found: ${dst}`);

  if (srcEntry.itemName !== dstEntry.itemName) {
    throw new Error(
      `merge requires same item: src=${srcEntry.itemName}, dst=${dstEntry.itemName}`
    );
  }

  const vprKeys = Object.keys(meta.items[srcEntry.itemName].vprs ?? {});
  const srcIdx = vprKeys.indexOf(src);
  const dstIdx = vprKeys.indexOf(dst);
  if (Math.abs(srcIdx - dstIdx) !== 1) {
    throw new Error('src and dst must be adjacent VPRs');
  }

  const srcMeta = srcEntry.vprMeta;
  const dstMeta = dstEntry.vprMeta;
  const srcClaims = srcMeta.claims ?? [];

  if (hasJj() && srcClaims.length > 0) {
    // jj path: physically squash src commits into dst
    for (const changeId of srcClaims) {
      jjSafe(`squash --from ${changeId} --into ${dst} --quiet`);
    }
  }

  // Meta update: transfer claims, apply optional title/story overrides, remove src
  const existingDstClaims = dstMeta.claims ?? [];
  const mergedClaims = [...new Set([...existingDstClaims, ...srcClaims])];
  if (mergedClaims.length > 0) {
    meta.items[srcEntry.itemName].vprs[dst].claims = mergedClaims;
  }
  if (title !== undefined) meta.items[srcEntry.itemName].vprs[dst].title = title;
  if (story !== undefined) meta.items[srcEntry.itemName].vprs[dst].story = story;
  delete meta.items[srcEntry.itemName].vprs[src];

  await saveMeta(meta);
  await appendEvent('cli', 'vpr.merge', {
    src,
    dst,
    item: srcEntry.itemName,
    srcCommits: srcClaims,
    jjUsed: hasJj() && srcClaims.length > 0,
  });
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
