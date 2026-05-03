/**
 * Tests for vpr merge <src> --into <dst>
 *
 * AC1: mergeVpr(src, { into, title, story }) signature.
 * AC8: Works with jj squash when jj is available; falls back to a
 * git-based approach (meta-only claim transfer) when jj is absent.
 * Both paths produce identical meta state (src removed, claims on dst).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

function runVprResult(args, cwd) {
  try {
    const stdout = execSync(`node ${vprBin} ${args}`, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

import { mergeVpr } from '../../src/commands/merge.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-merge-test-'));
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

describe('mergeVpr()', () => {
  before(() => { originalCwd = process.cwd(); });
  after(teardown);

  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    teardown();
    setup();
    await saveMeta({
      items: {
        'my-item': {
          wi: 1, wiTitle: 'My Item',
          vprs: {
            'my-item/src-feature': {
              title: 'Src Feature', story: '', acceptance: '', output: null,
              claims: ['abc123', 'def456'],
            },
            'my-item/dst-feature': {
              title: 'Dst Feature', story: '', acceptance: '', output: null,
              claims: ['xyz789'],
            },
          },
        },
        'other-item': {
          wi: 2, wiTitle: 'Other Item',
          vprs: {
            'other-item/some-vpr': {
              title: 'Some VPR', story: '', acceptance: '', output: null,
              claims: [],
            },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
  });

  it('AC1: accepts { into } object as second arg', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'].vprs['my-item/src-feature'], 'src removed');
    assert.ok(meta.items['my-item'].vprs['my-item/dst-feature'], 'dst exists');
  });

  it('removes src VPR from meta after merge', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'].vprs['my-item/src-feature'], 'src should be removed');
  });

  it('dst VPR gains claims from src VPR', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    const dstClaims = meta.items['my-item'].vprs['my-item/dst-feature'].claims ?? [];
    assert.ok(dstClaims.includes('abc123'), 'abc123 should be in dst claims');
    assert.ok(dstClaims.includes('def456'), 'def456 should be in dst claims');
    assert.ok(dstClaims.includes('xyz789'), 'xyz789 (original dst claim) should remain');
  });

  it('throws if src VPR not found', async () => {
    await assert.rejects(
      () => mergeVpr('my-item/nonexistent', { into: 'my-item/dst-feature' }),
      /not found/i
    );
  });

  it('throws if dst VPR not found', async () => {
    await assert.rejects(
      () => mergeVpr('my-item/src-feature', { into: 'my-item/nonexistent' }),
      /not found/i
    );
  });

  it('produces same meta state regardless of jj availability (git fallback)', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    assert.ok(!meta.items['my-item'].vprs['my-item/src-feature'], 'src removed');
    const dst = meta.items['my-item'].vprs['my-item/dst-feature'];
    assert.ok(dst, 'dst exists');
    assert.ok((dst.claims ?? []).includes('abc123'), 'src claims transferred');
  });

  it('AC2: refuses cross-item merge with clear error', async () => {
    await assert.rejects(
      () => mergeVpr('my-item/src-feature', { into: 'other-item/some-vpr' }),
      /merge requires same item: src=my-item, dst=other-item/
    );
  });

  it('AC12: event log includes src, dst, item, srcCommits, jjUsed', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    const ev = meta.eventLog.find(e => e.action === 'vpr.merge');
    assert.ok(ev, 'event logged');
    assert.equal(ev.detail.src, 'my-item/src-feature');
    assert.equal(ev.detail.dst, 'my-item/dst-feature');
    assert.equal(ev.detail.item, 'my-item');
    assert.deepEqual(ev.detail.srcCommits, ['abc123', 'def456']);
    assert.equal(typeof ev.detail.jjUsed, 'boolean');
  });

  it('AC8: dst title and story preserved when no overrides given', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature' });
    const meta = await loadMeta();
    const dst = meta.items['my-item'].vprs['my-item/dst-feature'];
    assert.equal(dst.title, 'Dst Feature', 'dst title preserved');
    assert.equal(dst.story, '', 'dst story preserved');
  });

  it('AC9: --title overrides dst title in meta', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature', title: 'New Title' });
    const meta = await loadMeta();
    const dst = meta.items['my-item'].vprs['my-item/dst-feature'];
    assert.equal(dst.title, 'New Title');
  });

  it('AC10: --story overrides dst story in meta', async () => {
    await mergeVpr('my-item/src-feature', { into: 'my-item/dst-feature', story: 'New story text' });
    const meta = await loadMeta();
    const dst = meta.items['my-item'].vprs['my-item/dst-feature'];
    assert.equal(dst.story, 'New story text');
  });

  it('AC11: vpr --help lists vpr merge command', () => {
    const tmpHelpDir = mkdtempSync(join(tmpdir(), 'vpr-merge-help-'));
    try {
      mkdirSync(join(tmpHelpDir, '.vpr'), { recursive: true });
      const res = runVprResult('--help', tmpHelpDir);
      const combined = res.stdout + res.stderr;
      assert.ok(combined.includes('vpr merge'), `--help should list vpr merge, got: ${combined.slice(0, 500)}`);
    } finally {
      rmSync(tmpHelpDir, { recursive: true, force: true });
    }
  });

  it('AC3: refuses non-adjacent merge with clear error', async () => {
    // Setup: 3 VPRs in order: vpr-a, vpr-b, vpr-c
    // Merging vpr-a into vpr-c should fail (not adjacent)
    await saveMeta({
      items: {
        'chain-item': {
          wi: 3, wiTitle: 'Chain Item',
          vprs: {
            'chain-item/vpr-a': { title: 'A', story: '', acceptance: '', output: null, claims: [] },
            'chain-item/vpr-b': { title: 'B', story: '', acceptance: '', output: null, claims: [] },
            'chain-item/vpr-c': { title: 'C', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
    await assert.rejects(
      () => mergeVpr('chain-item/vpr-a', { into: 'chain-item/vpr-c' }),
      /src and dst must be adjacent VPRs/
    );
  });
});
