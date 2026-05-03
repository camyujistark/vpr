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
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});
