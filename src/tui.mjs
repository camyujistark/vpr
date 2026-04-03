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
import { jj, jjSafe, hasJj, git, gitSafe } from './git.mjs';
import { loadConfig, loadMeta, saveMeta } from './config.mjs';
import { createProvider } from './providers/index.mjs';

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
let entries = [];     // [{ type: 'bookmark'|'commit', changeId, sha, subject, bookmark, ccType, ccScope, ccDesc }]
let cursor = 0;
let picked = null;  // changeId of picked commit
let message = '';
let diffScroll = 0;
let lastRightPaneKey = '';
let bodyH = 20;
let fieldIdx = 0; // which field is highlighted in the group summary
const FIELD_NAMES = ['wiTitle', 'wiDescription', 'prTitle', 'prDesc'];
const FIELD_LABELS = ['Ticket Title', 'Ticket Description', 'PR Title', 'PR Story'];

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

// ── Load jj log as flat list ───────────────────────────────────────────
function loadEntries(base) {
  const raw = jjSafe(`log --no-graph --reversed -r '${base}..@-' -T 'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"'`);
  if (!raw) return [];

  const lines = raw.split('\n').filter(Boolean);
  const result = [];

  for (const line of lines) {
    const [changeId, sha, bookmarkStr, subject] = line.split('\t');
    if (!changeId || !subject) continue;

    const ccMatch = subject.match(/^(feat|fix|chore|docs|test|refactor|ci|style|perf)(?:\(([^)]+)\))?:\s*(.*)$/);

    // Parse bookmarks (jj may list multiple separated by spaces)
    // Match bookmarks that have metadata in .vpr/meta.json
    const allBookmarks = bookmarkStr?.trim().split(/\s+/).filter(Boolean) || [];
    const bookmarks = allBookmarks.filter(b => vprMeta.bookmarks?.[b]);
    const bookmark = bookmarks[0] || null;

    result.push({
      type: bookmark ? 'bookmark' : 'commit',
      changeId: changeId.trim(),
      sha: sha.trim(),
      subject: subject.trim(),
      bookmark,
      ccType: ccMatch ? ccMatch[1] : null,
      ccScope: ccMatch ? ccMatch[2] || null : null,
      ccDesc: ccMatch ? ccMatch[3] : subject.trim(),
    });
  }

  return result;
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

  // Add empty groups from meta that have no jj bookmark
  const activeBookmarks = new Set(groups.filter(g => g.bookmark).map(g => g.bookmark));
  for (const [bm, meta] of Object.entries(vprMeta.bookmarks || {})) {
    if (!activeBookmarks.has(bm)) {
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

  // Build flat display list
  const items = [];
  for (const group of groups) {
    const meta = group.bookmark ? (vprMeta.bookmarks?.[group.bookmark] || {}) : {};
    const title = meta.wiTitle || meta.prTitle || group.commits[0]?.ccDesc || group.bookmark || 'ungrouped';

    if (group.bookmark) {
      items.push({
        type: 'group',
        bookmark: group.bookmark,
        title,
        meta,
        commitCount: group.commits.length,
        entry: group.commits[group.commits.length - 1], // the bookmark commit (tip)
      });
    } else {
      items.push({ type: 'ungrouped-header', title: 'Ungrouped', commitCount: group.commits.length });
    }

    for (const commit of group.commits) {
      items.push({
        ...commit,
        type: group.bookmark ? 'commit' : 'ungrouped',
        group: group.bookmark,
      });
    }
  }

  return items;
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
  lines.push(`╭─ ${tpLabel}${item.title}`);
  lines.push(`│  ${DIM}${item.bookmark}${RESET}`);
  lines.push('│');

  if (meta.wi) {
    lines.push(`│  ${DIM}WI: #${meta.wi} [${meta.wiState || '?'}]${RESET}`);
  }
  lines.push(`│  ${DIM}Target: ${targetBranch || 'main'}${RESET}`);
  lines.push('│');

  addField(0, 'Ticket Title', meta.wiTitle);
  addField(1, 'Ticket Description', meta.wiDescription);

  lines.push(`│  ${CYAN}${BOLD}▸ PR Draft${RESET}`);
  lines.push('│');

  addField(2, 'PR Title', meta.prTitle || meta.wiTitle);
  addField(3, 'PR Story', meta.prDesc);

  lines.push(`│  ${DIM}Commits: ${item.commitCount}${RESET}`);
  lines.push('╰─');
  lines.push('');
  lines.push(`${DIM}J/K select field  e edit  S sync to provider${RESET}`);

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
  const bookmarkCount = entries.filter(e => e.bookmark).length;
  out += `${BOLD}VPR${RESET}  ${DIM}${bookmarkCount} bookmarks, ${entries.length} commits${RESET}`;
  if (picked) out += `  ${MAGENTA}[MOVING: ${picked.slice(0, 8)}]${RESET}`;
  out += '\n';
  out += `${DIM}j/k nav  J/K field/scroll  space move  c commit  s squash  f split  e edit  d del  n new  S sync  u undo  : jj  q quit${RESET}\n`;
  out += `${DIM}${'─'.repeat(leftW)}┬${'─'.repeat(rightW)}${RESET}\n`;

  // Scroll
  let scrollStart = 0;
  if (cursor >= scrollStart + bodyH) scrollStart = cursor - bodyH + 1;
  if (cursor < scrollStart) scrollStart = cursor;

  // Right pane content — only reset scroll when content source changes
  const currentItem = items[cursor];
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
    rightLines = getCachedDiff(currentItem.changeId || currentItem.sha).split('\n');
  }

  // Body
  for (let row = 0; row < bodyH; row++) {
    const idx = scrollStart + row;
    let leftCell = '';

    if (idx < items.length) {
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
  if (message) { out += message + '\n'; message = ''; }
  else out += '\n';

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
export function startTui(config, baseArg) {
  if (!hasJj()) { process.stderr.write('VPR requires jj (jujutsu). Install it first.\n'); process.exit(1); }

  provider = createProvider(config);
  vprMeta = loadMeta();

  // Determine base: user arg, or nearest remote bookmark ancestor, or trunk
  if (baseArg) {
    base = baseArg;
  } else {
    // Find the nearest ancestor commit that has a remote bookmark
    const nearestRemote = jjSafe(`log --no-graph -r 'ancestors(@) & remote_bookmarks()' -T 'change_id.short() ++ "\\n"' --limit 1`);
    base = nearestRemote?.trim() || 'trunk()';
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

    // Ctrl+C in normal mode — quit
    if (key.name === 'c' && key.ctrl) {
      process.stdout.write(SHOW_CURSOR + CLEAR);
      process.exit(0);
    }

    // Shift keys — context-sensitive
    const currentItem = items[cursor];
    if (key.name === 'j' && key.shift) {
      if (currentItem?.type === 'group') {
        fieldIdx = Math.min(FIELD_NAMES.length - 1, fieldIdx + 1);
      } else {
        diffScroll += 3;
      }
      render(); return;
    }
    if (key.name === 'k' && key.shift) {
      if (currentItem?.type === 'group') {
        fieldIdx = Math.max(0, fieldIdx - 1);
      } else {
        diffScroll = Math.max(0, diffScroll - 3);
      }
      render(); return;
    }
    if (key.name === 'r' && key.shift) { reload(); render(); return; }
    // S (shift+s) — save to provider
    if (key.name === 's' && key.shift) {
      if (currentItem?.type === 'group' && currentItem.bookmark) {
        const sMeta = vprMeta.bookmarks?.[currentItem.bookmark];
        if (sMeta?.wi && provider) {
          try {
            provider.updateWorkItem(sMeta.wi, { title: sMeta.wiTitle, description: sMeta.wiDescription });
            message = `${GREEN}Synced ${currentItem.bookmark} to provider${RESET}`;
          } catch { message = `${RED}Sync failed${RESET}`; }
        } else {
          message = `${DIM}No WI to sync${RESET}`;
        }
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

            fs.appendFileSync('/tmp/vpr-debug.log', `DROP: picked=${picked} pickedBm=${pickedEntry?.bookmark} pickedGroup=${pickedGroup} target=${targetChangeId} targetBm=${targetEntry?.bookmark} targetGroup=${targetGroup} sameGroup=${pickedGroup === targetGroup} flag=${rebaseFlag}\n`);

            if (pickedEntry?.bookmark && pickedGroup && pickedGroup === targetGroup) {
              // Within-group tip move: use -B to put picked before target
              // Then move bookmark to the new last commit in the group
              // Adjacent (target right below tip): -B to swap them
              // Non-adjacent (tip moving further up): -A to insert after target
              const pickedIdx = entries.findIndex(e => e.changeId === picked || e.changeId?.startsWith(picked));
              const targetIdx = entries.findIndex(e => e.changeId === targetChangeId || e.changeId?.startsWith(targetChangeId));
              const isAdjacent = (pickedIdx - targetIdx === 1);
              const tipFlag = isAdjacent ? '-B' : '-A';
              fs.appendFileSync('/tmp/vpr-debug.log', `ACTION: within-group tip move — rebase -r ${picked} ${tipFlag} ${targetChangeId} (adjacent=${isAdjacent})\n`);
              jj(`rebase -r ${picked} ${tipFlag} ${targetChangeId}`);

              // Find the new last commit in the group (excluding picked, which moved earlier)
              // After rebase, need to re-read. Use the group's items minus picked.
              const groupCommits = items.filter(i => i.group === pickedGroup && i.type === 'commit');
              const lastNonPicked = groupCommits.filter(i => i.changeId !== picked && !i.changeId?.startsWith(picked)).pop();
              if (lastNonPicked) {
                fs.appendFileSync('/tmp/vpr-debug.log', `ACTION: move bookmark ${pickedEntry.bookmark} to new tip ${lastNonPicked.changeId}\n`);
                try { jj(`bookmark set ${pickedEntry.bookmark} -r ${lastNonPicked.changeId} --allow-backwards`); } catch {}
              }
            } else {
              // Cross-group or ungrouped: rebase
              fs.appendFileSync('/tmp/vpr-debug.log', `ACTION: cross-group rebase -r ${picked} ${rebaseFlag} ${targetChangeId}\n`);
              jj(`rebase -r ${picked} ${rebaseFlag} ${targetChangeId}`);

              if (targetEntry?.bookmark && rebaseFlag === '-A') {
                fs.appendFileSync('/tmp/vpr-debug.log', `ACTION: move target bookmark ${targetEntry.bookmark} -> ${picked}\n`);
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
      case 'e': {
        // Inline edit — works from group header or any commit in a group
        const eItem = items[cursor];
        const eBm = eItem?.type === 'group' ? eItem.bookmark : eItem?.group;
        if (!eBm) { message = `${RED}No group selected${RESET}`; break; }
        const eMeta = vprMeta.bookmarks?.[eBm] || {};
        const fieldName = FIELD_NAMES[fieldIdx];
        const currentVal = eMeta[fieldName] || (fieldName === 'prTitle' ? eMeta.wiTitle : '') || '';
        startFieldEdit(eBm, fieldName, currentVal);
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
        fs.appendFileSync('/tmp/vpr-debug.log', `C: starting title popup for ${nextBm}\n`);
        startInput(`${nextBm} — Ticket title: `, '', (title) => {
          fs.appendFileSync('/tmp/vpr-debug.log', `C: title entered: "${title}", starting desc popup\n`);
          startInput(`${nextBm} — Ticket description: `, '', (desc) => { // single-line, Enter confirms
            fs.appendFileSync('/tmp/vpr-debug.log', `C: desc entered: "${desc}", creating WI with provider ${provider?.name}\n`);
            try {
              fs.appendFileSync('/tmp/vpr-debug.log', `C: calling createWorkItem("${title}", "${desc}") provider=${provider?.constructor?.name}\n`);
              let result;
              try {
                result = provider.createWorkItem(title, desc);
              } catch (e) {
                fs.appendFileSync('/tmp/vpr-debug.log', `C: createWorkItem THREW: ${e?.message} ${e?.stderr?.toString()?.slice(0,200)}\n`);
                throw e;
              }
              fs.appendFileSync('/tmp/vpr-debug.log', `C: createWorkItem returned: ${JSON.stringify(result)}\n`);
              const wi = result?.then ? null : result;
              fs.appendFileSync('/tmp/vpr-debug.log', `C: wi = ${JSON.stringify(wi)}\n`);
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
        const dItem = items[cursor];
        if (dItem?.type === 'group') {
          // Delete entire group + all commits
          const dMeta = vprMeta.bookmarks?.[dItem.bookmark] || {};
          const dLabel = dMeta.tpIndex || dItem.bookmark;
          startInput(`Delete ${dLabel} and all its commits? (y/n)`, '', (answer) => {
            if (answer !== 'y') return;
            try {
              const groupCommits = items.filter(i => i.group === dItem.bookmark && i.type === 'commit');
              for (const c of groupCommits) {
                try { jj(`abandon ${c.changeId}`); } catch {}
              }
              try { jj(`bookmark delete ${dItem.bookmark}`); } catch {}
              if (vprMeta.bookmarks?.[dItem.bookmark]) delete vprMeta.bookmarks[dItem.bookmark];
              saveMeta(vprMeta);
              reload();
              message = `${GREEN}Deleted ${dLabel}${RESET}`;
            } catch (err) {
              message = `${RED}Failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
            }
          });
        } else if (dItem?.changeId) {
          // Delete single commit
          startInput(`Abandon ${dItem.changeId.slice(0, 8)}? (y/n)`, '', (answer) => {
            if (answer !== 'y') return;
            try {
              jj(`abandon ${dItem.changeId}`);
              reload();
              message = `${GREEN}Abandoned ${dItem.changeId.slice(0, 8)}${RESET}`;
            } catch (err) {
              message = `${RED}Failed: ${(err?.stderr?.toString() || '').slice(0, 60)}${RESET}`;
            }
          });
        } else {
          message = `${RED}Nothing to delete${RESET}`;
          break;
        }
        return;
      }

      case 's': {
        // Squash — merge selected commit into its parent
        const sItem = items[cursor];
        if (!sItem?.changeId) { message = `${RED}Select a commit${RESET}`; break; }
        runJjCommand(`squash -r ${sItem.changeId}`);
        return;
      }

      case 'f': {
        // Split — split selected commit interactively
        const fItem = items[cursor];
        if (!fItem?.changeId) { message = `${RED}Select a commit${RESET}`; break; }
        runJjCommand(`split -r ${fItem.changeId}`);
        return;
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
