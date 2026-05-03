import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveMeta } from '../../src/core/meta.mjs';
import { next } from '../../src/commands/next.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-next-test-'));
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('next()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    teardown();
  });

  beforeEach(async () => {
    teardown();
    originalCwd = process.cwd();
    setup();
  });

  it('returns empty array when no items', async () => {
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
    const result = await next();
    assert.deepStrictEqual(result, []);
  });

  it('returns ready ItemViews sorted by depth asc then name asc', async () => {
    await saveMeta({
      items: {
        alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: { 'alpha/v1': { title: 'v1' } } },
        beta:  { wi: 2, wiTitle: 'Beta',  dependsOn: ['alpha'], vprs: {} },
        gamma: { wi: 3, wiTitle: 'Gamma', dependsOn: [], vprs: {} },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const result = await next();
    // alpha and gamma are ready (no deps, not done); beta is blocked by alpha
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'alpha');
    assert.strictEqual(result[1].name, 'gamma');
  });

  it('each result is an ItemView with expected shape', async () => {
    await saveMeta({
      items: {
        alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: { 'alpha/v1': { title: 'v1' } } },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const result = await next();
    assert.strictEqual(result.length, 1);
    const view = result[0];
    assert.strictEqual(view.name, 'alpha');
    assert.strictEqual(view.wi, 1);
    assert.ok(typeof view.depth === 'number');
    assert.ok(typeof view.vprCount === 'number');
    assert.ok(typeof view.status === 'string');
    assert.ok(Array.isArray(view.blockers));
    assert.strictEqual(view.ready, true);
  });

  it('excludes blocked items', async () => {
    await saveMeta({
      items: {
        upstream: { wi: 1, wiTitle: 'Upstream', dependsOn: [], vprs: {} },
        downstream: { wi: 2, wiTitle: 'Downstream', dependsOn: ['upstream'], vprs: {} },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const result = await next();
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'upstream');
  });

  it('excludes done items', async () => {
    await saveMeta({
      items: {
        'done-item':  { wi: 1, wiTitle: 'Done',  dependsOn: [], vprs: {} },
        'ready-item': { wi: 2, wiTitle: 'Ready', dependsOn: [], vprs: {} },
      },
      hold: [],
      sent: {
        'done-item/v1': { itemName: 'done-item', prId: 1, sentAt: '2025-01-01', itemDone: true },
      },
      eventLog: [],
    });

    const result = await next();
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'ready-item');
  });
});
