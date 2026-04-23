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
    'log -r "ancestors(@) & remote_bookmarks()" --no-graph --template "commit_id.short()" -n 1'
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
 * Return the bookmark name of the nearest ancestor commit with a remote bookmark.
 * Strips @origin suffix. Returns null if nothing found.
 * @returns {string|null}
 */
export function getBaseBranch() {
  const raw = jjSafe(
    'log -r "ancestors(@) & remote_bookmarks()" --no-graph --template "bookmarks" -n 1'
  );
  if (!raw) return null;

  // bookmarks template may return space-separated list like "main main@origin"
  // Find the first one with @origin suffix and strip it, or use the first local one
  const parts = raw.split(/\s+/).filter(Boolean);
  const remote = parts.find(b => b.includes('@'));
  if (remote) return remote.replace(/@.*$/, '');
  return parts[0] || null;
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

const STATUS_PRECEDENCE = { A: 5, D: 4, M: 3, R: 2, C: 1 };

/**
 * Merge multiple file-summary line arrays into a deduped, sorted list.
 * When the same path appears with different statuses, the strongest wins
 * (A > D > M > R > C). Rename lines ("R old -> new") are keyed by their
 * full "old -> new" string and never collide with regular paths.
 *
 * Pure function — exported separately so it's testable without jj.
 *
 * @param {string[][]} linesArrays
 * @returns {string[]}
 */
export function mergeFileLines(linesArrays) {
  const map = new Map(); // key -> status
  for (const lines of linesArrays) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      const [, status, key] = m;
      const existingRank = STATUS_PRECEDENCE[map.get(key)] ?? -1;
      const newRank = STATUS_PRECEDENCE[status] ?? 0;
      if (newRank > existingRank) map.set(key, status);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, status]) => `${status} ${key}`);
}

/**
 * Aggregate file changes across all commits in a VPR.
 * Skips commits whose getFiles() throws.
 *
 * @param {string[]} changeIds
 * @returns {string[]} deduped, sorted "<status> <path>" lines
 */
export function getVprFiles(changeIds) {
  const all = [];
  for (const id of changeIds) {
    try {
      all.push(getFiles(id));
    } catch {
      // skip commits that fail to load
    }
  }
  return mergeFileLines(all);
}
