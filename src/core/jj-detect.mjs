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
