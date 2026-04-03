/**
 * VPR TUI — Interactive virtual PR manager with split-pane diff preview.
 *
 * Keys (lazygit-style):
 *   j/k    Navigate           J/K    Scroll diff
 *   space  Pick up / drop     n      New VPR group
 *   g      Merge VPRs         r      Rename VPR
 *   t      PR title           d      PR description
 *   w      Create/sync WI     R      Refresh
 *   s      Save               q      Quit
 */

import { execSync } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { git, gitSafe, jj, jjSafe, hasJj, getBase as gitGetBase, getFilesForCommit, getDiffForCommit, getNumstatForCommit, describeCommit } from './git.mjs';
import { loadConfig, loadMeta, saveMeta } from './config.mjs';
import { createProvider } from './providers/index.mjs';

function getRemoteHead() {
  return gitSafe(`rev-parse origin/${git('branch --show-current')}`);
}

function loadCommits(base, remoteHead) {
  let raw;
  if (hasJj()) {
    // jj log with template — cleaner than git format strings
    // Get commits between base and current, excluding the working copy (@)
    raw = jjSafe(`log --no-graph -r '${base}..@-' -T 'commit_id ++ "\\t" ++ description.first_line() ++ "\\t" ++ trailers().map(|t| if(t.key() == "VPR", t.value(), "")).join("") ++ "\\n"'`);
    // If jj template fails (older version), fall back to git
    if (!raw) {
      raw = git(`log --reverse --format='%H%x09%s%x09%(trailers:key=VPR,valueonly,separator=%x2C)' ${base}..HEAD`);
    }
  } else {
    raw = git(`log --reverse --format='%H%x09%s%x09%(trailers:key=VPR,valueonly,separator=%x2C)' ${base}..HEAD`);
  }
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  const all = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const sha = parts[0]?.trim();
    const subject = parts[1]?.trim();
    const trailer = parts[2]?.trim();
    if (!sha || !subject) continue;
    if (remoteHead) {
      try { execSync(`git merge-base --is-ancestor ${sha} ${remoteHead}`, { stdio: 'pipe', shell: '/bin/bash' }); continue; } catch {}
    }
    const tp = trailer || null;
    const ccMatch = subject.match(/^(feat|fix|chore|docs|test|refactor|ci|style|perf)(?:\(([^)]+)\))?:\s*(.*)$/);
    all.push({
      sha, subject, tp,
      ccType: ccMatch ? ccMatch[1] : null,
      ccScope: ccMatch ? ccMatch[2] || null : null,
      ccDesc: ccMatch ? ccMatch[3] : subject,
    });
  }
  // Only show from the first VPR-tagged commit onwards (skip old realized work)
  const firstVprIdx = all.findIndex(c => c.tp);
  if (firstVprIdx === -1) return all.slice(-20);
  return all.slice(firstVprIdx);
}

// getFilesForCommit, getDiffForCommit imported from git.mjs

let provider = null; // set in startTui()

function syncWi(tp) {
  const meta = vprMeta[tp];
  if (!meta?.wi || meta.wiSynced || !provider) return;
  try {
    // Sync is async but we call it in a sync context — use execSync wrapper
    const wi = provider.getWorkItem(meta.wi);
    if (wi.then) return; // Skip if truly async (shouldn't be with execSync providers)
    meta.wiTitle = wi.title || meta.title;
    meta.wiDescription = wi.description || '';
    meta.wiState = wi.state || '';
    meta.wiSynced = true;
    saveMeta(vprMeta);
  } catch {}
}

function getVprSummaryLines(vpr) {
  const meta = vprMeta[vpr.tp] || {};
  const lines = [];

  lines.push(`╭─ ${vpr.tp}: ${vpr.title}`);
  lines.push('│');

  // Work item
  if (meta.wi) {
    syncWi(vpr.tp);
    lines.push(`│  WI:       #${meta.wi} [${meta.wiState || '?'}]`);
    if (meta.wiTitle) lines.push(`│  Title:    ${meta.wiTitle}`);
    if (meta.wiDescription) {
      lines.push('│  Desc:');
      for (const l of meta.wiDescription.split('\n')) lines.push(`│    ${l}`);
    }
    if (meta.branch) lines.push(`│  Branch:   ${meta.branch}`);
  } else {
    lines.push('│  WI:       (press w to create)');
  }
  lines.push('│');
  lines.push('│  ─── PR Draft ───');
  lines.push('│');
  lines.push(`│  Title:    ${meta.prTitle || meta.wiTitle || meta.title || '(press t to set)'}`);
  if (meta.prDesc) {
    lines.push('│  Body:');
    for (const l of meta.prDesc.split('\n')) lines.push(`│    ${l}`);
  } else {
    lines.push(`│  Body:     (press d to write)`);
  }
  lines.push('│');

  // Commits
  lines.push(`│  Commits (${vpr.commitIdxs.length}):`);
  for (const ci of vpr.commitIdxs) {
    const c = commits[ci];
    const typeTag = c.ccType ? `[${c.ccType}]` : '[?]';
    lines.push(`│    ${c.sha.slice(0, 8)} ${typeTag} ${c.ccDesc || c.subject}`);
  }
  lines.push('│');

  // Files
  const allFiles = new Map(); // file -> {added, removed}
  for (const ci of vpr.commitIdxs) {
    try {
      const stat = git(`diff-tree --no-commit-id --numstat -r ${commits[ci].sha}`);
      for (const line of stat.split('\n').filter(Boolean)) {
        const [a, r, f] = line.split('\t');
        if (!allFiles.has(f)) allFiles.set(f, { added: 0, removed: 0 });
        const entry = allFiles.get(f);
        entry.added += parseInt(a) || 0;
        entry.removed += parseInt(r) || 0;
      }
    } catch {}
  }

  const totalAdded = [...allFiles.values()].reduce((s, f) => s + f.added, 0);
  const totalRemoved = [...allFiles.values()].reduce((s, f) => s + f.removed, 0);
  lines.push(`│  Files (${allFiles.size}):  +${totalAdded} -${totalRemoved}`);
  for (const [file, stat] of allFiles) {
    lines.push(`│    +${String(stat.added).padEnd(4)} -${String(stat.removed).padEnd(4)} ${file}`);
  }
  lines.push('│');
  lines.push('╰─');

  return lines;
}

// ── ANSI helpers ───────────────────────────────────────────────────────
const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const MAGENTA = `${ESC}35m`;
const RESET = `${ESC}0m`;
const INVERT = `${ESC}7m`;
const BG_DARK = `${ESC}48;5;236m`;

function moveTo(row, col) { return `${ESC}${row};${col}H`; }
function clearLine() { return `${ESC}2K`; }

// loadMeta, saveMeta imported from config.mjs
let vprMeta = loadMeta();

// ── State ──────────────────────────────────────────────────────────────
const MAX_VPRS = 10;
let commits = [];
let vprs = [];       // [{ tp, title, commitIdxs: [] }]
let ungrouped = [];
let cursor = 0;
let picked = null;   // index into flat items list (for space pick/drop)
let pickedCi = null; // commit index being moved
let message = '';
let dirty = false;
let diffScroll = 0;  // scroll offset for diff pane
let cachedDiffs = new Map();
let bodyH = 20;

function buildVprs() {
  const map = new Map();
  const order = [];
  ungrouped = [];
  commits.forEach((c, i) => {
    if (!c.tp) { ungrouped.push(i); return; }
    if (!map.has(c.tp)) {
      const metaTitle = vprMeta[c.tp]?.title;
      map.set(c.tp, { tp: c.tp, title: metaTitle || c.ccDesc || c.subject, commitIdxs: [] });
      order.push(c.tp);
    }
    map.get(c.tp).commitIdxs.push(i);
  });
  vprs = order.map(tp => map.get(tp));
}

function getDependencyErrors() {
  // Track first VPR that touches each file (by VPR order index)
  const fileFirstVpr = new Map(); // file -> vpr order index
  const errors = [];

  for (let vi = 0; vi < vprs.length; vi++) {
    const vpr = vprs[vi];
    for (const ci of vpr.commitIdxs) {
      const files = getFilesForCommit(commits[ci].sha);
      for (const f of files) {
        if (fileFirstVpr.has(f)) {
          const firstVi = fileFirstVpr.get(f);
          if (firstVi !== vi) {
            // File touched by two VPRs — check ordering
            if (firstVi > vi) {
              errors.push({ file: f, needs: vprs[firstVi].tp, before: vpr.tp });
            }
            // If firstVi < vi, ordering is correct — no error
          }
        } else {
          fileFirstVpr.set(f, vi);
        }
      }
    }
  }

  // Also collect shared files for display (not errors, just info)
  const sharedFiles = new Map(); // file -> [tp1, tp2]
  for (let vi = 0; vi < vprs.length; vi++) {
    const vpr = vprs[vi];
    for (const ci of vpr.commitIdxs) {
      const files = getFilesForCommit(commits[ci].sha);
      for (const f of files) {
        if (!sharedFiles.has(f)) sharedFiles.set(f, new Set());
        sharedFiles.get(f).add(vpr.tp);
      }
    }
  }

  const shared = [];
  for (const [file, tps] of sharedFiles) {
    if (tps.size > 1) shared.push({ file, vprs: [...tps].join(' → ') });
  }

  return { errors, shared };
}

function nextTp() {
  let max = 0;
  for (const c of commits) {
    if (c.tp) { const n = parseInt(c.tp.replace('TP-', '')); if (n > max) max = n; }
  }
  return `TP-${max + 1}`;
}

// ── Flat item list ─────────────────────────────────────────────────────
function buildItems() {
  const items = [];
  for (const vpr of vprs) {
    items.push({ type: 'vpr', vpr, ci: null });
    for (const ci of vpr.commitIdxs) {
      items.push({ type: 'commit', vpr, ci });
    }
  }
  if (ungrouped.length > 0) {
    items.push({ type: 'header', vpr: null, ci: null });
    for (const ci of ungrouped) {
      items.push({ type: 'ungrouped', vpr: null, ci });
    }
  }
  return items;
}

// ── Render ──────────────────────────────────────────────────────────────
function render() {
  const items = buildItems();
  const { errors, shared } = getDependencyErrors();
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  // Layout: left panel 40% (min 35), right panel rest
  const leftW = Math.max(35, Math.floor(cols * 0.4));
  const rightW = cols - leftW - 1; // 1 for border
  const headerLines = 3;
  const footerLines = 4 + (errors.length > 0 ? errors.length + 1 : 0) + (shared.length > 0 ? Math.min(shared.length, 3) + 1 : 0);
  bodyH = rows - headerLines - footerLines;

  let out = CLEAR + HIDE_CURSOR;

  // Header
  out += `${BOLD}VPR Manager${RESET}  ${DIM}${vprs.length} VPRs, ${commits.length} commits${RESET}`;
  if (dirty) out += `  ${YELLOW}●${RESET}`;
  if (picked !== null) out += `  ${MAGENTA}[MOVING: ${commits[pickedCi].sha.slice(0, 8)}]${RESET}`;
  out += '\n';
  out += `${DIM}j/k nav  J/K scroll  space move  n new  g merge  r rename  w ticket  p PR draft  R refresh  s save  q quit${RESET}\n`;
  out += `${DIM}${'─'.repeat(leftW)}┬${'─'.repeat(rightW)}${RESET}\n`;

  // Scroll left panel
  let scrollStart = 0;
  if (cursor >= scrollStart + bodyH) scrollStart = cursor - bodyH + 1;
  if (cursor < scrollStart) scrollStart = cursor;

  // Get right pane content: VPR summary for headers, diff for commits
  const currentItem = items[cursor];
  let rightLines = [];
  if (currentItem && currentItem.type === 'vpr') {
    rightLines = getVprSummaryLines(currentItem.vpr);
  } else if (currentItem && currentItem.ci !== null) {
    const sha = commits[currentItem.ci].sha;
    if (!cachedDiffs.has(sha)) cachedDiffs.set(sha, getDiffForCommit(sha));
    rightLines = cachedDiffs.get(sha).split('\n');
  }

  // Render body rows
  for (let row = 0; row < bodyH; row++) {
    const itemIdx = scrollStart + row;

    // Left panel
    let leftCell = '';
    if (itemIdx < items.length) {
      const item = items[itemIdx];
      const selected = itemIdx === cursor;
      const isPicked = picked !== null && itemIdx === picked;

      if (item.type === 'vpr') {
        const count = item.vpr.commitIdxs.length;
        const label = `${item.vpr.tp}: ${item.vpr.title}`;
        const truncated = label.slice(0, leftW - 6);
        if (selected) leftCell = `${INVERT}${CYAN}${BOLD}${truncated}${RESET} ${DIM}(${count})${RESET}`;
        else leftCell = `${CYAN}${BOLD}${truncated}${RESET} ${DIM}(${count})${RESET}`;
      } else if (item.type === 'commit' || item.type === 'ungrouped') {
        const c = commits[item.ci];
        const prefix = isPicked ? `${MAGENTA}● ` : '  ';
        const label = `${c.sha.slice(0, 8)} ${c.subject}`.slice(0, leftW - 4);
        if (selected) leftCell = `${INVERT}${prefix}${label}${RESET}`;
        else if (isPicked) leftCell = `${prefix}${label}${RESET}`;
        else if (item.type === 'ungrouped') leftCell = `${YELLOW}${prefix}${label}${RESET}`;
        else leftCell = `${prefix}${label}${RESET}`;
      } else if (item.type === 'header') {
        const label = '⚠ Ungrouped';
        if (selected) leftCell = `${INVERT}${YELLOW}${BOLD}${label}${RESET}`;
        else leftCell = `${YELLOW}${BOLD}${label}${RESET}`;
      }
    }

    // Right panel (VPR summary or diff preview)
    let rightCell = '';
    const rRow = diffScroll + row;
    if (rRow < rightLines.length) {
      let line = rightLines[rRow].slice(0, rightW - 1);
      // Color based on content
      if (currentItem?.type === 'vpr') {
        // VPR summary — use box drawing colors
        if (line.startsWith('╭') || line.startsWith('╰')) rightCell = `${CYAN}${line}${RESET}`;
        else if (line.includes('[feat]')) rightCell = line.replace('[feat]', `${GREEN}[feat]${RESET}`);
        else if (line.includes('[fix]')) rightCell = line.replace('[fix]', `${RED}[fix]${RESET}`);
        else if (line.includes('[test]')) rightCell = line.replace('[test]', `${YELLOW}[test]${RESET}`);
        else if (line.includes('[?]')) rightCell = line.replace('[?]', `${RED}[?]${RESET}`);
        else if (line.match(/^\│\s+\+/)) rightCell = `${DIM}${line}${RESET}`;
        else rightCell = `${DIM}${line}${RESET}`;
      } else {
        // Diff coloring
        if (line.startsWith('+') && !line.startsWith('+++')) rightCell = `${GREEN}${line}${RESET}`;
        else if (line.startsWith('-') && !line.startsWith('---')) rightCell = `${RED}${line}${RESET}`;
        else if (line.startsWith('@@')) rightCell = `${CYAN}${line}${RESET}`;
        else if (line.startsWith('diff ') || line.startsWith('index ')) rightCell = `${DIM}${line}${RESET}`;
        else rightCell = line;
      }
    }

    // Pad left cell to fixed width (strip ANSI for length calc)
    const visibleLen = leftCell.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, leftW - visibleLen);

    out += `${leftCell}${' '.repeat(padding)}│${rightCell}\n`;
  }

  // Footer separator
  out += `${DIM}${'─'.repeat(leftW)}┴${'─'.repeat(rightW)}${RESET}\n`;

  // Dependency errors
  if (errors.length > 0) {
    out += `${RED}Ordering errors:${RESET}\n`;
    for (const e of errors) {
      out += `  ${RED}✗${RESET} ${e.file}: ${e.needs} must come before ${e.before}\n`;
    }
  }

  // Shared files (info, not error if order is correct)
  if (shared.length > 0 && errors.length === 0) {
    const shown = shared.slice(0, 3);
    out += `${DIM}Shared files (order OK): ${shown.map(s => s.file).join(', ')}${shared.length > 3 ? ` +${shared.length - 3} more` : ''}${RESET}\n`;
  }

  // Status
  if (message) { out += message + '\n'; message = ''; }

  const ready = errors.length === 0 && ungrouped.length === 0 && vprs.length <= 10;
  if (vprs.length > MAX_VPRS) out += `${RED}Over limit: ${vprs.length} VPRs (max ${MAX_VPRS})${RESET}\n`;
  out += `${ready ? `${GREEN}Ready to render` : `${YELLOW}Not ready`}${RESET}\n`;

  process.stdout.write(out);
}

// ── Reload ─────────────────────────────────────────────────────────────
function reload() {
  const remoteHead = getRemoteHead();
  commits = loadCommits(base, remoteHead);
  cachedDiffs.clear();
  buildVprs();
  cursor = Math.min(cursor, buildItems().length - 1);
  message = `${GREEN}Refreshed (${commits.length} commits)${RESET}`;
}

// Watch .git for changes (like lazygit uses fsnotify)
let lastHead = git('rev-parse HEAD');
const gitDir = path.join(process.cwd(), '.git');
try {
  fs.watch(gitDir, { recursive: false }, (event, filename) => {
    if (!filename) return;
    // HEAD, refs, or index changed
    if (['HEAD', 'index', 'COMMIT_EDITMSG'].includes(filename) || filename.startsWith('refs')) {
      try {
        const head = git('rev-parse HEAD');
        if (head !== lastHead) { lastHead = head; reload(); render(); }
      } catch {}
    }
  });
  // Also watch refs/heads for branch changes
  const refsDir = path.join(gitDir, 'refs', 'heads');
  if (fs.existsSync(refsDir)) {
    fs.watch(refsDir, { recursive: true }, () => {
      try {
        const head = git('rev-parse HEAD');
        if (head !== lastHead) { lastHead = head; reload(); render(); }
      } catch {}
    });
  }
} catch {
  // Fallback to polling if fs.watch fails
  setInterval(() => {
    try {
      const head = git('rev-parse HEAD');
      if (head !== lastHead) { lastHead = head; reload(); render(); }
    } catch {}
  }, 2000);
}

// ── Actions ────────────────────────────────────────────────────────────
function pickOrDrop() {
  const items = buildItems();
  const item = items[cursor];

  if (picked === null) {
    // Pick up
    if (!item || (item.type !== 'commit' && item.type !== 'ungrouped')) {
      message = `${RED}Select a commit to pick up${RESET}`;
      return;
    }
    picked = cursor;
    pickedCi = item.ci;
    message = `${MAGENTA}Picked ${commits[pickedCi].sha.slice(0, 8)} — navigate to target VPR and press space to drop${RESET}`;
  } else {
    // Drop onto current position
    if (!item) { message = `${RED}Navigate to a VPR to drop${RESET}`; return; }

    let targetTp = null;
    if (item.type === 'vpr') {
      targetTp = item.vpr.tp;
    } else if (item.type === 'commit') {
      targetTp = item.vpr.tp;
    } else {
      message = `${RED}Navigate to a VPR or commit within a VPR to drop${RESET}`;
      return;
    }

    if (commits[pickedCi].tp === targetTp) {
      message = `${DIM}Already in ${targetTp}${RESET}`;
      picked = null;
      pickedCi = null;
      return;
    }

    commits[pickedCi].tp = targetTp;
    dirty = true;
    message = `${GREEN}Dropped into ${targetTp}${RESET}`;
    picked = null;
    pickedCi = null;
    buildVprs();
  }
}

function mergeVpr(input) {
  const items = buildItems();
  const item = items[cursor];
  if (!item || item.type !== 'vpr') { message = `${RED}Select a VPR header first${RESET}`; return false; }

  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= vprs.length) { message = `${RED}Invalid selection${RESET}`; return false; }

  const source = item.vpr;
  const target = vprs[idx];
  if (source.tp === target.tp) { message = `${RED}Can't merge into self${RESET}`; return false; }

  for (const ci of source.commitIdxs) {
    commits[ci].tp = target.tp;
  }

  dirty = true;
  message = `${GREEN}Merged ${source.tp} into ${target.tp}${RESET}`;
  cursor = 0;
  buildVprs();
  return true;
}

function save() {
  const edits = [];

  for (const c of commits) {
    const currentSubject = git(`log -1 --format=%s ${c.sha}`);
    const currentTrailer = git(`log -1 --format='%(trailers:key=VPR,valueonly)' ${c.sha}`).trim();
    const needsSubjectChange = currentSubject !== c.subject;
    const needsTrailerChange = (c.tp || '') !== (currentTrailer || '');

    if (needsSubjectChange || needsTrailerChange) {
      edits.push({ sha: c.sha, newSubject: c.subject, newTp: c.tp });
    }
  }

  if (edits.length === 0) { message = `${DIM}No changes to save${RESET}`; dirty = false; return; }

  if (hasJj()) {
    // jj: instant describe per commit — no rebase needed
    let saved = 0;
    for (const e of edits) {
      try {
        let msg = e.newSubject;
        if (e.newTp) msg += `\n\nVPR: ${e.newTp}`;
        describeCommit(e.sha, msg);
        saved++;
      } catch (err) {
        message = `${RED}Failed to describe ${e.sha.slice(0, 8)}${RESET}`;
        return;
      }
    }
    message = `${GREEN}Saved ${saved} commit(s) via jj describe${RESET}`;
    dirty = false;
    cachedDiffs.clear();
    const remoteHead = getRemoteHead();
    commits = loadCommits(getBase(), remoteHead);
    buildVprs();
  } else {
    // git fallback: interactive rebase (complex, fragile)
    const base = getBase();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-'));
    const sedCmds = edits.map(e => `s/^pick ${e.sha.slice(0, 7)}/reword ${e.sha.slice(0, 7)}/`).join('; ');

    const mapFile = path.join(tmpDir, 'map.json');
    const mapData = {};
    for (const e of edits) {
      mapData[e.sha.slice(0, 7)] = { subject: e.newSubject, tp: e.newTp };
    }
    fs.writeFileSync(mapFile, JSON.stringify(mapData));

    const editorScript = path.join(tmpDir, 'editor.sh');
    fs.writeFileSync(editorScript, `#!/bin/bash
MSG_FILE="$1"
SHORT_SHA=$(git log -1 --format=%h 2>/dev/null)
RESULT=$(node -e "
  const map = require('${mapFile}');
  const sha = '$SHORT_SHA';
  for (const [k, v] of Object.entries(map)) {
    if (sha.startsWith(k) || k.startsWith(sha)) {
      let msg = v.subject;
      if (v.tp) msg += '\\n\\nVPR: ' + v.tp;
      console.log(msg);
      process.exit(0);
    }
  }
  process.exit(1);
" 2>/dev/null)
if [ $? -eq 0 ] && [ -n "$RESULT" ]; then echo "$RESULT" > "$MSG_FILE"; fi
`, { mode: 0o755 });

    try {
      execSync(`git rebase -i ${base}`, {
        stdio: 'pipe',
        env: { ...process.env, GIT_SEQUENCE_EDITOR: `sed -i '${sedCmds}'`, GIT_EDITOR: editorScript }
      });
      message = `${GREEN}Saved ${edits.length} commit(s) via git rebase${RESET}`;
      dirty = false;
      cachedDiffs.clear();
      const remoteHead = getRemoteHead();
      commits = loadCommits(base, remoteHead);
      buildVprs();
    } catch {
      try { execSync('git rebase --abort', { stdio: 'pipe' }); } catch {}
      message = `${RED}Save failed — rebase aborted. Branch unchanged.${RESET}`;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ── Input mode state ───────────────────────────────────────────────────
let mode = 'normal'; // normal, merge, input
let inputBuffer = '';
let inputPrompt = '';
let inputCallback = null;

/**
 * Centered popup input — lazygit style.
 * Single-line: one input row. Multi-line: multiple rows, Enter adds newline, Ctrl+S saves.
 */
let inputMultiline = false;
let inputCursorLine = 0;

function startInput(prompt, defaultVal, callback, multiline = false) {
  mode = 'input';
  inputPrompt = prompt;
  inputMultiline = multiline;
  inputCallback = callback;
  if (multiline) {
    inputBuffer = defaultVal || '';
    inputCursorLine = inputBuffer.split('\n').length - 1;
  } else {
    inputBuffer = defaultVal || '';
  }
  renderPopup();
}

function renderPopup() {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const boxW = Math.min(70, cols - 4);
  const innerW = boxW - 4;
  const lines = inputMultiline ? inputBuffer.split('\n') : [inputBuffer];
  const contentH = inputMultiline ? Math.max(lines.length, 3) : 1;
  const boxH = contentH + 4; // border + padding + help + border
  const startCol = Math.floor((cols - boxW) / 2);
  const startRow = Math.max(1, Math.floor((rows - boxH) / 2));

  const title = ` ${inputPrompt} `;
  const titlePad = Math.max(0, Math.floor((boxW - 2 - title.length) / 2));

  let out = '';

  // Top border
  out += `${ESC}${startRow};${startCol}H`;
  out += `${CYAN}╭${'─'.repeat(titlePad)}${BOLD}${title}${RESET}${CYAN}${'─'.repeat(Math.max(0, boxW - 2 - titlePad - title.length))}╮${RESET}`;

  // Content lines
  for (let i = 0; i < contentH; i++) {
    const line = (lines[i] || '').slice(0, innerW);
    const pad = inputMultiline && i === lines.length
      ? '░'.repeat(Math.max(0, innerW - line.length))
      : ' '.repeat(Math.max(0, innerW - line.length));
    out += `${ESC}${startRow + 1 + i};${startCol}H`;
    out += `${CYAN}│${RESET} ${line}${i < lines.length ? '░'.repeat(Math.max(0, innerW - line.length)) : pad} ${CYAN}│${RESET}`;
  }

  // Help line
  const helpText = inputMultiline
    ? '  Ctrl+S save · Esc cancel · Enter newline'
    : '  Enter confirm · Esc cancel';
  out += `${ESC}${startRow + 1 + contentH};${startCol}H`;
  out += `${CYAN}│${RESET}${DIM}${helpText}${' '.repeat(Math.max(0, boxW - 2 - helpText.length))}${RESET}${CYAN}│${RESET}`;

  // Bottom border
  out += `${ESC}${startRow + 2 + contentH};${startCol}H`;
  out += `${CYAN}╰${'─'.repeat(boxW - 2)}╯${RESET}`;

  // Position cursor
  const cursorLineIdx = inputMultiline ? Math.min(inputCursorLine, lines.length - 1) : 0;
  const cursorLineText = lines[cursorLineIdx] || '';
  const cursorCol = startCol + 2 + cursorLineText.length;
  out += `${ESC}${startRow + 1 + cursorLineIdx};${cursorCol}H${SHOW_CURSOR}`;

  process.stdout.write(out);
}

function handleInputKey(str, key) {
  if (!inputMultiline && key.name === 'return') {
    // Single-line: Enter confirms
    mode = 'normal';
    process.stdout.write(HIDE_CURSOR);
    const val = inputBuffer.trim();
    inputBuffer = '';
    if (val && inputCallback) inputCallback(val);
    render();
    return;
  }
  if (inputMultiline && key.name === 'return') {
    // Multi-line: Enter adds newline
    inputBuffer += '\n';
    inputCursorLine++;
    renderPopup();
    return;
  }
  if (inputMultiline && key.name === 's' && key.ctrl) {
    // Multi-line: Ctrl+S saves
    mode = 'normal';
    process.stdout.write(HIDE_CURSOR);
    const val = inputBuffer.trim();
    inputBuffer = '';
    if (val && inputCallback) inputCallback(val);
    render();
    return;
  }
  if (key.name === 'escape') {
    mode = 'normal';
    inputBuffer = '';
    process.stdout.write(HIDE_CURSOR);
    render();
    return;
  }
  if (key.name === 'backspace') {
    if (inputBuffer.length > 0) {
      if (inputBuffer.endsWith('\n')) inputCursorLine = Math.max(0, inputCursorLine - 1);
      inputBuffer = inputBuffer.slice(0, -1);
    }
    renderPopup();
    return;
  }
  if (str && !key.ctrl && str.length === 1) {
    inputBuffer += str;
    renderPopup();
  }
}

/**
 * Open $EDITOR for multi-line input (like lazygit for commit messages).
 */
function openEditor(initialContent, callback) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  const tmpFile = path.join(os.tmpdir(), `vpr-edit-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, initialContent || '');

  // Restore terminal for editor
  process.stdout.write(SHOW_CURSOR + CLEAR);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  try {
    execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
    const result = fs.readFileSync(tmpFile, 'utf-8').trim();
    callback(result);
  } catch {
    message = `${RED}Editor failed${RESET}`;
  } finally {
    fs.rmSync(tmpFile, { force: true });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write(HIDE_CURSOR);
    render();
  }
}

// ── Main ───────────────────────────────────────────────────────────────
export function startTui(config, baseArg) {
  provider = createProvider(config);
  vprMeta = loadMeta();

  const base = baseArg || gitGetBase();
  if (!base) { process.stderr.write('Could not find base branch\n'); process.exit(1); }

  const remoteHead = getRemoteHead();
  commits = loadCommits(base, remoteHead);
  buildVprs();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', () => process.stdout.write(SHOW_CURSOR + CLEAR));

  render();

process.stdin.on('keypress', (str, key) => {
  if (!key) return;
  const items = buildItems();

  // Input mode: inline text entry
  if (mode === 'input') {
    handleInputKey(str, key);
    return;
  }

  // Merge mode: waiting for number input
  if (mode === 'merge') {
    if (str >= '1' && str <= '9') {
      mergeVpr(str);
    } else {
      message = `${DIM}Cancelled${RESET}`;
    }
    mode = 'normal';
    render();
    return;
  }

  // Shift keys (check before switch since key.name is lowercase)
  if (key.name === 'j' && key.shift) { diffScroll += 3; render(); return; }
  if (key.name === 'k' && key.shift) { diffScroll = Math.max(0, diffScroll - 3); render(); return; }
  if (key.name === 'r' && key.shift) { reload(); render(); return; }

  switch (key.name || str) {
    case 'up': case 'k':
      cursor = Math.max(0, cursor - 1);
      diffScroll = 0;
      break;
    case 'down': case 'j':
      cursor = Math.min(items.length - 1, cursor + 1);
      diffScroll = 0;
      break;

    // Scroll diff pane
    case 'pagedown': diffScroll += bodyH; break;
    case 'pageup': diffScroll = Math.max(0, diffScroll - bodyH); break;

    case 'space':
      pickOrDrop();
      break;

    case 'escape':
      if (picked !== null) {
        picked = null; pickedCi = null;
        message = `${DIM}Cancelled move${RESET}`;
      }
      break;

    case 'n': {
      const tp = nextTp();
      startInput(`New VPR (${tp}) title: `, '', (title) => {
        const item = buildItems()[cursor];
        if (item && (item.type === 'commit' || item.type === 'ungrouped')) {
          commits[item.ci].tp = tp;
          dirty = true;
          message = `${GREEN}Created ${tp} and moved commit${RESET}`;
        } else {
          message = `${DIM}Created ${tp}: ${title}${RESET}`;
        }
        vprMeta[tp] = { ...vprMeta[tp], title };
        saveMeta(vprMeta);
        buildVprs();
      });
      return;
    }

    case 'g':
      if (items[cursor]?.type !== 'vpr') { message = `${RED}Select a VPR header to merge${RESET}`; break; }
      mode = 'merge';
      message = `${CYAN}Merge into which VPR? (1-${vprs.length})${RESET}\n` +
        vprs.map((v, i) => `  ${i + 1}) ${v.tp}: ${v.title}`).join('\n');
      break;

    case 'r': {
      if (items[cursor]?.type !== 'vpr') { message = `${RED}Select a VPR header to rename${RESET}`; break; }
      const vprToRename = items[cursor].vpr;
      startInput(`Rename ${vprToRename.tp}: `, vprToRename.title, (title) => {
        vprToRename.title = title;
        vprMeta[vprToRename.tp] = { ...vprMeta[vprToRename.tp], title };
        saveMeta(vprMeta);
        message = `${GREEN}Renamed ${vprToRename.tp}${RESET}`;
        buildVprs();
      });
      return;
    }

    case 'w': {
      // Edit ticket: title → description → confirm save
      if (items[cursor]?.type !== 'vpr') { message = `${RED}Select a VPR header${RESET}`; break; }
      const vprForWi = items[cursor].vpr;
      const wiMeta = vprMeta[vprForWi.tp] || {};
      const wiTitle = wiMeta.wiTitle || wiMeta.title || vprForWi.title || '';
      const wiDesc = wiMeta.wiDescription || '';

      startInput(`Ticket title (${vprForWi.tp})`, wiTitle, (title) => {
        startInput(`Ticket description (${vprForWi.tp})`, wiDesc, (desc) => {
          startInput(`Save ticket? (y/n)`, '', (answer) => {
            if (answer !== 'y') { message = `${DIM}Cancelled${RESET}`; return; }
            vprMeta[vprForWi.tp] = {
              ...vprMeta[vprForWi.tp],
              wiTitle: title,
              wiDescription: desc,
              title: title,
            };
            if (wiMeta.wi && provider) {
              try { provider.updateWorkItem(wiMeta.wi, { title, description: desc }); } catch {}
            }
            saveMeta(vprMeta);
            message = `${GREEN}Ticket saved for ${vprForWi.tp}${RESET}`;
            buildVprs();
          });
        }, true);
      });
      return;
    }

    case 'p': {
      // Edit PR draft: title → body → save
      if (items[cursor]?.type !== 'vpr') { message = `${RED}Select a VPR header${RESET}`; break; }
      const vprForPr = items[cursor].vpr;
      const prMeta = vprMeta[vprForPr.tp] || {};
      const prTitle = prMeta.prTitle || prMeta.wiTitle || prMeta.title || vprForPr.title || '';
      const prDesc = prMeta.prDesc || prMeta.wiDescription || '';

      startInput(`PR title (${vprForPr.tp})`, prTitle, (title) => {
        startInput(`PR body (${vprForPr.tp})`, prDesc, (body) => {
          vprMeta[vprForPr.tp] = {
            ...vprMeta[vprForPr.tp],
            prTitle: title,
            prDesc: body,
          };
          saveMeta(vprMeta);
          message = `${GREEN}PR draft saved for ${vprForPr.tp}${RESET}`;
        }, true);
      });
      return;
    }

    case 's':
      save();
      break;

    case 'q':
      if (dirty) {
        message = `${YELLOW}Unsaved changes! q again to quit, s to save${RESET}`;
        render();
        process.stdin.once('keypress', (s, k) => {
          if (k?.name === 'q' || s === 'q') { process.stdout.write(SHOW_CURSOR + CLEAR); process.exit(0); }
          if (s === 's') { save(); }
          render();
        });
        return;
      }
      process.stdout.write(SHOW_CURSOR + CLEAR);
      process.exit(0);
      break;

    case 'c':
      if (key.ctrl) { process.stdout.write(SHOW_CURSOR + CLEAR); process.exit(0); }
      break;
  }

  render();
});
} // end startTui
