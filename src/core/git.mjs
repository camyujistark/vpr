import { execSync } from 'node:child_process';
import { mergeFileLines } from './file-lines.mjs';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] };

/**
 * Execute `git <cmd>`, return stdout trimmed. Throws on failure.
 * @param {string} cmd
 * @returns {string}
 */
export function git(cmd) {
  try {
    return execSync(`git ${cmd}`, EXEC_OPTS).trim();
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : err.message;
    throw new Error(`Command failed: git ${cmd}\n${msg}`);
  }
}

/**
 * Same as git() but returns null on failure instead of throwing.
 * @param {string} cmd
 * @returns {string|null}
 */
export function gitSafe(cmd) {
  try {
    return execSync(`git ${cmd}`, EXEC_OPTS).trim();
  } catch {
    return null;
  }
}

/** Translate the jj working-copy token `@` to git's `HEAD`. */
function tip(rev) {
  return rev === '@' ? 'HEAD' : rev;
}

/**
 * Map full sha → array of local branch names pointing at it.
 * @returns {Map<string, string[]>}
 */
function localBranchMap() {
  const map = new Map();
  const out = gitSafe("for-each-ref --format='%(objectname) %(refname:short)' refs/heads");
  if (!out) return map;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const sha = trimmed.slice(0, sp);
    const name = trimmed.slice(sp + 1).trim();
    if (!map.has(sha)) map.set(sha, []);
    map.get(sha).push(name);
  }
  return map;
}

/** Set of full shas that have a remote-tracking ref pointing at them. */
function remoteShaSet() {
  const out = gitSafe("for-each-ref --format='%(objectname)' refs/remotes");
  if (!out) return new Set();
  return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
}

/**
 * Nearest ancestor of HEAD that carries a remote-tracking ref (the top of the
 * already-pushed part of the stack). Full sha, or null.
 * @returns {string|null}
 */
function remoteTop() {
  const remotes = remoteShaSet();
  if (remotes.size === 0) return null;
  const out = gitSafe('rev-list HEAD');
  if (!out) return null;
  for (const sha of out.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (remotes.has(sha)) return sha;
  }
  return null;
}

/**
 * Normalize a `git --name-status` line into the jj-style "<STATUS> <path>"
 * (or "R <old> -> <new>" for renames) that mergeFileLines expects.
 * @param {string} line
 * @returns {string|null}
 */
function normalizeNameStatus(line) {
  const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const code = parts[0][0];
  const letter = code === 'T' ? 'M' : code; // type-change ~ modify
  if ((code === 'R' || code === 'C') && parts.length >= 3) {
    return `${letter} ${parts[1]} -> ${parts[2]}`;
  }
  return `${letter} ${parts[1]}`;
}

/**
 * The git (v2) backend. Identity is the full commit sha (git has no stable
 * change-id), so `changeId` carries the full sha and `sha` the short form;
 * every method keys on the full sha for internal consistency.
 *
 * @type {import('./vcs.mjs').VcsBackend}
 */
export const gitBackend = {
  kind: 'git',

  getBase() {
    return (
      remoteTop() ||
      gitSafe('merge-base HEAD origin/main') ||
      gitSafe('merge-base HEAD origin/master') ||
      (gitSafe('rev-list --max-parents=0 HEAD') || '').split('\n')[0].trim() ||
      null
    );
  },

  getBaseBranch() {
    const base = this.getBase();
    if (!base) return null;
    const remoteRef = gitSafe(`for-each-ref --points-at ${base} --format='%(refname:short)' refs/remotes`);
    if (remoteRef) {
      const first = remoteRef.split('\n')[0].trim();
      return first.replace(/^[^/]+\//, ''); // strip "origin/"
    }
    return null;
  },

  // Git has no conflict-carrying commits; conflicts only exist transiently
  // during an in-progress rebase (handled by the restack slice). Empty here.
  getConflicts() {
    return new Set();
  },

  listChain(base) {
    const branches = localBranchMap();
    const remotes = remoteShaSet();
    const out = gitSafe(`log --reverse --format='%H%x09%h%x09%s' ${base}..HEAD`);
    if (!out) return [];
    const rows = [];
    for (const line of out.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [full, short, subject] = parts;
      if (!full || !short) continue;
      if (!subject.trim()) continue;
      rows.push({
        changeId: full,
        sha: short,
        bookmarks: branches.get(full) ?? [],
        hasRemote: remotes.has(full),
        subject: subject.trim(),
      });
    }
    return rows;
  },

  getRemoteTop() {
    return remoteTop();
  },

  listChangeIds(from, to) {
    const out = gitSafe(`rev-list ${from}..${tip(to)}`);
    if (!out) return new Set();
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  },

  getDiff(id) {
    return git(`show --format= -p ${id}`);
  },

  getFiles(id) {
    const out = gitSafe(`show --format= --name-status ${id}`);
    if (!out) return [];
    return out.split('\n').map(normalizeNameStatus).filter(Boolean);
  },

  getVprFiles(ids) {
    const all = [];
    for (const id of ids) {
      try {
        all.push(this.getFiles(id));
      } catch {
        // skip commits that fail to load
      }
    }
    return mergeFileLines(all);
  },
};
