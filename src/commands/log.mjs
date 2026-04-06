import { jj, getBase } from '../core/jj.mjs';

/**
 * Print the jj log for the VPR range (base..visible_heads).
 * Falls back to a simple `jj log --limit N` if no base is found.
 *
 * @param {number} [limit=20]
 * @returns {string}  — stdout from jj log
 */
export function log(limit = 20) {
  const base = getBase();
  if (base) {
    const range = `${base}..(visible_heads() & descendants(${base}))`;
    return jj(`log -r '${range}' --limit ${limit}`);
  }
  return jj(`log --limit ${limit}`);
}
