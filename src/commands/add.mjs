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
 * @param {{ item?: string, model?: string }} opts
 * @returns {Promise<{ bookmark: string, item: string, title: string }>}
 */
export async function addVpr(title, { item, model } = {}) {
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

  // Determine whether @ has a description (non-empty commit) or is empty.
  // An empty working-copy commit has no description in jj.
  const desc = jjSafe('log -r @ --no-graph --template "description.first_line()"');
  let target = desc && desc.trim().length > 0 ? '@' : '@-';

  // If the target commit already carries a VPR bookmark, placing another
  // bookmark on the same commit causes state.mjs to partition all pending
  // commits to whichever bookmark jj emits first — one VPR wins, the other
  // shows empty. Create a fresh empty commit so the new VPR gets its own
  // anchor. The new VPR will start with zero commits, which is correct.
  const targetBmsRaw = jjSafe(`log -r ${target} --no-graph --template 'bookmarks'`);
  const targetBms = targetBmsRaw
    ? targetBmsRaw.split(/\s+/).filter(Boolean).filter(b => !b.includes('@'))
    : [];
  const collision = targetBms.some(bm => existingBookmarks.has(bm));
  if (collision) {
    jj('new');
    target = '@';
  }

  jj(`bookmark set ${bookmark} -r ${target}`);

  // Register in meta
  meta.items[item].vprs[bookmark] = {
    title,
    story: '',
    acceptance: '',
    output: null,
    // `model` hints to ralph/sandcastle which Claude model to run for this
    // slice. Empty = caller's default (typically Sonnet). Set to e.g.
    // "claude-opus-4-7" for slices that need cross-cutting refactors or
    // unfamiliar-codebase exploration.
    model: model ?? '',
  };
  await saveMeta(meta);
  await appendEvent('cli', 'vpr.add', { bookmark, item, title });

  return { bookmark, item, title };
}
