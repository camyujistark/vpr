import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { hasJj } from '../core/jj-detect.mjs';
import { jjSafe } from '../core/jj.mjs';
import { jjExportIfAvailable } from '../core/jj-detect.mjs';

/**
 * Migrate old-shape VPRs (with empty jj anchor commits) to new shape
 * (meta-only, no anchor commits).
 *
 * Old shape: vpr add created a jj bookmark at @/@ pointing to an empty
 * commit (no file changes). These "anchor" commits exist only to anchor
 * the bookmark and carry no real work.
 *
 * New shape: VPR is meta-only. No jj bookmark is created by vpr add.
 *
 * Algorithm (when jj is available):
 *   1. For each VPR bookmark in meta, check if jj has a local bookmark
 *      with that name pointing to an empty commit (diff is empty).
 *   2. If yes, delete the jj bookmark (removing the anchor).
 *   3. The meta entry is unchanged — it's already "new shape" from meta's
 *      perspective (meta never stored the anchor commit ID).
 *
 * Without jj: no anchor commits can exist, so migrate is a no-op.
 *
 * Does NOT touch meta.sent records.
 * Writes a timestamped backup before any mutation.
 *
 * @param {{ dryRun?: boolean }} opts
 * @returns {Promise<{ converted: string[], skipped: string[], dryRun: boolean }>}
 */
export async function migrateVprs({ dryRun = false } = {}) {
  const meta = await loadMeta();
  const converted = [];
  const skipped = [];

  if (!hasJj()) {
    return { converted, skipped, dryRun };
  }

  // Collect all VPR bookmark names from meta.items (exclude meta.sent)
  const vprBookmarks = [];
  for (const itemData of Object.values(meta.items ?? {})) {
    for (const bookmark of Object.keys(itemData.vprs ?? {})) {
      vprBookmarks.push(bookmark);
    }
  }

  for (const bookmark of vprBookmarks) {
    // Check if this bookmark exists in jj as a local bookmark
    const bookmarkRef = jjSafe(`log -r '${bookmark}' --no-graph --template 'commit_id.short()'`);
    if (!bookmarkRef) {
      // No jj bookmark — already new-shape, skip
      skipped.push(`${bookmark} (no jj bookmark)`);
      continue;
    }

    // Check if the commit is empty (no diff)
    const diff = jjSafe(`diff -r '${bookmark}' --summary`);
    const isEmpty = !diff || diff.trim() === '';
    if (!isEmpty) {
      // Non-empty anchor — refuse to touch it (handled by caller for error)
      skipped.push(`${bookmark} (non-empty diff, skipped)`);
      continue;
    }

    if (!dryRun) {
      // Write backup before first mutation
      if (converted.length === 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = join(process.cwd(), `.vpr/meta.json.pre-migrate-${ts}`);
        writeFileSync(backupPath, JSON.stringify(meta, null, 2), 'utf-8');
      }
      jjSafe(`bookmark delete ${bookmark}`);
    }
    converted.push(bookmark);
  }

  if (!dryRun && converted.length > 0) {
    await appendEvent('cli', 'vpr.migrate', { converted, skipped });
    jjExportIfAvailable();
  }

  return { converted, skipped, dryRun };
}
