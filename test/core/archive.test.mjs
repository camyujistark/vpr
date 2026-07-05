import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  archiveTerminal,
  getArchive,
  listArchive,
  archiveSentMap,
  countArchive,
} from '../../src/core/archive.mjs';

let tmpDir;
let originalCwd;

describe('archive core (sqlite)', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-archive-test-'));
    process.chdir(tmpDir);
  });

  describe('read path with no database', () => {
    it('listArchive returns [] when no db file exists', () => {
      assert.deepStrictEqual(listArchive(), []);
    });

    it('getArchive returns null when no db file exists', () => {
      assert.strictEqual(getArchive('anything'), null);
    });

    it('archiveSentMap returns {} when no db file exists', () => {
      assert.deepStrictEqual(archiveSentMap(), {});
    });

    it('reading does NOT create the db file', () => {
      listArchive();
      archiveSentMap();
      getArchive('x');
      assert.ok(!existsSync(join(tmpDir, '.vpr', 'archive.db')), 'read path must not create archive.db');
    });
  });

  describe('archiveTerminal() + getArchive()', () => {
    it('stores a sent VPR and reads it back with all fields', () => {
      archiveTerminal({
        name: 'feat/99-my-feature-nav-bar',
        kind: 'vpr',
        status: 'sent',
        itemName: 'my-feature',
        wi: 99,
        provider: 'azure-devops',
        ticket: '4952',
        title: '5: Nav Bar',
        story: 'The nav bar story',
        acceptance: '## Summary\n- nav bar',
        targetBranch: 'main',
        originalBookmark: 'my-feature/nav-bar',
        sentAt: '2026-04-28T00:00:00.000Z',
      });

      const row = getArchive('feat/99-my-feature-nav-bar');
      assert.ok(row, 'row should exist');
      assert.strictEqual(row.name, 'feat/99-my-feature-nav-bar');
      assert.strictEqual(row.kind, 'vpr');
      assert.strictEqual(row.status, 'sent');
      assert.strictEqual(row.itemName, 'my-feature');
      assert.strictEqual(row.wi, 99);
      assert.strictEqual(row.provider, 'azure-devops');
      assert.strictEqual(row.ticket, '4952');
      assert.strictEqual(row.title, '5: Nav Bar');
      assert.strictEqual(row.story, 'The nav bar story');
      assert.strictEqual(row.acceptance, '## Summary\n- nav bar');
      assert.strictEqual(row.targetBranch, 'main');
      assert.strictEqual(row.originalBookmark, 'my-feature/nav-bar');
      assert.strictEqual(row.sentAt, '2026-04-28T00:00:00.000Z');
      assert.ok(row.archivedAt, 'archivedAt should be stamped');
    });

    it('creates the db file at .vpr/archive.db on first write', () => {
      archiveTerminal({ name: 'feat/1-x', kind: 'vpr', status: 'sent', itemName: 'x' });
      assert.ok(existsSync(join(tmpDir, '.vpr', 'archive.db')), 'archive.db should exist after a write');
    });

    it('stores a done item', () => {
      archiveTerminal({
        name: 'old-feature',
        kind: 'item',
        status: 'done',
        itemName: 'old-feature',
        wi: 17065,
        title: 'Old Feature',
        doneAt: '2026-05-01T00:00:00.000Z',
      });
      const row = getArchive('old-feature');
      assert.strictEqual(row.status, 'done');
      assert.strictEqual(row.kind, 'item');
      assert.strictEqual(row.doneAt, '2026-05-01T00:00:00.000Z');
    });

    it('upserts on the same name (last write wins)', () => {
      archiveTerminal({ name: 'feat/1-x', kind: 'vpr', status: 'sent', itemName: 'x', title: 'first' });
      archiveTerminal({ name: 'feat/1-x', kind: 'vpr', status: 'sent', itemName: 'x', title: 'second' });
      const rows = listArchive();
      assert.strictEqual(rows.length, 1, 'same name should not duplicate');
      assert.strictEqual(getArchive('feat/1-x').title, 'second');
    });
  });

  describe('listArchive()', () => {
    beforeEach(() => {
      archiveTerminal({ name: 'feat/1-one', kind: 'vpr', status: 'sent', itemName: 'a', sentAt: '2026-01-01T00:00:00.000Z' });
      archiveTerminal({ name: 'feat/2-two', kind: 'vpr', status: 'sent', itemName: 'a', sentAt: '2026-02-01T00:00:00.000Z' });
      archiveTerminal({ name: 'done-item', kind: 'item', status: 'done', itemName: 'done-item', doneAt: '2026-03-01T00:00:00.000Z' });
    });

    it('returns all rows when no filter given', () => {
      assert.strictEqual(listArchive().length, 3);
    });

    it('filters by status', () => {
      const sent = listArchive({ status: 'sent' });
      assert.strictEqual(sent.length, 2);
      assert.ok(sent.every(r => r.status === 'sent'));
      const done = listArchive({ status: 'done' });
      assert.strictEqual(done.length, 1);
      assert.strictEqual(done[0].name, 'done-item');
    });

    it('filters by name substring', () => {
      const rows = listArchive({ name: 'two' });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, 'feat/2-two');
    });

    it('orders newest-archived first', () => {
      const rows = listArchive();
      // archivedAt is monotonic in insertion order here; newest should be first.
      const names = rows.map(r => r.name);
      assert.deepStrictEqual(names, ['done-item', 'feat/2-two', 'feat/1-one']);
    });
  });

  describe('archiveSentMap()', () => {
    it('returns only sent rows keyed by branch name with chain-state fields', () => {
      archiveTerminal({
        name: 'feat/1-one', kind: 'vpr', status: 'sent', itemName: 'a',
        wi: 1, sentAt: '2026-01-01T00:00:00.000Z', title: 'One',
        targetBranch: 'main', originalBookmark: 'a/one', ticket: '10',
      });
      archiveTerminal({ name: 'done-item', kind: 'item', status: 'done', itemName: 'done-item' });

      const map = archiveSentMap();
      assert.deepStrictEqual(Object.keys(map), ['feat/1-one']);
      const entry = map['feat/1-one'];
      assert.strictEqual(entry.itemName, 'a');
      assert.strictEqual(entry.sentAt, '2026-01-01T00:00:00.000Z');
      assert.strictEqual(entry.targetBranch, 'main');
      assert.strictEqual(entry.originalBookmark, 'a/one');
      assert.strictEqual(entry.wi, 1);
    });
  });

  describe('countArchive()', () => {
    it('counts rows, optionally by status', () => {
      archiveTerminal({ name: 'feat/1-one', kind: 'vpr', status: 'sent', itemName: 'a' });
      archiveTerminal({ name: 'd', kind: 'item', status: 'done', itemName: 'd' });
      assert.strictEqual(countArchive(), 2);
      assert.strictEqual(countArchive({ status: 'sent' }), 1);
      assert.strictEqual(countArchive({ status: 'done' }), 1);
    });
  });
});
