import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { jjSafe } from '../core/jj.mjs';

/**
 * Remove every VPR and item from meta, and delete each VPR's jj bookmark
 * (best-effort — missing bookmarks are ignored).
 *
 * @param {object} [opts]
 * @param {'cli'|'tui'} [opts.actor='cli']
 * @returns {Promise<{ bookmarks: string[] }>}
 */
export async function clearAll({ actor = 'cli' } = {}) {
  const meta = await loadMeta();
  const bookmarks = [];
  for (const itemData of Object.values(meta.items ?? {})) {
    for (const bm of Object.keys(itemData.vprs ?? {})) {
      bookmarks.push(bm);
    }
  }
  for (const bm of bookmarks) {
    jjSafe(`bookmark delete ${bm}`);
  }
  meta.items = {};
  await saveMeta(meta);
  await appendEvent(actor, 'vpr.clearAll', { count: bookmarks.length });
  return { bookmarks };
}
