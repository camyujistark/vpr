import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { analyze, downstream } from '../core/dag.mjs';
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

  // Snapshot: was itemName released before this abandonment?
  const wasReleased = isReleased(itemName, meta.sent);

  // Mark abandoned (audit trail preserved — record stays in meta.sent)
  sentRecord.abandoned = true;
  sentRecord.abandonedAt = new Date().toISOString();

  // Compute newly-blocked: only possible if itemName flipped released → not-released
  let newlyBlocked = [];
  if (wasReleased && !isReleased(itemName, meta.sent)) {
    const downstreamNames = downstream(itemName, meta);
    const view = analyze(meta);
    newlyBlocked = downstreamNames
      .filter(n => view.nodes.get(n)?.blockers.includes(itemName))
      .map(n => view.nodes.get(n))
      .filter(Boolean);
  }

  await saveMeta(meta);
  await appendEvent('cli', 'vpr.abandon', { branchName, itemName });

  return { branchName, itemName, newlyBlocked };
}
