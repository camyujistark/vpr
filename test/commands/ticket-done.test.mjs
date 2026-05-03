import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveMeta, loadMeta } from '../../src/core/meta.mjs';
import { ticketDone } from '../../src/commands/ticket.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

function runVpr(args, cwd) {
  return execSync(`node ${vprBin} ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
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

// ---------------------------------------------------------------------------
// Function-level integration tests — AC14 (a–e)
// ---------------------------------------------------------------------------

describe('ticketDone() integration — AC14', () => {
  let tmpDir;
  let originalCwd;

  before(() => { originalCwd = process.cwd(); });
  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-ticket-done-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: tmpDir, stdio: 'pipe' });
    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    process.chdir(tmpDir);
  });

  it('AC14(a): refuses when item has unsent VPRs', async () => {
    await saveMeta({
      items: {
        'my-item': { wi: 5, wiTitle: 'My Item', vprs: { 'my-item/feat': { title: 'F', story: '' } } },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    await assert.rejects(
      () => ticketDone('my-item'),
      (err) => {
        assert.match(err.message, /unsent/i);
        assert.ok(err.message.includes('my-item/feat'), `expected branch name in error: ${err.message}`);
        return true;
      }
    );
    const meta = await loadMeta();
    assert.ok(meta.items['my-item'], 'item should not be deleted on refusal');
  });

  it('AC14(b): refuses when sent records lack mergedAt', async () => {
    await saveMeta({
      items: { 'my-item': { wi: 5, wiTitle: 'My Item', vprs: {} } },
      hold: [],
      sent: {
        'feat/5-open': { itemName: 'my-item', wi: 5, prId: 1, sentAt: '2025-01-01T00:00:00Z' },
      },
      eventLog: [],
    });

    await assert.rejects(
      () => ticketDone('my-item'),
      /feat\/5-open/
    );
  });

  it('AC14(c): --check-merged polls stub provider and succeeds', async () => {
    const MERGED_AT = '2025-02-01T10:00:00Z';
    await saveMeta({
      items: { 'my-item': { wi: 5, wiTitle: 'My Item', vprs: {} } },
      hold: [],
      sent: {
        'feat/5-pr': { itemName: 'my-item', wi: 5, prId: 99, sentAt: '2025-01-01T00:00:00Z' },
      },
      eventLog: [],
    });

    const provider = {
      getPRStatus: async () => ({ merged: true, mergedAt: MERGED_AT }),
      updateWorkItem: async () => {},
    };

    await ticketDone('my-item', { checkMerged: true, provider });

    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'], 'item removed');
    assert.strictEqual(meta.sent['feat/5-pr'].mergedAt, MERGED_AT);
    assert.strictEqual(meta.sent['feat/5-pr'].itemDone, true);
  });

  it('AC14(d): --force bypasses all preconditions', async () => {
    await saveMeta({
      items: {
        'my-item': {
          wi: 5,
          wiTitle: 'My Item',
          vprs: { 'my-item/unmerged': { title: 'U', story: '' } },
        },
      },
      hold: [],
      sent: {
        'feat/5-open': { itemName: 'my-item', wi: 5, prId: 1, sentAt: '2025-01-01T00:00:00Z' },
      },
      eventLog: [],
    });

    let updateCalled = false;
    const provider = { updateWorkItem: async () => { updateCalled = true; } };

    await ticketDone('my-item', { force: true, provider });

    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'], 'item removed despite precondition failures');
    assert.ok(updateCalled, 'provider.updateWorkItem called even with force');
  });

  it('AC14(e): success path — provider.updateWorkItem called, itemDone stamped, item deleted', async () => {
    await saveMeta({
      items: { 'my-item': { wi: 5, wiTitle: 'My Item', vprs: {} } },
      hold: [],
      sent: {
        'feat/5-a': { itemName: 'my-item', wi: 5, prId: 1, sentAt: '2025-01-01T00:00:00Z', mergedAt: '2025-01-02T00:00:00Z' },
        'feat/5-b': { itemName: 'my-item', wi: 5, prId: 2, sentAt: '2025-01-03T00:00:00Z', mergedAt: '2025-01-04T00:00:00Z' },
      },
      eventLog: [],
    });

    const calls = [];
    const provider = { updateWorkItem: async (wi, fields) => { calls.push({ wi, fields }); } };

    await ticketDone('my-item', { provider });

    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'], 'item deleted from meta.items');
    assert.strictEqual(meta.sent['feat/5-a'].itemDone, true);
    assert.strictEqual(meta.sent['feat/5-b'].itemDone, true);
    assert.ok(meta.sent['feat/5-a'], 'sent record preserved');
    assert.deepStrictEqual(calls, [{ wi: 5, fields: { state: 'Done' } }]);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

describe('vpr ticket done CLI — AC14', () => {
  let cliTmpDir;
  let cliOriginalCwd;

  before(() => { cliOriginalCwd = process.cwd(); });
  after(() => {
    process.chdir(cliOriginalCwd);
    if (cliTmpDir) rmSync(cliTmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (cliTmpDir) rmSync(cliTmpDir, { recursive: true, force: true });
    cliTmpDir = mkdtempSync(join(tmpdir(), 'vpr-ticket-done-cli-'));
    execSync('git init', { cwd: cliTmpDir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: cliTmpDir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: cliTmpDir, stdio: 'pipe' });
    mkdirSync(join(cliTmpDir, '.vpr'), { recursive: true });
  });

  it('AC14(a) CLI: exits non-zero with error listing unsent VPRs', () => {
    writeFileSync(
      join(cliTmpDir, '.vpr/meta.json'),
      JSON.stringify({
        items: {
          'my-item': { wi: 5, wiTitle: 'My Item', vprs: { 'my-item/feat': { title: 'F', story: '' } } },
        },
        hold: [],
        sent: {},
        eventLog: [],
      })
    );

    const res = runVprResult('ticket done my-item', cliTmpDir);
    assert.notStrictEqual(res.code, 0);
    const output = res.stdout + res.stderr;
    assert.ok(output.includes('my-item/feat'), `expected branch in error: ${output}`);
  });

  it('AC14: vpr ticket --help lists --check-merged and --force', () => {
    const res = runVprResult('ticket --help', cliTmpDir);
    const combined = res.stdout + res.stderr;
    assert.ok(
      combined.includes('check-merged') || combined.includes('--check-merged'),
      `vpr ticket --help should mention check-merged, got: ${combined.slice(0, 500)}`
    );
    assert.ok(
      combined.includes('--force'),
      `vpr ticket --help should mention --force, got: ${combined.slice(0, 500)}`
    );
  });
});
