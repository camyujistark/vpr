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
 * Print human-readable colored VPR status to console.
 *
 * Format:
 *   ITEM  wi#N  Title
 *     ✓  bookmark  "VPR Title"  (N commits)
 *     ·  bookmark  "VPR Title"  (N commits)
 *     !  bookmark  "VPR Title"  (N commits, conflict)
 *
 * Ungrouped and held commits are shown at the bottom.
 *
 * @returns {Promise<void>}
 */
export async function status() {
  const state = await buildState();

  if (state.items.length === 0 && state.ungrouped.length === 0 && state.hold.length === 0) {
    console.log(dim('No VPRs yet. Run `vpr add` to create one.'));
    return;
  }

  // Active items first; held items rendered at the bottom (after ungrouped/hold).
  const activeItems = state.items.filter(i => !i.held);
  const heldItems = state.items.filter(i => i.held);

  for (const item of activeItems) {
    const wiLabel = item.wi ? gray(`wi#${item.wi}`) : '';
    console.log(`${bold(cyan(item.name))}  ${wiLabel}  ${dim(item.wiTitle)}`);

    if (item.vprs.length === 0) {
      console.log(`  ${dim('(no VPRs)')}`);
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
      const countStr = count === 1 ? '1 commit' : `${count} commits`;
      const conflictNote = vpr.conflict ? red(' conflict') : '';
      const sentNote = vpr.sent ? green(' sent') : '';

      console.log(`  ${indicator}  ${bold(vpr.bookmark)}  ${dim(`"${vpr.title}"`)}  ${gray(`(${countStr}${conflictNote || sentNote})`)}`);
    }

    console.log();
  }

  // Ungrouped commits (newest first for easy access)
  if (state.ungrouped.length > 0) {
    console.log(bold(yellow('ungrouped')));
    for (const commit of [...state.ungrouped].reverse()) {
      console.log(`  ${gray(commit.changeId)}  ${commit.subject}`);
    }
    console.log();
  }

  // Held commits
  if (state.hold.length > 0) {
    console.log(bold(gray('on hold')));
    for (const commit of state.hold) {
      console.log(`  ${gray(commit.changeId)}  ${dim(commit.subject)}`);
    }
    console.log();
  }

  // Held items (parked tickets — at the bottom for visibility without focus)
  if (heldItems.length > 0) {
    console.log(bold(gray('held tickets')));
    for (const item of heldItems) {
      const wiLabel = item.wi ? gray(`wi#${item.wi}`) : '';
      const vprCount = item.vprs.length;
      const note = vprCount > 0 ? gray(` (${vprCount} VPR${vprCount === 1 ? '' : 's'})`) : '';
      console.log(`  ${gray(item.name)}  ${wiLabel}  ${dim(item.wiTitle)}${note}`);
    }
    console.log();
  }
}
