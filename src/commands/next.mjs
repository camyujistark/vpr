import { loadMeta } from '../core/meta.mjs';
import { analyze, ready as dagReady } from '../core/dag.mjs';

/**
 * Return the sorted list of unblocked ItemViews.
 * Sorted by depth asc, then name asc (same order as dag.ready).
 *
 * @returns {Promise<import('../core/dag.mjs').ItemView[]>}
 */
export async function next() {
  const state = await loadMeta();
  const view = analyze(state);
  const readyNames = dagReady(view);
  return readyNames.map(n => view.nodes.get(n));
}
