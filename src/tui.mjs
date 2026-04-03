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
let lastRightPaneKey = ''; // track what's in the right pane to avoid unnecessary resets
let bodyH = 20;

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
    const bookmarks = bookmarkStr?.trim().split(/\s+/).filter(b => b && b.startsWith('tp-')) || [];
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

// ── Right pane: group summary or diff ──────────────────────────────────
function getGroupSummary(item) {
  const meta = item.meta || {};
  const lines = [];

  lines.push(`╭─ ${item.bookmark}: ${item.title}`);
  lines.push('│');

  if (meta.wi) {
    lines.push(`│  WI:       #${meta.wi} [${meta.wiState || '?'}]`);
    if (meta.wiTitle) lines.push(`│  Title:    ${meta.wiTitle}`);
    if (meta.wiDescription) {
      lines.push('│  Desc:');
      for (const l of meta.wiDescription.split('\n')) lines.push(`│    ${l}`);
    }
  } else {
    lines.push('│  WI:       (press c to create)');
  }

  lines.push('│');
  lines.push('│  ─── PR Draft ───');
  lines.push('│');
  lines.push(`│  Title:    ${meta.prTitle || meta.wiTitle || '(press p to edit)'}`);
  if (meta.prDesc) {
    lines.push('│  Body:');
    for (const l of meta.prDesc.split('\n')) lines.push(`│    ${l}`);
  } else {
    lines.push('│  Body:     (press p to edit)');
  }

  lines.push('│');
  lines.push(`│  Commits:  ${item.commitCount}`);
  lines.push('╰─');

  return lines;
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
  out += `${DIM}j/k nav  J/K scroll  space move  c create ticket  w edit ticket  p PR draft  x remove  : jj cmd  R refresh  q quit${RESET}\n`;
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
    lastRightPaneKey = rightPaneKey;
  }
  let rightLines = [];
  if (currentItem?.type === 'group') {
    rightLines = getGroupSummary(currentItem);
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
        const label = `${item.bookmark}: ${item.title}`.slice(0, leftW - 6);
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
        leftCell = sel ? `${INVERT}${YELLOW}${BOLD}${label}${RESET}` : `${YELLOW}${BOLD}${label}${RESET}`;
      } else if (item.type === 'ungrouped') {
        const label = `  ${item.changeId?.slice(0, 8) || ''} ${item.subject}`.slice(0, leftW - 2);
        leftCell = sel ? `${INVERT}${YELLOW}${label}${RESET}` : `${YELLOW}${label}${RESET}`;
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
    mode = 'normal'; process.stdout.write(HIDE_CURSOR);
    const val = inputBuffer.trim(); inputBuffer = '';
    if (val && inputCallback) inputCallback(val);
    render(); return;
  }
  if (inputMultiline && key.name === 'return') { inputBuffer += '\n'; inputCursorLine++; renderPopup(); return; }
  if (inputMultiline && key.name === 's' && key.ctrl) {
    mode = 'normal'; process.stdout.write(HIDE_CURSOR);
    const val = inputBuffer.trim(); inputBuffer = '';
    if (val && inputCallback) inputCallback(val);
    render(); return;
  }
  if (key.name === 'escape') { mode = 'normal'; inputBuffer = ''; process.stdout.write(HIDE_CURSOR); render(); return; }
  if (key.name === 'backspace') {
    if (inputBuffer.endsWith('\n')) inputCursorLine = Math.max(0, inputCursorLine - 1);
    inputBuffer = inputBuffer.slice(0, -1); renderPopup(); return;
  }
  if (str && !key.ctrl && str.length === 1) { inputBuffer += str; renderPopup(); }
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

    // Input mode
    if (mode === 'input') { handleInputKey(str, key); return; }

    // jj command mode
    if (mode === 'jjcmd') {
      handleInputKey(str, key);
      return;
    }

    // Shift keys
    if (key.name === 'j' && key.shift) { diffScroll += 3; render(); return; }
    if (key.name === 'k' && key.shift) { diffScroll = Math.max(0, diffScroll - 3); render(); return; }
    if (key.name === 'r' && key.shift) { reload(); render(); return; }

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

          let targetChangeId = null;
          if (item.type === 'group') {
            targetChangeId = item.entry?.changeId;
          } else if (item.type === 'commit' && item.group) {
            // Drop onto a commit within a group — rebase before it
            targetChangeId = item.changeId;
          }

          if (!targetChangeId) {
            message = `${RED}Navigate to a bookmark group or commit to drop${RESET}`;
            break;
          }

          if (picked === targetChangeId) {
            message = `${DIM}Same commit${RESET}`;
            picked = null;
            break;
          }

          try {
            jj(`rebase -r ${picked} -A ${targetChangeId}`);
            message = `${GREEN}Moved ${picked.slice(0, 8)} after ${targetChangeId.slice(0, 8)}${RESET}`;
            picked = null;
            reload();
          } catch (err) {
            message = `${RED}Rebase failed${RESET}`;
            picked = null;
          }
        }
        break;
      }

      case 'escape':
        if (picked) { picked = null; message = `${DIM}Cancelled${RESET}`; }
        break;

      case 'c': {
        // Create ticket + jj bookmark
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
              const wi = result.then ? null : result;
              if (wi) {
                const bm = nextBm;
                vprMeta.nextIndex = idx + 1;

                // Create jj bookmark
                jj(`bookmark create ${bm} -r ${targetChangeId}`);

                // Store metadata
                if (!vprMeta.bookmarks) vprMeta.bookmarks = {};
                vprMeta.bookmarks[bm] = {
                  wi: wi.id, wiTitle: title, wiDescription: desc, wiState: 'New',
                };
                saveMeta(vprMeta);
                reload();
                message = `${GREEN}Created ${bm} with WI #${wi.id}${RESET}`;
              }
            } catch { message = `${RED}Failed to create ticket${RESET}`; }
          }, true);
        });
        return;
      }

      case 'w': {
        // Edit ticket
        const item = items[cursor];
        const bm = item?.type === 'group' ? item.bookmark : item?.group;
        if (!bm) { message = `${RED}Select a bookmark group${RESET}`; break; }
        const meta = vprMeta.bookmarks?.[bm] || {};

        startInput(`Ticket title (${bm})`, meta.wiTitle || '', (title) => {
          startInput(`Ticket description (${bm})`, meta.wiDescription || '', (desc) => {
            startInput('Save to provider? (y/n)', '', (answer) => {
              if (answer !== 'y') { message = `${DIM}Saved locally only${RESET}`; }
              if (!vprMeta.bookmarks) vprMeta.bookmarks = {};
              vprMeta.bookmarks[bm] = { ...vprMeta.bookmarks[bm], wiTitle: title, wiDescription: desc };
              if (answer === 'y' && meta.wi && provider) {
                try { provider.updateWorkItem(meta.wi, { title, description: desc }); } catch {}
              }
              saveMeta(vprMeta);
              message = `${GREEN}Ticket updated${RESET}`;
              reload();
            });
          }, true);
        });
        return;
      }

      case 'p': {
        // Edit PR draft
        const item = items[cursor];
        const bm = item?.type === 'group' ? item.bookmark : item?.group;
        if (!bm) { message = `${RED}Select a bookmark group${RESET}`; break; }
        const meta = vprMeta.bookmarks?.[bm] || {};

        startInput(`PR title (${bm})`, meta.prTitle || meta.wiTitle || '', (title) => {
          startInput(`PR body (${bm})`, meta.prDesc || '', (body) => {
            if (!vprMeta.bookmarks) vprMeta.bookmarks = {};
            vprMeta.bookmarks[bm] = { ...vprMeta.bookmarks[bm], prTitle: title, prDesc: body };
            saveMeta(vprMeta);
            message = `${GREEN}PR draft saved${RESET}`;
          }, true);
        });
        return;
      }

      case 'x': {
        // Remove bookmark + metadata
        const item = items[cursor];
        if (item?.type !== 'group') { message = `${RED}Select a bookmark group${RESET}`; break; }
        startInput(`Remove ${item.bookmark}? (y/n)`, '', (answer) => {
          if (answer !== 'y') return;
          try { jj(`bookmark delete ${item.bookmark}`); } catch {}
          if (vprMeta.bookmarks?.[item.bookmark]) delete vprMeta.bookmarks[item.bookmark];
          saveMeta(vprMeta);
          reload();
          message = `${GREEN}Removed ${item.bookmark}${RESET}`;
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

      case 'q':
        process.stdout.write(SHOW_CURSOR + CLEAR);
        process.exit(0);
        break;

      case 'c': break; // handled above (switch duplicate prevention)
    }

    render();
  });
}
