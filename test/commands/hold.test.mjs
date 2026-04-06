import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hold, unhold } from '../../src/commands/hold.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-hold-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

async function emptyMeta() {
  await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('hold() and unhold()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    teardownRepo();
  });

  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    teardownRepo();
    setupRepo();
    await emptyMeta();
  });

  // -------------------------------------------------------------------------
  // hold()
  // -------------------------------------------------------------------------

  describe('hold()', () => {
    it('adds a changeId to the hold list', async () => {
      await hold('abc12345');
      const meta = await loadMeta();
      assert.ok(meta.hold.includes('abc12345'), 'changeId should be in hold list');
    });

    it('can hold multiple changeIds', async () => {
      await hold('abc12345');
      await hold('def67890');
      const meta = await loadMeta();
      assert.ok(meta.hold.includes('abc12345'));
      assert.ok(meta.hold.includes('def67890'));
      assert.strictEqual(meta.hold.length, 2);
    });

    it('is idempotent — holding the same id twice does not duplicate', async () => {
      await hold('abc12345');
      await hold('abc12345');
      const meta = await loadMeta();
      assert.strictEqual(meta.hold.filter(id => id === 'abc12345').length, 1, 'should not duplicate');
    });

    it('appends an event to the event log', async () => {
      await hold('abc12345');
      const meta = await loadMeta();
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'vpr.hold');
      assert.strictEqual(ev.detail.changeId, 'abc12345');
    });

    it('does not append event when id is already held (no-op)', async () => {
      await hold('abc12345');
      const countBefore = (await loadMeta()).eventLog.length;
      await hold('abc12345');
      const countAfter = (await loadMeta()).eventLog.length;
      assert.strictEqual(countAfter, countBefore, 'no event should be added for duplicate hold');
    });
  });

  // -------------------------------------------------------------------------
  // unhold()
  // -------------------------------------------------------------------------

  describe('unhold()', () => {
    it('removes a changeId from the hold list', async () => {
      await hold('abc12345');
      await unhold('abc12345');
      const meta = await loadMeta();
      assert.ok(!meta.hold.includes('abc12345'), 'changeId should be removed from hold list');
    });

    it('is idempotent — unholding a non-held id is a no-op', async () => {
      // Should not throw
      await unhold('nonexistent-id');
      const meta = await loadMeta();
      assert.strictEqual(meta.hold.length, 0);
    });

    it('only removes the specified id, leaves others', async () => {
      await hold('abc12345');
      await hold('def67890');
      await unhold('abc12345');
      const meta = await loadMeta();
      assert.ok(!meta.hold.includes('abc12345'));
      assert.ok(meta.hold.includes('def67890'));
    });

    it('appends an event when unholding a held id', async () => {
      await hold('abc12345');
      const countBefore = (await loadMeta()).eventLog.length;
      await unhold('abc12345');
      const meta = await loadMeta();
      assert.strictEqual(meta.eventLog.length, countBefore + 1, 'should append an event');
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'vpr.unhold');
      assert.strictEqual(ev.detail.changeId, 'abc12345');
    });

    it('does not append event when unholding a non-held id', async () => {
      const countBefore = (await loadMeta()).eventLog.length;
      await unhold('nonexistent-id');
      const countAfter = (await loadMeta()).eventLog.length;
      assert.strictEqual(countAfter, countBefore, 'no event for no-op unhold');
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('round-trip', () => {
    it('hold then unhold leaves hold list empty', async () => {
      await hold('abc12345');
      await hold('def67890');
      await unhold('abc12345');
      await unhold('def67890');
      const meta = await loadMeta();
      assert.strictEqual(meta.hold.length, 0);
    });
  });
});
