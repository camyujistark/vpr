import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  jjSafe,
  getBase as jjGetBase,
  getBaseBranch as jjGetBaseBranch,
  getConflicts as jjGetConflicts,
  getDiff as jjGetDiff,
  getFiles as jjGetFiles,
  getVprFiles as jjGetVprFiles,
} from './jj.mjs';
import { gitBackend } from './git.mjs';

/**
 * A raw commit row, oldest-first, as produced by a backend's chain query.
 * The `changeId` is a stable-across-rewrite identity where the backend has
 * one (jj change_id); backends without stable identity reuse the sha here.
 *
 * @typedef {Object} RawCommit
 * @property {string} changeId   stable id (jj) or sha (git)
 * @property {string} sha        short commit hash
 * @property {string[]} bookmarks local branch/bookmark names on this commit
 * @property {boolean} hasRemote  true if a remote-tracking ref sits here
 * @property {string} subject    first line of the description
 */

/**
 * The operations vpr needs from a version-control backend. This is the seam
 * that lets the git-based v2 backend coexist with the jj v1 backend behind a
 * config flag. Only the read-side is defined here; write/restack/push methods
 * are added by later migration slices.
 *
 * @typedef {Object} VcsBackend
 * @property {string} kind                          'jj' | 'git'
 * @property {() => string|null} getBase            base commit id (nearest pushed ancestor)
 * @property {() => string|null} getBaseBranch      base branch name (no remote suffix)
 * @property {() => Set<string>} getConflicts       set of conflicted change ids
 * @property {(base: string) => RawCommit[]} listChain  commits in base..heads, oldest-first
 * @property {() => string|null} getRemoteTop       top pushed ancestor of the working copy
 * @property {(from: string, to: string) => Set<string>} listChangeIds  change ids in from..to
 * @property {(id: string) => string} getDiff       git-format diff for one commit
 * @property {(id: string) => string[]} getFiles    file-summary lines for one commit
 * @property {(ids: string[]) => string[]} getVprFiles  merged file lines across commits
 */

/**
 * Parse a single tab-separated line from the jj log template into a RawCommit.
 * Template columns:
 *   change_id.short() \t commit_id.short() \t bookmarks \t description.first_line()
 * Returns null for malformed lines or undescribed commits (empty working-copy tips).
 *
 * @param {string} line
 * @returns {RawCommit | null}
 */
export function parseJjLine(line) {
  const parts = line.split('\t');
  if (parts.length < 4) return null;

  const [changeId, sha, bookmarksRaw, subject] = parts;
  if (!changeId || !sha) return null;
  if (!subject.trim()) return null;

  const allBookmarks = bookmarksRaw ? bookmarksRaw.split(' ').map(b => b.trim()).filter(Boolean) : [];
  const bookmarks = allBookmarks.filter(b => !b.includes('@'));
  const hasRemote = allBookmarks.some(b => b.includes('@'));

  return { changeId, sha, bookmarks, hasRemote, subject: subject.trim() };
}

/** The jj (v1) backend. Wraps the low-level helpers in ./jj.mjs. */
const jjBackend = {
  kind: 'jj',
  getBase: jjGetBase,
  getBaseBranch: jjGetBaseBranch,
  getConflicts: jjGetConflicts,
  getDiff: jjGetDiff,
  getFiles: jjGetFiles,
  getVprFiles: jjGetVprFiles,

  listChain(base) {
    const range = `${base}..(visible_heads() & descendants(${base}))`;
    const template =
      'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"';
    const output = jjSafe(`log -r '${range}' --reversed --no-graph --template '${template}'`);
    if (!output) return [];
    return output
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(parseJjLine)
      .filter(Boolean);
  },

  getRemoteTop() {
    return jjSafe(
      "log -r 'ancestors(@) & remote_bookmarks()' --no-graph --template 'commit_id.short()' -n 1"
    );
  },

  listChangeIds(from, to) {
    const output = jjSafe(
      `log -r '${from}..${to}' --no-graph --template 'change_id.short() ++ "\\n"'`
    );
    if (!output) return new Set();
    return new Set(output.split('\n').map(s => s.trim()).filter(Boolean));
  },
};

/**
 * Resolve which backend kind to use. Precedence:
 *   1. explicit `kind` argument
 *   2. VPR_VCS environment variable
 *   3. `.vpr/config.json` "vcs" field
 *   4. default 'jj'
 *
 * @param {string} [kind]
 * @returns {'jj'|'git'}
 */
export function resolveVcsKind(kind) {
  if (kind) return kind;
  if (process.env.VPR_VCS) return process.env.VPR_VCS;
  try {
    const path = join(process.cwd(), '.vpr', 'config.json');
    if (existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path, 'utf-8'));
      if (cfg.vcs) return cfg.vcs;
    }
  } catch {
    // fall through to default
  }
  return 'jj';
}

/**
 * Create a VCS backend. Defaults to jj (v1); the git (v2) backend is opt-in
 * via `.vpr/config.json` "vcs":"git", VPR_VCS=git, or an explicit kind. jj
 * remains the default until the reversible v1→v2 promotion.
 *
 * @param {{ kind?: 'jj'|'git' }} [opts]
 * @returns {VcsBackend}
 */
export function createVcs({ kind } = {}) {
  const resolved = resolveVcsKind(kind);
  switch (resolved) {
    case 'jj':
      return jjBackend;
    case 'git':
      return gitBackend;
    default:
      throw new Error(`Unknown vcs backend: ${resolved}`);
  }
}
