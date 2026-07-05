import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMeta, saveMeta } from '../../src/core/meta.mjs';
import { migrateArchive } from '../../src/commands/archive.mjs';
import { getArchive, listArchive } from '../../src/core/archive.mjs';

let tmpDir;
let originalCwd;

describe('migrateArchive()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-migrate-test-'));
    process.chdir(tmpDir);
  });

  it('moves existing meta.sent entries into the archive and empties meta.sent', async () => {
    await saveMeta({
      items: {},
      hold: [],
      sent: {
        'feat/1-a': { prId: 10, prTitle: '1: A', targetBranch: 'main', itemName: 'a', wi: 1, originalBookmark: 'a/one', sentAt: '2026-01-01T00:00:00.000Z' },
        'feat/2-b': { prId: 11, prTitle: '2: B', targetBranch: 'feat/1-a', itemName: 'a', wi: 2, originalBookmark: 'a/two', sentAt: '2026-02-01T00:00:00.000Z' },
      },
      eventLog: [],
    });

    const result = await migrateArchive();
    assert.strictEqual(result.sentMigrated, 2);

    const meta = await loadMeta();
    assert.deepStrictEqual(meta.sent, {}, 'meta.sent should be emptied');

    const a = getArchive('feat/1-a');
    assert.ok(a);
    assert.strictEqual(a.status, 'sent');
    assert.strictEqual(a.itemName, 'a');
    assert.strictEqual(a.ticket, '10');
    assert.strictEqual(a.sentAt, '2026-01-01T00:00:00.000Z');
  });

  it('recovers terminal done items from the eventLog', async () => {
    await saveMeta({
      items: {},
      hold: [],
      sent: {},
      eventLog: [
        { ts: '2026-03-01T00:00:00.000Z', actor: 'cli', action: 'ticket.done', detail: { name: 'shipped-feature' } },
        { ts: '2026-03-02T00:00:00.000Z', actor: 'cli', action: 'ticket.new', detail: { name: 'noise' } },
      ],
    });

    const result = await migrateArchive();
    assert.strictEqual(result.doneRecovered, 1);

    const done = getArchive('shipped-feature');
    assert.ok(done, 'done item recovered from eventLog');
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.doneAt, '2026-03-01T00:00:00.000Z');
  });

  it('does not overwrite an item still active in meta with an eventLog done stub', async () => {
    await saveMeta({
      items: { 'still-here': { wi: 5, wiTitle: 'Still Here', vprs: {} } },
      hold: [],
      sent: {},
      eventLog: [
        { ts: '2026-03-01T00:00:00.000Z', actor: 'cli', action: 'ticket.done', detail: { name: 'still-here' } },
      ],
    });

    const result = await migrateArchive();
    assert.strictEqual(result.doneRecovered, 0, 'active item must not be archived as done');
    assert.strictEqual(getArchive('still-here'), null);
  });

  it('is idempotent — a second run migrates nothing new', async () => {
    await saveMeta({
      items: {},
      hold: [],
      sent: { 'feat/1-a': { prId: 10, itemName: 'a', sentAt: '2026-01-01T00:00:00.000Z' } },
      eventLog: [{ ts: '2026-03-01T00:00:00.000Z', actor: 'cli', action: 'ticket.done', detail: { name: 'x' } }],
    });

    const first = await migrateArchive();
    assert.strictEqual(first.sentMigrated, 1);
    assert.strictEqual(first.doneRecovered, 1);

    const second = await migrateArchive();
    assert.strictEqual(second.sentMigrated, 0);
    assert.strictEqual(second.doneRecovered, 0);

    assert.strictEqual(listArchive().length, 2, 'no duplicate rows');
  });

  it('reports meta.json byte size shrinking', async () => {
    const bigSent = {};
    for (let i = 0; i < 50; i++) {
      bigSent[`feat/${i}-slice`] = { prId: i, prTitle: `${i}: Slice`, targetBranch: 'main', itemName: 'big', wi: i, originalBookmark: `big/slice-${i}`, sentAt: '2026-01-01T00:00:00.000Z' };
    }
    await saveMeta({ items: {}, hold: [], sent: bigSent, eventLog: [] });

    const result = await migrateArchive();
    assert.strictEqual(result.sentMigrated, 50);
    assert.ok(result.metaBytesAfter < result.metaBytesBefore, 'meta.json should shrink');
  });
});
