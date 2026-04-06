import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { list } from '../../src/commands/list.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-list-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  sh('jj git init --colocate', tmpDir);

  // Create a described commit so @ is described
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

/** Seed meta with a predictable set of items + VPRs. */
async function seedMeta() {
  await saveMeta({
    items: {
      'scaffold-app': {
        wi: 10,
        wiTitle: 'Scaffold App',
        vprs: {
          'scaffold-app/nav-bar': { title: 'Nav Bar', story: 'add navigation', output: null },
          'scaffold-app/auth-flow': { title: 'Auth Flow', story: '', output: null },
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
    sent: { 'portal-redesign/landing': { url: 'https://example.com/pr/1', sentAt: '2024-01-01T00:00:00.000Z' } },
    eventLog: [{ ts: '2024-01-01T00:00:00.000Z', actor: 'cli', action: 'vpr.add', detail: {} }],
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('list()', () => {
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
  // Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an object with items, ungrouped, hold, sent, eventLog', async () => {
      const result = await list();
      assert.ok(result, 'should return a result');
      assert.ok(Array.isArray(result.items), 'items should be an array');
      assert.ok(Array.isArray(result.ungrouped), 'ungrouped should be an array');
      assert.ok(Array.isArray(result.hold), 'hold should be an array');
      assert.ok(result.sent !== undefined, 'sent should be present');
      assert.ok(Array.isArray(result.eventLog), 'eventLog should be an array');
    });

    it('does not expose conflicts Set (internal state)', async () => {
      const result = await list();
      assert.strictEqual(result.conflicts, undefined, 'conflicts should not be in output');
    });
  });

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  describe('items', () => {
    it('returns all items from meta', async () => {
      const result = await list();
      assert.strictEqual(result.items.length, 2, 'should have 2 items');
    });

    it('each item has name, wi, wiTitle, vprs', async () => {
      const result = await list();
      const item = result.items.find(i => i.name === 'scaffold-app');
      assert.ok(item, 'scaffold-app item should exist');
      assert.strictEqual(item.wi, 10);
      assert.strictEqual(item.wiTitle, 'Scaffold App');
      assert.ok(Array.isArray(item.vprs), 'vprs should be an array');
    });

    it('each VPR has bookmark, title, story, output, commits, sent, conflict', async () => {
      const result = await list();
      const item = result.items.find(i => i.name === 'scaffold-app');
      const vpr = item.vprs.find(v => v.bookmark === 'scaffold-app/nav-bar');
      assert.ok(vpr, 'nav-bar VPR should exist');
      assert.strictEqual(vpr.title, 'Nav Bar');
      assert.strictEqual(vpr.story, 'add navigation');
      assert.strictEqual(vpr.output, null);
      assert.ok(Array.isArray(vpr.commits), 'commits should be an array');
      assert.strictEqual(typeof vpr.sent, 'boolean');
      assert.strictEqual(typeof vpr.conflict, 'boolean');
    });
  });

  // -------------------------------------------------------------------------
  // Sent flag
  // -------------------------------------------------------------------------

  describe('sent flag', () => {
    it('marks sent VPRs correctly', async () => {
      const result = await list();
      const item = result.items.find(i => i.name === 'portal-redesign');
      const vpr = item.vprs.find(v => v.bookmark === 'portal-redesign/landing');
      assert.strictEqual(vpr.sent, true, 'sent flag should be true for sent VPR');
    });

    it('marks unsent VPRs as not sent', async () => {
      const result = await list();
      const item = result.items.find(i => i.name === 'scaffold-app');
      const vpr = item.vprs.find(v => v.bookmark === 'scaffold-app/nav-bar');
      assert.strictEqual(vpr.sent, false, 'sent flag should be false for unsent VPR');
    });

    it('exposes the sent object directly', async () => {
      const result = await list();
      assert.ok(Object.prototype.hasOwnProperty.call(result.sent, 'portal-redesign/landing'));
    });
  });

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  describe('eventLog', () => {
    it('returns the event log', async () => {
      const result = await list();
      assert.ok(result.eventLog.length > 0, 'eventLog should not be empty');
      assert.strictEqual(result.eventLog[0].action, 'vpr.add');
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('returns empty items, hold, sent, eventLog when meta is empty', async () => {
      await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
      const result = await list();
      // items and hold are controlled entirely by meta
      assert.strictEqual(result.items.length, 0);
      assert.strictEqual(result.hold.length, 0);
      assert.deepStrictEqual(result.sent, {});
      assert.strictEqual(result.eventLog.length, 0);
      // ungrouped may contain repo commits that have no VPR assignment — that is correct behavior
    });
  });
});
