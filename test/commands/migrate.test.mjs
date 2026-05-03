/**
 * Tests for vpr migrate — convert old-shape meta (placeholder VPRs with
 * empty anchor commits) to new shape (meta-only, no anchors). Idempotent.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateVprs } from '../../src/commands/migrate.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-migrate-test-'));
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardown() {
  if (originalCwd) process.chdir(originalCwd);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('migrateVprs()', () => {
  before(() => { originalCwd = process.cwd(); });
  after(teardown);

  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    teardown();
    setup();
    await saveMeta({
      items: {
        'my-item': {
          wi: 1, wiTitle: 'My Item',
          vprs: {
            'my-item/my-feature': { title: 'My Feature', story: '', acceptance: '', output: null },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
  });

  it('returns a result object with { converted, skipped, dryRun }', async () => {
    const result = await migrateVprs({ dryRun: false });
    assert.ok(typeof result === 'object', 'should return object');
    assert.ok(Array.isArray(result.converted), 'converted should be array');
    assert.ok(Array.isArray(result.skipped), 'skipped should be array');
    assert.strictEqual(typeof result.dryRun, 'boolean', 'dryRun should be boolean');
  });

  it('is idempotent — running twice produces same meta', async () => {
    await migrateVprs({ dryRun: false });
    const after1 = await loadMeta();
    await migrateVprs({ dryRun: false });
    const after2 = await loadMeta();
    assert.deepStrictEqual(after2, after1, 'second run should not change meta');
  });

  it('in a no-jj environment, converts 0 VPRs (nothing to migrate)', async () => {
    const result = await migrateVprs({ dryRun: false });
    // Without jj, no anchor commits to detect or remove
    assert.strictEqual(result.converted.length, 0, 'no VPRs to convert without jj');
  });

  it('dry-run does not mutate meta', async () => {
    const before = await loadMeta();
    await migrateVprs({ dryRun: true });
    const after = await loadMeta();
    assert.deepStrictEqual(after, before, 'dry-run should not change meta');
  });
});
