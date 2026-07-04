import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { createVcs } from '../core/vcs.mjs';

/**
 * Convert a title to a slug (lowercase, non-alphanum → hyphen, max 4 words).
 * Matches `vpr add`'s slugify so a slice planned in bulk and one added
 * individually land on the same bookmark name.
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
 * Materialize a batch of approved planning slices as lightweight branch
 * POINTERS — never empty scaffold commits.
 *
 * This is the `to-issues` materialization step. Historically each slice was
 * anchored with an empty scaffold commit (jj `new` on collision / a manual
 * `git commit --allow-empty`); those zero-diff commits then rode in every PR's
 * commit list and could not be stripped once each branch was checked out in its
 * own worktree. Planning must not write commits — a slice that has no work yet
 * is just a name pointing at the chain base.
 *
 * Every slice branch is create-or-moved to `at` (the chain base, default the
 * working tip `@`/`HEAD`) via `moveBookmark`, which is a pure ref update in both
 * backends — `git branch --force` and `jj bookmark set`, neither of which
 * creates a commit. Work lands later and advances the individual branch.
 *
 * Idempotent: a slice already registered in meta is re-pointed at `at` and
 * reported as `exists` rather than duplicated.
 *
 * @param {string[]} titles  — approved slice titles, in chain order
 * @param {{ item?: string, at?: string }} [opts]
 * @returns {Promise<{ item: string, slices: Array<{ bookmark: string, title: string, status: 'planned'|'exists' }> }>}
 */
export async function planSlices(titles, { item, at } = {}) {
  if (!Array.isArray(titles) || titles.length === 0) {
    throw new Error('No slice titles given — pass at least one title to plan');
  }

  const meta = await loadMeta();

  // Resolve item name (same rule as `vpr add`).
  if (!item) {
    const names = Object.keys(meta.items);
    if (names.length === 0) throw new Error('No items found — create a ticket first with `vpr ticket new`');
    if (names.length > 1) throw new Error('Ambiguous: multiple items exist — specify --item');
    item = names[0];
  }
  if (!meta.items[item]) throw new Error(`Item not found: ${item}`);
  meta.items[item].vprs = meta.items[item].vprs ?? {};

  const vcs = createVcs();
  // Anchor pointers at the chain base — the working tip by default. Both
  // backends translate '@' to their notion of the current commit.
  const anchor = at ?? '@';

  const slices = [];
  for (const title of titles) {
    const slug = slugify(title);
    const bookmark = `${item}/${slug}`;
    const already = Boolean(meta.items[item].vprs[bookmark]);

    // Pure pointer — create-or-move, never a commit.
    vcs.moveBookmark(bookmark, anchor);

    if (!already) {
      meta.items[item].vprs[bookmark] = { title, story: '', output: null };
    }
    slices.push({ bookmark, title, status: already ? 'exists' : 'planned' });
  }

  await saveMeta(meta);
  await appendEvent('cli', 'plan.slices', {
    item,
    planned: slices.filter(s => s.status === 'planned').length,
    existed: slices.filter(s => s.status === 'exists').length,
    bookmarks: slices.map(s => s.bookmark),
  });

  return { item, slices };
}
