import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addVpr } from '../../src/commands/add.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/**
 * Setup a fresh git + jj colocated repo with one real commit so we have a
 * non-empty working copy (@) that can carry a bookmark.
 */
function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-add-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  sh('jj git init --colocate', tmpDir);

  // Create a described commit so @ is described (has content)
  writeFileSync(join(tmpDir, 'init.txt'), 'init\n');
  sh('jj describe -m "chore: init"');
  sh('jj new');

  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('addVpr()', () => {
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
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
  });

  // -------------------------------------------------------------------------
  // Basic VPR creation
  // -------------------------------------------------------------------------

  describe('creating a VPR under an item', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': { wi: 10, wiTitle: 'Scaffold App', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('returns { bookmark, item, title }', async () => {
      const result = await addVpr('Add nav bar', { item: 'scaffold-app' });
      assert.ok(result, 'should return a result');
      assert.ok(typeof result.bookmark === 'string', 'bookmark should be a string');
      assert.strictEqual(result.item, 'scaffold-app');
      assert.strictEqual(result.title, 'Add nav bar');
    });

    it('bookmark is prefixed with item name', async () => {
      const result = await addVpr('Add nav bar', { item: 'scaffold-app' });
      assert.ok(result.bookmark.startsWith('scaffold-app/'), `bookmark should start with item name, got: ${result.bookmark}`);
    });

    it('bookmark suffix is the slugified title', async () => {
      const result = await addVpr('Add nav bar', { item: 'scaffold-app' });
      assert.strictEqual(result.bookmark, 'scaffold-app/add-nav-bar');
    });

    it('registers VPR in meta.items[item].vprs', async () => {
      await addVpr('My Feature', { item: 'scaffold-app' });
      const meta = await loadMeta();
      const vprs = meta.items['scaffold-app'].vprs;
      assert.ok(vprs['scaffold-app/my-feature'], 'VPR should be in meta');
      const vpr = vprs['scaffold-app/my-feature'];
      assert.strictEqual(vpr.title, 'My Feature');
      assert.strictEqual(vpr.story, '');
      assert.strictEqual(vpr.output, null);
    });

    it('appends an event to the event log', async () => {
      await addVpr('New Feature', { item: 'scaffold-app' });
      const meta = await loadMeta();
      assert.ok(meta.eventLog.length > 0);
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'vpr.add');
    });
  });

  // -------------------------------------------------------------------------
  // Auto-select item when only one exists
  // -------------------------------------------------------------------------

  describe('item auto-selection', () => {
    it('uses the only item when none specified', async () => {
      await saveMeta({
        items: {
          'only-item': { wi: 20, wiTitle: 'Only Item', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await addVpr('My VPR', {});
      assert.strictEqual(result.item, 'only-item');
    });

    it('throws when no item specified and multiple items exist', async () => {
      await saveMeta({
        items: {
          'item-a': { wi: 21, wiTitle: 'Item A', vprs: {} },
          'item-b': { wi: 22, wiTitle: 'Item B', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      await assert.rejects(
        () => addVpr('My VPR', {}),
        /ambiguous|multiple|specify/i
      );
    });

    it('throws when no item specified and no items exist', async () => {
      // meta already empty from beforeEach
      await assert.rejects(
        () => addVpr('My VPR', {}),
        /no items|not found|specify/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // Bookmark placement
  // -------------------------------------------------------------------------

  describe('bookmark placement', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': { wi: 10, wiTitle: 'Scaffold App', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('creates a jj bookmark that exists after addVpr', async () => {
      const result = await addVpr('My Bookmark', { item: 'scaffold-app' });
      // Check that the bookmark exists in jj
      const bookmarks = sh('jj bookmark list');
      assert.ok(
        bookmarks.includes(result.bookmark),
        `Expected bookmark ${result.bookmark} to exist. Got:\n${bookmarks}`
      );
    });
  });
});
