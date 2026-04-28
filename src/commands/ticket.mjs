import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { hasJj, jj, jjSafe } from '../core/jj.mjs';
import { computeTicketSync } from './ticket-sync.mjs';

/**
 * Quote a string for use as a literal bookmark name in a jj revset.
 * @param {string} s
 * @returns {string}
 */
function quoteRev(s) {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Detach an item's commits from the active chain by rebasing them onto trunk.
 * Held items become a sidebranch off main; jj auto-reparents the active
 * chain's descendants to skip the held commits, closing the gap.
 *
 * Idempotent — if no active-chain bookmark has any item commit as ancestor,
 * the item is already detached and this is a no-op.
 *
 * @param {string} itemName
 * @param {object} item — meta.items[name]
 * @param {object} meta — the full meta (used to find other items' bookmarks)
 * @returns {{ detached: boolean, reason?: string }}
 */
function detachItem(itemName, item, meta) {
  if (!hasJj()) return { detached: false, reason: 'no-jj' };
  const bookmarks = Object.keys(item.vprs);
  if (bookmarks.length === 0) return { detached: false, reason: 'no-bookmarks' };

  const itemSet = bookmarks.map(quoteRev).join(' | ');

  // Collect bookmarks belonging to OTHER items — those are the active chain.
  const others = [];
  for (const [n, it] of Object.entries(meta.items)) {
    if (n === itemName) continue;
    for (const b of Object.keys(it.vprs)) others.push(b);
  }
  if (others.length === 0) {
    return { detached: false, reason: 'no-other-items' };
  }
  const otherSet = others.map(quoteRev).join(' | ');

  // Find the boundary below the item: the topmost ancestor of the item's
  // root bookmark that is itself an anchor — another item's bookmark, trunk,
  // or a remote bookmark. Anchors are intersected directly (not their
  // ancestors), because `::(others)` would walk through the item's own
  // commits via the active chain. Unbookmarked commits between this boundary
  // and the item's root bookmark belong to the item (matches state.mjs's
  // "pending" semantics where a bookmark claims preceding unbookmarked commits).
  const boundaryRevset = `heads((::(roots(${itemSet}))) & ((${otherSet}) | trunk() | remote_bookmarks()))`;

  // Item range = everything from boundary (exclusive) up to item heads.
  const itemRange = `(${boundaryRevset})..heads(${itemSet})`;

  // Already detached when no other bookmark has any item commit as ancestor.
  const overlap = jjSafe(
    `log -r '(${itemRange}) & ::(${otherSet})' --no-graph -T 'change_id ++ "\\n"' -n 1`
  );
  if (!overlap) return { detached: false, reason: 'already-detached' };

  // Rebase the held commits onto the boundary (their actual base), not trunk.
  // The active chain's descendants are reparented onto the same boundary by
  // jj automatically, so held + active become parallel sidebranches off the
  // shared base — neither pulls the other into its ancestry.
  jj(`rebase -r '${itemRange}' -d '${boundaryRevset}'`);
  return { detached: true };
}

/**
 * Convert a string title to a slug: lowercase, non-alphanumeric → hyphen,
 * trim hyphens, limit to 4 words.
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-');
}

/**
 * Create a new ticket (item) in meta.
 *
 * - If titleOrId is a number: attach to existing work item via provider.getWorkItem(id).
 * - If titleOrId is a string: create a new work item via provider.createWorkItem(title, '').
 *
 * Registers the item in meta.items with slugified name, wi, wiTitle, vprs: {}.
 *
 * @param {string|number} titleOrId
 * @param {{ provider: object }} opts
 * @returns {Promise<{ name: string, wi: number, wiTitle: string }>}
 */
export async function ticketNew(titleOrId, { provider, parentId } = {}) {
  let wi, wiTitle;
  let assignedTo = null;

  if (typeof titleOrId === 'number') {
    const item = await provider.getWorkItem(titleOrId);
    wi = titleOrId;
    wiTitle = item.title;
  } else {
    const result = await provider.createWorkItem(titleOrId, '');
    wi = result.id;
    wiTitle = titleOrId;
    if (parentId) {
      if (typeof provider.linkParent !== 'function') {
        throw new Error('Provider does not support linkParent');
      }
      provider.linkParent(wi, parentId);
    }
    // Auto-assign newly created Tasks to the current user — you'd never
    // file a ticket via vpr that you didn't intend to own.
    if (typeof provider.assignTo === 'function' && typeof provider.getCurrentUser === 'function') {
      const me = provider.getCurrentUser();
      if (me) {
        provider.assignTo(wi, me);
        assignedTo = me;
      }
    }
  }

  const name = slugify(wiTitle);

  const meta = await loadMeta();
  meta.items[name] = { wi, wiTitle, vprs: {} };
  await saveMeta(meta);
  await appendEvent('cli', 'ticket.new', { name, wi, wiTitle, parentId: parentId ?? null, assignedTo });

  return { name, wi, wiTitle, parentId: parentId ?? null, assignedTo };
}

/**
 * List all items in meta.
 * @returns {Promise<Array<{ name: string, wi: number, wiTitle: string, vprCount: number }>>}
 */
export async function ticketList() {
  const meta = await loadMeta();
  return Object.entries(meta.items).map(([name, item]) => ({
    name,
    wi: item.wi,
    wiTitle: item.wiTitle,
    vprCount: Object.keys(item.vprs).length,
  }));
}

/**
 * Update fields on an existing item.
 * @param {string} name
 * @param {object} updates  — e.g. { wiTitle: 'New Title' }
 * @returns {Promise<void>}
 */
export async function ticketEdit(name, updates) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);

  Object.assign(meta.items[name], updates);
  await saveMeta(meta);
  await appendEvent('cli', 'ticket.edit', { name, updates });
}

/**
 * Mark an item as held — moves it to the bottom of `vpr status` and detaches
 * its commits from the active chain (rebases onto trunk as a sidebranch) so
 * pushing other VPRs no longer drags held commits along.
 *
 * Idempotent — already-held items still get re-detached if their commits
 * have crept back into the chain (e.g. via a later rebase).
 *
 * @param {string} name
 * @returns {Promise<{ held: boolean, detached: boolean, reason?: string }>}
 */
export async function ticketHold(name) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);

  if (!meta.items[name].held) {
    meta.items[name].held = true;
    await saveMeta(meta);
    await appendEvent('cli', 'ticket.hold', { name });
  }

  const result = detachItem(name, meta.items[name], meta);
  if (result.detached) {
    await appendEvent('cli', 'ticket.detach', { name });
  }
  return { held: true, detached: result.detached, reason: result.reason };
}

/**
 * Unmark an item as held.
 * Idempotent.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function ticketUnhold(name) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);
  if (meta.items[name].held) {
    delete meta.items[name].held;
    await saveMeta(meta);
    await appendEvent('cli', 'ticket.unhold', { name });
  }
}

/**
 * Refresh an item's cached work-item fields from the provider. Pulls the
 * latest wiTitle/wiDescription via provider.getWorkItem(item.wi) and persists
 * them into meta.
 *
 * @param {string} name
 * @param {{ provider: object }} opts
 * @returns {Promise<void>}
 */
export async function ticketRefresh(name, { provider }) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);
  const item = meta.items[name];
  if (!item.wi) return;

  const fetchedWi = await provider.getWorkItem(item.wi);
  const fetchedParent = item.parentWi
    ? await provider.getWorkItem(item.parentWi)
    : null;
  const result = computeTicketSync({ itemName: name, item, fetchedWi, fetchedParent });
  meta.items[name] = result.item;
  await saveMeta(meta);
}

/**
 * Delete an item from meta.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function ticketDone(name) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);

  delete meta.items[name];
  await saveMeta(meta);
  await appendEvent('cli', 'ticket.done', { name });
}
