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

  // Items → active VPRs → Commits (held VPRs and held items collected for bottom)
  const heldVprs = [];
  const heldItems = state.items.filter(it => it.held);
  const activeItems = state.items.filter(it => !it.held);

  for (const item of activeItems) {
    const activeVprs = item.vprs.filter(v => !v.held);
    const itemHeldVprs = item.vprs.filter(v => v.held);

    rows.push({
      type: 'item',
      name: item.name,
      wi: item.wi,
      wiTitle: item.wiTitle,
      vprCount: activeVprs.length,
      collapsed: false,
      held: false,
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

  // Held items + held VPRs + held commits, all under one hold-header
  const totalHeld = heldItems.length + heldVprs.length + state.hold.length;
  if (totalHeld > 0) {
    rows.push({ type: 'hold-header', count: totalHeld });

    for (const item of heldItems) {
      rows.push({
        type: 'item',
        name: item.name,
        wi: item.wi,
        wiTitle: item.wiTitle,
        vprCount: item.vprs.length,
        collapsed: true,
        held: true,
      });
    }

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
