import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { hasJj } from '../core/jj-detect.mjs';
import { jj, jjSafe } from '../core/jj.mjs';
import { jjExportIfAvailable } from '../core/jj-detect.mjs';

/**
 * Surgically move a jj change-id from its current VPR onto a target VPR.
 *
 * Requires jj. Captures the op-log head before the move so it can roll back
 * atomically if the rebase produces conflicts.
 *
 * @param {string} changeId   jj change-id (short or long) to move
 * @param {{ toVpr: string }} opts
 * @returns {Promise<MoveResult>}
 *
 * @typedef {{ moved: true, changeId: string, sourceVpr: string, targetVpr: string }
 *          | { moved: false, changeId: string, targetVpr: string,
 *              conflicts: string[], suggestions: string[] }} MoveResult
 */
export async function moveCommit(changeId, { toVpr } = {}) {
  if (!hasJj()) throw new Error('Install jj for surgical commit moves');

  const meta = await loadMeta();

  // Validate target VPR exists
  const targetEntry = findVprEntry(meta, toVpr);
  if (!targetEntry) throw new Error(`No such VPR: ${toVpr}`);

  // Find source VPR for the changeId (by checking which VPR claims it)
  const sourceEntry = findVprByChangeId(meta, changeId);
  const sourceVpr = sourceEntry?.bookmark ?? null;

  // AC3: capture op-log head before any mutation
  const preOp = jj("op log -n 1 -T 'self.id().short()'");

  // AC4: attempt rebase of changeId onto target VPR bookmark
  jjSafe(`rebase -r ${changeId} -d ${toVpr}`);

  // AC5: check for conflicts in the rebased commit
  const conflicts = getConflictPaths(changeId);
  if (conflicts.length > 0) {
    // Roll back atomically
    jjSafe(`op restore ${preOp}`);

    // AC7: find clean-target suggestions by trial-rebasing into other VPRs
    const suggestions = await findCleanTargets(meta, changeId, toVpr, preOp);

    await appendEvent('cli', 'vpr.move', {
      changeId,
      sourceVpr,
      targetVpr: toVpr,
      success: false,
      conflicts: conflicts.length,
    });

    return { moved: false, changeId, targetVpr: toVpr, conflicts, suggestions };
  }

  // AC8: success — leave op-log advanced
  await appendEvent('cli', 'vpr.move', {
    changeId,
    sourceVpr,
    targetVpr: toVpr,
    success: true,
  });
  jjExportIfAvailable();

  return { moved: true, changeId, sourceVpr, targetVpr: toVpr };
}

/**
 * Get conflict file paths for a given change-id via `jj resolve --list`.
 * Returns empty array when no conflicts.
 * @param {string} changeId
 * @returns {string[]}
 */
function getConflictPaths(changeId) {
  const output = jjSafe(`resolve --list -r ${changeId}`);
  if (!output) return [];
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Trial-rebase into each VPR in the same item (excluding the failed target)
 * to find clean alternatives. Reverts each trial via op restore.
 * @param {object} meta
 * @param {string} changeId
 * @param {string} failedTarget
 * @param {string} baseOp  op to restore to after each trial
 * @returns {Promise<string[]>} bookmark names of clean candidate VPRs
 */
async function findCleanTargets(meta, changeId, failedTarget, baseOp) {
  // Find which item contains the failedTarget
  const targetEntry = findVprEntry(meta, failedTarget);
  if (!targetEntry) return [];

  const itemVprs = Object.keys(meta.items[targetEntry.itemName]?.vprs ?? {});
  const candidates = itemVprs.filter((b) => b !== failedTarget);

  const clean = [];
  for (const candidate of candidates) {
    // Capture current op before trial
    const beforeTrial = jj("op log -n 1 -T 'self.id().short()'");
    jjSafe(`rebase -r ${changeId} -d ${candidate}`);
    const trialConflicts = getConflictPaths(changeId);
    // Always restore after trial
    jjSafe(`op restore ${beforeTrial}`);
    if (trialConflicts.length === 0) clean.push(candidate);
  }
  return clean;
}

/**
 * Find a VPR entry by bookmark name across all items.
 * @param {object} meta
 * @param {string} bookmark
 * @returns {{ itemName: string, bookmark: string, vprMeta: object } | null}
 */
function findVprEntry(meta, bookmark) {
  for (const [itemName, itemData] of Object.entries(meta.items ?? {})) {
    const vprMeta = (itemData.vprs ?? {})[bookmark];
    if (vprMeta) return { itemName, bookmark, vprMeta };
  }
  return null;
}

/**
 * Find which VPR in meta claims the given change-id.
 * @param {object} meta
 * @param {string} changeId
 * @returns {{ itemName: string, bookmark: string } | null}
 */
function findVprByChangeId(meta, changeId) {
  for (const [itemName, itemData] of Object.entries(meta.items ?? {})) {
    for (const [bookmark, vprMeta] of Object.entries(itemData.vprs ?? {})) {
      const claims = vprMeta.claims ?? [];
      if (claims.some((c) => c === changeId || c.startsWith(changeId) || changeId.startsWith(c))) {
        return { itemName, bookmark };
      }
    }
  }
  return null;
}
