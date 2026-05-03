import { buildState } from '../core/state.mjs';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function bold(s) { return `${c.bold}${s}${c.reset}`; }
function dim(s) { return `${c.dim}${s}${c.reset}`; }
function red(s) { return `${c.red}${s}${c.reset}`; }
function green(s) { return `${c.green}${s}${c.reset}`; }
function yellow(s) { return `${c.yellow}${s}${c.reset}`; }
function cyan(s) { return `${c.cyan}${s}${c.reset}`; }
function gray(s) { return `${c.gray}${s}${c.reset}`; }

/**
 * Lifecycle group order for sorting items when dagView is provided.
 * Lower = higher priority (appears first).
 */
function lifecycleRank(dagView, itemName) {
  if (!dagView) return 0;
  const view = dagView.nodes?.get(itemName);
  if (!view) return 0;
  if (view.done) return 3;
  if (view.released && !view.done) return 1; // in-flight
  if (view.ready) return 0; // ready to work
  return 2; // blocked
}

/**
 * Format state as a human-readable string (no color-stripping needed for tests).
 * Exported for testability.
 *
 * @param {object} state - result of buildState()
 * @param {object|null} [dagView] - result of dag.analyze(), optional
 * @param {object} [opts]
 * @param {boolean} [opts.showAll] - include done items (default false)
 * @returns {string}
 */
export function formatStatus(state, dagView = null, opts = {}) {
  const { showAll = false } = opts;
  const lines = [];

  if (state.items.length === 0 && state.ungrouped.length === 0 && state.hold.length === 0) {
    lines.push(dim('No VPRs yet. Run `vpr add` to create one.'));
    return lines.join('\n');
  }

  const nonHeld = state.items.filter(i => !i.held);
  const heldItems = state.items.filter(i => i.held);

  // Hide done items unless showAll requested
  const visibleNonHeld = (dagView && !showAll)
    ? nonHeld.filter(i => !dagView.nodes?.get(i.name)?.done)
    : nonHeld;

  // Sort non-held items by lifecycle group when dagView available
  const activeItems = dagView
    ? [...visibleNonHeld].sort((a, b) => lifecycleRank(dagView, a.name) - lifecycleRank(dagView, b.name))
    : visibleNonHeld;

  for (const item of activeItems) {
    const wiLabel = item.wi ? gray(`wi#${item.wi}`) : '';
    const dagNode = dagView?.nodes?.get(item.name);
    const depthLabel = dagNode != null ? gray(` depth=${dagNode.depth}`) : '';
    const readyMarker = dagNode?.ready ? green(' ▶') : '';
    const openPrs = Object.values(state.sent ?? {})
      .filter(r => r.itemName === item.name && r.abandoned !== true && r.itemDone !== true).length;
    const inFlightLabel = openPrs > 0 ? cyan(` (${openPrs} open)`) : '';
    lines.push(`${bold(cyan(item.name))}${readyMarker}  ${wiLabel}${depthLabel}${inFlightLabel}  ${dim(item.wiTitle)}`);

    if (dagNode?.blockers?.length > 0) {
      lines.push(`  ${red('blocked by:')} ${dagNode.blockers.join(', ')}`);
    }

    if (item.vprs.length === 0) {
      lines.push(`  ${dim('(no VPRs)')}`);
    }

    for (const vpr of item.vprs) {
      let indicator;
      if (vpr.conflict) {
        indicator = red('!');
      } else if (vpr.sent) {
        indicator = green('✓');
      } else {
        indicator = yellow('·');
      }

      const count = vpr.commits.length;
      const statusStr = count === 0
        ? 'planned, no work yet'
        : count === 1 ? '1 commit' : `${count} commits`;
      const conflictNote = vpr.conflict ? red(' conflict') : '';
      const sentNote = vpr.sent ? green(' sent') : '';

      lines.push(`  ${indicator}  ${bold(vpr.bookmark)}  ${dim(`"${vpr.title}"`)}  ${gray(`(${statusStr}${conflictNote || sentNote})`)}`);
    }

    lines.push('');
  }

  if (state.ungrouped.length > 0) {
    lines.push(bold(yellow('ungrouped')));
    for (const commit of [...state.ungrouped].reverse()) {
      lines.push(`  ${gray(commit.changeId)}  ${commit.subject}`);
    }
    lines.push('');
  }

  if (state.hold.length > 0) {
    lines.push(bold(gray('on hold')));
    for (const commit of state.hold) {
      lines.push(`  ${gray(commit.changeId)}  ${dim(commit.subject)}`);
    }
    lines.push('');
  }

  if (heldItems.length > 0) {
    lines.push(bold(gray('held tickets')));
    for (const item of heldItems) {
      const wiLabel = item.wi ? gray(`wi#${item.wi}`) : '';
      const vprCount = item.vprs.length;
      const note = vprCount > 0 ? gray(` (${vprCount} VPR${vprCount === 1 ? '' : 's'})`) : '';
      lines.push(`  ${gray(item.name)}  ${wiLabel}  ${dim(item.wiTitle)}${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Print human-readable colored VPR status to console.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.showAll] - include done items
 * @returns {Promise<void>}
 */
export async function status(opts = {}) {
  const state = await buildState();
  console.log(formatStatus(state, null, opts));
}
