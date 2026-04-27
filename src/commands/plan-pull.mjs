import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

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
 * Pull a parent work item and create one item per child Task.
 *
 * - Children are fetched via provider.getChildren(parentId).
 * - Only children whose type matches /task/i become items.
 * - Idempotent: WIs already in meta.items are skipped.
 * - On slug collision (different WI, same slug), the WI id is appended.
 *
 * @param {number} parentId
 * @param {{ provider: object }} opts
 * @returns {Promise<{ parent: object, results: Array<{wi:number,status:'created'|'exists'|'skipped',name?:string,reason?:string}> }>}
 */
export async function planPull(parentId, { provider }) {
  if (!provider) throw new Error('No provider configured');
  if (!parentId) throw new Error('parentId is required');
  if (typeof provider.getChildren !== 'function') {
    throw new Error('Provider does not support getChildren');
  }

  const parent = provider.getWorkItem(parentId);
  if (!parent) throw new Error(`Parent work item not found: ${parentId}`);

  const me = typeof provider.getCurrentUser === 'function' ? provider.getCurrentUser() : null;
  const children = provider.getChildren(parentId);
  const meta = await loadMeta();

  const wisInMeta = new Map();
  for (const [name, item] of Object.entries(meta.items)) {
    wisInMeta.set(item.wi, name);
  }

  const results = [];
  for (const child of children) {
    if (!child) continue;
    if (!/task/i.test(child.type || '')) {
      results.push({ wi: child.id, status: 'skipped', reason: `not a Task (${child.type})` });
      continue;
    }
    // Pull only Tasks assigned to the current user or unassigned.
    if (me && child.assignedTo && child.assignedTo !== me) {
      results.push({ wi: child.id, status: 'skipped', reason: `assigned to ${child.assignedTo}` });
      continue;
    }
    if (wisInMeta.has(child.id)) {
      results.push({ wi: child.id, status: 'exists', name: wisInMeta.get(child.id) });
      continue;
    }
    let name = slugify(child.title);
    if (meta.items[name]) name = `${name}-${child.id}`;
    meta.items[name] = { wi: child.id, wiTitle: child.title, vprs: {} };
    wisInMeta.set(child.id, name);
    results.push({ wi: child.id, status: 'created', name });
  }

  await saveMeta(meta);
  await appendEvent('cli', 'plan.pull', {
    parentId,
    parentTitle: parent.title,
    created: results.filter(r => r.status === 'created').length,
    existed: results.filter(r => r.status === 'exists').length,
    skipped: results.filter(r => r.status === 'skipped').length,
  });

  return { parent: { id: parent.id, type: parent.type, title: parent.title }, results };
}
