import { execSync } from 'node:child_process';
import { jjSafe } from '../core/jj.mjs';
import { loadMeta } from '../core/meta.mjs';

/**
 * Walk every commit between main and the chain head, group by `Ralph-Slice:`
 * trailer, and verify that each unsent VPR's bookmark sits on the tip commit
 * of its slice. Reports drift WITHOUT mutating.
 *
 * Drift kinds:
 *  - "moved": bookmark sits on a commit, but the slice's actual tip (per
 *    trailer) is elsewhere. Fix: re-anchor.
 *  - "empty": bookmark sits on a commit that has no Ralph-Slice trailer for
 *    this slice (e.g. an empty placeholder after a rebase). Fix: re-anchor.
 *  - "missing-tip": no commit carries this slice's trailer at all. Cannot
 *    auto-repair — slice work was abandoned or never landed.
 *
 * Commits authored manually (no Ralph-Slice trailer) are invisible to this
 * audit; their bookmark drift cannot be detected through trailers.
 *
 * @param {{ baseBranch?: string }} [opts]
 * @returns {Promise<{
 *   ok: Array<{ bookmark: string, sha: string }>,
 *   drift: Array<{ kind: 'moved'|'empty'|'missing-tip', bookmark: string, current: string|null, expected: string|null }>,
 * }>}
 */
export async function auditBookmarks({ baseBranch = 'main' } = {}) {
  const meta = await loadMeta();
  const sentSet = new Set(Object.keys(meta.sent ?? {}));

  // Collect every (bookmark, expected) pair from unsent VPRs in meta.
  /** @type {Array<{ itemName: string, bookmark: string }>} */
  const unsentBookmarks = [];
  for (const [itemName, itemData] of Object.entries(meta.items ?? {})) {
    for (const bookmark of Object.keys(itemData.vprs ?? {})) {
      if (sentSet.has(bookmark)) continue;
      unsentBookmarks.push({ itemName, bookmark });
    }
  }

  // Walk commits oldest-first between baseBranch and @, capturing
  // (sha, body) so we can group by Ralph-Slice trailer.
  const SEP = '---vpr-audit-sep---';
  let log = '';
  try {
    log = execSync(`git log --reverse --format='%H%n%B%n${SEP}' ${baseBranch}..HEAD`, {
      encoding: 'utf-8',
    });
  } catch {
    log = '';
  }
  /** @type {Record<string, string[]>} slice -> sha[] (oldest-first) */
  const tipsBySlice = {};
  for (const block of log.split(`${SEP}\n`).map(b => b.trim()).filter(Boolean)) {
    const newlineIdx = block.indexOf('\n');
    if (newlineIdx === -1) continue;
    const sha = block.slice(0, newlineIdx).trim();
    const body = block.slice(newlineIdx + 1);
    const m = body.match(/^Ralph-Slice:\s*(\S+)/m);
    if (!m) continue;
    if (!tipsBySlice[m[1]]) tipsBySlice[m[1]] = [];
    tipsBySlice[m[1]].push(sha);
  }

  const ok = [];
  const drift = [];

  for (const { bookmark } of unsentBookmarks) {
    const expectedShas = tipsBySlice[bookmark];
    const expectedTip = expectedShas ? expectedShas[expectedShas.length - 1] : null;

    const currentSha = jjSafe(
      `log -r 'bookmarks(exact:"${bookmark}")' --no-graph --template 'commit_id'`,
    );

    if (!expectedTip) {
      drift.push({ kind: 'missing-tip', bookmark, current: currentSha || null, expected: null });
      continue;
    }
    if (!currentSha || !currentSha.startsWith(expectedTip) && !expectedTip.startsWith(currentSha)) {
      drift.push({ kind: 'moved', bookmark, current: currentSha || null, expected: expectedTip });
      continue;
    }
    ok.push({ bookmark, sha: currentSha });
  }

  return { ok, drift };
}

/**
 * Apply fixes for "moved" or "empty" drift detected by auditBookmarks().
 * Skips "missing-tip" since that has no recoverable target.
 *
 * @param {Awaited<ReturnType<typeof auditBookmarks>>} report
 * @returns {Promise<{ repaired: Array<{ bookmark: string, sha: string }>, skipped: Array<{ bookmark: string, reason: string }> }>}
 */
export async function repairBookmarks(report) {
  const repaired = [];
  const skipped = [];
  for (const entry of report.drift) {
    if (entry.kind === 'missing-tip' || !entry.expected) {
      skipped.push({ bookmark: entry.bookmark, reason: `no recoverable tip — ${entry.kind}` });
      continue;
    }
    try {
      execSync(`jj bookmark set ${entry.bookmark} -r ${entry.expected} --allow-backwards`, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      repaired.push({ bookmark: entry.bookmark, sha: entry.expected });
    } catch (err) {
      skipped.push({ bookmark: entry.bookmark, reason: err.message });
    }
  }
  return { repaired, skipped };
}
