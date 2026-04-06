import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { jj, jjSafe } from '../core/jj.mjs';

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

  // Determine whether @ has a description (non-empty commit) or is empty.
  // An empty working-copy commit has no description in jj.
  const desc = jjSafe('log -r @ --no-graph --template "description.first_line()"');
  const target = desc && desc.trim().length > 0 ? '@' : '@-';

  jj(`bookmark set ${bookmark} -r ${target}`);

  // Register in meta
  meta.items[item].vprs[bookmark] = { title, story: '', output: null };
  await saveMeta(meta);
  await appendEvent('cli', 'vpr.add', { bookmark, item, title });

  return { bookmark, item, title };
}
