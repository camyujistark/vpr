import { createVcs } from '../core/vcs.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState, computeChainState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';
import { resolveWorkItemId } from './plan-lock.mjs';

/**
 * Resolve the bookmark of the next sendable VPR by walking the chain state.
 * Returns the bookmark string, or null if no VPR is currently sendable.
 */
async function resolveNextUpBookmark() {
  const state = await buildState();
  const enriched = computeChainState(state.items, { sent: state.sent });
  for (const item of enriched) {
    for (const vpr of item.vprs) {
      if (vpr.nextUp) return vpr.bookmark;
    }
  }
  return null;
}

/**
 * The branch a VPR is pushed under at send time: `feat/<wi>-<slug>` so the
 * provider links the PR branch to its work item. Single source of truth so the
 * real send and the batch dry-run preview never drift.
 * @param {string|number} wi
 * @param {string} bookmark
 * @returns {string}
 */
export function sliceBranchName(wi, bookmark) {
  return `feat/${wi}-${bookmark.replace(/\//g, '-')}`;
}

/**
 * Generate a URL-safe slug from a string.
 * @param {string} str
 * @returns {string}
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Run pre-flight checks for a VPR.
 *
 * @param {string} query  — bookmark name, partial bookmark, or partial title
 * @returns {Promise<Array<{ name: string, pass: boolean, message: string }>>}
 */
export async function sendChecks(query) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;

  // Story check
  const storyPass = Boolean(vpr.story && vpr.story.trim());
  const storyCheck = {
    name: 'story',
    pass: storyPass,
    message: storyPass ? 'Story written' : 'No story — write one with vpr edit',
  };

  // Output check (warning only)
  const outputPass = Boolean(vpr.output);
  const outputCheck = {
    name: 'output',
    pass: outputPass,
    message: outputPass ? 'Output generated' : 'No output — generate with vpr generate',
  };

  // Commits check — use buildState to count commits under this VPR
  const state = await buildState();
  const stateItem = state.items.find(i => i.name === itemName);
  const stateVpr = stateItem?.vprs.find(v => v.bookmark === bookmark);
  const commits = stateVpr?.commits ?? [];
  const commitsPass = commits.length > 0;
  const commitsCheck = {
    name: 'commits',
    pass: commitsPass,
    message: commitsPass ? `${commits.length} commit${commits.length === 1 ? '' : 's'}` : 'No commits',
  };

  // Conflicts check
  const hasConflict = commits.some(c => c.conflict);
  const conflictsCheck = {
    name: 'conflicts',
    pass: !hasConflict,
    message: hasConflict ? 'Conflicts detected — resolve before sending' : 'No conflicts',
  };

  return [storyCheck, outputCheck, commitsCheck, conflictsCheck];
}

/**
 * Send a VPR: rename bookmark, push to git, create PR, update meta.
 *
 * @param {string} query  — bookmark name, partial bookmark, or partial title
 * @param {{
 *   provider?: object|null,
 *   dryRun?: boolean,
 *   tpIndex?: number,
 *   targetBranch?: string
 * }} [opts]
 * @returns {Promise<{
 *   branchName: string,
 *   prTitle: string,
 *   prId: number|null,
 *   targetBranch: string
 * }>}
 */
export async function send(query, { provider = null, dryRun = false, tpIndex, targetBranch, force = false, workItemModel = 'per-slice' } = {}) {
  if (!query) {
    const nextUp = await resolveNextUpBookmark();
    if (!nextUp) throw new Error('No sendable VPRs — chain is empty or fully sent');
    query = nextUp;
  }
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;
  const item = meta.items[itemName];
  const vcs = createVcs();

  // Sequential refusal: walk the chain and refuse if this VPR has an earlier
  // unsent sibling. The agent and CLI parse this single-line error to discover
  // the blocker. Also captures cascadeTarget for default targetBranch resolution.
  let cascadeTarget = null;
  {
    const chainState = await buildState();
    const enriched = computeChainState(chainState.items, {
      sent: chainState.sent,
      baseBranch: vcs.getBaseBranch() ?? 'main',
    });
    const enrichedItem = enriched.find(i => i.name === itemName);
    const enrichedVpr = enrichedItem?.vprs.find(v => v.bookmark === bookmark);
    if (enrichedVpr?.blocked) {
      throw new Error(`Cannot send ${bookmark}: send ${enrichedVpr.blockedBy} first`);
    }
    cascadeTarget = enrichedVpr?.cascadeTarget ?? null;
  }

  // Auto-detect chain top and TP-index from provider if not explicitly set.
  // Resolution order: explicit opt > cascadeTarget > provider.getChainTop > getBaseBranch > 'main'.
  if (targetBranch === undefined && cascadeTarget) {
    targetBranch = cascadeTarget;
  }
  if (provider && targetBranch === undefined) {
    targetBranch = provider.getChainTop?.() ?? 'main';
  }
  if (provider && tpIndex === undefined) {
    tpIndex = (provider.getLatestPRIndex?.() ?? 0) + 1;
  }
  targetBranch = targetBranch ?? vcs.getBaseBranch() ?? 'main';
  tpIndex = tpIndex ?? 1;

  console.log(`Target: ${targetBranch}`);

  // 1. Pre-flight checks — block on story or conflicts failures
  const checks = await sendChecks(query);
  const storyCheck = checks.find(c => c.name === 'story');
  const conflictsCheck = checks.find(c => c.name === 'conflicts');

  if (!storyCheck.pass) {
    throw new Error(`Send blocked: ${storyCheck.message}`);
  }
  if (!conflictsCheck.pass) {
    throw new Error(`Send blocked: ${conflictsCheck.message}`);
  }

  // Chain/meta order check: a fast-forward push of `bookmark` from
  // `targetBranch` will carry every commit in `targetBranch..bookmark`. If
  // a commit in that range belongs to another VPR (sent or unsent), the
  // push will silently bundle it into this PR. Refuse so the user can
  // reorder commits in jj, extend this VPR's scope, or force-send.
  if (!force) {
    // Collect every bookmark belonging to a sibling VPR (sent or unsent),
    // excluding the one being sent now.
    const siblingBookmarks = new Set();
    for (const [, itemData] of Object.entries(meta.items ?? {})) {
      for (const bm of Object.keys(itemData.vprs ?? {})) {
        if (bm !== bookmark) siblingBookmarks.add(bm);
      }
    }
    for (const sentBranch of Object.keys(meta.sent ?? {})) {
      if (sentBranch !== bookmark) siblingBookmarks.add(sentBranch);
    }
    const rangeCommits = vcs.listRange(targetBranch, bookmark);
    const stowaways = [];
    for (const commit of rangeCommits) {
      // Stowaway iff this commit carries a bookmark of a different VPR
      const owningSibling = commit.bookmarks.find(b => siblingBookmarks.has(b));
      if (owningSibling) {
        stowaways.push({ cid: commit.changeId, subject: commit.subject, ownedBy: owningSibling });
      }
    }
    if (stowaways.length > 0) {
      const lines = stowaways.map(s => `  ${s.cid} ${s.subject} — owned by ${s.ownedBy}`).join('\n');
      const msg =
        `Send blocked: ${stowaways.length} commit(s) between ${targetBranch} and ${bookmark} belong to other VPRs.\n` +
        `These would be pushed as part of "${vpr.title}" PR:\n${lines}\n` +
        `Reorder commits so this VPR sits before them, OR add them to this VPR's scope, OR re-run with --force to ignore.`;
      const err = new Error(msg);
      err.code = 'CHAIN_STOWAWAYS';
      err.stowaways = stowaways;
      throw err;
    }
  }

  // 2. Generate branch name: feat/{wi}-{slug}
  const branchName = sliceBranchName(item.wi, bookmark);

  // 3. Generate PR title
  const prefix = provider?.config?.prefix;
  const useIndex = provider?.config?.index !== false;
  let prTitle;
  if (!useIndex) {
    prTitle = vpr.title;
  } else if (prefix) {
    prTitle = `${prefix}-${tpIndex}: ${vpr.title}`;
  } else {
    prTitle = `${tpIndex}: ${vpr.title}`;
  }

  // 4. PR body
  const prBody = vpr.output || vpr.story || '';

  // 5. Dry run — return plan without executing
  if (dryRun) {
    return { branchName, prTitle, prId: null, targetBranch, prBody, dryRun: true };
  }

  // 5b. Check for a stale bookmark at the target branch name. If one exists,
  //     the rename would fail and the push would be ambiguous. Caller must
  //     re-run with { force: true } to delete it.
  if (branchName !== bookmark) {
    if (vcs.hasBookmark(branchName)) {
      if (!force) {
        const err = new Error(`Branch "${branchName}" already exists. Delete it and retry, or run with --force.`);
        err.code = 'BRANCH_COLLISION';
        err.branchName = branchName;
        throw err;
      }
      vcs.deleteBookmark(branchName);
    }
  }

  // 6. Rename the branch/bookmark to the send name
  if (branchName !== bookmark) {
    vcs.renameBookmark(bookmark, branchName);
  }

  // 7. Push
  vcs.pushBookmark(branchName);

  // 8. Create PR via provider if available. The work item linked is resolved
  //    from the locked workItemModel (§ plan lock): 'one-pbi' links the feature
  //    PBI on every slice; 'per-slice' links the slice's own work item.
  let prId = null;
  const workItemId = resolveWorkItemId(item, vpr, workItemModel);
  if (provider && typeof provider.createPR === 'function') {
    const pr = await provider.createPR(branchName, targetBranch, prTitle, prBody, workItemId);
    prId = pr?.id ?? null;
  }

  // 9. Move VPR from items to sent in meta
  const freshMeta = await loadMeta();
  const vprData = freshMeta.items[itemName]?.vprs[bookmark];
  if (vprData) {
    delete freshMeta.items[itemName].vprs[bookmark];
    freshMeta.sent = freshMeta.sent ?? {};
    freshMeta.sent[branchName] = {
      prId,
      prTitle,
      targetBranch,
      itemName,
      wi: item.wi,
      originalBookmark: bookmark,
      sentAt: new Date().toISOString(),
    };
  }

  // 10. Clean up empty items (if all VPRs sent)
  if (
    freshMeta.items[itemName] &&
    Object.keys(freshMeta.items[itemName].vprs ?? {}).length === 0
  ) {
    delete freshMeta.items[itemName];
  }

  // 11. Save + append event
  await saveMeta(freshMeta);
  await appendEvent('cli', 'vpr.send', { bookmark, branchName, prId, prTitle, targetBranch });

  // 12. Return result
  return { branchName, prTitle, prId, targetBranch };
}

/**
 * Batch send: automate the sequential per-slice send we otherwise hand-crank.
 *
 * Given the configured provider, loop the chain oldest-unsent-first and send
 * each slice: gate (sendChecks, enforced inside `send`) → push `feat/<wi>-<slug>`
 * → create the PR with the work item linked → chain onto the previous slice's
 * branch (the `cascadeTarget` resolved live per slice) → record in meta.sent.
 * Each `send` moves its VPR to `sent`, so the next `resolveNextUpBookmark`
 * surfaces the following slice — the base resolves itself as the stack grows.
 *
 * Stops at the first slice that fails a gate or errors, returning everything
 * sent so far plus the blocker, so the caller can fix one slice and re-run —
 * already-sent slices are skipped on the next pass (never re-pushed).
 *
 * Dry-run walks the same chain and previews each slice's branch/target/title
 * from meta + chain state WITHOUT pushing (it can't call `send` per slice,
 * since later slices are blocked until their predecessor is actually sent).
 *
 * @param {{
 *   provider?: object|null,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   onSlice?: (result: object) => void,
 * }} [opts]
 * @returns {Promise<{ sent: object[], previews?: object[], blocked: null | { bookmark: string, error: string } }>}
 */
export async function sendAll({ provider = null, force = false, dryRun = false, onSlice, workItemModel = 'per-slice' } = {}) {
  const vcs = createVcs();

  if (dryRun) {
    const meta = await loadMeta();
    const state = await buildState();
    const enriched = computeChainState(state.items, {
      sent: state.sent,
      baseBranch: vcs.getBaseBranch() ?? 'main',
    });
    const previews = [];
    for (const item of enriched) {
      const wi = meta.items[item.name]?.wi;
      for (const vpr of item.vprs) {
        if (vpr.sent || vpr.held) continue;
        previews.push({
          bookmark: vpr.bookmark,
          branchName: sliceBranchName(wi, vpr.bookmark),
          targetBranch: vpr.cascadeTarget,
          title: meta.items[item.name]?.vprs?.[vpr.bookmark]?.title ?? vpr.bookmark,
        });
      }
    }
    return { sent: [], previews, blocked: null };
  }

  const sent = [];
  // Guard against a pathological loop where a VPR never leaves the unsent set.
  for (let guard = 0; guard < 1000; guard++) {
    const next = await resolveNextUpBookmark();
    if (!next) break;
    let result;
    try {
      result = await send(next, { provider, force, workItemModel });
    } catch (err) {
      return { sent, blocked: { bookmark: next, error: err.message } };
    }
    sent.push(result);
    if (onSlice) onSlice(result);
  }
  return { sent, blocked: null };
}
