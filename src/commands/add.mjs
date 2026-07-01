import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { createVcs } from '../core/vcs.mjs';

/**
 * Convert a title to a slug (lowercase, non-alphanum → hyphen, max 4 words).
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
 * Create a VPR within an item.
 *
 * - If item is not specified and exactly one item exists in meta, use it.
 * - If item is not specified and multiple items exist, throw.
 * - Bookmark name: `{item}/{slugified-title}`.
 * - Creates a jj bookmark at @ if @ is described, else at @-.
 * - Registers VPR in meta.items[item].vprs.
 *
 * @param {string} title
 * @param {{ item?: string }} opts
 * @returns {Promise<{ bookmark: string, item: string, title: string }>}
 */
export async function addVpr(title, { item } = {}) {
  const meta = await loadMeta();

  // Resolve item name
  if (!item) {
    const names = Object.keys(meta.items);
    if (names.length === 0) throw new Error('No items found — create a ticket first with `vpr ticket new`');
    if (names.length > 1) throw new Error('Ambiguous: multiple items exist — specify --item');
    item = names[0];
  }

  if (!meta.items[item]) throw new Error(`Item not found: ${item}`);

  const slug = slugify(title);
  const bookmark = `${item}/${slug}`;

  // Collect bookmarks already claimed by any VPR in meta
  const existingBookmarks = new Set();
  for (const itemData of Object.values(meta.items)) {
    for (const bm of Object.keys(itemData.vprs ?? {})) {
      existingBookmarks.add(bm);
    }
  }

  // Anchor the new VPR at the working tip. The backend handles "create as you
  // go": jj places a bookmark (creating an empty change on collision); git
  // points a branch at HEAD.
  const vcs = createVcs();
  vcs.addBookmark(bookmark, existingBookmarks);

  // Register in meta
  meta.items[item].vprs[bookmark] = { title, story: '', output: null };
  await saveMeta(meta);
  await appendEvent('cli', 'vpr.add', { bookmark, item, title });

  return { bookmark, item, title };
}
