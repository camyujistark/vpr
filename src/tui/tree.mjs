/**
 * Build a flat array of display items from the unified VPR state.
 *
 * Ordering:
 *   - Items (grouped), each followed by their VPRs and commits
 *   - ungrouped-header + ungrouped commits (omitted when empty)
 *   - hold-header + held commits (omitted when empty)
 *
 * @param {object} state — result of buildState()
 * @returns {Array}
 */
export function buildTree(state) {
  const rows = [];

  // Items → active VPRs → Commits (held VPRs collected for bottom)
  const heldVprs = [];

  for (const item of state.items) {
    const activeVprs = item.vprs.filter(v => !v.held);
    const itemHeldVprs = item.vprs.filter(v => v.held);

    rows.push({
      type: 'item',
      name: item.name,
      wi: item.wi,
      wiTitle: item.wiTitle,
      vprCount: activeVprs.length,
      collapsed: false,
    });

    for (const vpr of activeVprs) {
      rows.push({
        type: 'vpr',
        bookmark: vpr.bookmark,
        title: vpr.title,
        story: vpr.story,
        output: vpr.output,
        sent: vpr.sent,
        held: false,
        conflict: vpr.conflict,
        commitCount: vpr.commits.length,
        itemName: item.name,
      });

      for (const commit of vpr.commits) {
        rows.push({
          type: 'commit',
          changeId: commit.changeId,
          sha: commit.sha,
          subject: commit.subject,
          conflict: commit.conflict,
          vprBookmark: vpr.bookmark,
          itemName: item.name,
        });
      }
    }

    for (const vpr of itemHeldVprs) {
      heldVprs.push({ vpr, itemName: item.name, wiTitle: item.wiTitle });
    }
  }

  // Ungrouped
  if (state.ungrouped.length > 0) {
    rows.push({ type: 'ungrouped-header', count: state.ungrouped.length });
    for (const commit of [...state.ungrouped].reverse()) {
      rows.push({
        type: 'ungrouped',
        changeId: commit.changeId,
        sha: commit.sha,
        subject: commit.subject,
      });
    }
  }

  // Held VPRs
  if (heldVprs.length > 0) {
    rows.push({ type: 'hold-header', count: heldVprs.length + state.hold.length });
    for (const { vpr, itemName } of heldVprs) {
      rows.push({
        type: 'vpr',
        bookmark: vpr.bookmark,
        title: vpr.title,
        story: vpr.story,
        output: vpr.output,
        sent: vpr.sent,
        held: true,
        conflict: vpr.conflict,
        commitCount: vpr.commits.length,
        itemName,
      });
    }

    // Held commits
    for (const commit of state.hold) {
      rows.push({
        type: 'hold',
        changeId: commit.changeId,
        sha: commit.sha,
        subject: commit.subject,
      });
    }
  } else if (state.hold.length > 0) {
    rows.push({ type: 'hold-header', count: state.hold.length });
    for (const commit of state.hold) {
      rows.push({
        type: 'hold',
        changeId: commit.changeId,
        sha: commit.sha,
        subject: commit.subject,
      });
    }
  }

  return rows;
}
