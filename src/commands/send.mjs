import { jj, jjSafe, getBaseBranch } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState, computeChainState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

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
export async function send(query, { provider = null, dryRun = false, tpIndex, targetBranch, force = false } = {}) {
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

  // Sequential refusal: walk the chain and refuse if this VPR has an earlier
  // unsent sibling. The agent and CLI parse this single-line error to discover
  // the blocker. Also captures cascadeTarget for default targetBranch resolution.
  let cascadeTarget = null;
  {
    const chainState = await buildState();
    const enriched = computeChainState(chainState.items, {
      sent: chainState.sent,
      baseBranch: getBaseBranch() ?? 'main',
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
  targetBranch = targetBranch ?? getBaseBranch() ?? 'main';
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
    const rangeOutput = jjSafe(
      `log -r '${targetBranch}..${bookmark}' --no-graph --template 'change_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"'`,
    );
    const rangeLines = rangeOutput ? rangeOutput.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const stowaways = [];
    for (const line of rangeLines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [cid, bookmarksRaw, subject] = parts;
      const commitBookmarks = bookmarksRaw
        .split(' ')
        .map(b => b.trim())
        .filter(b => b && !b.includes('@'));
      // Stowaway iff this commit carries a bookmark of a different VPR
      const owningSibling = commitBookmarks.find(b => siblingBookmarks.has(b));
      if (owningSibling) stowaways.push({ cid, subject, ownedBy: owningSibling });
    }
    if (stowaways.length > 0) {
      const lines = stowaways.map(s => `  ${s.cid} ${s.subject} — owned by ${s.ownedBy}`).join('\n');
      const msg =
        `Send blocked: ${stowaways.length} commit(s) between ${targetBranch} and ${bookmark} belong to other VPRs.\n` +
        `These would be pushed as part of "${vpr.title}" PR:\n${lines}\n` +
        `Reorder commits in jj so this VPR sits before them, OR add them to this VPR's scope, OR re-run with --force to ignore.`;
      const err = new Error(msg);
      err.code = 'CHAIN_STOWAWAYS';
      err.stowaways = stowaways;
      throw err;
    }
  }

  // 2. Generate branch name: feat/{wi}-{slug}
  const slug = bookmark.replace(/\//g, '-');
  const branchName = `feat/${item.wi}-${slug}`;

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
    const existing = jjSafe(`bookmark list ${branchName} --template 'self.name() ++ "\\n"'`);
    const hasCollision = Boolean(existing && existing.trim());
    if (hasCollision) {
      if (!force) {
        const err = new Error(`Branch "${branchName}" already exists as a jj bookmark. Delete it and retry, or run with --force.`);
        err.code = 'BRANCH_COLLISION';
        err.branchName = branchName;
        throw err;
      }
      jjSafe(`bookmark delete ${branchName}`);
    }
  }

  // 6. Rename jj bookmark: try rename, fallback to create + delete
  const renamed = jjSafe(`bookmark rename ${bookmark} ${branchName}`);
  if (!renamed && renamed !== '') {
    // rename returned null (failed) — try create + delete fallback
    jj(`bookmark create ${branchName} -r ${bookmark}`);
    jj(`bookmark delete ${bookmark}`);
  }

  // 7. Push
  jj(`git push --bookmark ${branchName}`);

  // 8. Create PR via provider if available
  let prId = null;
  if (provider && typeof provider.createPR === 'function') {
    const pr = await provider.createPR(branchName, targetBranch, prTitle, prBody, item.wi);
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
