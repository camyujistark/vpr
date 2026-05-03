import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

function runVpr(args, cwd, opts = {}) {
  return execSync(`node ${vprBin} ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function runVprResult(args, cwd) {
  try {
    const stdout = runVpr(args, cwd);
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

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

  // AC10: appends vpr.abandon event to event log
  it('AC10: appends { actor: cli, action: vpr.abandon, detail: { branchName, itemName } } to eventLog', async () => {
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
    const event = meta.eventLog.find(e => e.action === 'vpr.abandon');
    assert.ok(event, 'vpr.abandon event must be in eventLog');
    assert.strictEqual(event.actor, 'cli');
    assert.strictEqual(event.detail.branchName, 'feat/1-alpha');
    assert.strictEqual(event.detail.itemName, 'alpha');
  });
});

// ---------------------------------------------------------------------------
// AC8–9: CLI vpr abandon <branchName>
// ---------------------------------------------------------------------------

describe('vpr abandon CLI', () => {
  let cliTmpDir;
  let cliOriginalCwd;

  before(() => { cliOriginalCwd = process.cwd(); });
  after(() => {
    process.chdir(cliOriginalCwd);
    if (cliTmpDir) rmSync(cliTmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (cliTmpDir) rmSync(cliTmpDir, { recursive: true, force: true });
    cliTmpDir = mkdtempSync(join(tmpdir(), 'vpr-abandon-cli-'));
    mkdirSync(join(cliTmpDir, '.vpr'), { recursive: true });
  });

  it('AC8: prints "Abandoned <branchName>" on success', () => {
    writeFileSync(
      join(cliTmpDir, '.vpr/meta.json'),
      JSON.stringify({
        items: { alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} } },
        hold: [],
        sent: { 'feat/1-alpha': { itemName: 'alpha', prId: 10, sentAt: '2025-01-01T00:00:00Z' } },
        eventLog: [],
      })
    );
    const out = runVpr('abandon feat/1-alpha', cliTmpDir).trim();
    assert.strictEqual(out, 'Abandoned feat/1-alpha');
  });

  it('AC8: lists newly-blocked items under "Newly blocked downstream:"', () => {
    writeFileSync(
      join(cliTmpDir, '.vpr/meta.json'),
      JSON.stringify({
        items: {
          alpha: { wi: 1, wiTitle: 'Alpha', dependsOn: [], vprs: {} },
          beta:  { wi: 2, wiTitle: 'Beta',  dependsOn: ['alpha'], vprs: {} },
        },
        hold: [],
        sent: { 'feat/1-alpha': { itemName: 'alpha', prId: 10, sentAt: '2025-01-01T00:00:00Z' } },
        eventLog: [],
      })
    );
    const out = runVpr('abandon feat/1-alpha', cliTmpDir).trim();
    assert.ok(out.includes('Abandoned feat/1-alpha'), `missing header: ${out}`);
    assert.ok(out.includes('Newly blocked downstream:'), `missing section header: ${out}`);
    assert.ok(out.includes('beta'), `missing beta in output: ${out}`);
  });

  it('AC9: exits non-zero with clear error for unknown branch', () => {
    writeFileSync(
      join(cliTmpDir, '.vpr/meta.json'),
      JSON.stringify({ items: {}, hold: [], sent: {}, eventLog: [] })
    );
    const res = runVprResult('abandon feat/999-ghost', cliTmpDir);
    assert.notStrictEqual(res.code, 0);
    assert.ok(
      res.stderr.includes('feat/999-ghost') || res.stdout.includes('feat/999-ghost'),
      `expected branch name in error output, got: ${res.stderr}`
    );
  });

  it('AC8: vpr --help mentions abandon', () => {
    const res = runVprResult('--help', cliTmpDir);
    const combined = res.stdout + res.stderr;
    assert.ok(combined.includes('abandon'), `--help should mention abandon, got: ${combined.slice(0, 500)}`);
  });
});

// ---------------------------------------------------------------------------
// AC11–13: Integration tests
// ---------------------------------------------------------------------------

describe('integration: abandon lifecycle', () => {
  let intTmpDir;
  let intOriginalCwd;

  before(() => { intOriginalCwd = process.cwd(); });
  after(() => {
    process.chdir(intOriginalCwd);
    if (intTmpDir) rmSync(intTmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (intTmpDir) rmSync(intTmpDir, { recursive: true, force: true });
    intTmpDir = mkdtempSync(join(tmpdir(), 'vpr-abandon-int-'));
    mkdirSync(join(intTmpDir, '.vpr'), { recursive: true });
    process.chdir(intTmpDir);
  });

  // AC11: send A; B depends on A; abandon A's branch; B is blocked
  it('AC11: after abandoning A\'s only sent record, B.ready=false and B.blockers=[A]', async () => {
    writeFileSync(
      join(intTmpDir, '.vpr/meta.json'),
      JSON.stringify({
        items: {
          itemA: { wi: 1, wiTitle: 'A', dependsOn: [], vprs: {} },
          itemB: { wi: 2, wiTitle: 'B', dependsOn: ['itemA'], vprs: {} },
        },
        hold: [],
        sent: {
          'feat/1-itemA': { itemName: 'itemA', prId: 10, sentAt: '2025-01-01T00:00:00Z' },
        },
        eventLog: [],
      })
    );

    const { abandonVpr: abandon } = await import('../../src/commands/abandon.mjs');
    const { status: dagStatus } = await import('../../src/core/dag.mjs');
    const { loadMeta: lm } = await import('../../src/core/meta.mjs');

    await abandon('feat/1-itemA');

    const state = await lm();
    const view = dagStatus('itemB', state);
    assert.strictEqual(view.ready, false, 'itemB should not be ready');
    assert.deepStrictEqual(view.blockers, ['itemA'], 'itemB.blockers should be [itemA]');
  });

  // AC12: abandoning already-abandoned VPR — exits 0 with warning, no double-stamp
  it('AC12: abandoning already-abandoned VPR warns and no-ops via CLI (exits 0)', () => {
    const originalAt = '2024-06-01T12:00:00Z';
    writeFileSync(
      join(intTmpDir, '.vpr/meta.json'),
      JSON.stringify({
        items: {},
        hold: [],
        sent: {
          'feat/1-alpha': { itemName: 'alpha', abandoned: true, abandonedAt: originalAt },
        },
        eventLog: [],
      })
    );
    // Should exit 0 (no throw) and emit warning
    let out = '';
    let err = '';
    try {
      out = runVpr('abandon feat/1-alpha', intTmpDir);
    } catch (e) {
      assert.fail(`Expected exit 0 for already-abandoned, got non-zero: ${e.stderr}`);
    }
    // abandonedAt should not be overwritten
    const meta = JSON.parse(readFileSync(join(intTmpDir, '.vpr/meta.json'), 'utf8'));
    assert.strictEqual(meta.sent['feat/1-alpha'].abandonedAt, originalAt);
  });

  // AC13: abandon non-existent branch — exits non-zero with clear error
  it('AC13: abandoning non-existent branch exits non-zero with clear error', () => {
    writeFileSync(
      join(intTmpDir, '.vpr/meta.json'),
      JSON.stringify({ items: {}, hold: [], sent: {}, eventLog: [] })
    );
    const res = runVprResult('abandon feat/999-ghost', intTmpDir);
    assert.notStrictEqual(res.code, 0, 'should exit non-zero');
    assert.ok(
      res.stderr.includes('feat/999-ghost') || res.stdout.includes('feat/999-ghost'),
      `expected branch name in error output, got stderr: ${res.stderr}`
    );
  });
});
