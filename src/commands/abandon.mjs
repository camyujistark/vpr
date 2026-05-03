import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { analyze, downstream, status as dagStatus } from '../core/dag.mjs';
import { isReleased } from '../core/lifecycle.mjs';

/**
 * Mark a sent VPR as abandoned.
 *
 * @param {string} branchName - key in meta.sent
 * @returns {Promise<{ branchName: string, itemName: string, newlyBlocked: import('../core/dag.mjs').ItemView[] }>}
 */
export async function abandonVpr(branchName) {
  const meta = await loadMeta();
  const sentRecord = meta.sent?.[branchName];

  if (!sentRecord) {
    throw new Error(`No sent VPR found: ${branchName}`);
  }

  if (sentRecord.abandoned === true) {
    console.warn(`Warning: ${branchName} is already abandoned — no-op`);
    const itemName = sentRecord.itemName;
    return { branchName, itemName, newlyBlocked: [] };
  }

  const itemName = sentRecord.itemName;

  // Snapshot released state before abandonment
  const downstreamNames = downstream(itemName, meta);
  const releasedBefore = new Set(
    downstreamNames.filter(n => isReleased(n, meta.sent))
  );

  // Mark abandoned
  sentRecord.abandoned = true;
  sentRecord.abandonedAt = new Date().toISOString();

  // Compute newly-blocked: downstream items that were released and are now not
  const view = analyze(meta);
  const newlyBlocked = downstreamNames
    .filter(n => releasedBefore.has(n) && !view.nodes.get(n)?.released)
    .map(n => view.nodes.get(n))
    .filter(Boolean);

  await saveMeta(meta);
  await appendEvent('cli', 'vpr.abandon', { branchName, itemName });

  return { branchName, itemName, newlyBlocked };
}
