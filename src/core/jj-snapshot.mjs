import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SNAPSHOT_FILE = '.vpr/ralph-snapshot.txt';

/**
 * Capture the current jj op-log head id and write it to .vpr/ralph-snapshot.txt.
 * Silently no-ops on non-jj repos. Returns the captured id or null.
 *
 * Why: sandcastle's merge-to-head strategy creates git refs the host jj must
 * import. If a divergent change-id collides on import, `jj abandon` can cascade
 * across the chain. Capturing the op-log head before ralph runs gives a single
 * `jj op restore <id>` to undo everything the run did.
 */
export function snapshotJjOp(cwd = process.cwd()) {
  try {
    const opId = execSync(`jj op log -T 'self.id().short()' --no-graph -n 1`, {
      encoding: 'utf-8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!opId) return null;
    const dir = join(cwd, '.vpr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(cwd, SNAPSHOT_FILE), opId);
    return opId;
  } catch {
    return null;
  }
}

/**
 * Read the saved snapshot id, or null if missing/unreadable.
 */
export function readSnapshot(cwd = process.cwd()) {
  const path = join(cwd, SNAPSHOT_FILE);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Restore jj to the snapshot. Throws if no snapshot exists or jj op restore
 * fails. Caller should confirm with the user before invoking.
 */
export function restoreFromSnapshot(cwd = process.cwd()) {
  const opId = readSnapshot(cwd);
  if (!opId) throw new Error('No snapshot found at .vpr/ralph-snapshot.txt');
  execSync(`jj op restore ${opId}`, { cwd, stdio: 'inherit' });
  return opId;
}
