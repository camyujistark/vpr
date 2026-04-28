import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ticketNew, ticketList, ticketEdit, ticketDone, ticketRefresh, ticketUpdate } from '../../src/commands/ticket.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-ticket-test-'));
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

/** A simple mock provider that avoids any real HTTP calls. */
function makeProvider({ nextId = 42, titleForGet = 'Fetched Title' } = {}) {
  return {
    createWorkItem: async (title) => ({ id: nextId, url: `http://example.com/wi/${nextId}` }),
    getWorkItem: async (id) => ({ id, title: titleForGet, description: '', state: 'active', url: `http://example.com/wi/${id}` }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ticket commands', () => {
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
    // Start each test with clean meta
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
  });

  // -------------------------------------------------------------------------
  // ticketNew — string title → create work item
  // -------------------------------------------------------------------------

  describe('ticketNew() with string title', () => {
    it('creates a new work item and registers it in meta', async () => {
      const provider = makeProvider({ nextId: 100 });
      const result = await ticketNew('Scaffold App', { provider });

      assert.ok(result, 'should return a result object');
      assert.strictEqual(result.wi, 100);
      assert.strictEqual(result.wiTitle, 'Scaffold App');
      assert.ok(typeof result.name === 'string' && result.name.length > 0, 'name should be non-empty');
    });

    it('slug is derived from the title', async () => {
      const provider = makeProvider({ nextId: 101 });
      const result = await ticketNew('Scaffold App', { provider });
      assert.strictEqual(result.name, 'scaffold-app');
    });

    it('slug is limited to 4 words max', async () => {
      const provider = makeProvider({ nextId: 102 });
      const result = await ticketNew('one two three four five six', { provider });
      assert.strictEqual(result.name, 'one-two-three-four');
    });

    it('slug strips special characters', async () => {
      const provider = makeProvider({ nextId: 103 });
      const result = await ticketNew('Hello, World! (test)', { provider });
      assert.strictEqual(result.name, 'hello-world-test');
    });

    it('persists item to meta with empty vprs', async () => {
      const provider = makeProvider({ nextId: 104 });
      const result = await ticketNew('My Feature', { provider });

      const meta = await loadMeta();
      assert.ok(meta.items[result.name], 'item should be in meta.items');
      const item = meta.items[result.name];
      assert.strictEqual(item.wi, 104);
      assert.strictEqual(item.wiTitle, 'My Feature');
      assert.deepStrictEqual(item.vprs, {});
    });

    it('appends an event to the event log', async () => {
      const provider = makeProvider({ nextId: 105 });
      await ticketNew('Event Feature', { provider });

      const meta = await loadMeta();
      assert.ok(meta.eventLog.length > 0, 'event should be logged');
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'ticket.new');
    });
  });

  // -------------------------------------------------------------------------
  // ticketNew — numeric id → attach to existing work item
  // -------------------------------------------------------------------------

  describe('ticketNew() with numeric id', () => {
    it('attaches to existing work item by id', async () => {
      const provider = makeProvider({ titleForGet: 'Existing Ticket' });
      const result = await ticketNew(999, { provider });

      assert.strictEqual(result.wi, 999);
      assert.strictEqual(result.wiTitle, 'Existing Ticket');
    });

    it('slug is derived from fetched work item title', async () => {
      const provider = makeProvider({ titleForGet: 'Deploy New Service' });
      const result = await ticketNew(200, { provider });
      assert.strictEqual(result.name, 'deploy-new-service');
    });

    it('persists item to meta', async () => {
      const provider = makeProvider({ titleForGet: 'Attached Ticket' });
      const result = await ticketNew(300, { provider });

      const meta = await loadMeta();
      assert.ok(meta.items[result.name], 'item should exist in meta');
      assert.strictEqual(meta.items[result.name].wi, 300);
    });
  });

  // -------------------------------------------------------------------------
  // ticketList
  // -------------------------------------------------------------------------

  describe('ticketList()', () => {
    it('returns empty array when no items', async () => {
      const result = await ticketList();
      assert.deepStrictEqual(result, []);
    });

    it('returns array of items with expected shape', async () => {
      await saveMeta({
        items: {
          'scaffold-app': { wi: 10, wiTitle: 'Scaffold App', vprs: {} },
          'portal-nav': { wi: 11, wiTitle: 'Portal Nav', vprs: { 'portal-nav/ui': { title: 'UI' } } },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await ticketList();
      assert.strictEqual(result.length, 2);

      const scaffold = result.find(r => r.name === 'scaffold-app');
      assert.ok(scaffold, 'scaffold-app should be in list');
      assert.strictEqual(scaffold.wi, 10);
      assert.strictEqual(scaffold.wiTitle, 'Scaffold App');
      assert.strictEqual(scaffold.vprCount, 0);

      const portal = result.find(r => r.name === 'portal-nav');
      assert.ok(portal, 'portal-nav should be in list');
      assert.strictEqual(portal.vprCount, 1);
    });
  });

  // -------------------------------------------------------------------------
  // ticketEdit
  // -------------------------------------------------------------------------

  describe('ticketEdit()', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': { wi: 10, wiTitle: 'Old Title', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('updates wiTitle field', async () => {
      await ticketEdit('scaffold-app', { wiTitle: 'New Title' });
      const meta = await loadMeta();
      assert.strictEqual(meta.items['scaffold-app'].wiTitle, 'New Title');
    });

    it('throws when item not found', async () => {
      await assert.rejects(
        () => ticketEdit('nonexistent', { wiTitle: 'x' }),
        /not found/i
      );
    });

    it('appends an event to the event log', async () => {
      await ticketEdit('scaffold-app', { wiTitle: 'Updated' });
      const meta = await loadMeta();
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'ticket.edit');
    });
  });

  // -------------------------------------------------------------------------
  // ticketDone
  // -------------------------------------------------------------------------

  describe('ticketDone()', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': { wi: 10, wiTitle: 'Scaffold App', vprs: {} },
          'other-item': { wi: 11, wiTitle: 'Other', vprs: {} },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('removes the item from meta', async () => {
      await ticketDone('scaffold-app');
      const meta = await loadMeta();
      assert.ok(!meta.items['scaffold-app'], 'scaffold-app should be removed');
      assert.ok(meta.items['other-item'], 'other-item should remain');
    });

    it('throws when item not found', async () => {
      await assert.rejects(
        () => ticketDone('nonexistent'),
        /not found/i
      );
    });

    it('appends an event to the event log', async () => {
      await ticketDone('scaffold-app');
      const meta = await loadMeta();
      const ev = meta.eventLog[meta.eventLog.length - 1];
      assert.strictEqual(ev.action, 'ticket.done');
    });
  });

  // -------------------------------------------------------------------------
  // ticketRefresh
  // -------------------------------------------------------------------------

  describe('ticketRefresh()', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': {
            wi: 10,
            wiTitle: 'Old Title',
            wiDescription: 'old desc',
            vprs: {},
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('fetches wiDescription from the provider and persists it', async () => {
      const provider = {
        getWorkItem: async (id) => ({
          id,
          title: 'New Title',
          description: 'new desc',
        }),
      };

      await ticketRefresh('scaffold-app', { provider });

      const meta = await loadMeta();
      assert.strictEqual(meta.items['scaffold-app'].wiDescription, 'new desc');
    });

    it('refreshes a legacy item missing the new fields without error', async () => {
      await saveMeta({
        items: {
          'legacy-item': {
            wi: 10,
            wiTitle: 'Legacy Title',
            vprs: {},
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const provider = {
        getWorkItem: async (id) => ({
          id,
          title: 'Refreshed Title',
          description: 'refreshed desc',
        }),
      };

      await ticketRefresh('legacy-item', { provider });

      const meta = await loadMeta();
      const item = meta.items['legacy-item'];
      assert.strictEqual(item.wiDescription, 'refreshed desc');
      assert.ok(!('parentWiTitle' in item), 'should not fabricate parentWiTitle when parentWi is unset');
      assert.ok(!('parentWiDescription' in item), 'should not fabricate parentWiDescription when parentWi is unset');
    });

    it('fetches parentWiTitle and parentWiDescription when item has parentWi', async () => {
      await saveMeta({
        items: {
          'with-parent': {
            wi: 10,
            wiTitle: 'Child Title',
            wiDescription: 'child desc',
            parentWi: 99,
            parentWiTitle: 'old parent title',
            parentWiDescription: 'old parent desc',
            vprs: {},
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const calls = [];
      const provider = {
        getWorkItem: async (id) => {
          calls.push(id);
          if (id === 10) return { id, title: 'Child Title', description: 'child desc' };
          if (id === 99) return { id, title: 'New Parent', description: 'new parent desc' };
          throw new Error(`unexpected id ${id}`);
        },
      };

      await ticketRefresh('with-parent', { provider });

      const meta = await loadMeta();
      assert.strictEqual(meta.items['with-parent'].parentWiTitle, 'New Parent');
      assert.strictEqual(meta.items['with-parent'].parentWiDescription, 'new parent desc');
      assert.deepStrictEqual(calls.sort(), [10, 99]);
    });
  });

  // -------------------------------------------------------------------------
  // ticketUpdate
  // -------------------------------------------------------------------------

  describe('ticketUpdate()', () => {
    beforeEach(async () => {
      await saveMeta({
        items: {
          'scaffold-app': {
            wi: 42,
            wiTitle: 'Scaffold App',
            wiDescription: 'local edited description',
            vprs: {},
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
    });

    it('pushes the local wiDescription to the provider', async () => {
      const calls = [];
      const provider = {
        updateWorkItemDescription: async (id, body) => {
          calls.push({ id, body });
        },
      };

      await ticketUpdate('scaffold-app', { provider });

      assert.deepStrictEqual(calls, [{ id: 42, body: 'local edited description' }]);
    });

    it('is a no-op when item.wi is unset', async () => {
      await saveMeta({
        items: {
          'detached-item': {
            wi: null,
            wiTitle: 'Detached',
            wiDescription: 'whatever',
            vprs: {},
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      let called = false;
      const provider = {
        updateWorkItemDescription: async () => {
          called = true;
        },
      };

      await ticketUpdate('detached-item', { provider });

      assert.strictEqual(called, false, 'provider should not be invoked when item.wi is unset');
    });
  });
});
