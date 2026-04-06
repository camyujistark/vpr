/**
 * Normal mode key handler for the TUI.
 *
 * Each handler returns true if the key was consumed, false otherwise.
 */

import readline from 'node:readline';
import { jj, jjSafe, getDiff, getFiles } from '../../core/jj.mjs';
import { ticketNew } from '../../commands/ticket.mjs';
import { addVpr } from '../../commands/add.mjs';
import { editVpr } from '../../commands/edit.mjs';
import { hold, unhold } from '../../commands/hold.mjs';
import { removeVpr } from '../../commands/remove.mjs';
import { sendChecks, send } from '../../commands/send.mjs';
import {
  openEditor,
  buildBulkEditContent,
  parseBulkEditContent,
  buildReorderContent,
  parseReorderContent,
  buildInteractiveContent,
  parseInteractiveContent,
} from '../editor.mjs';
import { loadMeta, saveMeta } from '../../core/meta.mjs';
import { SHOW_CURSOR, HIDE_CURSOR } from '../render.mjs';

// ─── Prompt helper ───────────────────────────────────────────────────────────

/**
 * Drop raw mode, prompt the user for a line of input, then restore raw mode.
 * Returns the trimmed input, or null if cancelled (empty / Ctrl-C).
 */
function prompt(question) {
  return new Promise((resolve) => {
    // Show cursor, move to bottom
    process.stdout.write(SHOW_CURSOR);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdout.write(HIDE_CURSOR);
      const trimmed = answer?.trim();
      resolve(trimmed || null);
    });

    rl.on('close', () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdout.write(HIDE_CURSOR);
    });
  });
}

/**
 * Prompt for yes/no confirmation. Returns true if 'y' or 'Y'.
 */
async function confirm(question) {
  const answer = await prompt(`${question} (y/N) `);
  return answer && answer.toLowerCase() === 'y';
}

// ─── Item lookup ─────────────────────────────────────────────────────────────

/** Walk backwards from cursor to find the parent item name. */
function findParentItem(treeItems, cursor) {
  for (let i = cursor; i >= 0; i--) {
    if (treeItems[i].type === 'item') return treeItems[i].name;
  }
  return null;
}

// ─── Key handler ─────────────────────────────────────────────────────────────

/**
 * Handle a keypress in normal mode.
 *
 * @param {string} str  — raw string from keypress
 * @param {object} key  — keypress key object
 * @param {object} ctx  — context with state, treeItems, cursor, etc.
 * @returns {Promise<boolean>} true if key was handled
 */
export async function handleNormalKey(str, key, ctx) {
  const {
    state, treeItems, cursor, setCursor,
    diffScroll, setDiffScroll,
    rightView, setRightView,
    message, setMessage,
    reload, render: renderFn,
    config,
  } = ctx;

  const current = treeItems[cursor] ?? null;
  const name = key?.name;

  // ─── Navigation ──────────────────────────────────────────────────────

  // j / down — move cursor down
  if (str === 'j' || name === 'down') {
    setCursor(Math.min(cursor + 1, treeItems.length - 1));
    setDiffScroll(0);
    renderFn();
    return true;
  }

  // k / up — move cursor up
  if (str === 'k' || name === 'up') {
    setCursor(Math.max(cursor - 1, 0));
    setDiffScroll(0);
    renderFn();
    return true;
  }

  // J — scroll right pane down
  if (str === 'J') {
    setDiffScroll(diffScroll + 3);
    renderFn();
    return true;
  }

  // K — scroll right pane up
  if (str === 'K') {
    setDiffScroll(Math.max(0, diffScroll - 3));
    renderFn();
    return true;
  }

  // ─── Toggle view ─────────────────────────────────────────────────────

  // v — toggle diff/files view
  if (str === 'v') {
    setRightView(rightView === 'diff' ? 'files' : 'diff');
    setDiffScroll(0);
    renderFn();
    return true;
  }

  // ─── Item actions ────────────────────────────────────────────────────

  // n — new item (ticket)
  if (str === 'n') {
    const title = await prompt('Item title (or work item ID): ');
    if (!title) { renderFn(); return true; }

    try {
      const titleOrId = /^\d+$/.test(title) ? Number(title) : title;

      // Load config for provider
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const configPath = join(process.cwd(), '.vpr', 'config.json');
      let providerConfig = { provider: 'none' };
      if (existsSync(configPath)) {
        try { providerConfig = { ...providerConfig, ...JSON.parse(readFileSync(configPath, 'utf-8')) }; } catch {}
      }
      const { createProvider } = await import('../../providers/index.mjs');
      const provider = createProvider(providerConfig);

      await ticketNew(titleOrId, { provider });
      setMessage('Item created');
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
    await reload();
    renderFn();
    return true;
  }

  // a — add VPR to current item
  if (str === 'a') {
    const title = await prompt('VPR title: ');
    if (!title) { renderFn(); return true; }

    const itemName = findParentItem(treeItems, cursor);
    try {
      await addVpr(title, { item: itemName || undefined });
      setMessage('VPR added');
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
    await reload();
    renderFn();
    return true;
  }

  // ─── VPR actions ─────────────────────────────────────────────────────

  // s — edit story (on VPR)
  if (str === 's' && current?.type === 'vpr') {
    openEditor(current.story || '', async (content) => {
      try {
        await editVpr(current.bookmark, { story: content });
        setMessage('Story updated');
      } catch (err) {
        setMessage(`Error: ${err.message}`);
      }
      await reload();
      renderFn();
    });
    return true;
  }

  // P — send VPR
  if (str === 'P' && current?.type === 'vpr') {
    try {
      const checks = await sendChecks(current.bookmark);
      const lines = checks.map(c => `${c.pass ? '✓' : '✗'} ${c.name}: ${c.message}`);
      setMessage(lines.join('  '));
      renderFn();

      const blocked = checks.filter(c => !c.pass && (c.name === 'story' || c.name === 'conflicts'));
      if (blocked.length > 0) {
        setMessage(`Send blocked: ${blocked.map(c => c.message).join('; ')}`);
        renderFn();
        return true;
      }

      const yes = await confirm('Send this VPR?');
      if (!yes) {
        setMessage('Send cancelled');
        renderFn();
        return true;
      }

      // Load provider config
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const configPath = join(process.cwd(), '.vpr', 'config.json');
      let providerConfig = { provider: 'none' };
      if (existsSync(configPath)) {
        try { providerConfig = { ...providerConfig, ...JSON.parse(readFileSync(configPath, 'utf-8')) }; } catch {}
      }
      const { createProvider } = await import('../../providers/index.mjs');
      const provider = createProvider(providerConfig);

      const result = await send(current.bookmark, { provider });
      setMessage(`Sent → ${result.branchName}`);
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
    await reload();
    renderFn();
    return true;
  }

  // d — dissolve VPR
  if (str === 'd' && current?.type === 'vpr') {
    const yes = await confirm(`Remove VPR "${current.title || current.bookmark}"?`);
    if (!yes) {
      setMessage('Cancelled');
      renderFn();
      return true;
    }

    try {
      await removeVpr(current.bookmark);
      setMessage('VPR removed');
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
    await reload();
    renderFn();
    return true;
  }

  // i — interactive rebase (on VPR)
  if (str === 'i' && current?.type === 'vpr') {
    // Gather commits with files for this VPR
    const item = state.items.find(it => it.name === current.itemName);
    const vpr = item?.vprs.find(v => v.bookmark === current.bookmark);
    if (!vpr || vpr.commits.length === 0) {
      setMessage('No commits to rebase');
      renderFn();
      return true;
    }

    const commitsWithFiles = vpr.commits.map(c => ({
      changeId: c.changeId,
      subject: c.subject,
      files: getFiles(c.changeId),
    }));

    const content = buildInteractiveContent(commitsWithFiles);
    openEditor(content, async (result) => {
      const actions = parseInteractiveContent(result);
      let applied = 0;

      for (const action of actions) {
        try {
          switch (action.action) {
            case 'drop':
              jj(`abandon ${action.changeId}`);
              applied++;
              break;
            case 'squash':
              jj(`squash -r ${action.changeId}`);
              applied++;
              break;
            case 'reword':
              if (action.newMessage) {
                jj(`describe ${action.changeId} -m "${action.newMessage}"`);
                applied++;
              }
              break;
            case 'pick':
              // no-op — keep as-is
              break;
          }
        } catch (err) {
          setMessage(`Error on ${action.changeId}: ${err.message}`);
        }
      }

      setMessage(`Interactive: ${applied} action${applied !== 1 ? 's' : ''} applied`);
      await reload();
      renderFn();
    });
    return true;
  }

  // ─── Bulk edit ───────────────────────────────────────────────────────

  // E — edit all items/VPRs
  if (str === 'E') {
    const content = buildBulkEditContent(state);
    openEditor(content, async (result) => {
      const updates = parseBulkEditContent(result, state);
      for (const update of updates) {
        try {
          await editVpr(update.bookmark, {
            title: update.title,
            story: update.story,
            output: update.output,
          });
        } catch (err) {
          setMessage(`Error updating ${update.bookmark}: ${err.message}`);
        }
      }
      setMessage(`Updated ${updates.length} VPR${updates.length !== 1 ? 's' : ''}`);
      await reload();
      renderFn();
    });
    return true;
  }

  // O — reorder VPRs
  if (str === 'O') {
    const content = buildReorderContent(state);
    openEditor(content, async (result) => {
      const newOrder = parseReorderContent(result);
      // Rewrite meta with new VPR ordering within each item
      const meta = await loadMeta();
      for (const [itemName, itemData] of Object.entries(meta.items)) {
        const vprs = itemData.vprs ?? {};
        const bookmarks = Object.keys(vprs);
        // Filter newOrder to bookmarks belonging to this item
        const ordered = newOrder.filter(b => bookmarks.includes(b));
        // Add any bookmarks not in the reorder list at the end
        for (const b of bookmarks) {
          if (!ordered.includes(b)) ordered.push(b);
        }
        // Rebuild vprs in new order
        const reordered = {};
        for (const b of ordered) {
          if (vprs[b]) reordered[b] = vprs[b];
        }
        itemData.vprs = reordered;
      }
      await saveMeta(meta);
      setMessage('Reorder applied');
      await reload();
      renderFn();
    });
    return true;
  }

  // ─── Hold ────────────────────────────────────────────────────────────

  // H — toggle hold/unhold
  if (str === 'H') {
    if (current?.type === 'commit') {
      try {
        await hold(current.changeId);
        setMessage(`Held ${current.changeId}`);
      } catch (err) {
        setMessage(`Error: ${err.message}`);
      }
      await reload();
      renderFn();
      return true;
    }

    if (current?.type === 'hold') {
      try {
        await unhold(current.changeId);
        setMessage(`Unheld ${current.changeId}`);
      } catch (err) {
        setMessage(`Error: ${err.message}`);
      }
      await reload();
      renderFn();
      return true;
    }

    if (current?.type === 'ungrouped') {
      try {
        await hold(current.changeId);
        setMessage(`Held ${current.changeId}`);
      } catch (err) {
        setMessage(`Error: ${err.message}`);
      }
      await reload();
      renderFn();
      return true;
    }
  }

  // ─── Undo ────────────────────────────────────────────────────────────

  // u — jj undo
  if (str === 'u') {
    try {
      const output = jj('undo');
      setMessage(`Undo: ${output || 'done'}`);
    } catch (err) {
      setMessage(`Undo failed: ${err.message}`);
    }
    await reload();
    renderFn();
    return true;
  }

  // ─── Enter — context-dependent ───────────────────────────────────────

  if (name === 'return') {
    if (current?.type === 'item') {
      // Edit item title
      const title = await prompt(`Item title [${current.wiTitle}]: `);
      if (title) {
        try {
          const { ticketEdit } = await import('../../commands/ticket.mjs');
          await ticketEdit(current.name, { wiTitle: title });
          setMessage('Item updated');
        } catch (err) {
          setMessage(`Error: ${err.message}`);
        }
        await reload();
      }
      renderFn();
      return true;
    }

    if (current?.type === 'vpr') {
      // Edit story
      openEditor(current.story || '', async (content) => {
        try {
          await editVpr(current.bookmark, { story: content });
          setMessage('Story updated');
        } catch (err) {
          setMessage(`Error: ${err.message}`);
        }
        await reload();
        renderFn();
      });
      return true;
    }

    if (current?.type === 'commit') {
      // jj describe
      const desc = await prompt(`Describe [${current.subject}]: `);
      if (desc) {
        try {
          jj(`describe ${current.changeId} -m "${desc.replace(/"/g, '\\"')}"`);
          setMessage('Described');
        } catch (err) {
          setMessage(`Error: ${err.message}`);
        }
        await reload();
      }
      renderFn();
      return true;
    }

    return false;
  }

  // ─── Command mode ───────────────────────────────────────────────────

  // : — jj command mode
  if (str === ':') {
    const cmd = await prompt('jj ');
    if (cmd) {
      try {
        const output = jj(cmd);
        setMessage(output ? output.split('\n')[0] : 'OK');
      } catch (err) {
        setMessage(`Error: ${err.message}`);
      }
      await reload();
    }
    renderFn();
    return true;
  }

  // ─── Quit ────────────────────────────────────────────────────────────

  if (str === 'q' || (key?.ctrl && name === 'c')) {
    process.stdout.write(SHOW_CURSOR + '\x1b[2J\x1b[H');
    process.exit(0);
  }

  return false;
}
