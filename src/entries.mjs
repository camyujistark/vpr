/**
 * Shared entry loading and grouping — used by both CLI and TUI.
 */

import { jjSafe } from './git.mjs';
import { loadMeta } from './config.mjs';

const CC_RE = /^(feat|fix|chore|docs|test|refactor|ci|style|perf)(?:\(([^)]+)\))?:\s*(.*)$/;

/**
 * Load jj log entries between base and @.
 * Returns oldest-first (--reversed). Skips empty working copy with no description.
 *
 * Options:
 *   files: true  — include file summary per commit (slower, used by CLI status)
 */
export function loadEntries(base, { files = false } = {}) {
  const fileFlag = files ? ' -s' : '';
  // Include @ and its children so ungrouped commits (rebased after last bookmark) are visible
  const raw = jjSafe(
    `log --no-graph --reversed -r '${base}..(@ | children(@))'${fileFlag}` +
    ` -T 'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"'`
  );
  if (!raw) return [];

  const meta = loadMeta();
  const entries = [];
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.includes('\t')) {
      const [changeId, sha, bookmarkStr, subject] = line.split('\t');
      // Skip commits with no description — these are jj's auto-created mutable
      // working copy tip. Described commits (even empty ones) are kept.
      if (!subject?.trim()) continue;

      const allBookmarks = bookmarkStr?.trim().split(/\s+/).filter(Boolean) || [];
      const bookmark = allBookmarks.find(b => meta.bookmarks?.[b]) || null;
      const ccMatch = subject?.match(CC_RE);

      current = {
        changeId: changeId?.trim(),
        sha: sha?.trim(),
        subject: subject?.trim(),
        bookmark,
        ccType: ccMatch ? ccMatch[1] : null,
        ccScope: ccMatch ? ccMatch[2] || null : null,
        ccDesc: ccMatch ? ccMatch[3] : subject?.trim(),
        files: [],
      };
      entries.push(current);
    } else if (files && current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  return entries;
}

/**
 * Group entries by bookmark. Bookmark is at the TIP of a group.
 * Accumulates pending commits; when a bookmark is hit, it caps that group.
 * Returns sorted by TP index (ascending), ungrouped at the end.
 */
export function groupEntries(entries, meta) {
  const groups = [];
  let pending = [];

  for (const entry of entries) {
    if (entry.bookmark) {
      groups.push({ bookmark: entry.bookmark, commits: [...pending, entry] });
      pending = [];
    } else {
      pending.push(entry);
    }
  }
  if (pending.length > 0) {
    groups.push({ bookmark: null, commits: pending });
  }

  groups.sort((a, b) => {
    if (!a.bookmark) return 1;
    if (!b.bookmark) return -1;
    const aMeta = meta.bookmarks?.[a.bookmark] || {};
    const bMeta = meta.bookmarks?.[b.bookmark] || {};
    const aNum = parseInt(aMeta.tpIndex?.replace(/\D/g, '')) || parseInt(a.bookmark.replace(/\D/g, '')) || 0;
    const bNum = parseInt(bMeta.tpIndex?.replace(/\D/g, '')) || parseInt(b.bookmark.replace(/\D/g, '')) || 0;
    return aNum - bNum;
  });

  return groups;
}

/**
 * Find a bookmark by exact name, TP index, or partial match.
 */
export function findBookmark(meta, query) {
  if (!query) return null;
  if (meta.bookmarks?.[query]) return query;
  const lower = query.toLowerCase();
  for (const [bm, m] of Object.entries(meta.bookmarks || {})) {
    if (m.tpIndex?.toLowerCase() === lower) return bm;
    if (bm.toLowerCase() === lower) return bm;
  }
  for (const [bm] of Object.entries(meta.bookmarks || {})) {
    if (bm.includes(query)) return bm;
  }
  return null;
}

/**
 * Resolve a jj change ID or ref to its bookmark name (if it has one).
 */
export function resolveToBookmark(changeId) {
  if (!changeId || changeId.includes('/') || changeId.includes('@')) return changeId;
  try {
    const bm = jjSafe(`log --no-graph -r '${changeId}' -T 'bookmarks'`)?.trim().split(/\s+/)[0];
    if (bm) return bm;
  } catch {}
  return changeId;
}
