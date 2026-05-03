import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { jjExportIfAvailable } from '../core/jj-detect.mjs';

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
 * - Registers VPR in meta.items[item].vprs as a meta-only placeholder.
 *   A jj bookmark is NOT created here; it is created lazily by vpr sync
 *   when the first commit lands under this VPR.
 *
 * @param {string} title
 * @param {{ item?: string, model?: string, manual?: boolean }} opts
 * @returns {Promise<{ bookmark: string, item: string, title: string, manual?: boolean }>}
 */
export async function addVpr(title, { item, model, manual } = {}) {
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

  // Reject if the bookmark name is already in use (items or sent)
  for (const itemData of Object.values(meta.items)) {
    if (Object.prototype.hasOwnProperty.call(itemData.vprs ?? {}, bookmark)) {
      throw new Error(`VPR '${bookmark}' already exists in meta.items`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(meta.sent ?? {}, bookmark)) {
    throw new Error(`VPR '${bookmark}' already exists in meta.sent`);
  }

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
    // `manual: true` marks slices created outside a ralph TDD loop — ad-hoc
    // commits made directly by a human or claude during interactive work.
    // Used downstream to differentiate spec-driven slices from manual edits.
    ...(manual ? { manual: true } : {}),
  };
  await saveMeta(meta);
  await appendEvent('cli', 'vpr.add', { bookmark, item, title, manual: !!manual });
  jjExportIfAvailable();

  return manual ? { bookmark, item, title, manual: true } : { bookmark, item, title };
}
