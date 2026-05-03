/**
 * Tests for the git-first vpr add behavior:
 * - addVpr registers meta entry without creating any jj bookmark
 * - Works in a plain git repo (no jj installed/initialized)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addVpr } from '../../src/commands/add.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function setupGitOnlyRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-add-git-first-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('addVpr() — git-first (no jj)', () => {
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
    setupGitOnlyRepo();
    await saveMeta({
      items: { 'my-item': { wi: 1, wiTitle: 'My Item', vprs: {} } },
      hold: [],
      sent: {},
      eventLog: [],
    });
  });

  it('succeeds in a git-only repo (no jj)', async () => {
    const result = await addVpr('My Feature', { item: 'my-item' });
    assert.strictEqual(result.bookmark, 'my-item/my-feature');
    assert.strictEqual(result.item, 'my-item');
  });

  it('registers the VPR in meta without error', async () => {
    await addVpr('My Feature', { item: 'my-item' });
    const meta = await loadMeta();
    assert.ok(meta.items['my-item'].vprs['my-item/my-feature'], 'VPR should be in meta');
  });

  it('does not create a jj bookmark (meta-only placeholder)', async () => {
    await addVpr('My Feature', { item: 'my-item' });
    // In a git-only repo, there are no jj bookmarks to check.
    // The test verifies no error is thrown even without jj.
    const meta = await loadMeta();
    const vpr = meta.items['my-item'].vprs['my-item/my-feature'];
    assert.ok(vpr, 'VPR exists in meta');
    assert.strictEqual(vpr.title, 'My Feature');
    // No jj bookmark anchor in meta
    assert.ok(!vpr.anchor, 'no anchor field for meta-only VPR');
  });
});
