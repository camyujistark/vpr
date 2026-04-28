/**
 * TUI main loop — wires state, tree, render, and mode handlers.
 */

import { buildState } from '../core/state.mjs';
import { getDiff, getFiles, getVprFiles } from '../core/jj.mjs';
import { buildTree, findNextUpCursor } from './tree.mjs';
import { render, CLEAR, HIDE_CURSOR, SHOW_CURSOR } from './render.mjs';
import { handleNormalKey } from './modes/normal.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load .vpr/config.json from cwd, or return empty object.
 */
function loadConfig() {
  const path = join(process.cwd(), '.vpr', 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Build the right pane content for the current cursor position.
 *
 * @param {object} current — current tree item at cursor
 * @param {string} rightView — 'diff' or 'files'
 * @param {object} state — buildState() result
 * @returns {string[]}
 */
function buildRightContent(current, rightView, state, vprFilesCache) {
  if (!current) return [];

  // Commit — show diff or file summary
  if (current.type === 'commit' || current.type === 'ungrouped' || current.type === 'hold') {
    try {
      if (rightView === 'files') {
        return getFiles(current.changeId);
      }
      const diff = getDiff(current.changeId);
      return diff ? diff.split('\n') : ['(no diff)'];
    } catch {
      return ['(error loading diff)'];
    }
  }

  // VPR — show story + output metadata
  if (current.type === 'vpr') {
    const lines = [];
    lines.push(`VPR: ${current.title || current.bookmark}`);
    lines.push(`Bookmark: ${current.bookmark}`);
    lines.push(`Commits: ${current.commitCount}`);
    lines.push(`Sent: ${current.sent ? 'yes' : 'no'}`);
    lines.push(`Conflict: ${current.conflict ? 'yes' : 'no'}`);
    lines.push('');

    const item = state.items.find(i => i.name === current.itemName);
    const vpr = item?.vprs.find(v => v.bookmark === current.bookmark);
    const changeIds = vpr?.commits.map(c => c.changeId) ?? [];
    if (changeIds.length > 0) {
      let files = vprFilesCache?.get(current.bookmark);
      if (files === undefined) {
        files = getVprFiles(changeIds);
        vprFilesCache?.set(current.bookmark, files);
      }
      if (files.length > 0) {
        lines.push(`─── Files (${files.length}) ───`);
        lines.push(...files);
        lines.push('');
      }
    }

    if (current.story) {
      lines.push('─── Story ───');
      lines.push(...current.story.split('\n'));
      lines.push('');
    }

    if (current.output) {
      lines.push('─── Output ───');
      lines.push(...current.output.split('\n'));
    }

    return lines;
  }

  // Item — summary
  if (current.type === 'item') {
    const item = state.items.find(i => i.name === current.name);
    if (!item) return [];

    const lines = [];
    lines.push(`Item: ${item.wiTitle || item.name}`);
    if (item.wi) lines.push(`Work Item: #${item.wi}`);
    lines.push(`VPRs: ${item.vprs.length}`);
    lines.push('');

    for (const vpr of item.vprs) {
      const icon = vpr.sent ? '✓' : vpr.conflict ? '!' : '·';
      lines.push(`  ${icon} ${vpr.title || vpr.bookmark} (${vpr.commits.length} commits)`);
    }

    return lines;
  }

  // Headers
  if (current.type === 'ungrouped-header') {
    return [`Ungrouped commits: ${current.count}`, '', 'These commits are not assigned to any VPR.', 'Use `a` to add a VPR, or `H` to hold them.'];
  }

  if (current.type === 'hold-header') {
    return [`On Hold: ${current.count}`, '', 'These commits are parked.', 'Navigate to one and press `H` to unhold.'];
  }

  return [];
}

/**
 * Start the TUI main loop.
 */
export async function startTui() {
  const config = loadConfig();

  // ─── Mutable state ─────────────────────────────────────────────────
  let state, treeItems;
  let cursor = 0;
  let scrollStart = 0;
  let diffScroll = 0;
  let rightView = 'diff';
  let message = '';
  let mode = 'normal';
  let busy = false; // true while a prompt or async action is in progress
  let picked = null; // changeId of commit being moved (space-to-move)
  let vprFilesCache = new Map(); // vpr bookmark → files[] (invalidated on reload)

  // ─── State builders ────────────────────────────────────────────────

  async function reload() {
    state = await buildState();
    treeItems = buildTree(state);
    vprFilesCache = new Map();
    // Clamp cursor
    if (cursor >= treeItems.length) cursor = Math.max(0, treeItems.length - 1);
  }

  function renderFn() {
    // Auto-scroll tree to keep cursor visible
    const bodyRows = Math.max(1, (process.stdout.rows || 40) - 4);
    if (cursor < scrollStart) scrollStart = cursor;
    if (cursor >= scrollStart + bodyRows) scrollStart = cursor - bodyRows + 1;

    const current = treeItems[cursor] ?? null;
    const rightContent = buildRightContent(current, rightView, state, vprFilesCache);
    render(state, treeItems, cursor, scrollStart, diffScroll, rightContent, mode, message, picked);
    // Clear message after render (one-shot display)
    message = '';
  }

  // ─── Setters for mode handlers ────────────────────────────────────

  function setCursor(n) { cursor = n; }
  function setDiffScroll(n) { diffScroll = n; }
  function setRightView(v) { rightView = v; }
  function setMessage(m) { message = m; }
  function getPicked() { return picked; }
  function setPicked(p) { picked = p; }

  // ─── Initial load ─────────────────────────────────────────────────

  await reload();
  cursor = findNextUpCursor(treeItems);

  // ─── Terminal setup ────────────────────────────────────────────────

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdout.write(HIDE_CURSOR);

  // Initial render
  renderFn();

  // ─── Keypress listener ────────────────────────────────────────────

  const { emitKeypressEvents } = await import('node:readline');
  emitKeypressEvents(process.stdin);

  process.stdin.on('keypress', async (str, key) => {
    // Ctrl-C always exits
    if (key?.ctrl && key.name === 'c') {
      process.stdout.write(SHOW_CURSOR + '\x1b[2J\x1b[H');
      process.exit(0);
    }

    if (busy) return;

    if (mode === 'normal') {
      busy = true;
      try {
        await handleNormalKey(str, key, {
          state, treeItems, cursor, setCursor,
          diffScroll, setDiffScroll,
          rightView, setRightView,
          message, setMessage,
          picked: getPicked(), setPicked,
          reload, render: renderFn,
          config,
        });
      } finally {
        busy = false;
      }
    }
  });

  // ─── Resize handler ───────────────────────────────────────────────

  process.stdout.on('resize', () => {
    renderFn();
  });

  // ─── Cleanup on exit ──────────────────────────────────────────────

  process.on('exit', () => {
    process.stdout.write(SHOW_CURSOR);
  });

  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR + '\x1b[2J\x1b[H');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
}
