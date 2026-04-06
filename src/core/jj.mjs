import { execSync } from 'node:child_process';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] };

/**
 * Execute `jj <cmd>`, return stdout trimmed. Throws on failure.
 * @param {string} cmd
 * @returns {string}
 */
export function jj(cmd) {
  try {
    return execSync(`jj ${cmd}`, EXEC_OPTS).trim();
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : err.message;
    throw new Error(`Command failed: jj ${cmd}\n${msg}`);
  }
}

/**
 * Same as jj() but returns null on failure instead of throwing.
 * @param {string} cmd
 * @returns {string|null}
 */
export function jjSafe(cmd) {
  try {
    return execSync(`jj ${cmd}`, EXEC_OPTS).trim();
  } catch {
    return null;
  }
}

/** Cached result of hasJj(). */
let _hasJj = null;

/**
 * Returns true if jj is available and the current directory is a jj repo.
 * Result is cached after first call.
 * @returns {boolean}
 */
export function hasJj() {
  if (_hasJj !== null) return _hasJj;
  try {
    execSync('jj root', EXEC_OPTS);
    _hasJj = true;
  } catch {
    _hasJj = false;
  }
  return _hasJj;
}

/**
 * Find the nearest ancestor commit with a remote bookmark.
 * Returns the commit_id (not change_id) to avoid divergent ID issues.
 *
 * Fallback chain:
 *   1. Remote bookmarks on ancestors
 *   2. main@origin
 *   3. master@origin
 *   4. trunk()
 *
 * Returns null if nothing found.
 * @returns {string|null}
 */
export function getBase() {
  // Try ancestors with remote bookmarks (excluding the working copy itself)
  const remoteAncestor = jjSafe(
    'log -r "ancestors(@, 1) & remote_bookmarks()" --no-graph --template "commit_id.short()" -n 1'
  );
  if (remoteAncestor) return remoteAncestor;

  // Try main@origin
  const mainOrigin = jjSafe(
    'log -r "main@origin" --no-graph --template "commit_id.short()" -n 1'
  );
  if (mainOrigin) return mainOrigin;

  // Try master@origin
  const masterOrigin = jjSafe(
    'log -r "master@origin" --no-graph --template "commit_id.short()" -n 1'
  );
  if (masterOrigin) return masterOrigin;

  // Try trunk()
  const trunk = jjSafe(
    'log -r "trunk()" --no-graph --template "commit_id.short()" -n 1'
  );
  if (trunk) return trunk;

  return null;
}

/**
 * Return a Set of change_id shorts for all conflicted commits.
 * @returns {Set<string>}
 */
export function getConflicts() {
  const output = jjSafe("log -r 'conflicts()' --no-graph --template 'change_id.short() ++ \"\\n\"'");
  if (!output) return new Set();
  const ids = output.split('\n').map(s => s.trim()).filter(Boolean);
  return new Set(ids);
}

/**
 * Return the git-format diff for a commit.
 * @param {string} changeId
 * @returns {string}
 */
export function getDiff(changeId) {
  return jj(`diff -r ${changeId} --git`);
}

/**
 * Return array of file summary lines (e.g. "A path/to/file") for a commit.
 * @param {string} changeId
 * @returns {string[]}
 */
export function getFiles(changeId) {
  const output = jjSafe(`diff -r ${changeId} --summary`);
  if (!output) return [];
  return output.split('\n').map(s => s.trim()).filter(Boolean);
}
