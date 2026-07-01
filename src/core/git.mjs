import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Locate an in-progress rebase directory, if any.
 * @returns {string|null} absolute path to the rebase state dir
 */
function rebaseStateDir() {
  const gitDir = gitSafe('rev-parse --absolute-git-dir');
  if (!gitDir) return null;
  for (const sub of ['rebase-merge', 'rebase-apply']) {
    const p = join(gitDir, sub);
    if (existsSync(p)) return p;
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

  // Git commit shas are NOT stable across rewrites, so vpr cannot pin a VPR to
  // a commit by id the way jj does with change-ids. Consumers key VPR ownership
  // off branch-boundary partitioning instead; stale sha "claims" in meta simply
  // fail to match a commit and are ignored.
  stableIdentity: false,

  // Git halts a rebase on the first conflict rather than recording conflicts in
  // commits. A "conflict" therefore only exists transiently while a rebase is
  // paused with unmerged paths.
  isRebaseInProgress() {
    return rebaseStateDir() !== null;
  },

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

  // Returns the set of commit shas currently conflicting in a paused rebase.
  // Empty when no rebase is in progress or the paused rebase has no unmerged
  // paths. The sha is the original commit that failed to apply (from
  // rebase-merge/stopped-sha), letting callers surface "there is a conflict".
  getConflicts() {
    const dir = rebaseStateDir();
    if (!dir) return new Set();
    const unmerged = gitSafe('diff --name-only --diff-filter=U');
    if (!unmerged) return new Set();
    const set = new Set();
    const stoppedPath = join(dir, 'stopped-sha');
    if (existsSync(stoppedPath)) {
      const sha = readFileSync(stoppedPath, 'utf-8').trim();
      if (sha) {
        const full = gitSafe(`rev-parse ${sha}`);
        if (full) set.add(full);
      }
    }
    return set;
  },

  listChain(base) {
    return this.listRange(base, 'HEAD');
  },

  listRange(from, to) {
    const branches = localBranchMap();
    const remotes = remoteShaSet();
    const out = gitSafe(`log --reverse --format='%H%x09%h%x09%s' ${tip(from)}..${tip(to)}`);
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

  // "Create as you go" in git: the new VPR's branch is anchored at HEAD. Unlike
  // jj there is no auto-snapshotted working copy and no empty-commit dance —
  // if HEAD already carries another VPR branch, the new branch simply starts
  // empty and advances when the developer commits work and moves it. Two
  // branches can share a commit; the partition walk attributes the commit to
  // the earlier-declared VPR, leaving the new one empty until it advances.
  addBookmark(name /* , existing */) {
    git(`branch --force ${name} HEAD`);
  },

  deleteBookmark(name) {
    return gitSafe(`branch -D ${name}`) !== null;
  },

  hasBookmark(name) {
    return gitSafe(`show-ref --verify --quiet refs/heads/${name} && echo yes`) === 'yes';
  },

  moveBookmark(name, rev) {
    // branch -f is create-or-move and allows moving backwards.
    git(`branch --force ${name} ${tip(rev)}`);
  },

  renameBookmark(from, to) {
    git(`branch -m ${from} ${to}`);
  },

  // Reordering a single commit with automatic descendant reparenting is jj's
  // model; git has no one-shot equivalent (§ migration report 2.4). In git mode
  // the developer reorders with `git rebase -i`.
  moveCommitAfter() {
    throw new Error('reorder commits with `git rebase -i` in git mode');
  },

  rebaseOnto(newBase, upstream) {
    git(`rebase --onto ${tip(newBase)} ${tip(upstream)}`);
  },

  parentOf(id) {
    return gitSafe(`rev-parse ${id}^`);
  },

  headId() {
    return gitSafe('rev-parse HEAD');
  },

  // The design's headline restack: collapse base..HEAD into one clean commit
  // while preserving the working tree (git reset --soft). The messy dev history
  // is dropped from git; its intent lives on in the vpr metadata/eventLog.
  recompose(base, message) {
    git(`reset --soft ${tip(base)}`);
    const staged = gitSafe('diff --cached --name-only');
    if (staged) git(`commit -m ${JSON.stringify(message)}`);
  },

  // Restacked slice branches diverge from what was previously pushed, so a
  // lease-guarded force keeps updates safe without clobbering others' work.
  // A never-pushed branch has no remote ref, so the lease is a no-op there.
  pushBookmark(name) {
    git(`push --force-with-lease origin ${name}`);
  },
};
