/**
 * VPR TUI — Thin metadata layer over jj's native bookmark stacking.
 *
 * jj handles: commit manipulation, reordering, splitting, squashing, bookmarks
 * VPR handles: work item tracking, PR titles/descriptions, provider integration
 *
 * Keys:
 *   j/k    Navigate           J/K    Scroll diff
 *   c      Create ticket + bookmark at current commit
 *   w      Edit ticket (title → desc → sync to provider)
 *   p      Edit PR draft (title → body)
 *   x      Remove bookmark + metadata
 *   R      Refresh
 *   :      Run jj command directly
 *   q      Quit
 */

import { execSync } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jj, jjSafe, hasJj, git, gitSafe, getBase } from './git.mjs';
import { loadConfig, loadMeta, saveMeta, appendRebaseLog } from './config.mjs';
import { createProvider } from './providers/index.mjs';
import { loadEntries as sharedLoadEntries } from './entries.mjs';

// ── ANSI ───────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const SYNC_START = `${ESC}?2026h`;
const SYNC_END = `${ESC}?2026l`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const MAGENTA = `${ESC}35m`;
const RESET = `${ESC}0m`;
const INVERT = `${ESC}7m`;

// ── State ──────────────────────────────────────────────────────────────
let provider = null;
let vprMeta = {};
let entries = [];     // [{ changeId, sha, subject, bookmark, ccType, ccScope, ccDesc }]
let cursor = 0;
let picked = null;  // changeId of picked commit (normal mode move)
let message = '';
let diffScroll = 0;
let lastRightPaneKey = '';
let bodyH = 20;
let fieldIdx = 0; // which field is highlighted in the group summary
const FIELD_NAMES = ['wiTitle', 'wiDescription', 'prTitle', 'prDesc'];
const FIELD_LABELS = ['Ticket Title', 'Ticket Description', 'PR Title', 'PR Story'];

// ── Interactive mode state ────────────────────────────────────────────
let interactiveGroup = null;  // bookmark name of the group being edited
let selected = new Set();      // changeIds selected in interactive mode
let reorderPicked = null;      // changeId being reordered in interactive mode
let rightPaneView = 'diff';    // 'diff' or 'files' — toggle with f

// ── File split mode state ─────────────────────────────────────────────
let splitFiles = [];           // [{ status, path }] files in the commit being split
let splitSelected = new Set(); // indices of selected files
let splitChangeId = null;      // changeId being split
let splitCursor = 0;           // cursor in file_split mode

// Caches
const diffCache = new Map();
const filesCache = new Map();

function getCachedDiff(sha) {
  if (!diffCache.has(sha)) {
    try { diffCache.set(sha, jj(`diff --git -r ${sha}`)); } catch { diffCache.set(sha, ''); }
  }
  return diffCache.get(sha);
}

function getCachedFiles(sha) {
  if (!filesCache.has(sha)) {
    try {
      filesCache.set(sha, jj(`diff --summary -r ${sha}`).split('\n').filter(Boolean));
    } catch { filesCache.set(sha, []); }
  }
  return filesCache.get(sha);
}

// ── Load jj log as flat list (delegates to shared entries.mjs) ─────────
function loadEntries(base) {
  return sharedLoadEntries(base);
}

// ── Build grouped view ─────────────────────────────────────────────────
function buildItems() {
  // jj stacked model: bookmark is at the TIP of a group.
  // Scan oldest→newest: accumulate commits, when we hit a bookmark it caps that group.
  // Entries are loaded oldest-first (--reversed).
  const groups = [];
  let pending = []; // commits waiting for a bookmark to claim them

  for (const entry of entries) {
    if (entry.bookmark) {
      // This bookmark claims all pending commits + itself
      groups.push({
        bookmark: entry.bookmark,
        commits: [...pending, entry], // pending commits + the bookmark commit
      });
      pending = [];
    } else {
      pending.push(entry);
    }
  }

  // Any remaining commits after the last bookmark are ungrouped
  if (pending.length > 0) {
    groups.push({ bookmark: null, commits: pending });
  }

  // Add empty groups from active bookmarks (not done) that have no jj bookmark
  const activeBookmarks = new Set(groups.filter(g => g.bookmark).map(g => g.bookmark));
  const doneBookmarks = new Set(Object.keys(vprMeta.done || {}));
  for (const [bm, meta] of Object.entries(vprMeta.bookmarks || {})) {
    if (!activeBookmarks.has(bm) && !doneBookmarks.has(bm)) {
      groups.push({ bookmark: bm, commits: [] });
    }
  }

  // Sort groups by TP index (ascending), ungrouped at the end
  groups.sort((a, b) => {
    if (!a.bookmark) return 1;
    if (!b.bookmark) return -1;
    // Sort by TP index if available, otherwise by WI ID from bookmark name
    const aMeta = vprMeta.bookmarks?.[a.bookmark] || {};
    const bMeta = vprMeta.bookmarks?.[b.bookmark] || {};
    const aNum = parseInt(aMeta.tpIndex?.replace(/\D/g, '')) || parseInt(a.bookmark.replace(/\D/g, '')) || 0;
    const bNum = parseInt(bMeta.tpIndex?.replace(/\D/g, '')) || parseInt(b.bookmark.replace(/\D/g, '')) || 0;
    return aNum - bNum;
  });

  // Build flat display list — separate held commits into their own section
  const holdSet = new Set(vprMeta.hold || []);
  const items = [];
  const heldItems = [];

  for (const group of groups) {
    const meta = group.bookmark ? (vprMeta.bookmarks?.[group.bookmark] || {}) : {};
    const title = meta.wiTitle || meta.prTitle || group.commits[0]?.ccDesc || group.bookmark || 'ungrouped';

    // Split commits into active and held
    const activeCommits = group.commits.filter(c => !holdSet.has(c.changeId));
    const heldCommits = group.commits.filter(c => holdSet.has(c.changeId));

    if (group.bookmark) {
      items.push({
        type: 'group',
        bookmark: group.bookmark,
        title,
        meta,
        commitCount: activeCommits.length,
        entry: activeCommits[activeCommits.length - 1] || group.commits[group.commits.length - 1],
      });
    } else {
      items.push({ type: 'ungrouped-header', title: 'Ungrouped', commitCount: activeCommits.length });
    }

    for (const commit of activeCommits) {
      items.push({
        ...commit,
        type: group.bookmark ? 'commit' : 'ungrouped',
        group: group.bookmark,
      });
    }

    for (const commit of heldCommits) {
      heldItems.push({ ...commit, type: 'hold', group: group.bookmark });
    }
  }

  // Always show ungrouped section if not already present
  const hasUngroupedHeader = items.some(i => i.type === 'ungrouped-header');
  if (!hasUngroupedHeader) {
    items.push({ type: 'ungrouped-header', title: 'Ungrouped', commitCount: 0 });
  }

  // Hold section at the bottom
  if (heldItems.length > 0) {
    items.push({ type: 'hold-header', title: 'On Hold', commitCount: heldItems.length });
    items.push(...heldItems);
  }

  return items;
}

// ── Interactive mode items ─────────────────────────────────────────────
function getInteractiveItems(allItems) {
  // Only commits belonging to the interactive group + separator + ungrouped
  const result = [];
  for (const item of allItems) {
    if (item.type === 'commit' && item.group === interactiveGroup) {
      result.push(item);
    }
  }
  // Always show separator + ungrouped section
  const ungrouped = allItems.filter(i => i.type === 'ungrouped');
  result.push({ type: 'interactive-separator' });
  if (ungrouped.length > 0) {
    result.push(...ungrouped);
  } else {
    result.push({ type: 'interactive-empty', subject: '(no ungrouped commits)' });
  }
  return result;
}

// ── Right pane: group summary with selectable fields ─────────────────
function getGroupSummary(item, rightW, targetBranch) {
  const meta = item.meta || {};
  const lines = [];
  const WHITE = `${ESC}37m`;
  const fieldW = Math.max(20, (rightW || 50) - 6);

  function wordWrap(text, width) {
    const result = [];
    for (const line of text.split('\n')) {
      if (line.length <= width) { result.push(line); continue; }
      let remaining = line;
      while (remaining.length > width) {
        let breakAt = remaining.lastIndexOf(' ', width);
        if (breakAt <= 0) breakAt = width;
        result.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) result.push(remaining);
    }
    return result;
  }

  function addField(idx, label, value) {
    const val = value || '(empty)';
    const wrapW = Math.max(20, fieldW - 2);
    const wrapped = wordWrap(val, wrapW);
    const selected = fieldIdx === idx;
    const borderColor = selected ? GREEN : `${ESC}90m`; // green or dark gray
    const labelColor = selected ? `${GREEN}${BOLD}` : `${ESC}90m`;

    // Header: ── Label ──────
    lines.push(`│  ${borderColor}──${RESET} ${labelColor}${label}${RESET} ${borderColor}${'─'.repeat(Math.max(0, 30 - label.length))}${RESET}`);
    // Content: always readable white
    for (const l of wrapped) lines.push(`│    ${l}`);
    lines.push('│');
  }

  const tpLabel = meta.tpIndex ? `${BOLD}${meta.tpIndex}${RESET}  ` : '';
  const wiTag = meta.wi ? `${DIM}#${meta.wi}${RESET}` : '';
  lines.push(`╭─ ${tpLabel}${wiTag}  ${DIM}${item.bookmark} → ${targetBranch || 'main'}${RESET}`);
  lines.push(`│  ${meta.wiTitle || '(no ticket title)'}${meta.wiDescription ? `  ${DIM}— ${meta.wiDescription}${RESET}` : ''}`);
  lines.push('│');

  // PR Title + Story together
  addField(FIELD_NAMES.indexOf('prTitle'), 'PR Title', meta.prTitle || meta.wiTitle);
  addField(FIELD_NAMES.indexOf('prDesc'), 'PR Story', meta.prDesc);

  // PR Description (generated) — always shown even if empty
  lines.push(`│  ${DIM}── PR Description (Shift+S to generate) ──${RESET}`);
  if (meta.prBody) {
    const wrapW = Math.max(20, fieldW - 2);
    for (const l of wordWrap(meta.prBody, wrapW)) lines.push(`│    ${l}`);
  } else {
    lines.push(`│    ${DIM}(empty — press Shift+S to generate from story)${RESET}`);
  }
  lines.push('│');

  lines.push(`│  ${DIM}${item.commitCount} commits${RESET}`);
  lines.push('╰─');
  lines.push('');
  lines.push(`${DIM}t edit title  s edit story  S generate description${RESET}`);

  return lines;
}

// ── Fast right-pane-only redraw for edit mode ──────────────────────────
function renderEditOnly() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const leftW = Math.max(35, Math.floor(cols * 0.4));
  const rightW = cols - leftW - 1;
  const headerLines = 3;
  const footerLines = 3;
  const bH = rows - headerLines - footerLines;

  const edit = getEditLines(rightW);
  let out = SYNC_START + HIDE_CURSOR;

  for (let row = 0; row < bH; row++) {
    const rRow = diffScroll + row;
    let rightCell = '';
    if (rRow < edit.lines.length) {
      rightCell = edit.lines[rRow].slice(0, rightW - 1);
    }
    // Move to right pane column and overwrite
    out += `${ESC}${headerLines + 1 + row};${leftW + 2}H${ESC}0K${rightCell}`;
  }

  // Cursor
  if (edit.cursorRow >= 0) {
    const screenRow = headerLines + 1 + edit.cursorRow - diffScroll;
    const screenCol = leftW + 2 + edit.cursorCol;
    if (screenRow > headerLines && screenRow <= headerLines + bH) {
      out += `${ESC}${screenRow};${screenCol}H${SHOW_CURSOR}`;
    }
  }

  out += SYNC_END;
  process.stdout.write(out);
}

// ── Render ──────────────────────────────────────────────────────────────
function render() {
  const items = buildItems();
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const leftW = Math.max(35, Math.floor(cols * 0.4));
  const rightW = cols - leftW - 1;
  const headerLines = 3;
  const footerLines = 3;
  bodyH = rows - headerLines - footerLines;

  let out = SYNC_START + CLEAR + HIDE_CURSOR;

  // Header
  const viewLabel = rightPaneView === 'files' ? 'v diff' : 'v files';
  if (mode === 'file_split') {
    const shortId = splitChangeId?.slice(0, 8) || '?';
    out += `${BOLD}VPR${RESET}  ${YELLOW}[SPLIT: ${shortId}]${RESET}  ${DIM}${splitFiles.length} files, ${splitSelected.size} selected${RESET}\n`;
    out += `${DIM}j/k nav  Space select  y/Enter split  Esc back${RESET}\n`;
  } else if (mode === 'interactive') {
    const iMeta = vprMeta.bookmarks?.[interactiveGroup] || {};
    const iLabel = iMeta.tpIndex || interactiveGroup || '?';
    const iTitle = iMeta.wiTitle || '';
    const iItems = getInteractiveItems(items);
    const iCurrent = iItems[cursor];
    out += `${BOLD}VPR${RESET}  ${CYAN}[INTERACTIVE: ${iLabel}${iTitle ? ` — ${iTitle}` : ''}]${RESET}  ${DIM}${selected.size} selected${RESET}\n`;
    if (iCurrent?.type === 'ungrouped') {
      out += `${DIM}j/k nav  m move-in  Esc back${RESET}\n`;
    } else if (iCurrent?.changeId) {
      out += selected.size > 0
        ? `${DIM}j/k nav  ${viewLabel}  Space select  s squash  d drop  r reword  o reorder  U ungroup  Esc back${RESET}\n`
        : `${DIM}j/k nav  ${viewLabel}  Space select  s split  r reword  o reorder  U ungroup  Esc back${RESET}\n`;
    } else {
      out += `${DIM}j/k nav  Esc back${RESET}\n`;
    }
  } else {
    const bookmarkCount = entries.filter(e => e.bookmark).length;
    out += `${BOLD}VPR${RESET}  ${DIM}${bookmarkCount} bookmarks, ${entries.length} commits${RESET}`;
    if (picked) out += `  ${MAGENTA}[MOVING: ${picked.slice(0, 8)}]${RESET}`;
    out += '\n';
    // Context-sensitive help
    const helpItem = items[cursor];
    if (helpItem?.type === 'group') {
      out += `${DIM}j/k nav  J/K scroll  ${viewLabel}  t title  s story  E edit all  S generate  O reorder  d dissolve  i interactive  n new  u undo  : jj  q quit${RESET}\n`;
    } else if (helpItem?.type === 'commit') {
      out += `${DIM}j/k nav  J/K scroll  ${viewLabel}  Space move  U ungroup  H hold  i interactive  c commit  n new  u undo  : jj  q quit${RESET}\n`;
    } else if (helpItem?.type === 'ungrouped') {
      out += `${DIM}j/k nav  ${viewLabel}  Space move  H hold  n new  u undo  q quit${RESET}\n`;
    } else if (helpItem?.type === 'hold') {
      out += `${DIM}j/k nav  H unhold  u undo  q quit${RESET}\n`;
    } else {
      out += `${DIM}j/k nav  n new  u undo  : jj  q quit${RESET}\n`;
    }
  }
  out += `${DIM}${'─'.repeat(leftW)}┬${'─'.repeat(rightW)}${RESET}\n`;

  // Scroll
  let scrollStart = 0;
  if (cursor >= scrollStart + bodyH) scrollStart = cursor - bodyH + 1;
  if (cursor < scrollStart) scrollStart = cursor;

  // Right pane content — only reset scroll when content source changes
  const currentItem = (mode === 'interactive') ? getInteractiveItems(items)[cursor]
    : (mode === 'file_split') ? null
    : items[cursor];
  const rightPaneKey = currentItem?.type === 'group' ? `group:${currentItem.bookmark}` : `commit:${currentItem?.changeId || ''}`;
  if (rightPaneKey !== lastRightPaneKey) {
    diffScroll = 0;
    if (!rightPaneKey.startsWith('group:')) fieldIdx = 0; // reset field selection when leaving a group
    lastRightPaneKey = rightPaneKey;
  }
  let rightLines = [];
  let editCursorScreenRow = -1;
  let editCursorScreenCol = -1;
  if (editMode) {
    const edit = getEditLines(rightW);
    rightLines = edit.lines;
    editCursorScreenRow = edit.cursorRow;
    editCursorScreenCol = edit.cursorCol;
  } else if (currentItem?.type === 'group') {
    // Find previous group in the chain for target branch
    const allGroups = items.filter(i => i.type === 'group');
    const groupIdx = allGroups.findIndex(g => g.bookmark === currentItem.bookmark);
    const prevGroup = groupIdx > 0 ? allGroups[groupIdx - 1] : null;
    const targetBranch = prevGroup?.bookmark || base;
    rightLines = getGroupSummary(currentItem, rightW, targetBranch);
  } else if (currentItem?.sha) {
    if (rightPaneView === 'files') {
      const fileList = getCachedFiles(currentItem.changeId || currentItem.sha);
      rightLines = [`${BOLD}Files changed${RESET}`, ''];
      for (const f of fileList) {
        const type = f.charAt(0);
        const color = type === 'A' ? GREEN : type === 'D' ? RED : DIM;
        rightLines.push(`${color}${f}${RESET}`);
      }
      if (fileList.length === 0) rightLines.push(`${DIM}(no files)${RESET}`);
      rightLines.push('', `${DIM}v toggle to diff view${RESET}`);
    } else {
      rightLines = getCachedDiff(currentItem.changeId || currentItem.sha).split('\n');
    }
  }

  // Body — build display items based on mode
  let displayItems = items;
  let displayCount = items.length;

  if (mode === 'file_split') {
    displayCount = splitFiles.length;
  } else if (mode === 'interactive') {
    // Show group commits + separator + ungrouped commits
    displayItems = getInteractiveItems(items);
    displayCount = displayItems.length;
  }

  for (let row = 0; row < bodyH; row++) {
    const idx = scrollStart + row;
    let leftCell = '';

    if (mode === 'file_split' && idx < splitFiles.length) {
      const file = splitFiles[idx];
      const sel = idx === cursor;
      const isSelected = splitSelected.has(idx);
      const marker = isSelected ? `${GREEN}✓ ` : '  ';
      const statusColor = file.status === 'A' ? GREEN : file.status === 'D' ? RED : DIM;
      const label = `${marker}${statusColor}${file.status}${RESET} ${file.path}`.slice(0, leftW - 2);
      leftCell = sel ? `${INVERT}${label}${RESET}` : label;
    } else if (mode === 'interactive' && idx < displayItems.length) {
      const item = displayItems[idx];
      const sel = idx === cursor;

      if (item.type === 'interactive-separator') {
        leftCell = `${DIM}${'─'.repeat(Math.min(12, leftW - 15))} ungrouped ${'─'.repeat(Math.max(0, leftW - 25))}${RESET}`;
      } else if (item.type === 'interactive-empty') {
        leftCell = sel ? `${INVERT}${DIM}  (empty)${RESET}` : `${DIM}  (empty)${RESET}`;
      } else {
        const isSelected = selected.has(item.changeId);
        const isReorderPicked = reorderPicked && item.changeId?.startsWith(reorderPicked.slice(0, 8));
        const marker = isReorderPicked ? `${YELLOW}◆ ` : isSelected ? `${GREEN}● ` : '  ';
        const typeTag = item.ccType ? `${DIM}[${item.ccType}]${RESET}` : '';
        const label = `${marker}${item.changeId?.slice(0, 8) || ''} ${typeTag} ${item.ccDesc || item.subject}`.slice(0, leftW - 2);
        leftCell = sel ? `${INVERT}${label}${RESET}` : isSelected ? `${GREEN}${label}${RESET}` : isReorderPicked ? `${YELLOW}${label}${RESET}` : label;
      }
    } else if (mode !== 'interactive' && mode !== 'file_split' && idx < items.length) {
      const item = items[idx];
      const sel = idx === cursor;

      if (item.type === 'group') {
        const tp = item.meta?.tpIndex || '';
        const wi = item.meta?.wi || '';
        const prefix = tp ? `${tp}` : item.bookmark;
        const wiTag = wi ? ` (${wi})` : '';
        const label = `${prefix}${wiTag}: ${item.title}`.slice(0, leftW - 6);
        leftCell = sel
          ? `${INVERT}${CYAN}${BOLD}${label}${RESET} ${DIM}(${item.commitCount})${RESET}`
          : `${CYAN}${BOLD}${label}${RESET} ${DIM}(${item.commitCount})${RESET}`;
      } else if (item.type === 'commit') {
        const isPicked = picked && item.changeId?.startsWith(picked.slice(0, 8));
        const prefix = isPicked ? `${MAGENTA}● ` : '  ';
        const typeTag = item.ccType ? `${DIM}[${item.ccType}]${RESET}` : '';
        const label = `${prefix}${item.changeId?.slice(0, 8) || ''} ${typeTag} ${item.ccDesc || item.subject}`.slice(0, leftW - 2);
        leftCell = sel ? `${INVERT}${label}${RESET}` : isPicked ? `${MAGENTA}${label}${RESET}` : label;
      } else if (item.type === 'ungrouped-header') {
        const label = `⚠ Ungrouped (${item.commitCount})`;
        leftCell = sel ? `${INVERT}${MAGENTA}${BOLD}${label}${RESET}` : `${MAGENTA}${BOLD}${label}${RESET}`;
      } else if (item.type === 'ungrouped') {
        const isPicked = picked && item.changeId?.startsWith(picked.slice(0, 8));
        const prefix = isPicked ? `${MAGENTA}${BOLD}● ` : '  ';
        const label = `${prefix}${item.changeId?.slice(0, 8) || ''} ${item.subject}`.slice(0, leftW - 2);
        leftCell = sel ? `${INVERT}${label}${RESET}` : isPicked ? `${MAGENTA}${BOLD}${label}${RESET}` : `${MAGENTA}${label}${RESET}`;
      } else if (item.type === 'hold-header') {
        const label = `⏸ On Hold (${item.commitCount})`;
        leftCell = sel ? `${INVERT}${DIM}${label}${RESET}` : `${DIM}${label}${RESET}`;
      } else if (item.type === 'hold') {
        const label = `  ${DIM}${item.changeId?.slice(0, 8) || ''} ${item.subject}${RESET}`.slice(0, leftW - 2);
        leftCell = sel ? `${INVERT}${label}${RESET}` : `${DIM}${label}${RESET}`;
      }
    }

    // Right pane
    let rightCell = '';
    const rRow = diffScroll + row;
    if (rRow < rightLines.length) {
      const line = rightLines[rRow].slice(0, rightW - 1);
      if (currentItem?.type === 'group') {
        if (line.startsWith('╭') || line.startsWith('╰')) rightCell = `${CYAN}${line}${RESET}`;
        else rightCell = `${DIM}${line}${RESET}`;
      } else {
        if (line.startsWith('+') && !line.startsWith('+++')) rightCell = `${GREEN}${line}${RESET}`;
        else if (line.startsWith('-') && !line.startsWith('---')) rightCell = `${RED}${line}${RESET}`;
        else if (line.startsWith('@@')) rightCell = `${CYAN}${line}${RESET}`;
        else if (line.startsWith('diff ') || line.startsWith('index ')) rightCell = `${DIM}${line}${RESET}`;
        else rightCell = line;
      }
    }

    const visibleLen = leftCell.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, leftW - visibleLen);
    out += `${leftCell}${' '.repeat(padding)}│${rightCell}\n`;
  }

  // Footer
  out += `${DIM}${'─'.repeat(leftW)}┴${'─'.repeat(rightW)}${RESET}\n`;
  const doneCount = Object.keys(vprMeta.done || {}).length;
  const holdCount = (vprMeta.hold || []).length;
  const footerParts = [];
  if (holdCount > 0) footerParts.push(`⏸ ${holdCount} held`);
  if (doneCount > 0) footerParts.push(`${doneCount} done`);
  const footerInfo = footerParts.length > 0 ? `  ${DIM}${footerParts.join('  ·  ')}${RESET}` : '';
  if (message) { out += message + footerInfo + '\n'; message = ''; }
  else out += footerInfo + '\n';

  // Show cursor in edit mode
  if (editMode && editCursorScreenRow >= 0) {
    const screenRow = headerLines + 1 + editCursorScreenRow - diffScroll;
    const screenCol = leftW + 2 + editCursorScreenCol;
    if (screenRow > headerLines && screenRow <= headerLines + bodyH) {
      out += `${ESC}${screenRow};${screenCol}H${SHOW_CURSOR}`;
    }
  }

  out += SYNC_END;

  process.stdout.write(out);
}

// ── Input popup ────────────────────────────────────────────────────────
let mode = 'normal';
let inputBuffer = '';
let inputPrompt = '';
let inputCallback = null;
let inputMultiline = false;
let inputCursorLine = 0;

function startInput(prompt, defaultVal, callback, multiline = false) {
  mode = 'input';
  inputPrompt = prompt;
  inputMultiline = multiline;
  inputBuffer = defaultVal || '';
  inputCallback = callback;
  inputCursorLine = inputBuffer.split('\n').length - 1;
  renderPopup();
}

function renderPopup() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const boxW = Math.min(70, cols - 4);
  const innerW = boxW - 4;
  const lines = inputMultiline ? inputBuffer.split('\n') : [inputBuffer];
  const contentH = inputMultiline ? Math.max(lines.length, 3) : 1;
  const boxH = contentH + 4;
  const startCol = Math.floor((cols - boxW) / 2);
  const startRow = Math.max(1, Math.floor((rows - boxH) / 2));
  const title = ` ${inputPrompt} `;
  const titlePad = Math.max(0, Math.floor((boxW - 2 - title.length) / 2));

  let out = '';
  out += `${ESC}${startRow};${startCol}H${CYAN}╭${'─'.repeat(titlePad)}${BOLD}${title}${RESET}${CYAN}${'─'.repeat(Math.max(0, boxW - 2 - titlePad - title.length))}╮${RESET}`;

  for (let i = 0; i < contentH; i++) {
    const line = (lines[i] || '').slice(0, innerW);
    out += `${ESC}${startRow + 1 + i};${startCol}H${CYAN}│${RESET} ${line}${'░'.repeat(Math.max(0, innerW - line.length))} ${CYAN}│${RESET}`;
  }

  const helpText = inputMultiline ? '  Ctrl+S save · Esc cancel · Enter newline' : '  Enter confirm · Esc cancel';
  out += `${ESC}${startRow + 1 + contentH};${startCol}H${CYAN}│${RESET}${DIM}${helpText}${' '.repeat(Math.max(0, boxW - 2 - helpText.length))}${RESET}${CYAN}│${RESET}`;
  out += `${ESC}${startRow + 2 + contentH};${startCol}H${CYAN}╰${'─'.repeat(boxW - 2)}╯${RESET}`;

  const cursorLineIdx = inputMultiline ? Math.min(inputCursorLine, lines.length - 1) : 0;
  const cursorCol = startCol + 2 + (lines[cursorLineIdx] || '').length;
  out += `${ESC}${startRow + 1 + cursorLineIdx};${cursorCol}H${SHOW_CURSOR}`;

  process.stdout.write(out);
}

function handleInputKey(str, key) {
  if (!inputMultiline && key.name === 'return') {
    const cb = inputCallback;
    const val = inputBuffer.trim(); inputBuffer = '';
    inputCallback = null;
    mode = 'normal'; process.stdout.write(HIDE_CURSOR);
    if (cb) cb(val);
    // Only render if the callback didn't open a new popup
    if (mode === 'normal') render();
    return;
  }
  if (inputMultiline && key.name === 'return') { inputBuffer += '\n'; inputCursorLine++; renderPopup(); return; }
  if (inputMultiline && (key.name === 's' && key.ctrl)) {
    mode = 'normal'; process.stdout.write(HIDE_CURSOR);
    const val = inputBuffer.trim(); inputBuffer = '';
    if (inputCallback) inputCallback(val); // allow empty
    render(); return;
  }
  if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
    mode = 'normal'; inputBuffer = ''; process.stdout.write(HIDE_CURSOR);
    render(); return; // cancel — no callback
  }
  if (key.name === 'backspace') {
    if (inputBuffer.endsWith('\n')) inputCursorLine = Math.max(0, inputCursorLine - 1);
    inputBuffer = inputBuffer.slice(0, -1); renderPopup(); return;
  }
  if (str && !key.ctrl && str.length === 1) { inputBuffer += str; renderPopup(); }
}

// ── Inline field editor ─────────────────────────────────────────────────
let editMode = false;
let editBuffer = '';
let editOriginal = ''; // for undo
let editCursorPos = 0;
let editFieldName = '';
let editBookmark = '';

function startFieldEdit(bookmark, fieldName, currentValue) {
  editMode = true;
  editBuffer = currentValue || '';
  editOriginal = editBuffer;
  editCursorPos = editBuffer.length;
  editFieldName = fieldName;
  editBookmark = bookmark;
  mode = 'edit';
}

function handleEditKey(str, key) {
  if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
    // Save and exit
    if (!vprMeta.bookmarks) vprMeta.bookmarks = {};
    if (!vprMeta.bookmarks[editBookmark]) vprMeta.bookmarks[editBookmark] = {};
    vprMeta.bookmarks[editBookmark][editFieldName] = editBuffer;

    // If title changed, rename the jj bookmark to match new slug
    if (editFieldName === 'wiTitle') {
      const meta = vprMeta.bookmarks[editBookmark];
      const wi = meta.wi;
      if (wi) {
        const slug = editBuffer.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .split('-').slice(0, 4).join('-');
        const newBm = `feat/${wi}-${slug}`;
        if (newBm !== editBookmark) {
          try {
            jj(`bookmark rename ${editBookmark} ${newBm}`);
            // Move meta to new key
            vprMeta.bookmarks[newBm] = vprMeta.bookmarks[editBookmark];
            delete vprMeta.bookmarks[editBookmark];
            // Update PR title if it was auto-generated
            if (vprMeta.bookmarks[newBm].tpIndex) {
              vprMeta.bookmarks[newBm].prTitle = `${vprMeta.bookmarks[newBm].tpIndex}: ${editBuffer}`;
            }
            editBookmark = newBm;
          } catch {}
        }
      }
    }

    saveMeta(vprMeta);
    editMode = false;
    mode = 'normal';
    message = `${GREEN}${FIELD_LABELS[FIELD_NAMES.indexOf(editFieldName)]} saved${RESET}`;
    process.stdout.write(HIDE_CURSOR);
    render();
    return;
  }
  if (key.name === 'z' && key.ctrl) {
    editBuffer = editOriginal;
    editCursorPos = editBuffer.length;
    renderEditOnly();
    return;
  }
  if (key.name === 'backspace') {
    if (editCursorPos > 0) {
      editBuffer = editBuffer.slice(0, editCursorPos - 1) + editBuffer.slice(editCursorPos);
      editCursorPos--;
    }
    renderEditOnly();
    return;
  }
  if (key.name === 'return') {
    editBuffer = editBuffer.slice(0, editCursorPos) + '\n' + editBuffer.slice(editCursorPos);
    editCursorPos++;
    renderEditOnly();
    return;
  }
  if (key.name === 'left') {
    editCursorPos = Math.max(0, editCursorPos - 1);
    renderEditOnly();
    return;
  }
  if (key.name === 'right') {
    editCursorPos = Math.min(editBuffer.length, editCursorPos + 1);
    renderEditOnly();
    return;
  }
  if (key.name === 'up') {
    // Move cursor up one line
    const before = editBuffer.slice(0, editCursorPos);
    const lastNewline = before.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const prevNewline = before.lastIndexOf('\n', lastNewline - 1);
      const colInLine = editCursorPos - lastNewline - 1;
      const prevLineStart = prevNewline + 1;
      const prevLineLen = lastNewline - prevLineStart;
      editCursorPos = prevLineStart + Math.min(colInLine, prevLineLen);
    }
    renderEditOnly();
    return;
  }
  if (key.name === 'down') {
    // Move cursor down one line
    const after = editBuffer.slice(editCursorPos);
    const nextNewline = after.indexOf('\n');
    if (nextNewline >= 0) {
      const before = editBuffer.slice(0, editCursorPos);
      const currentLineStart = before.lastIndexOf('\n') + 1;
      const colInLine = editCursorPos - currentLineStart;
      const nextLineStart = editCursorPos + nextNewline + 1;
      const nextNextNewline = editBuffer.indexOf('\n', nextLineStart);
      const nextLineLen = (nextNextNewline >= 0 ? nextNextNewline : editBuffer.length) - nextLineStart;
      editCursorPos = nextLineStart + Math.min(colInLine, nextLineLen);
    }
    renderEditOnly();
    return;
  }
  if (str && !key.ctrl && str.length === 1) {
    editBuffer = editBuffer.slice(0, editCursorPos) + str + editBuffer.slice(editCursorPos);
    editCursorPos++;
    renderEditOnly();
    return;
  }
}

function getEditLines(rightW) {
  const wrapW = Math.max(20, rightW - 6);
  const label = FIELD_LABELS[FIELD_NAMES.indexOf(editFieldName)] || editFieldName;
  const lines = [];

  lines.push(`${GREEN}${BOLD}── ${label} (editing) ${'─'.repeat(Math.max(0, 25 - label.length))}${RESET}`);
  lines.push('');

  // Word wrap the buffer and find cursor position
  const beforeCursor = editBuffer.slice(0, editCursorPos);
  const afterCursor = editBuffer.slice(editCursorPos);
  const fullText = editBuffer;

  // Wrap and render with cursor marker
  let charCount = 0;
  let cursorRow = 0;
  let cursorCol = 0;

  for (const line of fullText.split('\n')) {
    // Wrap this line
    if (line.length <= wrapW) {
      if (charCount <= editCursorPos && editCursorPos <= charCount + line.length) {
        cursorRow = lines.length;
        cursorCol = editCursorPos - charCount;
      }
      lines.push(line || ' ');
      charCount += line.length + 1; // +1 for \n
    } else {
      let remaining = line;
      while (remaining.length > wrapW) {
        let breakAt = remaining.lastIndexOf(' ', wrapW);
        if (breakAt <= 0) breakAt = wrapW;
        const segment = remaining.slice(0, breakAt);
        if (charCount <= editCursorPos && editCursorPos <= charCount + segment.length) {
          cursorRow = lines.length;
          cursorCol = editCursorPos - charCount;
        }
        lines.push(segment);
        charCount += breakAt;
        remaining = remaining.slice(breakAt).trimStart();
        if (remaining.length > 0) charCount++; // trimmed space
      }
      if (remaining) {
        if (charCount <= editCursorPos && editCursorPos <= charCount + remaining.length) {
          cursorRow = lines.length;
          cursorCol = editCursorPos - charCount;
        }
        lines.push(remaining);
        charCount += remaining.length + 1;
      }
    }
  }

  lines.push('');
  lines.push(`${DIM}type to edit · Enter newline · Ctrl+Z undo · Esc save${RESET}`);

  return { lines, cursorRow, cursorCol };
}

// ── Open $EDITOR for multi-line (like lazygit) ─────────────────────────
function openEditor(initial, callback) {
  const editor = process.env.EDITOR || 'nano';
  const tmp = path.join(os.tmpdir(), `vpr-${Date.now()}.md`);
  fs.writeFileSync(tmp, initial || '');
  process.stdout.write(SHOW_CURSOR + CLEAR);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
    callback(fs.readFileSync(tmp, 'utf-8').trim());
  } catch { message = `${RED}Editor failed${RESET}`; }
  finally { fs.rmSync(tmp, { force: true }); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdout.write(HIDE_CURSOR); render(); }
}

// ── jj command mode ────────────────────────────────────────────────────
function runJjCommand(cmd) {
  process.stdout.write(SHOW_CURSOR + CLEAR);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    execSync(`jj ${cmd}`, { stdio: 'inherit', shell: '/bin/bash' });
  } catch {}
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(HIDE_CURSOR);
  reload();
  render();
}

// ── Reload ─────────────────────────────────────────────────────────────
let base = '';

function reload() {
  vprMeta = loadMeta();
  entries = loadEntries(base);
  diffCache.clear();
  filesCache.clear();
  const items = buildItems();
  cursor = Math.min(cursor, Math.max(0, items.length - 1));
  message = `${GREEN}Refreshed${RESET}`;
}

// ── Main ───────────────────────────────────────────────────────────────
// Debounced renumber — waits for moves to settle before renumbering
let _renumberTimer = null;
function _debouncedRenumber(cfg, meta, baseRef) {
  if (_renumberTimer) clearTimeout(_renumberTimer);
  _renumberTimer = setTimeout(() => {
    _renumberTimer = null;
    _renumberIndexes(cfg, meta, baseRef);
    render();
  }, 600);
}

// Renumber TP indexes after reordering groups in the chain
function _renumberIndexes(cfg, meta, baseRef) {
  const fresh = sharedLoadEntries(baseRef);
  const groups = [];
  let pending = [];
  for (const entry of fresh) {
    if (entry.bookmark && meta.bookmarks?.[entry.bookmark]) {
      groups.push({ bookmark: entry.bookmark });
      pending = [];
    } else {
      pending.push(entry);
    }
  }
  const prefix = cfg?.prefix || 'TP';
  const doneIndexes = Object.values(meta.done || {}).map(d => parseInt(d.tpIndex?.replace(/\D/g, '')) || 0);
  let idx = doneIndexes.length > 0 ? Math.max(...doneIndexes) + 1 : 1;
  for (const g of groups) {
    const bm = meta.bookmarks[g.bookmark];
    if (!bm) continue;
    const newTp = `${prefix}-${idx}`;
    const oldTp = bm.tpIndex;
    if (oldTp !== newTp) {
      bm.tpIndex = newTp;
      bm.prTitle = bm.prTitle?.replace(oldTp, newTp) || `${newTp}: ${bm.wiTitle}`;
    }
    idx++;
  }
  meta.nextIndex = idx;
  saveMeta(meta);
}

export function startTui(config, baseArg) {
  if (!hasJj()) { process.stderr.write('VPR requires jj (jujutsu). Install it first.\n'); process.exit(1); }

  provider = createProvider(config);
  vprMeta = loadMeta();

  // Determine base: user arg, or getBase() from shared git helpers
  if (baseArg) {
    base = baseArg;
  } else {
    base = getBase() || 'trunk()';
  }
  entries = loadEntries(base);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', () => process.stdout.write(SHOW_CURSOR + CLEAR));

  // Watch .git for changes
  const gitDir = path.join(process.cwd(), '.git');
  let lastHead = '';
  try {
    lastHead = jj('log --no-graph -r @ -T commit_id');
    fs.watch(gitDir, { recursive: false }, () => {
      try {
        const head = jj('log --no-graph -r @ -T commit_id');
        if (head !== lastHead) { lastHead = head; reload(); render(); }
      } catch {}
    });
  } catch {}

  render();

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    const items = buildItems();

    // Inline edit mode
    if (mode === 'edit') { handleEditKey(str, key); return; }

    // Input mode (popups)
    if (mode === 'input') { handleInputKey(str, key); return; }

    // jj command mode
    if (mode === 'jjcmd') {
      handleInputKey(str, key);
      return;
    }

    // Bookmark mode
    if (mode === 'bookmark') {
      mode = 'normal';
      const bItem = items[cursor];
      const bmList = Object.keys(vprMeta.bookmarks || {});
      const idx = parseInt(str) - 1;
      if (idx >= 0 && idx < bmList.length && bItem?.changeId) {
        const bm = bmList[idx];
        try { jj(`bookmark set ${bm} -r ${bItem.changeId} --allow-backwards`); } catch {
          try { jj(`bookmark create ${bm} -r ${bItem.changeId}`); } catch {}
        }
        message = `${GREEN}Set ${bm} on ${bItem.changeId.slice(0, 8)}${RESET}`;
        reload();
      } else {
        message = `${DIM}Cancelled${RESET}`;
      }
      render(); return;
    }

    // ── File split mode ──────────────────────────────────────────────
    if (mode === 'file_split') {
      if (key.name === 'escape' || str === 'i') {
        mode = 'interactive';
        splitFiles = []; splitSelected.clear(); splitChangeId = null; splitCursor = 0;
        cursor = 0;
        render(); return;
      }
      if (key.name === 'down' || str === 'j') { cursor = Math.min(splitFiles.length - 1, cursor + 1); render(); return; }
      if (key.name === 'up' || str === 'k') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (str === ' ') {
        if (splitSelected.has(cursor)) splitSelected.delete(cursor);
        else splitSelected.add(cursor);
        render(); return;
      }
      if (key.name === 'return' || str === 'y') {
        if (splitSelected.size === 0) { message = `${RED}Select files to split out (Space to select)${RESET}`; render(); return; }
        const files = [...splitSelected].map(i => splitFiles[i].path);
        try {
          message = `${DIM}Splitting ${files.length} file(s)...${RESET}`;
          render();
          const fileArgs = files.map(f => `"${f}"`).join(' ');
          execSync(`JJ_EDITOR=true jj split -r ${splitChangeId} ${fileArgs}`, { stdio: 'pipe', shell: '/bin/bash' });
          appendRebaseLog([{ type: 'split', changeId: splitChangeId, files, result: 'ok' }]);
          mode = 'interactive';
          splitFiles = []; splitSelected.clear(); splitChangeId = null;
          reload();
          message = `${GREEN}Split ${files.length} file(s)${RESET}`;
        } catch (err) {
          message = `${RED}Split failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
        }
        render(); return;
      }
      render(); return;
    }

    // ── Interactive mode ────────────────────────────────────────────
    if (mode === 'interactive') {
      const iItems = getInteractiveItems(items);

      if (key.name === 'escape' || str === 'i') {
        mode = 'normal';
        interactiveGroup = null; selected.clear(); reorderPicked = null;
        cursor = 0;
        render(); return;
      }
      if (key.name === 'down' || str === 'j') { cursor = Math.min(iItems.length - 1, cursor + 1); render(); return; }
      if (key.name === 'up' || str === 'k') { cursor = Math.max(0, cursor - 1); render(); return; }
      if (key.name === 'j' && key.shift) { diffScroll += 3; render(); return; }
      if (key.name === 'k' && key.shift) { diffScroll = Math.max(0, diffScroll - 3); render(); return; }
      if (str === 'v') { rightPaneView = rightPaneView === 'diff' ? 'files' : 'diff'; diffScroll = 0; render(); return; }

      const iItem = iItems[cursor];
      if (!iItem || iItem.type === 'interactive-separator') { render(); return; }

      // Space — toggle select
      if (str === ' ') {
        if (iItem?.changeId) {
          if (selected.has(iItem.changeId)) selected.delete(iItem.changeId);
          else selected.add(iItem.changeId);
        }
        render(); return;
      }

      // s — context-sensitive: split (no selection) or squash (with selection)
      if (str === 's' || str === 'S') {
        if (selected.size > 0) {
          // Squash selected into parents
          const count = selected.size;
          startInput(`Squash ${count} commit(s) into parent? (y/n)`, '', (answer) => {
            if (answer !== 'y') { mode = 'interactive'; return; }
            const actions = [];
            const sorted = [...selected].sort((a, b) => {
              const aIdx = entries.findIndex(e => e.changeId === a);
              const bIdx = entries.findIndex(e => e.changeId === b);
              return bIdx - aIdx;
            });
            for (const cid of sorted) {
              const entry = entries.find(e => e.changeId === cid);
              try {
                jj(`squash -r ${cid}`);
                actions.push({ type: 'squash', changeId: cid, subject: entry?.subject || '', result: 'ok' });
              } catch (err) {
                actions.push({ type: 'squash', changeId: cid, subject: entry?.subject || '', result: 'failed', error: (err?.stderr?.toString() || '').slice(0, 80) });
              }
            }
            if (actions.length > 0) appendRebaseLog(actions);
            selected.clear();
            mode = 'interactive';
            reload();
            const ok = actions.filter(a => a.result === 'ok').length;
            const fail = actions.filter(a => a.result === 'failed').length;
            message = fail > 0
              ? `${YELLOW}Squashed ${ok}/${actions.length} (${fail} failed)${RESET}`
              : `${GREEN}Squashed ${ok} commit(s)${RESET}`;
          });
          return;
        }
        // No selection — split cursor commit (enter file_split)
        const cid = iItem?.changeId;
        if (!cid) { message = `${RED}Select a commit${RESET}`; render(); return; }
        try {
          const raw = jj(`diff --summary -r ${cid}`);
          splitFiles = raw.split('\n').filter(Boolean).map(line => {
            const status = line.charAt(0);
            const filePath = line.slice(2).trim();
            return { status, path: filePath };
          });
          if (splitFiles.length === 0) { message = `${RED}No files in commit${RESET}`; render(); return; }
          splitChangeId = cid;
          splitSelected.clear();
          splitCursor = 0;
          cursor = 0;
          mode = 'file_split';
        } catch (err) {
          message = `${RED}Failed to load files: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
        }
        render(); return;
      }

      // d — drop selected
      if (str === 'd') {
        if (selected.size === 0) { message = `${RED}Select commits to drop${RESET}`; render(); return; }
        const count = selected.size;
        startInput(`Drop ${count} commit(s)? (y/n)`, '', (answer) => {
          if (answer !== 'y') { mode = 'interactive'; return; }
          const actions = [];
          const sorted = [...selected].sort((a, b) => {
            const aIdx = entries.findIndex(e => e.changeId === a);
            const bIdx = entries.findIndex(e => e.changeId === b);
            return bIdx - aIdx;
          });
          for (const cid of sorted) {
            const entry = entries.find(e => e.changeId === cid);
            try {
              jj(`abandon ${cid}`);
              actions.push({ type: 'drop', changeId: cid, subject: entry?.subject || '', result: 'ok' });
            } catch (err) {
              actions.push({ type: 'drop', changeId: cid, subject: entry?.subject || '', result: 'failed' });
            }
          }
          if (actions.length > 0) appendRebaseLog(actions);
          selected.clear();
          mode = 'interactive';
          reload();
          message = `${GREEN}Dropped ${actions.filter(a => a.result === 'ok').length} commit(s)${RESET}`;
        });
        return;
      }

      // r — reword commit (works on cursor or single selection)
      if (str === 'r') {
        const cid = selected.size === 1 ? [...selected][0] : iItem?.changeId;
        if (!cid) { message = `${RED}Select a commit to reword${RESET}`; render(); return; }
        const entry = entries.find(e => e.changeId === cid);
        startInput('New message: ', entry?.subject || '', (newMsg) => {
          mode = 'interactive';
          if (!newMsg?.trim()) return;
          try {
            const escaped = newMsg.replace(/'/g, "'\\''");
            jj(`describe ${cid} -m '${escaped}'`);
            selected.clear();
            reload();
            message = `${GREEN}Reworded ${cid.slice(0, 8)}${RESET}`;
          } catch (err) {
            message = `${RED}Reword failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
          }
        });
        return;
      }

      // o — reorder (pick/drop within group)
      if (str === 'o') {
        if (!iItem?.changeId) { render(); return; }
        if (!reorderPicked) {
          reorderPicked = iItem.changeId;
          message = `${YELLOW}Picked ${iItem.changeId.slice(0, 8)} — navigate and press o to drop${RESET}`;
        } else {
          if (reorderPicked === iItem.changeId) {
            reorderPicked = null;
            message = `${DIM}Cancelled reorder${RESET}`;
          } else {
            try {
              jj(`rebase -r ${reorderPicked} -A ${iItem.changeId}`);
              reorderPicked = null;
              reload();
              message = `${GREEN}Reordered${RESET}`;
            } catch (err) {
              message = `${RED}Reorder failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
            }
          }
        }
        render(); return;
      }

      // m — move ungrouped commit into this group
      if (str === 'm') {
        if (iItem?.type === 'ungrouped' && iItem?.changeId) {
          try {
            jj(`rebase -r ${iItem.changeId} -B ${interactiveGroup}`);
            reload();
            message = `${GREEN}Moved ${iItem.changeId.slice(0, 8)} into group${RESET}`;
          } catch (err) {
            message = `${RED}Move failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
          }
        } else {
          message = `${RED}Navigate to an ungrouped commit${RESET}`;
        }
        render(); return;
      }

      render(); return;
    }

    // Ctrl+C in normal mode — quit
    if (key.name === 'c' && key.ctrl) {
      process.stdout.write(SHOW_CURSOR + CLEAR);
      process.exit(0);
    }

    // Shift keys — context-sensitive
    const currentItem = items[cursor];
    if (key.name === 'j' && key.shift) {
      diffScroll += 3;
      render(); return;
    }
    if (key.name === 'k' && key.shift) {
      diffScroll = Math.max(0, diffScroll - 3);
      render(); return;
    }
    if (key.name === 'r' && key.shift) { reload(); render(); return; }

    // E — open editor to edit all group fields (ticket title, PR title, PR story, PR description)
    if (str === 'E') {
      const eBm = currentItem?.type === 'group' ? currentItem.bookmark : currentItem?.group;
      if (!eBm) { message = `${RED}Navigate to a group${RESET}`; render(); return; }
      const eMeta = vprMeta.bookmarks?.[eBm] || {};

      const content = [
        '# Edit group fields. Each section starts with --- label ---',
        '# Save and close to apply. Lines starting with # are ignored.',
        '',
        '--- Ticket Title ---',
        eMeta.wiTitle || '',
        '',
        '--- PR Title ---',
        eMeta.prTitle || eMeta.wiTitle || '',
        '',
        '--- PR Story ---',
        eMeta.prDesc || '',
        '',
        '--- PR Description ---',
        eMeta.prBody || '',
        '',
      ].join('\n');

      openEditor(content, (result) => {
        // Parse sections
        const sections = {};
        let currentSection = null;
        let currentLines = [];

        for (const line of result.split('\n')) {
          if (line.startsWith('#')) continue;
          const sectionMatch = line.match(/^---\s*(.+?)\s*---$/);
          if (sectionMatch) {
            if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
            currentSection = sectionMatch[1];
            currentLines = [];
          } else if (currentSection) {
            currentLines.push(line);
          }
        }
        if (currentSection) sections[currentSection] = currentLines.join('\n').trim();

        // Apply changes
        let changed = false;
        if (!vprMeta.bookmarks[eBm]) vprMeta.bookmarks[eBm] = {};
        const bm = vprMeta.bookmarks[eBm];

        if (sections['Ticket Title'] !== undefined && sections['Ticket Title'] !== (bm.wiTitle || '')) {
          bm.wiTitle = sections['Ticket Title'];
          changed = true;
        }
        if (sections['PR Title'] !== undefined && sections['PR Title'] !== (bm.prTitle || '')) {
          bm.prTitle = sections['PR Title'];
          changed = true;
        }
        if (sections['PR Story'] !== undefined && sections['PR Story'] !== (bm.prDesc || '')) {
          bm.prDesc = sections['PR Story'];
          changed = true;
        }
        if (sections['PR Description'] !== undefined && sections['PR Description'] !== (bm.prBody || '')) {
          bm.prBody = sections['PR Description'];
          changed = true;
        }

        if (changed) {
          saveMeta(vprMeta);
          reload();
          message = `${GREEN}Updated fields for ${bm.tpIndex || eBm}${RESET}`;
        } else {
          message = `${DIM}No changes${RESET}`;
        }
      });
      return;
    }

    // O — open editor to reorder groups (like git rebase -i)
    if (str === 'O') {
      const allGroups = items.filter(i => i.type === 'group');
      if (allGroups.length < 2) { message = `${DIM}Nothing to reorder${RESET}`; render(); return; }

      // Build editor content — one line per group, bookmark as the key
      const lines = allGroups.map(g => {
        const m = vprMeta.bookmarks?.[g.bookmark] || {};
        return `${g.bookmark}  # ${m.tpIndex || ''} ${m.wiTitle || g.title}`;
      });
      const header = [
        '# Reorder groups by moving lines. Lines starting with # are ignored.',
        '# Save and close to apply. Empty file or unchanged = cancel.',
        '',
      ];

      openEditor(header.join('\n') + lines.join('\n') + '\n', (result) => {
        // Parse result — extract bookmark names (ignore comments and empty lines)
        const newOrder = result.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => l.split(/\s+/)[0]); // first word is the bookmark

        // Validate
        const oldOrder = allGroups.map(g => g.bookmark);
        if (newOrder.length !== oldOrder.length || !newOrder.every(b => oldOrder.includes(b))) {
          message = `${RED}Invalid reorder — bookmarks don't match${RESET}`;
          return;
        }
        if (newOrder.join(',') === oldOrder.join(',')) {
          message = `${DIM}No changes${RESET}`;
          return;
        }

        // Rebase to match new order — work bottom-up
        // Strategy: for each group in new order (from second to last), rebase after the previous
        message = `${DIM}Reordering...${RESET}`;
        render();

        try {
          for (let i = 1; i < newOrder.length; i++) {
            const bm = newOrder[i];
            const prevBm = newOrder[i - 1];
            const group = allGroups.find(g => g.bookmark === bm);
            const groupCommits = items.filter(it => it.type === 'commit' && it.group === bm);
            // Find the tip of the previous group (its bookmark commit)
            const prevTip = items.find(it => it.type === 'commit' && it.bookmark === prevBm)
              || items.filter(it => it.type === 'commit' && it.group === prevBm).pop();
            if (!prevTip) continue;

            for (const c of groupCommits) {
              jj(`rebase -r ${c.changeId} -A ${prevTip.changeId}`);
            }
          }

          _renumberIndexes(config, vprMeta, base);
          reload();

          // Check for conflicts after reorder (single jj call)
          const conflictIds = new Set(
            (jjSafe(`log --no-graph -r 'conflicts()' -T 'change_id.short() ++ "\\n"'`) || '')
              .split('\n').filter(Boolean)
          );
          const conflicted = entries.filter(e => conflictIds.has(e.changeId));

          if (conflicted.length > 0) {
            const conflictList = conflicted.slice(0, 5).map(c => `  ${c.changeId?.slice(0, 8)} ${c.subject}`).join('\n');
            const more = conflicted.length > 5 ? `\n  ... and ${conflicted.length - 5} more` : '';
            message = `${YELLOW}Reordered ${newOrder.length} groups — ${conflicted.length} conflict(s):\n${conflictList}${more}\n\nResolve with: jj resolve -r <changeId>${RESET}`;
          } else {
            message = `${GREEN}Reordered ${newOrder.length} groups — no conflicts${RESET}`;
          }
        } catch (err) {
          message = `${RED}Reorder failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
        }
      });
      return;
    }

    // S (shift+s) — generate PR description from story via LLM
    if (key.name === 's' && key.shift) {
      const gBm = currentItem?.type === 'group' ? currentItem.bookmark : currentItem?.group;
      if (!gBm) { message = `${RED}Navigate to a group${RESET}`; render(); return; }
      const gMeta = vprMeta.bookmarks?.[gBm] || {};
      if (!gMeta.prDesc?.trim()) {
        message = `${YELLOW}Write a PR story first (press s)${RESET}`;
        render(); return;
      }

      // Find generate command: config > claude CLI > error
      const generateCmd = config?.generateCmd || null;
      let cmd = generateCmd;
      if (!cmd) {
        try { execSync('which claude', { stdio: 'pipe' }); cmd = 'claude -p'; } catch {}
      }
      if (!cmd) {
        message = `${RED}No LLM configured. Add "generateCmd" to .vpr/config.json or install claude CLI${RESET}`;
        render(); return;
      }

      // Build prompt with story + commits
      const groupCommits = items.filter(i => i.group === gBm && i.type === 'commit');
      const commitList = groupCommits.map(c => `- ${c.changeId?.slice(0, 8)} ${c.subject}`).join('\n');
      const prompt = [
        'Generate a concise PR description in markdown from the following.',
        'Output ONLY the description body — no preamble, no "Here is", just the markdown.',
        'Use ## Summary with 1-3 bullet points, then ## Changes with details grouped logically.',
        '',
        `PR Title: ${gMeta.prTitle || ''}`,
        '',
        'PR Story:',
        gMeta.prDesc,
        '',
        'Commits:',
        commitList,
      ].join('\n');

      message = `${DIM}Generating PR description...${RESET}`;
      render();

      // Run async-ish via spawn to not block TUI
      try {
        const result = execSync(cmd, {
          input: prompt,
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: '/bin/bash',
        }).trim();

        if (result) {
          if (!vprMeta.bookmarks[gBm]) vprMeta.bookmarks[gBm] = {};
          vprMeta.bookmarks[gBm].prBody = result;
          saveMeta(vprMeta);
          message = `${GREEN}PR description generated and saved${RESET}`;
        } else {
          message = `${YELLOW}LLM returned empty response${RESET}`;
        }
      } catch (err) {
        const stderr = err?.stderr?.toString()?.slice(0, 80) || err.message?.slice(0, 80) || '';
        message = `${RED}Generation failed: ${stderr}${RESET}`;
      }
      render(); return;
    }

    // v — toggle right pane between diff and file view
    if (str === 'v' && mode !== 'file_split') {
      rightPaneView = rightPaneView === 'diff' ? 'files' : 'diff';
      diffScroll = 0;
      render(); return;
    }

    // H (shift+h) — toggle hold on a commit
    if (str === 'H') {
      const hItem = mode === 'interactive' ? getInteractiveItems(items)[cursor] : currentItem;
      if (!hItem?.changeId) { message = `${RED}Select a commit${RESET}`; render(); return; }
      if (!vprMeta.hold) vprMeta.hold = [];
      const idx = vprMeta.hold.indexOf(hItem.changeId);
      if (idx >= 0) {
        vprMeta.hold.splice(idx, 1);
        saveMeta(vprMeta);
        reload();
        message = `${GREEN}Removed from hold: ${hItem.changeId.slice(0, 8)}${RESET}`;
      } else {
        vprMeta.hold.push(hItem.changeId);
        saveMeta(vprMeta);
        reload();
        message = `${YELLOW}On hold: ${hItem.changeId.slice(0, 8)}${RESET}`;
      }
      render(); return;
    }

    // U (shift+u) — ungroup: eject commit to after the last bookmark (truly ungrouped)
    if (key.name === 'u' && key.shift) {
      const uItem = mode === 'interactive' ? getInteractiveItems(items)[cursor] : currentItem;
      if (!uItem?.changeId || !uItem?.group) {
        message = `${RED}Select a commit in a group to ungroup${RESET}`;
        render(); return;
      }
      // Find the last bookmark in the chain — rebase after it so commit is truly ungrouped
      const lastBookmarked = [...entries].reverse().find(e => e.bookmark);
      if (!lastBookmarked) {
        message = `${RED}No bookmarks found${RESET}`;
        render(); return;
      }
      try {
        jj(`rebase -r ${uItem.changeId} -A ${lastBookmarked.changeId}`);
        reload();
        message = `${GREEN}Ungrouped ${uItem.changeId.slice(0, 8)}${RESET}`;
      } catch (err) {
        message = `${RED}Ungroup failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
      }
      render(); return;
    }

    switch (key.name || str) {
      case 'up': case 'k':
        cursor = Math.max(0, cursor - 1);
        break;
      case 'down': case 'j':
        cursor = Math.min(items.length - 1, cursor + 1);
        break;
      case 'pagedown': diffScroll += bodyH; break;
      case 'pageup': diffScroll = Math.max(0, diffScroll - bodyH); break;

      case 'space': {
        const item = items[cursor];
        if (!picked) {
          // Pick up a commit
          if (!item?.changeId || item.type === 'group' || item.type === 'ungrouped-header') {
            message = `${RED}Select a commit to move${RESET}`;
            break;
          }
          picked = item.changeId;
          message = `${MAGENTA}Picked ${picked.slice(0, 8)} — navigate to a bookmark and press space${RESET}`;
        } else {
          // Drop: rebase picked commit onto the bookmark's commit
          if (!item) { message = `${RED}Navigate to a target${RESET}`; break; }

          // Two cases: drop on a commit, or drop on a group header
          let targetChangeId = null;
          let rebaseFlag = '-A';
          let isEmptyGroupDrop = false;

          if (item.type === 'group') {
            const groupCommits = items.filter(i => i.group === item.bookmark && i.type === 'commit');
            if (groupCommits.length > 0) {
              // Group with commits: insert before first commit (top of group)
              targetChangeId = groupCommits[0].changeId;
              rebaseFlag = '-B';
            } else {
              // Empty group: no rebase — just reassign the bookmark
              isEmptyGroupDrop = true;
            }
          } else if (item.changeId) {
            targetChangeId = item.changeId;
            rebaseFlag = '-A';
          }

          // Handle empty group drop: no rebase, just split the bookmark boundary
          // The picked commit is the tip of some group. Move that group's bookmark
          // back to the previous commit, then create the empty group's bookmark on picked.
          if (isEmptyGroupDrop && item.bookmark) {
            try {
              const pickedEntry = entries.find(e => e.changeId === picked || e.changeId?.startsWith(picked) || picked?.startsWith(e.changeId));
              if (pickedEntry?.bookmark) {
                // Move the source bookmark back to the commit before picked
                // jj syntax: picked- means parent of picked
                try {
                  jj(`bookmark set ${pickedEntry.bookmark} -r '${picked}-' --allow-backwards`);
                } catch {
                  // If no parent, delete the bookmark
                  jj(`bookmark delete ${pickedEntry.bookmark}`);
                }
              }
              // Create the empty group's bookmark on picked
              try { jj(`bookmark create ${item.bookmark} -r ${picked}`); } catch {
                jj(`bookmark set ${item.bookmark} -r ${picked} --allow-backwards`);
              }
              message = `${GREEN}Assigned ${picked.slice(0, 8)} to ${item.bookmark}${RESET}`;
            } catch (err) {
              message = `${RED}Failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
            }
            picked = null;
            reload();
            break;
          }

          if (!targetChangeId) {
            message = `${RED}No target found${RESET}`;
            break;
          }

          if (picked === targetChangeId || picked.startsWith(targetChangeId) || targetChangeId.startsWith(picked)) {
            message = `${DIM}Same position${RESET}`;
            picked = null;
            break;
          }

          try {
            const pickedEntry = entries.find(e => e.changeId === picked || e.changeId?.startsWith(picked) || picked?.startsWith(e.changeId));
            const targetEntry = entries.find(e =>
              e.bookmark && (e.changeId === targetChangeId || e.changeId?.startsWith(targetChangeId?.slice(0, 8)))
            );

            const pickedGroup = items.find(i => i.changeId === picked)?.group;
            const targetGroup = items.find(i => i.changeId === targetChangeId)?.group;

            if (pickedEntry?.bookmark && pickedGroup && pickedGroup === targetGroup) {
              // Within-group tip move: rebase picked, then reload to find real new tip
              const pickedIdx = entries.findIndex(e => e.changeId === picked || e.changeId?.startsWith(picked));
              const targetIdx = entries.findIndex(e => e.changeId === targetChangeId || e.changeId?.startsWith(targetChangeId));
              const isAdjacent = (pickedIdx - targetIdx === 1);
              const tipFlag = isAdjacent ? '-B' : '-A';
              jj(`rebase -r ${picked} ${tipFlag} ${targetChangeId}`);

              // Reload entries to find the real new tip after rebase
              // The bookmark followed the picked commit (jj tracks change IDs),
              // but picked moved earlier in the group — find the actual last commit
              const freshEntries = loadEntries(base);
              const pickedBm = pickedEntry.bookmark;

              // Walk the fresh entries: collect commits in this group
              // (between previous known bookmark and the next known bookmark after ours)
              let foundOurBm = false;
              let lastInGroup = null;
              for (const e of freshEntries) {
                if (e.bookmark === pickedBm) {
                  foundOurBm = true;
                  lastInGroup = e;
                } else if (foundOurBm) {
                  if (e.bookmark && vprMeta.bookmarks?.[e.bookmark]) break; // hit next group
                  lastInGroup = e;
                }
              }

              if (lastInGroup && lastInGroup.changeId !== (freshEntries.find(e => e.bookmark === pickedBm)?.changeId)) {
                try { jj(`bookmark set ${pickedBm} -r ${lastInGroup.changeId} --allow-backwards`); } catch {}
              }
            } else {
              // Cross-group or ungrouped: rebase
              jj(`rebase -r ${picked} ${rebaseFlag} ${targetChangeId}`);

              if (targetEntry?.bookmark && rebaseFlag === '-A') {
                try { jj(`bookmark set ${targetEntry.bookmark} -r ${picked} --allow-backwards`); } catch {}
              }
            }

            message = `${GREEN}Moved ${picked.slice(0, 8)}${RESET}`;
            picked = null;
            reload();
          } catch (err) {
            const stderr = err?.stderr?.toString() || err?.message || 'unknown error';
            message = `${RED}Rebase failed: ${stderr.slice(0, 80)}${RESET}`;
            picked = null;
          }
        }
        break;
      }

      case 'escape':
        if (picked) { picked = null; message = `${DIM}Cancelled${RESET}`; }
        break;

      case 'return':
      case 't': {
        // Edit PR title
        const tItem = items[cursor];
        const tBm = tItem?.type === 'group' ? tItem.bookmark : tItem?.group;
        if (!tBm) { message = `${RED}Navigate to a group${RESET}`; break; }
        const tMeta = vprMeta.bookmarks?.[tBm] || {};
        fieldIdx = FIELD_NAMES.indexOf('prTitle');
        startFieldEdit(tBm, 'prTitle', tMeta.prTitle || tMeta.wiTitle || '');
        render();
        return;
      }

      case 's': {
        // Edit PR story
        const sItem = items[cursor];
        const sBm = sItem?.type === 'group' ? sItem.bookmark : sItem?.group;
        if (!sBm) { message = `${RED}Navigate to a group${RESET}`; break; }
        const sMeta = vprMeta.bookmarks?.[sBm] || {};
        fieldIdx = FIELD_NAMES.indexOf('prDesc');
        startFieldEdit(sBm, 'prDesc', sMeta.prDesc || '');
        render();
        return;
      }

      case 'n': {
        // New ticket + jj bookmark
        if (!provider) { message = `${RED}No provider configured${RESET}`; break; }
        const item = items[cursor];
        // Resolve target: commit's changeId, group's tip commit, or @-
        const targetChangeId = item?.changeId || item?.entry?.changeId || '@-';
        if (!targetChangeId) { message = `${RED}No target commit${RESET}`; break; }

        const prefix = config?.prefix || 'TP';
        const idx = vprMeta.nextIndex || 1;
        const nextBm = `${prefix.toLowerCase()}-${idx}`;
        startInput(`${nextBm} — Ticket title: `, '', (title) => {
          startInput(`${nextBm} — Ticket description: `, '', (desc) => {
            try {
              const result = provider.createWorkItem(title, desc);
              const wi = result?.then ? null : result;
              if (wi) {
                // Branch name from WI ID + slug
                const slug = title.toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 40);
                const bm = `feat/${wi.id}-${slug}`;
                const tpIdx = `${prefix}-${idx}`;
                vprMeta.nextIndex = idx + 1;

                // Create jj bookmark (this becomes the git branch)
                jj(`bookmark create ${bm} -r ${targetChangeId}`);

                // Store metadata
                if (!vprMeta.bookmarks) vprMeta.bookmarks = {};
                vprMeta.bookmarks[bm] = {
                  wi: wi.id,
                  wiTitle: title,
                  wiDescription: desc,
                  wiState: 'New',
                  tpIndex: tpIdx,
                  prTitle: `${tpIdx}: ${title}`,
                };
                saveMeta(vprMeta);
                reload();
                message = `${GREEN}${tpIdx} → ${bm} (WI #${wi.id})${RESET}`;
              }
            } catch (err) { message = `${RED}Failed: ${(err?.stderr?.toString() || err?.message || '').slice(0, 80)}${RESET}`; }
            render();
          });
        });
        return;
      }

      // w and p removed — use J/K to select field, e to edit, S to sync

      case 'd': {
        // Dissolve group — remove bookmark, commits become ungrouped. Ticket ID preserved for reuse.
        const dItem = items[cursor];
        if (dItem?.type !== 'group') { message = `${RED}Navigate to a group${RESET}`; break; }
        const dBm = dItem.bookmark;
        const dMeta = vprMeta.bookmarks?.[dBm] || {};
        const dLabel = dMeta.tpIndex || dBm;
        startInput(`Dissolve ${dLabel}? Commits become ungrouped. (y/n)`, '', (answer) => {
          if (answer !== 'y') return;
          try {
            // Delete the jj bookmark — commits stay, just become ungrouped
            try { jj(`bookmark delete ${dBm}`); } catch {}
            // Remove from active bookmarks, keep ticket ID available
            if (vprMeta.bookmarks?.[dBm]) delete vprMeta.bookmarks[dBm];
            saveMeta(vprMeta);
            reload();
            message = `${GREEN}Dissolved ${dLabel} — commits ungrouped, ticket #${dMeta.wi || '?'} available for reuse${RESET}`;
          } catch (err) {
            message = `${RED}Failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
          }
        });
        return;
      }

      case 'i': {
        // Enter interactive mode on current group
        const iItem = items[cursor];
        let groupBookmark = null;
        if (iItem?.type === 'group') groupBookmark = iItem.bookmark;
        else if (iItem?.group) groupBookmark = iItem.group;
        if (!groupBookmark) { message = `${RED}Navigate to a group or commit within a group${RESET}`; break; }
        interactiveGroup = groupBookmark;
        selected.clear();
        reorderPicked = null;
        mode = 'interactive';
        cursor = 0;
        render(); return;
      }

      case 'c': {
        // Commit (jj commit) — prompts for message
        startInput('Commit message: ', '', (msg) => {
          if (!msg) return;
          try {
            jj(`commit -m '${msg.replace(/'/g, "'\\''")}'`);
            reload();
            message = `${GREEN}Committed: ${msg.slice(0, 40)}${RESET}`;
          } catch (err) {
            message = `${RED}Failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
          }
        });
        return;
      }

      default:
        // : for jj command
        if (str === ':') {
          startInput('jj ', '', (cmd) => {
            runJjCommand(cmd);
          });
          return;
        }
        return; // unknown key, don't re-render

      case 'u': {
        // Undo last jj operation
        try {
          jj('undo');
          reload();
          message = `${GREEN}Undone${RESET}`;
        } catch (err) {
          message = `${RED}Undo failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
        }
        break;
      }

      case 'u': {
        try { jj('undo'); reload(); message = `${GREEN}Undone${RESET}`; }
        catch (err) { message = `${RED}Undo failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`; }
        break;
      }

      case 'b': {
        // Set/move a bookmark on current commit
        const bItem = items[cursor];
        if (!bItem?.changeId) { message = `${RED}Select a commit${RESET}`; break; }
        const bmList = Object.keys(vprMeta.bookmarks || {});
        if (bmList.length === 0) { message = `${RED}No bookmarks — create a ticket first (c)${RESET}`; break; }
        message = `${CYAN}Set bookmark on ${bItem.changeId.slice(0, 8)}:\n${bmList.map((bm, i) => `  ${i + 1}) ${bm}`).join('\n')}${RESET}`;
        mode = 'bookmark';
        break;
      }

      case 'q':
        process.stdout.write(SHOW_CURSOR + CLEAR);
        process.exit(0);
        break;

      case 'n': break; // handled above (switch duplicate prevention)
    }

    render();
  });
}
