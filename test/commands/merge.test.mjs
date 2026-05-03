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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Integration tests (AC13-16)
// ---------------------------------------------------------------------------

describe('integration: vpr merge', () => {
  let intDir;
  let intOrigCwd;

  before(() => { intOrigCwd = process.cwd(); });
  after(() => {
    process.chdir(intOrigCwd);
    if (intDir) rmSync(intDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    if (intDir) rmSync(intDir, { recursive: true, force: true });
    intDir = mkdtempSync(join(tmpdir(), 'vpr-merge-int-'));
    mkdirSync(join(intDir, '.vpr'), { recursive: true });
    process.chdir(intDir);
    await saveMeta({
      items: {
        'item-a': {
          wi: 1, wiTitle: 'A', dependsOn: [],
          vprs: {
            'item-a/vpr-1': { title: 'VPR 1', story: '', acceptance: '', output: null, claims: ['ch1', 'ch2'] },
            'item-a/vpr-2': { title: 'VPR 2', story: '', acceptance: '', output: null, claims: ['ch3'] },
          },
        },
        'item-b': {
          wi: 2, wiTitle: 'B', dependsOn: [],
          vprs: {
            'item-b/vpr-x': { title: 'VPR X', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
  });

  it('AC14: git fallback produces correct meta state (src removed, claims merged)', async () => {
    // jj is not available in this env, so this always uses the git/meta-only path
    await mergeVpr('item-a/vpr-1', { into: 'item-a/vpr-2' });
    const meta = await loadMeta();
    assert.ok(!meta.items['item-a'].vprs['item-a/vpr-1'], 'src record gone');
    const dst = meta.items['item-a'].vprs['item-a/vpr-2'];
    assert.ok(dst, 'dst exists');
    const claims = dst.claims ?? [];
    assert.ok(claims.includes('ch1'), 'ch1 transferred');
    assert.ok(claims.includes('ch2'), 'ch2 transferred');
    assert.ok(claims.includes('ch3'), 'ch3 preserved');
  });

  it('AC15: integration — refuses cross-item merge via CLI', () => {
    const res = runVprResult('merge item-a/vpr-1 --into item-b/vpr-x', intDir);
    assert.notStrictEqual(res.code, 0, 'should exit non-zero');
    const combined = res.stdout + res.stderr;
    assert.ok(combined.match(/merge requires same item/i), `expected cross-item error, got: ${combined}`);
  });

  it('AC16: integration — refuses non-adjacent merge via CLI', async () => {
    await saveMeta({
      items: {
        'item-c': {
          wi: 3, wiTitle: 'C', dependsOn: [],
          vprs: {
            'item-c/vpr-x': { title: 'X', story: '', acceptance: '', output: null, claims: [] },
            'item-c/vpr-y': { title: 'Y', story: '', acceptance: '', output: null, claims: [] },
            'item-c/vpr-z': { title: 'Z', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
    const res = runVprResult('merge item-c/vpr-x --into item-c/vpr-z', intDir);
    assert.notStrictEqual(res.code, 0, 'should exit non-zero');
    const combined = res.stdout + res.stderr;
    assert.ok(combined.match(/adjacent/i), `expected adjacency error, got: ${combined}`);
  });
});

// ---------------------------------------------------------------------------
// AC5: git fallback squashes actual commits on real git branches
// ---------------------------------------------------------------------------

describe('AC5: git fallback squashes commits on real git branches', () => {
  let gitDir;
  let savedCwd;

  function sh(cmd, cwd = gitDir) {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  before(() => { savedCwd = process.cwd(); });
  after(() => {
    process.chdir(savedCwd);
    if (gitDir) rmSync(gitDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (gitDir) rmSync(gitDir, { recursive: true, force: true });
    gitDir = mkdtempSync(join(tmpdir(), 'vpr-merge-git-ac5-'));
    mkdirSync(join(gitDir, '.vpr'), { recursive: true });
    process.chdir(gitDir);

    sh('git init');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');

    // Initial commit (base)
    writeFileSync(join(gitDir, 'base.txt'), 'base-content');
    sh('git add base.txt');
    sh('git commit -m "Initial"');

    // src branch: add src-file.txt
    sh('git checkout -b item-a/vpr-1');
    writeFileSync(join(gitDir, 'src-file.txt'), 'src-content');
    sh('git add src-file.txt');
    sh('git commit -m "Add src file"');

    // dst branch (stacked above src): add dst-file.txt
    sh('git checkout -b item-a/vpr-2');
    writeFileSync(join(gitDir, 'dst-file.txt'), 'dst-content');
    sh('git add dst-file.txt');
    sh('git commit -m "Add dst file"');

    // Set up meta with empty claims (no jj in this env)
    await saveMeta({
      items: {
        'item-a': {
          wi: 1, wiTitle: 'A', dependsOn: [],
          vprs: {
            'item-a/vpr-1': { title: 'VPR 1', story: '', acceptance: '', output: null, claims: [] },
            'item-a/vpr-2': { title: 'VPR 2', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
  });

  it('src git branch is deleted after merge (no orphan refs)', async () => {
    await mergeVpr('item-a/vpr-1', { into: 'item-a/vpr-2' });
    assert.throws(
      () => sh('git rev-parse refs/heads/item-a/vpr-1'),
      'src branch should be gone after merge'
    );
  });

  it('dst git branch contains both src and dst changes after squash', async () => {
    await mergeVpr('item-a/vpr-1', { into: 'item-a/vpr-2' });
    const srcFileContent = sh('git show refs/heads/item-a/vpr-2:src-file.txt');
    assert.equal(srcFileContent, 'src-content', 'src changes present in dst');
    const dstFileContent = sh('git show refs/heads/item-a/vpr-2:dst-file.txt');
    assert.equal(dstFileContent, 'dst-content', 'dst changes preserved in dst');
  });

  it('history is collapsed: squash commit parent is initial commit', async () => {
    // Grab the root commit (before any VPR commits) before the merge
    const initialSha = sh('git rev-list --max-parents=0 refs/heads/item-a/vpr-2');
    await mergeVpr('item-a/vpr-1', { into: 'item-a/vpr-2' });
    const squashParent = sh('git rev-parse refs/heads/item-a/vpr-2^');
    assert.equal(squashParent, initialSha, 'squash parent is initial commit — history collapsed');
  });
});
