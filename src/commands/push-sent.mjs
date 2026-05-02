import { execSync } from 'node:child_process';
import { jjSafe } from '../core/jj.mjs';
import { loadMeta } from '../core/meta.mjs';

/**
 * Find every sent VPR bookmark whose local commit_id differs from its
 * @origin tracking ref. Returns the set of bookmarks that would be pushed
 * along with any that must be skipped (e.g. conflicted commits). Does not
 * push — caller decides whether to invoke pushSent() after confirming.
 *
 * @returns {Promise<{ toPush: string[], skipped: Array<{bookmark: string, reason: string}> }>}
 */
export async function previewPushSent() {
  const meta = await loadMeta();
  const sentNames = Object.keys(meta.sent ?? {});
  if (sentNames.length === 0) {
    return { toPush: [], skipped: [] };
  }

  const skipped = [];
  const toPush = [];

  for (const name of sentNames) {
    const out = jjSafe(
      `log -r 'bookmarks(exact:"${name}") | bookmarks(exact:"${name}@origin")' --no-graph -T 'commit_id.short() ++ "\\t" ++ bookmarks ++ "\\n"'`
    );
    if (!out) {
      skipped.push({ bookmark: name, reason: 'bookmark not found locally' });
      continue;
    }
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const conflictCheck = jjSafe(
      `log -r 'bookmarks(exact:"${name}")' --no-graph -T 'if(conflict, "yes", "no")'`
    );
    if (conflictCheck === 'yes') {
      skipped.push({ bookmark: name, reason: 'commit has conflicts — resolve first' });
      continue;
    }

    toPush.push(name);
  }

  return { toPush, skipped };
}

/**
 * Force-push the given bookmark list. Caller must have confirmed the set
 * with the user first via previewPushSent().
 *
 * @param {string[]} bookmarks
 * @returns {Promise<{ pushed: string[], skipped: Array<{bookmark: string, reason: string}> }>}
 */
export async function pushSent(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) {
    return { pushed: [], skipped: [] };
  }
  const args = bookmarks.map(b => `--bookmark ${b}`).join(' ');
  try {
    execSync(`jj git push ${args}`, { stdio: 'inherit' });
    return { pushed: [...bookmarks], skipped: [] };
  } catch (err) {
    return { pushed: [], skipped: bookmarks.map(b => ({ bookmark: b, reason: `push failed: ${err.message}` })) };
  }
}
