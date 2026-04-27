import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

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
export async function ticketNew(titleOrId, { provider }) {
  let wi, wiTitle;

  if (typeof titleOrId === 'number') {
    const item = await provider.getWorkItem(titleOrId);
    wi = titleOrId;
    wiTitle = item.title;
  } else {
    const result = await provider.createWorkItem(titleOrId, '');
    wi = result.id;
    wiTitle = titleOrId;
  }

  const name = slugify(wiTitle);

  const meta = await loadMeta();
  meta.items[name] = { wi, wiTitle, vprs: {} };
  await saveMeta(meta);
  await appendEvent('cli', 'ticket.new', { name, wi, wiTitle });

  return { name, wi, wiTitle };
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
 * Mark an item as held — moves it to the bottom of `vpr status`.
 * Idempotent.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function ticketHold(name) {
  const meta = await loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);
  if (!meta.items[name].held) {
    meta.items[name].held = true;
    await saveMeta(meta);
    await appendEvent('cli', 'ticket.hold', { name });
  }
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
