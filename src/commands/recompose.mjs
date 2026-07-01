import { loadMeta, appendEvent } from '../core/meta.mjs';
import { createVcs } from '../core/vcs.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

/**
 * Recompose a VPR's messy dev history into one clean commit, preserving the
 * working tree (git reset --soft). This is the git v2 replacement for jj's
 * painless restack: the "how we got there" is dropped from git; the intent
 * lives on in the VPR story / eventLog.
 *
 * Only the tip slice can be recomposed — its latest commit must be HEAD, so the
 * soft reset does not swallow descendant slices. Mid-stack slices should be
 * rebase-edited instead. Run with the slice's branch checked out so the branch
 * ref moves with HEAD.
 *
 * @param {string} query  — bookmark, partial bookmark, or partial title
 * @param {{ message?: string }} [opts]
 * @returns {Promise<{ bookmark: string, base: string, collapsed: number }>}
 */
export async function recompose(query, { message } = {}) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;

  const state = await buildState();
  const item = state.items.find(i => i.name === itemName);
  const stateVpr = item?.vprs.find(v => v.bookmark === bookmark);
  const commits = stateVpr?.commits ?? [];
  if (commits.length === 0) throw new Error(`No commits to recompose for ${bookmark}`);

  const vcs = createVcs();

  // Guard: recompose only the tip slice, or the soft reset would collapse
  // commits belonging to slices stacked above this one.
  const head = vcs.headId();
  const last = commits[commits.length - 1].changeId;
  if (head && last && head !== last && !last.startsWith(head) && !head.startsWith(last)) {
    throw new Error(
      `Recompose only supports the tip slice: ${bookmark}'s latest commit is not HEAD. ` +
      `Rebase-edit mid-stack slices instead.`
    );
  }

  const base = vcs.parentOf(commits[0].changeId);
  if (!base) throw new Error(`Could not resolve the base commit below ${bookmark}`);

  const msg = message || vpr.title || bookmark;
  vcs.recompose(base, msg);

  await appendEvent('cli', 'vpr.recompose', { bookmark, base, collapsed: commits.length });
  return { bookmark, base, collapsed: commits.length };
}
