import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planPull } from '../../src/commands/plan-pull.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-plan-pull-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: tmpDir, stdio: 'pipe' });
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  originalCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardownRepo() {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeProvider(overrides = {}) {
  return {
    getWorkItem: (id) => ({ id, title: `Task ${id}`, type: 'Task', state: 'Active' }),
    getChildren: (parentId) => [],
    getCurrentUser: () => null,
    ...overrides,
  };
}

describe('planPull() dedup — AC13', () => {
  before(() => setupRepo());
  after(() => teardownRepo());

  beforeEach(async () => {
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
  });

  it('skips wi already in meta.items', async () => {
    await saveMeta({
      items: { 'existing-item': { wi: 42, wiTitle: 'Existing', vprs: {} } },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const provider = makeProvider({
      getWorkItem: (id) => ({ id, title: `Parent ${id}`, type: 'Feature' }),
      getChildren: () => [{ id: 42, title: 'Task 42', type: 'Task', assignedTo: null }],
    });

    const { results } = await planPull(100, { provider });
    const r = results.find(r => r.wi === 42);
    assert.strictEqual(r.status, 'exists');
  });

  it('AC13(b): skips wi already in meta.sent', async () => {
    await saveMeta({
      items: {},
      hold: [],
      sent: {
        'feat/42-branch': { itemName: 'old-item', wi: 42, prId: 1, sentAt: '2025-01-01T00:00:00Z', mergedAt: '2025-01-02T00:00:00Z', itemDone: true },
      },
      eventLog: [],
    });

    const provider = makeProvider({
      getWorkItem: (id) => ({ id, title: `Parent ${id}`, type: 'Feature' }),
      getChildren: () => [{ id: 42, title: 'Task 42', type: 'Task', assignedTo: null }],
    });

    const { results } = await planPull(100, { provider });
    const r = results.find(r => r.wi === 42);
    assert.ok(r, 'should have a result for wi 42');
    assert.strictEqual(r.status, 'skipped', 'wi in sent should be skipped');
  });

  it('AC13(c): skips wi whose provider state is a terminal state', async () => {
    const provider = makeProvider({
      getWorkItem: (id) => {
        if (id === 100) return { id: 100, title: 'Parent', type: 'Feature' };
        return { id, title: `Task ${id}`, type: 'Task', state: 'Done' };
      },
      getChildren: () => [{ id: 55, title: 'Done Task', type: 'Task', assignedTo: null }],
    });

    const { results } = await planPull(100, { provider });
    const r = results.find(r => r.wi === 55);
    assert.ok(r, 'should have a result for wi 55');
    assert.strictEqual(r.status, 'skipped', 'terminal-state wi should be skipped');
  });

  it('AC13(c): does NOT skip wi in active state', async () => {
    const provider = makeProvider({
      getWorkItem: (id) => {
        if (id === 100) return { id: 100, title: 'Parent', type: 'Feature' };
        return { id, title: `Task ${id}`, type: 'Task', state: 'Active' };
      },
      getChildren: () => [{ id: 77, title: 'Active Task', type: 'Task', assignedTo: null }],
    });

    const { results } = await planPull(100, { provider });
    const r = results.find(r => r.wi === 77);
    assert.ok(r, 'should have a result for wi 77');
    assert.strictEqual(r.status, 'created', 'active wi should be created');
  });
});
