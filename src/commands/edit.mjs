import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

/**
 * Find a VPR by bookmark name, partial bookmark match, or partial title match.
 *
 * Search order:
 *   1. Exact bookmark match
 *   2. Partial bookmark match (bookmark includes query)
 *   3. Partial title match (case-insensitive)
 *
 * Returns the first match found, or null.
 *
 * @param {object} meta
 * @param {string} query
 * @returns {{ itemName: string, bookmark: string, vpr: object } | null}
 */
export function findVpr(meta, query) {
  const lower = query.toLowerCase();

  // Pass 1: exact bookmark match
  for (const [itemName, item] of Object.entries(meta.items)) {
    for (const [bookmark, vpr] of Object.entries(item.vprs)) {
      if (bookmark === query) return { itemName, bookmark, vpr };
    }
  }

  // Pass 2: partial bookmark match
  for (const [itemName, item] of Object.entries(meta.items)) {
    for (const [bookmark, vpr] of Object.entries(item.vprs)) {
      if (bookmark.includes(query)) return { itemName, bookmark, vpr };
    }
  }

  // Pass 3: partial title match (case-insensitive)
  for (const [itemName, item] of Object.entries(meta.items)) {
    for (const [bookmark, vpr] of Object.entries(item.vprs)) {
      if (vpr.title && vpr.title.toLowerCase().includes(lower)) {
        return { itemName, bookmark, vpr };
      }
    }
  }

  return null;
}

/**
 * Update fields on a VPR found by query.
 * Updatable fields: title, story, acceptance, output.
 *
 * `story` holds the human-curated PR narrative (typically refined post-QA).
 * `acceptance` holds the machine-readable TDD spec (acceptance criteria
 * that ralph drives against). They are separate concerns: story is for
 * humans reading the PR, acceptance is for the agent driving the
 * implementation.
 *
 * @param {string} query  — bookmark name, partial bookmark, or partial title
 * @param {object} updates  — e.g. { story, title, acceptance, output }
 * @returns {Promise<void>}
 */
export async function editVpr(query, updates) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;

  // Apply only recognised fields
  if ('title' in updates) vpr.title = updates.title;
  if ('story' in updates) vpr.story = updates.story;
  if ('acceptance' in updates) vpr.acceptance = updates.acceptance;
  if ('output' in updates) vpr.output = updates.output;
  if ('model' in updates) vpr.model = updates.model;

  meta.items[itemName].vprs[bookmark] = vpr;
  await saveMeta(meta);
  await appendEvent('cli', 'vpr.edit', { bookmark, updates });
}
