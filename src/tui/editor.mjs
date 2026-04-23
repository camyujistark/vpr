import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── Terminal helpers ──────────────────────────────────────────────────────────

/**
 * Open $EDITOR with `initial` content in a temp file. When the editor closes,
 * reads the file and calls `callback(content)`. Handles TUI state: shows
 * cursor, drops raw mode before opening, restores after.
 *
 * @param {string} initial
 * @param {(content: string) => void} callback
 */
export function openEditor(initial, callback) {
  const editor = process.env.EDITOR || 'vim';
  const tmp = path.join(os.tmpdir(), `vpr-${Date.now()}.md`);
  fs.writeFileSync(tmp, initial || '');

  // Restore terminal for editor
  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); // show cursor, clear
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  try {
    execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
    const result = fs.readFileSync(tmp, 'utf-8').trim();
    callback(result);
  } catch {
    // editor failed — ignore
  } finally {
    fs.rmSync(tmp, { force: true });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdout.write('\x1b[?25l'); // hide cursor
  }
}

// ─── Bulk edit ────────────────────────────────────────────────────────────────

/**
 * Builds the content for the `E` key — all items/VPRs with title/story/output
 * sections grouped under item headers.
 *
 * @param {object} state — result of buildState()
 * @returns {string}
 */
export function buildBulkEditContent(state) {
  const lines = [];

  for (const item of state.items) {
    const label = item.wi ? `${item.wiTitle} (#${item.wi})` : item.name;
    lines.push(`# ${'═'.repeat(39)}`);
    lines.push(`# ${label}`);
    lines.push(`# ${'═'.repeat(39)}`);
    lines.push('');

    for (const vpr of item.vprs) {
      lines.push(`## ${vpr.title || vpr.bookmark}`);
      lines.push('--- Title ---');
      lines.push(vpr.title || '');
      lines.push('');
      lines.push('--- Story ---');
      lines.push(vpr.story || '');
      lines.push('');
      lines.push('--- Output ---');
      lines.push(vpr.output || '');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parses the bulk editor content back into an array of updates.
 *
 * @param {string} content
 * @param {object} state — result of buildState()
 * @returns {Array<{ itemName: string, bookmark: string, title: string, story: string, output: string }>}
 */
export function parseBulkEditContent(content, state) {
  // Build a flat ordered lookup of VPRs matching the order in buildBulkEditContent
  const vprOrder = [];
  for (const item of state.items) {
    for (const vpr of item.vprs) {
      vprOrder.push({ itemName: item.name, bookmark: vpr.bookmark, title: vpr.title });
    }
  }

  const updates = [];
  let currentVprIndex = -1;
  let section = null; // 'title' | 'story' | 'output'
  let buffer = [];

  const flush = () => {
    if (currentVprIndex < 0 || !section) return;
    const meta = vprOrder[currentVprIndex];
    if (!meta) return;
    const value = buffer.join('\n').trim();

    // Find or create the update entry
    let entry = updates.find(u => u.bookmark === meta.bookmark);
    if (!entry) {
      entry = { itemName: meta.itemName, bookmark: meta.bookmark, title: '', story: '', output: '' };
      updates.push(entry);
    }
    entry[section] = value;
    buffer = [];
    section = null;
  };

  for (const raw of content.split('\n')) {
    // VPR header: ## <title> — must check before single # skip
    if (raw.startsWith('## ')) {
      flush();
      currentVprIndex++;
      section = null;
      continue;
    }

    // Skip comment lines (single # — checked after ## to not swallow VPR headers)
    if (raw.startsWith('#')) continue;

    // Section markers
    if (raw === '--- Title ---') { flush(); section = 'title'; continue; }
    if (raw === '--- Story ---') { flush(); section = 'story'; continue; }
    if (raw === '--- Output ---') { flush(); section = 'output'; continue; }

    // Content line
    if (section !== null) {
      buffer.push(raw);
    }
  }
  flush();

  return updates;
}

// ─── Single-VPR story + output edit ───────────────────────────────────────────

/**
 * Builds content for the `s` key — edit story and output for one VPR.
 *
 * @param {{ title?: string, bookmark?: string, story?: string, output?: string }} vpr
 * @returns {string}
 */
export function buildStoryEditContent(vpr) {
  const label = vpr.title || vpr.bookmark || '';
  const lines = [
    `# ${label}`,
    '# Edit the story, and optionally adjust the output below it.',
    '# Save and close to apply both.',
    '',
    '--- Story ---',
    vpr.story || '',
    '',
    '--- Output ---',
    vpr.output || '',
    '',
  ];
  return lines.join('\n');
}

/**
 * Parse content from buildStoryEditContent back into { story, output }.
 *
 * @param {string} content
 * @returns {{ story: string, output: string }}
 */
export function parseStoryEditContent(content) {
  let section = null; // 'story' | 'output'
  const buffers = { story: [], output: [] };

  for (const raw of content.split('\n')) {
    if (raw === '--- Story ---') { section = 'story'; continue; }
    if (raw === '--- Output ---') { section = 'output'; continue; }
    if (raw.startsWith('#')) continue;
    if (section) buffers[section].push(raw);
  }

  return {
    story: buffers.story.join('\n').trim(),
    output: buffers.output.join('\n').trim(),
  };
}

// ─── Reorder ──────────────────────────────────────────────────────────────────

/**
 * Builds content for the `O` key — list of VPR bookmarks grouped by item.
 *
 * @param {object} state — result of buildState()
 * @returns {string}
 */
export function buildReorderContent(state) {
  const lines = [
    '# Reorder VPRs — move lines to set push order',
    '# Save and close to apply',
  ];

  for (const item of state.items) {
    lines.push('#');
    lines.push(`# [${item.name}]`);
    for (const vpr of item.vprs) {
      lines.push(`${vpr.bookmark}          # ${vpr.title || vpr.bookmark}`);
    }
  }

  return lines.join('\n');
}

/**
 * Parse reorder content back. Returns array of bookmark names in order.
 * Ignores `#` lines and empty lines.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function parseReorderContent(content) {
  const bookmarks = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Strip inline comment
    const bookmark = line.split('#')[0].trim();
    if (bookmark) bookmarks.push(bookmark);
  }
  return bookmarks;
}

// ─── Interactive rebase ───────────────────────────────────────────────────────

/**
 * Builds content for the `i` key — rebase-i style list of commits.
 *
 * @param {Array<{ changeId: string, subject: string, files: string[] }>} vprCommits
 * @param {Array<{ changeId: string, subject: string, files: string[] }>} [ungroupedCommits]
 * @returns {string}
 */
export function buildInteractiveContent(vprCommits, ungroupedCommits) {
  const lines = [
    '# Interactive rebase',
    '# Commands: pick, squash, drop, reword "new message"',
    '#',
  ];

  for (const commit of vprCommits) {
    const filesSummary = commit.files && commit.files.length
      ? `(${commit.files.slice(0, 3).join(', ')}${commit.files.length > 3 ? ', …' : ''})`
      : '';
    const suffix = filesSummary ? `        ${filesSummary}` : '';
    lines.push(`pick ${commit.changeId} ${commit.subject}${suffix}`);
  }

  if (ungroupedCommits && ungroupedCommits.length > 0) {
    lines.push('');
    lines.push('# ─── Ungrouped (uncomment to include) ───');
    for (const commit of ungroupedCommits) {
      const filesSummary = commit.files && commit.files.length
        ? `(${commit.files.slice(0, 3).join(', ')}${commit.files.length > 3 ? ', …' : ''})`
        : '';
      const suffix = filesSummary ? `        ${filesSummary}` : '';
      lines.push(`# pick ${commit.changeId} ${commit.subject}${suffix}`);
    }
  }

  return lines.join('\n');
}

/**
 * Parse interactive rebase content back.
 *
 * @param {string} content
 * @returns {Array<{ action: string, changeId: string, subject: string, newMessage?: string }>}
 */
export function parseInteractiveContent(content) {
  const results = [];
  const actionRe = /^(pick|squash|drop|reword)\s+(\S+)\s*(.*)?$/;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(actionRe);
    if (!m) continue;

    const [, action, changeId, rest = ''] = m;
    const entry = { action, changeId, subject: rest.trim() };

    // reword may carry a quoted new message: reword ab12 "new message"
    if (action === 'reword') {
      const quoted = rest.match(/^"([^"]*)"/) || rest.match(/^'([^']*)'/);;
      if (quoted) {
        entry.newMessage = quoted[1];
        entry.subject = rest.slice(quoted[0].length).trim();
      }
    }

    results.push(entry);
  }

  return results;
}
