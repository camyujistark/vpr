import { getBase, getConflicts, jjSafe } from './jj.mjs';
import { loadMeta } from './meta.mjs';

/**
 * Parse a single line from the jj log template into a raw commit object.
 * Template columns (tab-separated):
 *   change_id.short() \t commit_id.short() \t bookmarks \t description.first_line()
 *
 * Returns null if the line is malformed or has no description (skip working-copy tips).
 *
 * @param {string} line
 * @returns {{ changeId: string, sha: string, bookmarks: string[], subject: string } | null}
 */
function parseLine(line) {
  const parts = line.split('\t');
  if (parts.length < 4) return null;

  const [changeId, sha, bookmarksRaw, subject] = parts;
  if (!changeId || !sha) return null;
  if (!subject.trim()) return null; // skip undescribed commits (empty working-copy tips)

  // bookmarksRaw may be empty string, space-separated, or contain remote suffixes like "name@remote"
  // We only want the local bookmark names (no @suffix) that match VPR bookmark keys.
  const bookmarks = bookmarksRaw
    ? bookmarksRaw.split(' ').map(b => b.trim()).filter(b => b && !b.includes('@'))
    : [];

  return { changeId, sha, bookmarks, subject: subject.trim() };
}

/**
 * Build a unified state object from the jj graph and meta.json.
 *
 * @returns {Promise<{
 *   items: Array,
 *   ungrouped: Array,
 *   hold: Array,
 *   conflicts: Set,
 *   sent: object,
 *   eventLog: Array
 * }>}
 */
export async function buildState() {
  // 1. Determine the base commit
  const base = getBase();

  // 2. Query all commits between base and visible heads (oldest first)
  let rawCommits = [];
  if (base) {
    const range = `${base}..(visible_heads() & descendants(${base}))`;
    const template = 'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"';
    const output = jjSafe(`log -r '${range}' --reversed --no-graph --template '${template}'`);
    if (output) {
      rawCommits = output
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(parseLine)
        .filter(Boolean);
    }
  }

  // 3. Get conflicts
  const conflicts = getConflicts();

  // 4. Load meta
  const meta = await loadMeta();
  const metaItems = meta.items ?? {};
  const holdIds = new Set(meta.hold ?? []);
  const sent = meta.sent ?? {};
  const eventLog = meta.eventLog ?? [];

  // 5. Build a lookup: bookmark name → { itemName, vprBookmark }
  //    so we can claim commits efficiently.
  /** @type {Map<string, { itemName: string, vprBookmark: string }>} */
  const bookmarkIndex = new Map();
  for (const [itemName, itemData] of Object.entries(metaItems)) {
    for (const vprBookmark of Object.keys(itemData.vprs ?? {})) {
      bookmarkIndex.set(vprBookmark, { itemName, vprBookmark });
    }
  }

  // 6. Partition commits into: claimed (by VPR bookmark), held, ungrouped
  //    vprCommits: Map<vprBookmark, rawCommit[]>
  /** @type {Map<string, Array>} */
  const vprCommits = new Map();
  for (const vprBookmark of bookmarkIndex.keys()) {
    vprCommits.set(vprBookmark, []);
  }

  const ungrouped = [];
  const holdCommits = [];

  for (const commit of rawCommits) {
    // Check hold first
    if (holdIds.has(commit.changeId)) {
      holdCommits.push(commit);
      continue;
    }

    // Check if any of this commit's bookmarks claim it for a VPR
    let claimed = false;
    for (const bm of commit.bookmarks) {
      if (vprCommits.has(bm)) {
        vprCommits.get(bm).push(commit);
        claimed = true;
        break; // a commit is claimed by the first matching VPR bookmark
      }
    }

    if (!claimed) {
      ungrouped.push(commit);
    }
  }

  // 7. Assemble items array
  const items = Object.entries(metaItems).map(([itemName, itemData]) => {
    const vprs = Object.entries(itemData.vprs ?? {}).map(([vprBookmark, vprMeta]) => {
      const commits = (vprCommits.get(vprBookmark) ?? []).map(c => ({
        changeId: c.changeId,
        sha: c.sha,
        subject: c.subject,
        conflict: conflicts.has(c.changeId),
      }));

      const hasConflict = commits.some(c => c.conflict);

      return {
        bookmark: vprBookmark,
        title: vprMeta.title ?? '',
        story: vprMeta.story ?? '',
        output: vprMeta.output ?? null,
        commits,
        sent: Object.prototype.hasOwnProperty.call(sent, vprBookmark),
        conflict: hasConflict,
      };
    });

    return {
      name: itemName,
      wi: itemData.wi,
      wiTitle: itemData.wiTitle ?? '',
      vprs,
    };
  });

  // 8. Assemble hold array
  const hold = holdCommits.map(c => ({
    changeId: c.changeId,
    sha: c.sha,
    subject: c.subject,
  }));

  // 9. Assemble ungrouped array
  const ungroupedOut = ungrouped.map(c => ({
    changeId: c.changeId,
    sha: c.sha,
    subject: c.subject,
  }));

  return {
    items,
    ungrouped: ungroupedOut,
    hold,
    conflicts,
    sent,
    eventLog,
  };
}
