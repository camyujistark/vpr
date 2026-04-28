import { getBase, getConflicts, jjSafe } from './jj.mjs';
import { loadMeta } from './meta.mjs';

/**
 * Pure decorator: enrich each item's VPRs with chain-state fields
 * (`blocked`, `blockedBy`, `nextUp`, `cascadeTarget`).
 *
 * Inputs are synthetic-friendly: an items array (each with `name` and
 * `vprs[]` carrying at minimum `bookmark`, `sent`, `held`), and an options
 * bag with `sent` (the meta.sent map) and `baseBranch` (default `main`).
 *
 * Returns a new array — does not mutate the input.
 *
 * @param {Array<{name: string, vprs: Array<{bookmark: string, sent?: boolean, held?: boolean}>}>} items
 * @param {{ sent?: object, baseBranch?: string }} [opts]
 * @returns {Array}
 */
export function computeChainState(items, { sent = {}, baseBranch = 'main' } = {}) {
  return items.map(item => {
    let nextUpAssigned = false;
    let prevUnsentBookmark = null;

    const itemCascadeTarget = latestSentBranchForItem(sent, item.name) ?? baseBranch;

    const vprs = item.vprs.map(vpr => {
      if (vpr.held) {
        return { ...vpr, blocked: false, blockedBy: null, nextUp: false, cascadeTarget: baseBranch };
      }
      if (vpr.sent) {
        return { ...vpr, blocked: false, blockedBy: null, nextUp: false, cascadeTarget: baseBranch };
      }

      const enriched = !nextUpAssigned
        ? { ...vpr, blocked: false, blockedBy: null, nextUp: true, cascadeTarget: itemCascadeTarget }
        : { ...vpr, blocked: true, blockedBy: prevUnsentBookmark, nextUp: false, cascadeTarget: itemCascadeTarget };

      nextUpAssigned = true;
      prevUnsentBookmark = vpr.bookmark;
      return enriched;
    });

    return { ...item, vprs };
  });
}

function latestSentBranchForItem(sent, itemName) {
  let latestBranch = null;
  let latestAt = null;
  for (const [branch, entry] of Object.entries(sent)) {
    if (entry?.itemName !== itemName) continue;
    const at = entry.sentAt ?? '';
    if (latestAt === null || at > latestAt) {
      latestAt = at;
      latestBranch = branch;
    }
  }
  return latestBranch;
}

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
  const allBookmarks = bookmarksRaw ? bookmarksRaw.split(' ').map(b => b.trim()).filter(Boolean) : [];
  const bookmarks = allBookmarks.filter(b => !b.includes('@'));
  const hasRemote = allBookmarks.some(b => b.includes('@'));

  return { changeId, sha, bookmarks, hasRemote, subject: subject.trim() };
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

  // 3. Find the top of the remote stack (highest remote bookmark ancestor of @)
  //    and build the set of commits after it — only these are ungrouped candidates.
  const remoteTop = jjSafe(
    "log -r 'ancestors(@) & remote_bookmarks()' --no-graph --template 'commit_id.short()' -n 1"
  );
  const ungroupedBase = remoteTop || base;
  const afterRemoteOutput = ungroupedBase ? jjSafe(
    `log -r '${ungroupedBase}..@' --no-graph --template 'change_id.short() ++ "\\n"'`
  ) : null;
  const afterRemote = new Set(
    afterRemoteOutput ? afterRemoteOutput.split('\n').map(s => s.trim()).filter(Boolean) : []
  );

  // 4. Get conflicts
  const conflicts = getConflicts();

  // 4. Load meta
  const meta = await loadMeta();
  const metaItems = meta.items ?? {};
  const holdIds = new Set(meta.hold ?? []);
  const sent = meta.sent ?? {};
  const eventLog = meta.eventLog ?? [];

  // 5. Build lookups: bookmark → item, and changeId → vprBookmark (from claims)
  /** @type {Map<string, { itemName: string, vprBookmark: string }>} */
  const bookmarkIndex = new Map();
  /** @type {Map<string, string>} changeId → vprBookmark */
  const claimsIndex = new Map();
  for (const [itemName, itemData] of Object.entries(metaItems)) {
    for (const [vprBookmark, vprMeta] of Object.entries(itemData.vprs ?? {})) {
      bookmarkIndex.set(vprBookmark, { itemName, vprBookmark });
      for (const changeId of (vprMeta.claims ?? [])) {
        claimsIndex.set(changeId, vprBookmark);
      }
    }
  }

  // 6. Partition commits into: claimed (by VPR bookmark), held, ungrouped
  //    Commits are oldest-first. A VPR bookmark on commit N claims all unclaimed
  //    commits between the previous bookmark and N (inclusive).
  /** @type {Map<string, Array>} */
  const vprCommits = new Map();
  for (const vprBookmark of bookmarkIndex.keys()) {
    vprCommits.set(vprBookmark, []);
  }

  const ungrouped = [];
  const holdCommits = [];
  // Pending commits waiting for the next VPR bookmark to claim them.
  // In a linear chain, all commits between two consecutive bookmarks belong
  // to the later bookmark's VPR.
  let pending = [];

  for (const commit of rawCommits) {
    // Check hold first
    if (holdIds.has(commit.changeId)) {
      holdCommits.push(commit);
      continue;
    }

    // Check explicit claims first (user-assigned), then bookmark matches
    let claimedBookmark = null;
    if (claimsIndex.has(commit.changeId)) {
      claimedBookmark = claimsIndex.get(commit.changeId);
    }
    if (!claimedBookmark) {
      for (const bm of commit.bookmarks) {
        if (bookmarkIndex.has(bm)) {
          claimedBookmark = bm;
          break;
        }
      }
    }

    if (claimedBookmark) {
      // This commit has a VPR bookmark — claim it plus all pending commits.
      // Previously this gated on `afterRemote.has(p.changeId)` to skip
      // already-pushed history, but that filter dropped legitimate commits
      // when the bookmark sits on a branch that diverged from @'s ancestry
      // (e.g. after a `jj squash` rebases descendants onto a sibling line).
      // The `${base}..(...)` query already excludes pushed-trunk history,
      // so commits surviving to here belong somewhere in the local stack.
      for (const p of pending) {
        vprCommits.get(claimedBookmark).push(p);
      }
      pending = [];
      vprCommits.get(claimedBookmark).push(commit);
    } else {
      // No bookmark — accumulate as pending for the next bookmark to claim
      pending.push(commit);
    }
  }

  // Any remaining pending commits after the last bookmark are ungrouped
  // (only those after the remote tip — the "new local work" zone)
  for (const commit of pending) {
    if (afterRemote.has(commit.changeId)) {
      ungrouped.push(commit);
    }
  }

  // 7. Assemble items array (chain-state enriched below)
  const baseItems = Object.entries(metaItems).map(([itemName, itemData]) => {
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
        held: Boolean(vprMeta.held),
        conflict: hasConflict,
      };
    });

    return {
      name: itemName,
      wi: itemData.wi,
      wiTitle: itemData.wiTitle ?? '',
      held: Boolean(itemData.held),
      vprs,
    };
  });

  // Sort items by chain position so the TUI shows them in send order:
  // items whose earliest commit is closest to base come first. Items with no
  // commits (placeholder items) sort by meta-declaration order at the tail.
  // `rawCommits` is already oldest-first, so we use that index.
  const chainIndexByChangeId = new Map();
  rawCommits.forEach((c, i) => chainIndexByChangeId.set(c.changeId, i));
  const itemEarliestIndex = new Map();
  for (const item of baseItems) {
    let earliest = Infinity;
    for (const v of item.vprs) {
      for (const c of v.commits) {
        const idx = chainIndexByChangeId.get(c.changeId);
        if (idx !== undefined && idx < earliest) earliest = idx;
      }
    }
    itemEarliestIndex.set(item.name, earliest);
  }
  const declOrder = new Map(baseItems.map((it, i) => [it.name, i]));
  const sortedBaseItems = [...baseItems].sort((a, b) => {
    const ai = itemEarliestIndex.get(a.name);
    const bi = itemEarliestIndex.get(b.name);
    if (ai !== bi) return ai - bi;
    return declOrder.get(a.name) - declOrder.get(b.name);
  });

  const items = computeChainState(sortedBaseItems, { sent });

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
