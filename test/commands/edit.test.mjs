import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findVpr, editVpr } from '../../src/commands/edit.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-edit-test-'));
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

/** Meta with a predictable set of items and VPRs for search tests. */
async function seedMeta() {
  await saveMeta({
    items: {
      'scaffold-app': {
        wi: 10,
        wiTitle: 'Scaffold App',
        vprs: {
          'scaffold-app/nav-bar': { title: 'Nav Bar', story: '', output: null },
          'scaffold-app/auth-flow': { title: 'Auth Flow', story: 'old story', output: null },
        },
      },
      'portal-redesign': {
        wi: 11,
        wiTitle: 'Portal Redesign',
        vprs: {
          'portal-redesign/landing': { title: 'Landing Page', story: '', output: null },
        },
      },
    },
    hold: [],
    sent: {},
    eventLog: [],
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('findVpr() and editVpr()', () => {
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
    await seedMeta();
  });

  // -------------------------------------------------------------------------
  // findVpr
  // -------------------------------------------------------------------------

  describe('findVpr()', () => {
    it('finds by exact bookmark name', async () => {
      const meta = await loadMeta();
      const result = findVpr(meta, 'scaffold-app/nav-bar');
      assert.ok(result, 'should find the VPR');
      assert.strictEqual(result.bookmark, 'scaffold-app/nav-bar');
      assert.strictEqual(result.itemName, 'scaffold-app');
      assert.strictEqual(result.vpr.title, 'Nav Bar');
    });

    it('finds by partial bookmark match', async () => {
      const meta = await loadMeta();
      const result = findVpr(meta, 'nav-bar');
      assert.ok(result, 'should find by partial match');
      assert.strictEqual(result.bookmark, 'scaffold-app/nav-bar');
    });

    it('finds by partial title match (case-insensitive)', async () => {
      const meta = await loadMeta();
      const result = findVpr(meta, 'auth');
      assert.ok(result, 'should find by title partial match');
      assert.strictEqual(result.bookmark, 'scaffold-app/auth-flow');
    });

    it('finds in second item', async () => {
      const meta = await loadMeta();
      const result = findVpr(meta, 'portal-redesign/landing');
      assert.ok(result, 'should find VPR in second item');
      assert.strictEqual(result.itemName, 'portal-redesign');
    });

    it('returns null when nothing matches', async () => {
      const meta = await loadMeta();
      const result = findVpr(meta, 'nonexistent-vpr-xyz');
      assert.strictEqual(result, null);
    });

    it('returns null on empty meta', async () => {
      const emptyMeta = { items: {}, hold: [], sent: {}, eventLog: [] };
      const result = findVpr(emptyMeta, 'anything');
      assert.strictEqual(result, null);
    });

    it('exact match takes priority over partial match', async () => {
      const meta = await loadMeta();
      // 'landing' would partial-match 'portal-redesign/landing'
      // but exact match of full bookmark wins if both could match
      const result = findVpr(meta, 'portal-redesign/landing');
      assert.strictEqual(result.bookmark, 'portal-redesign/landing');
    });
  });

  // -------------------------------------------------------------------------
  // editVpr
  // -------------------------------------------------------------------------

  describe('editVpr()', () => {
    it('updates story field', async () => {
      await editVpr('scaffold-app/auth-flow', { story: 'new story content' });
      const meta = await loadMeta();
      assert.strictEqual(
        meta.items['scaffold-app'].vprs['scaffold-app/auth-flow'].story,
        'new story content'
      );
    });

    it('updates title field', async () => {
      await editVpr('scaffold-app/nav-bar', { title: 'Navigation Bar' });
      const meta = await loadMeta();
      assert.strictEqual(
        meta.items['scaffold-app'].vprs['scaffold-app/nav-bar'].title,
        'Navigation Bar'
      );
    });

    it('updates output field', async () => {
      await editVpr('scaffold-app/nav-bar', { output: 'some/output/path' });
      const meta = await loadMeta();
      assert.strictEqual(
        meta.items['scaffold-app'].vprs['scaffold-app/nav-bar'].output,
        'some/output/path'
      );
    });

    it('can update multiple fields at once', async () => {
      await editVpr('scaffold-app/auth-flow', { title: 'Updated Auth', story: 'updated story' });
      const meta = await loadMeta();
      const vpr = meta.items['scaffold-app'].vprs['scaffold-app/auth-flow'];
      assert.strictEqual(vpr.title, 'Updated Auth');
      assert.strictEqual(vpr.story, 'updated story');
    });

    it('finds by partial query (bookmark suffix)', async () => {
      await editVpr('auth-flow', { story: 'found by partial' });
      const meta = await loadMeta();
      assert.strictEqual(
        meta.items['scaffold-app'].vprs['scaffold-app/auth-flow'].story,
        'found by partial'
      );
    });

    it('finds by partial title match', async () => {
      await editVpr('Nav', { story: 'matched by title' });
      const meta = await loadMeta();
      assert.strictEqual(
        meta.items['scaffold-app'].vprs['scaffold-app/nav-bar'].story,
        'matched by title'
      );
    });

    it('throws when VPR not found', async () => {
      await assert.rejects(
        () => editVpr('nonexistent-vpr', { story: 'x' }),
        /not found/i
      );
    });

    it('appends an event to the event log', async () => {
      await editVpr('scaffold-app/nav-bar', { story: 'logged' });
      const meta = await loadMeta();
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'vpr.edit');
      assert.strictEqual(ev.detail.bookmark, 'scaffold-app/nav-bar');
    });
  });
});
