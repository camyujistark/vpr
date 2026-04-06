import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

/**
 * Add a changeId to the hold list.
 * Idempotent — adding an already-held id is a no-op.
 *
 * @param {string} changeId
 * @returns {Promise<void>}
 */
export async function hold(changeId) {
  const meta = await loadMeta();
  if (!meta.hold.includes(changeId)) {
    meta.hold.push(changeId);
    await saveMeta(meta);
    await appendEvent('cli', 'vpr.hold', { changeId });
  }
}

/**
 * Remove a changeId from the hold list.
 * Idempotent — removing a non-held id is a no-op.
 *
 * @param {string} changeId
 * @returns {Promise<void>}
 */
export async function unhold(changeId) {
  const meta = await loadMeta();
  const before = meta.hold.length;
  meta.hold = meta.hold.filter(id => id !== changeId);
  if (meta.hold.length !== before) {
    await saveMeta(meta);
    await appendEvent('cli', 'vpr.unhold', { changeId });
  }
}
