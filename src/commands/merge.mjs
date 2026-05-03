import { execSync } from 'node:child_process';
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
    // jj path: squash all src commits into dst in a single invocation
    const range = srcClaims.join(' | ');
    jjSafe(`squash --from "${range}" --into "${dst}" --quiet`);
  } else if (!hasJj()) {
    gitSquashFallback(src, dst);
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
 * Git-only squash: collapse src bookmark's commits into dst bookmark.
 *
 * For a linear stack (src is ancestor of dst), creates a squash commit whose
 * tree is dst's current tree and whose parent is src's parent — collapsing
 * the combined range to one commit.  For a diverged case uses merge-tree.
 * Deletes the src branch after squash.  Silently no-ops if the git ops fail
 * (e.g. branches don't exist as git refs).
 *
 * @param {string} src  bookmark / branch name of the source VPR
 * @param {string} dst  bookmark / branch name of the destination VPR
 */
function gitSquashFallback(src, dst) {
  const OPTS = { stdio: 'pipe', encoding: 'utf8' };
  try {
    execSync('git rev-parse --git-dir', OPTS);
    const srcTip = execSync(`git rev-parse refs/heads/${src}`, OPTS).trim();
    const dstTip = execSync(`git rev-parse refs/heads/${dst}`, OPTS).trim();

    let squashParent;
    let squashTree;

    let srcIsAncestor = false;
    try {
      execSync(`git merge-base --is-ancestor ${srcTip} ${dstTip}`, OPTS);
      srcIsAncestor = true;
    } catch { /* not ancestor */ }

    if (srcIsAncestor) {
      // Linear stack: src commits → dst commits.  Squash by taking dst's tree
      // and re-parenting at src's parent, collapsing the full range to one commit.
      squashParent = execSync(`git rev-parse ${srcTip}^`, OPTS).trim();
      squashTree = execSync(`git rev-parse ${dstTip}^{tree}`, OPTS).trim();
    } else {
      // Diverged or src-above-dst: use merge-tree to combine both sides.
      const mergeOut = execSync(
        `git merge-tree --write-tree --no-messages ${dstTip} ${srcTip}`,
        OPTS
      );
      squashTree = mergeOut.split('\n')[0].trim();
      squashParent = dstTip;
    }

    const newCommit = execSync(
      `git commit-tree ${squashTree} -p ${squashParent} -m "Squash: merge ${src} into ${dst}"`,
      OPTS
    ).trim();

    execSync(`git update-ref refs/heads/${dst} ${newCommit}`, OPTS);
    execSync(`git branch -D ${src}`, OPTS);
  } catch {
    // Graceful fallback: meta-only already handled above
  }
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
