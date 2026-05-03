import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveMeta, loadMeta } from '../../src/core/meta.mjs';
import { abandonVpr } from '../../src/commands/abandon.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-abandon-test-'));
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
// AC1: exports abandonVpr function
// ---------------------------------------------------------------------------

describe('abandon module', () => {
  it('exports abandonVpr as a function', async () => {
    const mod = await import('../../src/commands/abandon.mjs');
    assert.strictEqual(typeof mod.abandonVpr, 'function');
  });
});

// ---------------------------------------------------------------------------
// AC2–7: core function behaviour
// ---------------------------------------------------------------------------

describe('abandonVpr()', () => {
  before(() => { originalCwd = process.cwd(); });
  after(() => { teardown(); });
  beforeEach(async () => {
    teardown();
    originalCwd = process.cwd();
    setup();
  });

  // AC2: sets abandoned=true and abandonedAt; does NOT delete record
  it('AC2: sets abandoned=true and abandonedAt ISO timestamp; record preserved', async () => {
    await saveMeta({
      items: { alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} } },
      hold: [],
      sent: {
        'feat/1-alpha': { itemName: 'alpha', prId: 42, sentAt: '2025-01-01T00:00:00Z' },
      },
      eventLog: [],
    });

    await abandonVpr('feat/1-alpha');

    const meta = await loadMeta();
    const record = meta.sent['feat/1-alpha'];
    assert.ok(record, 'sent record must still exist');
    assert.strictEqual(record.abandoned, true);
    assert.ok(typeof record.abandonedAt === 'string', 'abandonedAt must be a string');
    assert.ok(!isNaN(Date.parse(record.abandonedAt)), 'abandonedAt must be a valid ISO date');
  });

  // AC3: refuses unknown branch
  it('AC3: throws "No sent VPR found: <name>" for unknown branch', async () => {
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
    await assert.rejects(
      () => abandonVpr('feat/999-nonexistent'),
      /No sent VPR found: feat\/999-nonexistent/
    );
  });

  // AC4: idempotent — no-op on already-abandoned, does not double-stamp abandonedAt
  it('AC4: warns and no-ops if already abandoned; abandonedAt not overwritten', async () => {
    const originalAt = '2024-06-01T12:00:00Z';
    await saveMeta({
      items: { alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} } },
      hold: [],
      sent: {
        'feat/1-alpha': {
          itemName: 'alpha',
          abandoned: true,
          abandonedAt: originalAt,
        },
      },
      eventLog: [],
    });

    const result = await abandonVpr('feat/1-alpha');
    const meta = await loadMeta();
    assert.strictEqual(meta.sent['feat/1-alpha'].abandonedAt, originalAt);
    assert.deepStrictEqual(result.newlyBlocked, []);
  });

  // AC5 + AC6 + AC7: returns { branchName, itemName, newlyBlocked } with correct downstream calc
  it('AC5-7: downstream item newly-blocked when abandoned VPR was only non-abandoned record', async () => {
    await saveMeta({
      items: {
        alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} },
        beta:  { wi: 2, wiTitle: 'Beta',  dependsOn: ['alpha'], vprs: {} },
      },
      hold: [],
      sent: {
        'feat/1-alpha': { itemName: 'alpha', prId: 10, sentAt: '2025-01-01T00:00:00Z' },
      },
      eventLog: [],
    });

    const result = await abandonVpr('feat/1-alpha');

    assert.strictEqual(result.branchName, 'feat/1-alpha');
    assert.strictEqual(result.itemName, 'alpha');
    assert.strictEqual(result.newlyBlocked.length, 1);
    assert.strictEqual(result.newlyBlocked[0].name, 'beta');
  });

  it('AC7: returns empty newlyBlocked when downstream had other non-abandoned sent records', async () => {
    await saveMeta({
      items: {
        alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} },
        beta:  { wi: 2, wiTitle: 'Beta',  dependsOn: ['alpha'], vprs: {} },
      },
      hold: [],
      sent: {
        'feat/1-alpha-v1': { itemName: 'alpha', prId: 10, sentAt: '2025-01-01T00:00:00Z' },
        'feat/1-alpha-v2': { itemName: 'alpha', prId: 11, sentAt: '2025-01-02T00:00:00Z' },
      },
      eventLog: [],
    });

    // abandoning v1 — alpha still released via v2
    const result = await abandonVpr('feat/1-alpha-v1');
    assert.deepStrictEqual(result.newlyBlocked, []);
  });
});
