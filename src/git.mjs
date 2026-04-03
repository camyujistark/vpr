/**
 * VCS helpers — supports both jj (preferred) and git (fallback).
 * Detects jj colocated repo and uses it when available.
 */

import { execSync } from 'child_process';
import fs from 'fs';

function exec(cmd) {
  return execSync(cmd, {
    encoding: 'utf-8',
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Detect if jj is available and initialized
let _hasJj = null;
export function hasJj() {
  if (_hasJj !== null) return _hasJj;
  try {
    exec('jj root');
    _hasJj = true;
  } catch {
    _hasJj = false;
  }
  return _hasJj;
}

export function jj(cmd) {
  return exec(`jj ${cmd}`);
}

export function jjSafe(cmd) {
  try { return jj(cmd); } catch { return null; }
}

export function git(cmd) {
  return exec(`git ${cmd}`);
}

export function gitSafe(cmd) {
  try { return git(cmd); } catch { return null; }
}

export function currentBranch() {
  return git('branch --show-current');
}

export function getBase() {
  if (hasJj()) {
    // jj uses branch@remote syntax
    for (const ref of ['main@origin', 'master@origin', 'main', 'master']) {
      if (jjSafe(`log --no-graph -r '${ref}' -T 'change_id.short()'`)) return ref;
    }
    // Fallback to trunk()
    return 'trunk()';
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitSafe(`rev-parse --verify ${ref}`)) return ref;
  }
  return null;
}

export function getFilesForCommit(sha) {
  try {
    if (hasJj()) {
      // jj uses change IDs, but also accepts git SHAs
      return jj(`diff --summary -r ${sha}`).split('\n').filter(Boolean).map(line => {
        // Output: "M path/to/file" or "A path/to/file"
        return line.replace(/^[MADR]\s+/, '');
      });
    }
    return git(`diff-tree --no-commit-id --name-only -r ${sha}`).split('\n').filter(Boolean);
  } catch { return []; }
}

export function getDiffForCommit(sha) {
  try {
    if (hasJj()) return jj(`diff --git -r ${sha}`);
    return git(`show --stat --patch --color=never ${sha}`);
  } catch { return ''; }
}

export function getNumstatForCommit(sha) {
  try {
    // jj doesn't have numstat, use git even in jj mode (colocated)
    return git(`diff-tree --no-commit-id --numstat -r ${sha}`)
      .split('\n').filter(Boolean)
      .map(line => {
        const [added, removed, file] = line.split('\t');
        return { file, added: parseInt(added) || 0, removed: parseInt(removed) || 0 };
      });
  } catch { return []; }
}

/**
 * Describe a commit (change its message). jj does this instantly without rebase.
 */
export function describeCommit(sha, newMessage) {
  if (hasJj()) {
    // jj describe works on any commit, no rebase needed
    const escaped = newMessage.replace(/'/g, "'\\''");
    jj(`describe ${sha} -m '${escaped}'`);
  } else {
    throw new Error('describeCommit without jj requires interactive rebase');
  }
}

/**
 * Move a commit to a new parent. jj auto-rebases descendants.
 */
export function rebaseCommit(sha, newParent) {
  if (hasJj()) {
    jj(`rebase -r ${sha} -d ${newParent}`);
  } else {
    throw new Error('rebaseCommit without jj requires interactive rebase');
  }
}

/**
 * Get jj change ID for a commit. Change IDs are stable across rebases/describes.
 * Falls back to git SHA when jj is not available.
 */
let changeIdCache = new Map();
export function getChangeId(sha) {
  if (changeIdCache.has(sha)) return changeIdCache.get(sha);
  let id;
  if (hasJj()) {
    try {
      id = jj(`log --no-graph -r ${sha} -T 'change_id.short()'`).trim();
    } catch { id = sha; }
  } else {
    id = sha;
  }
  changeIdCache.set(sha, id);
  return id;
}

export function clearChangeIdCache() {
  changeIdCache.clear();
}
