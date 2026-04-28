/**
 * TUI split-pane renderer.
 *
 * Draws: header, left tree pane, right diff/files pane, footer with help.
 */

// ─── ANSI codes ──────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const MAGENTA = `${ESC}35m`;
const RESET = `${ESC}0m`;
const INVERT = `${ESC}7m`;

export { CLEAR, HIDE_CURSOR, SHOW_CURSOR };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes for width calculation. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pad or truncate a string to exactly `width` visible characters. */
function fitWidth(str, width) {
  const visible = stripAnsi(str);
  if (visible.length > width) {
    // Truncate — need to walk the original string tracking visible chars
    let out = '';
    let vis = 0;
    let inEsc = false;
    for (const ch of str) {
      if (ch === '\x1b') inEsc = true;
      if (inEsc) {
        out += ch;
        if (ch.match(/[a-zA-Z]/) && ch !== '\x1b' && ch !== '[') inEsc = false;
        continue;
      }
      if (vis >= width - 1) {
        out += '…';
        break;
      }
      out += ch;
      vis++;
    }
    return out;
  }
  return str + ' '.repeat(Math.max(0, width - visible.length));
}

// ─── Left pane row rendering ─────────────────────────────────────────────────

function renderItem(item) {
  const label = item.wi ? `${item.wiTitle} (#${item.wi})` : item.name;
  if (item.held) {
    const vprNote = item.vprCount > 0 ? `${DIM} (${item.vprCount} VPR${item.vprCount === 1 ? '' : 's'})${RESET}` : '';
    return `  ${YELLOW}⏸${RESET} ${DIM}${label}${RESET}${vprNote}`;
  }
  return `${CYAN}${BOLD}▼ ${label}${RESET}`;
}

/**
 * Pure: pick the status icon for a VPR row.
 *
 * Precedence (highest first): held, sent, conflict, nextUp, blocked, default.
 *
 * @param {{ held?: boolean, sent?: boolean, conflict?: boolean, nextUp?: boolean, blocked?: boolean }} vpr
 * @returns {string} icon string with ANSI color codes
 */
export function vprIcon(vpr) {
  if (vpr.held) return `${YELLOW}⏸${RESET}`;
  if (vpr.sent) return `${GREEN}✓${RESET}`;
  if (vpr.conflict) return `${RED}!${RESET}`;
  if (vpr.nextUp) return `▶`;
  if (vpr.blocked) return `${DIM}◦${RESET}`;
  return `${DIM}·${RESET}`;
}

/**
 * Pure: pick the right-aligned target label for a VPR row.
 *
 * Blocked VPRs label what they wait on; sent VPRs label their PR; held VPRs
 * call out the detached state. Other VPRs have no label.
 *
 * @param {{ held?: boolean, sent?: boolean, blocked?: boolean, blockedBy?: string|null, prId?: number|null }} vpr
 * @returns {string} label string with ANSI color codes (empty when no label applies)
 */
export function vprTargetLabel(vpr) {
  if (vpr.held) return `${YELLOW}[held — detached]${RESET}`;
  if (vpr.blocked && vpr.blockedBy) return `${DIM}→ ${vpr.blockedBy}${RESET}`;
  if (vpr.sent && vpr.prId) return `${GREEN}→ PR #${vpr.prId}${RESET}`;
  return '';
}

function renderVpr(vpr) {
  const icon = vprIcon(vpr);
  const count = vpr.commitCount > 0 ? `${DIM} (${vpr.commitCount})${RESET}` : '';
  const label = vpr.held ? `${DIM}${vpr.title || vpr.bookmark}${RESET}` : (vpr.title || vpr.bookmark);
  return `  ${icon} ${label}${count}`;
}

function renderCommit(commit, picked) {
  const isPicked = picked && commit.changeId?.startsWith(picked.slice(0, 12));
  const prefix = isPicked ? `${MAGENTA}● ` : '      ';
  if (commit.conflict) {
    return `${prefix}${RED}! ${commit.changeId.slice(0, 8)} ${commit.subject}${RESET}`;
  }
  if (isPicked) {
    return `${prefix}${MAGENTA}${commit.changeId.slice(0, 8)} ${commit.subject}${RESET}`;
  }
  return `${prefix}${DIM}${commit.changeId.slice(0, 8)}${RESET} ${commit.subject}`;
}

function renderUngroupedHeader(item) {
  return `${YELLOW}  Ungrouped (${item.count})${RESET}`;
}

function renderUngrouped(item, picked) {
  const isPicked = picked && item.changeId?.startsWith(picked.slice(0, 12));
  if (isPicked) {
    return `  ${MAGENTA}● ${item.changeId.slice(0, 8)} ${item.subject}${RESET}`;
  }
  return `    ${DIM}${item.changeId.slice(0, 8)}${RESET} ${item.subject}`;
}

function renderHoldHeader(item) {
  return `${DIM}  ⏸ On Hold (${item.count})${RESET}`;
}

function renderHold(item) {
  return `${DIM}    ${item.changeId.slice(0, 8)} ${item.subject}${RESET}`;
}

/** Render a single tree row (without selection highlight). */
function renderRow(item, picked) {
  switch (item.type) {
    case 'item': return renderItem(item);
    case 'vpr': return renderVpr(item);
    case 'commit': return renderCommit(item, picked);
    case 'ungrouped-header': return renderUngroupedHeader(item);
    case 'ungrouped': return renderUngrouped(item, picked);
    case 'hold-header': return renderHoldHeader(item);
    case 'hold': return renderHold(item);
    default: return '';
  }
}

// ─── Right pane diff coloring ────────────────────────────────────────────────

function colorDiffLine(line) {
  if (line.startsWith('+')) return `${GREEN}${line}${RESET}`;
  if (line.startsWith('-')) return `${RED}${line}${RESET}`;
  if (line.startsWith('@@')) return `${CYAN}${line}${RESET}`;
  if (line.startsWith('diff') || line.startsWith('index')) return `${DIM}${line}${RESET}`;
  return line;
}

// ─── Help lines ──────────────────────────────────────────────────────────────

function helpLine(cursorItem, mode) {
  if (mode !== 'normal') return '';

  if (!cursorItem) return `${DIM}j/k nav  R refresh  X clear all  q quit${RESET}`;

  switch (cursorItem.type) {
    case 'item':
      return `${DIM}j/k nav  J/K scroll  v files  r rename  n new item  a add vpr  H hold  E edit all  O reorder  R refresh  X clear all  q quit${RESET}`;
    case 'vpr':
      return `${DIM}j/k nav  J/K scroll  v files  r rename  s story  g generate  H hold  P send  d dissolve  i interactive  R refresh  q quit${RESET}`;
    case 'commit':
      return `${DIM}j/k nav  J/K scroll  v files  r rename  space move  H hold  R refresh  q quit${RESET}`;
    case 'ungrouped-header':
    case 'ungrouped':
      return `${DIM}j/k nav  r rename  space move  H hold/unhold  R refresh  q quit${RESET}`;
    case 'hold-header':
    case 'hold':
      return `${DIM}j/k nav  H hold/unhold  R refresh  q quit${RESET}`;
    default:
      return `${DIM}j/k nav  R refresh  q quit${RESET}`;
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────

/**
 * Render the full TUI frame.
 *
 * @param {object} state        — buildState() result
 * @param {Array}  treeItems    — buildTree() result
 * @param {number} cursor       — selected row index
 * @param {number} scrollStart  — first visible tree row
 * @param {number} diffScroll   — right pane scroll offset
 * @param {string[]} rightContent — lines for the right pane
 * @param {string} mode         — current mode name
 * @param {string} message      — footer message (overrides help if non-empty)
 * @param {string|null} picked  — changeId of commit being moved
 */
export function render(state, treeItems, cursor, scrollStart, diffScroll, rightContent, mode, message, picked) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  // Layout: 1 header + 1 blank + body + 1 separator + 1 footer = body is rows-4
  const bodyRows = Math.max(1, rows - 4);
  const leftWidth = Math.min(Math.floor(cols * 0.45), 60);
  const rightWidth = cols - leftWidth - 3; // 3 for " │ "

  // ─── Header ──────────────────────────────────────────────────────────
  const itemCount = state.items.length;
  const vprCount = state.items.reduce((n, it) => n + it.vprs.length, 0);
  const commitCount = state.items.reduce(
    (n, it) => n + it.vprs.reduce((m, v) => m + v.commits.length, 0),
    0,
  );
  let header = `${BOLD}VPR${RESET}  ${itemCount} item${itemCount !== 1 ? 's' : ''}, ${vprCount} vpr${vprCount !== 1 ? 's' : ''}, ${commitCount} commit${commitCount !== 1 ? 's' : ''}`;
  if (picked) header += `  ${MAGENTA}[MOVING: ${picked.slice(0, 8)}]${RESET}`;

  // ─── Build left pane lines ───────────────────────────────────────────
  const leftLines = [];
  const visibleEnd = scrollStart + bodyRows;
  for (let i = scrollStart; i < Math.min(visibleEnd, treeItems.length); i++) {
    let line = renderRow(treeItems[i], picked);
    if (i === cursor) {
      line = `${INVERT}${stripAnsi(line)}${RESET}`;
      line = fitWidth(line, leftWidth);
    } else {
      line = fitWidth(line, leftWidth);
    }
    leftLines.push(line);
  }
  // Pad with empty lines if tree is shorter than body
  while (leftLines.length < bodyRows) {
    leftLines.push(' '.repeat(leftWidth));
  }

  // ─── Build right pane lines ──────────────────────────────────────────
  const rightLines = [];
  const rightSlice = (rightContent || []).slice(diffScroll, diffScroll + bodyRows);
  for (let i = 0; i < bodyRows; i++) {
    const raw = rightSlice[i] ?? '';
    rightLines.push(fitWidth(colorDiffLine(raw), rightWidth));
  }

  // ─── Compose output ─────────────────────────────────────────────────
  const buf = [CLEAR, header, ''];

  for (let i = 0; i < bodyRows; i++) {
    buf.push(`${leftLines[i]} ${DIM}│${RESET} ${rightLines[i]}`);
  }

  // Separator
  buf.push(`${DIM}${'─'.repeat(leftWidth)}┴${'─'.repeat(rightWidth + 2)}${RESET}`);

  // Footer
  const cursorItem = treeItems[cursor] ?? null;
  const footer = message || helpLine(cursorItem, mode);
  buf.push(footer);

  process.stdout.write(buf.join('\n'));
}
