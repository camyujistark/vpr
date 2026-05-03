import { execSync } from 'node:child_process';

/** Cached result of hasJj(). */
let _hasJj = null;

/**
 * Returns true if the `jj` binary is present in PATH.
 * Uses `which jj` — does NOT require a jj repository to be initialized.
 * Result is cached after first call.
 * @returns {boolean}
 */
export function hasJj() {
  if (_hasJj !== null) return _hasJj;
  try {
    execSync('which jj', { stdio: 'pipe' });
    _hasJj = true;
  } catch {
    _hasJj = false;
  }
  return _hasJj;
}

/**
 * Runs `jj git export` if jj is available, so git refs stay in sync after
 * ref-touching mutations (add, remove, move, merge). No-op if jj is absent.
 * Swallows errors — export is best-effort (e.g. fails outside a jj repo).
 * @returns {boolean} true if export was attempted, false if jj not available.
 */
export function jjExportIfAvailable() {
  if (!hasJj()) return false;
  try {
    execSync('jj git export', { stdio: 'pipe' });
  } catch {
    // best-effort — not in a jj repo, or export failed for other reasons
  }
  return true;
}
