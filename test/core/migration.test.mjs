import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMeta } from '../../src/core/migration.mjs';

describe('migrateMeta()', () => {
  it('exports migrateMeta that returns an object', () => {
    const result = migrateMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
    assert.ok(result !== null && typeof result === 'object');
  });

  it('adds dependsOn: [] to items that do not have one', () => {
    const meta = { items: { foo: { wi: 1, wiTitle: 'Foo', vprs: {} } }, hold: [], sent: {}, eventLog: [] };
    const result = migrateMeta(meta);
    assert.deepStrictEqual(result.items.foo.dependsOn, []);
  });

  it('leaves existing dependsOn arrays untouched', () => {
    const meta = { items: { foo: { wi: 1, dependsOn: ['bar'] } }, hold: [], sent: {}, eventLog: [] };
    const result = migrateMeta(meta);
    assert.deepStrictEqual(result.items.foo.dependsOn, ['bar']);
  });

  it('does not add mergedAt, abandoned, or itemDone to sent records without them', () => {
    const meta = {
      items: {},
      hold: [],
      sent: { 'feat/x': { prId: 1, itemName: 'foo', sentAt: '2026-01-01T00:00:00.000Z' } },
      eventLog: [],
    };
    const result = migrateMeta(meta);
    const sent = result.sent['feat/x'];
    assert.ok(!('mergedAt' in sent), 'should not inject mergedAt');
    assert.ok(!('abandoned' in sent), 'should not inject abandoned');
    assert.ok(!('itemDone' in sent), 'should not inject itemDone');
  });

  it('is idempotent: migrateMeta(migrateMeta(x)) deep-equals migrateMeta(x)', () => {
    const meta = {
      items: { foo: { wi: 1 }, bar: { wi: 2, dependsOn: ['foo'] } },
      hold: [],
      sent: { 'feat/baz': { prId: 3 } },
      eventLog: [],
    };
    const once = migrateMeta(meta);
    const twice = migrateMeta(once);
    assert.deepStrictEqual(twice, once);
  });
});

describe('round-trip: load fixture → migrate → save → reload', () => {
  let tmpDir;
  let originalCwd;

  before(() => { originalCwd = process.cwd(); });
  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-migration-rt-'));
    process.chdir(tmpDir);
  });

  it('loadMeta migrates pre-migration fixture and second load produces no further mutation', async () => {
    const { loadMeta, saveMeta } = await import('../../src/core/meta.mjs');

    const fixture = {
      items: {
        alpha: { wi: 1, wiTitle: 'Alpha', vprs: {} },
        beta: { wi: 2, wiTitle: 'Beta', vprs: {}, dependsOn: ['alpha'] },
      },
      hold: [],
      sent: { 'feat/alpha-1': { prId: 10, itemName: 'alpha', sentAt: '2026-01-01T00:00:00.000Z' } },
      eventLog: [],
    };

    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    writeFileSync(join(tmpDir, '.vpr', 'meta.json'), JSON.stringify(fixture, null, 2));

    const firstLoad = await loadMeta();
    assert.deepStrictEqual(firstLoad.items.alpha.dependsOn, [], 'alpha should gain dependsOn after first load');
    assert.deepStrictEqual(firstLoad.items.beta.dependsOn, ['alpha'], 'beta.dependsOn should be untouched');
    assert.ok(!('mergedAt' in firstLoad.sent['feat/alpha-1']), 'mergedAt should not be injected');

    const diskAfterFirst = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'meta.json'), 'utf-8'));
    assert.deepStrictEqual(diskAfterFirst.items.alpha.dependsOn, [], 'migration should be written back');

    const secondLoad = await loadMeta();
    assert.deepStrictEqual(secondLoad, firstLoad, 'second load must equal first load (idempotent)');

    const diskAfterSecond = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'meta.json'), 'utf-8'));
    assert.deepStrictEqual(diskAfterSecond, diskAfterFirst, 'disk should not change on second load');
  });
});
