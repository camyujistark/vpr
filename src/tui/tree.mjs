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

  // Items → VPRs → Commits
  for (const item of state.items) {
    rows.push({
      type: 'item',
      name: item.name,
      wi: item.wi,
      wiTitle: item.wiTitle,
      vprCount: item.vprs.length,
      collapsed: false,
    });

    for (const vpr of item.vprs) {
      rows.push({
        type: 'vpr',
        bookmark: vpr.bookmark,
        title: vpr.title,
        story: vpr.story,
        output: vpr.output,
        sent: vpr.sent,
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
  }

  // Ungrouped
  if (state.ungrouped.length > 0) {
    rows.push({ type: 'ungrouped-header', count: state.ungrouped.length });
    for (const commit of state.ungrouped) {
      rows.push({
        type: 'ungrouped',
        changeId: commit.changeId,
        sha: commit.sha,
        subject: commit.subject,
      });
    }
  }

  // Hold
  if (state.hold.length > 0) {
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
