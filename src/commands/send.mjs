import { jj, jjSafe } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

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
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;
  const item = meta.items[itemName];

  // Auto-detect chain top and TP-index from provider if not explicitly set
  if (provider && targetBranch === undefined) {
    targetBranch = provider.getChainTop?.() ?? 'main';
  }
  if (provider && tpIndex === undefined) {
    tpIndex = (provider.getLatestPRIndex?.() ?? 0) + 1;
  }
  const { getBaseBranch } = await import('../core/jj.mjs');
  targetBranch = targetBranch ?? getBaseBranch() ?? 'main';
  tpIndex = tpIndex ?? 1;

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
