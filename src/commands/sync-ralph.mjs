import { execSync } from 'node:child_process';

/**
 * Sync ralph-produced commits into the chain by advancing each slice's
 * jj bookmark to the tip commit of its slice. Reads `Ralph-Slice:` trailers
 * from commit messages on the sandcastle temp branch (or any branch passed
 * via `branch`).
 *
 * Behaviour:
 * - Walks commits since main (or `--since`) on the latest sandcastle temp
 *   branch (or specified branch).
 * - Groups by `Ralph-Slice` trailer.
 * - For each slice, finds the newest commit (last by chronological commit
 *   order) and runs `jj bookmark set <slice> -r <commit-sha>
 *   --allow-backwards`.
 *
 * Idempotent. Safe to run multiple times — bookmark just stays at the same
 * tip if nothing has changed.
 *
 * @param {string} item        VPR item name (used to find sandcastle branch).
 * @param {object} [opts]
 * @param {string} [opts.branch]  Override branch (defaults to latest
 *                                sandcastle/ralph-<item>/* by committer date).
 * @param {string} [opts.since]   Override base ref (defaults to "main").
 * @returns {Promise<{ advanced: Record<string, string>, skipped: string[] }>}
 */
export async function syncRalphBookmarks(item, { branch, since = 'main' } = {}) {
  // Find latest sandcastle temp branch for the item.
  let tempBranch = branch;
  if (!tempBranch) {
    const branches = execSync(
      `git branch --list 'sandcastle/ralph-${item}/*' --sort=-committerdate`,
      { encoding: 'utf-8' },
    ).split('\n').map(b => b.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
    tempBranch = branches[0];
  }
  if (!tempBranch) {
    return { advanced: {}, skipped: [`no sandcastle branch found for item ${item}`] };
  }

  // Walk commits, oldest first, collecting (sha, body) pairs.
  // %H sha, %B full body, then a unique sentinel separator.
  const SEP = '---vpr-commit-sep---';
  let log;
  try {
    log = execSync(
      `git log --reverse --format='%H%n%B%n${SEP}' ${since}..${tempBranch}`,
      { encoding: 'utf-8' },
    );
  } catch (err) {
    return { advanced: {}, skipped: [`git log failed: ${err.message}`] };
  }

  // Parse: each block is a commit's (sha, body).
  const blocks = log.split(`${SEP}\n`).map(b => b.trim()).filter(Boolean);
  /** @type {Record<string, string[]>} */
  const slices = {};
  for (const block of blocks) {
    const newlineIdx = block.indexOf('\n');
    if (newlineIdx === -1) continue;
    const sha = block.slice(0, newlineIdx).trim();
    const body = block.slice(newlineIdx + 1);
    const m = body.match(/^Ralph-Slice:\s*(\S+)/m);
    if (!m) continue;
    const slice = m[1];
    if (!slices[slice]) slices[slice] = [];
    slices[slice].push(sha);
  }

  // For each slice, advance its bookmark to its newest commit (last in oldest-first list).
  const advanced = {};
  const skipped = [];
  for (const [slice, shas] of Object.entries(slices)) {
    const tip = shas[shas.length - 1];
    try {
      execSync(`jj bookmark set ${slice} -r ${tip} --allow-backwards`, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      advanced[slice] = tip;
    } catch (err) {
      skipped.push(`${slice}: ${err.message}`);
    }
  }

  return { advanced, skipped };
}
