import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitBackend } from '../../src/core/git.mjs';
import { buildState } from '../../src/core/state.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd, allowFail = false) {
  try {
    return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

describe('gitBackend conflict / rebase state', () => {
  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-conflict-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    // rebase can invoke an editor for the todo list; keep it non-interactive
    sh('git config core.editor true');
    writeFileSync(join(tmpDir, 'file.txt'), 'line1\n');
    sh('git add file.txt');
    sh('git commit -q -m base');
    sh('git checkout -q -b feature');
    writeFileSync(join(tmpDir, 'file.txt'), 'feature-change\n');
    sh('git commit -q -am "feature change"');
    sh('git checkout -q main');
    writeFileSync(join(tmpDir, 'file.txt'), 'main-change\n');
    sh('git commit -q -am "main change"');
    sh('git checkout -q feature');
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no rebase / no conflicts when the tree is clean', () => {
    assert.equal(gitBackend.isRebaseInProgress(), false);
    assert.equal(gitBackend.getConflicts().size, 0);
  });

  it('detects a paused, conflicted rebase', () => {
    sh('git rebase main', true); // conflicts on file.txt, stops
    assert.equal(gitBackend.isRebaseInProgress(), true, 'rebase should be in progress');
    assert.ok(gitBackend.getConflicts().size >= 1, 'a conflicting commit should be reported');
  });

  it('clears once the rebase is aborted', () => {
    sh('git rebase --abort', true);
    assert.equal(gitBackend.isRebaseInProgress(), false);
    assert.equal(gitBackend.getConflicts().size, 0);
  });
});

describe('buildState tolerates stale sha claims under git', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-claims-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    writeFileSync(join(tmpDir, 'base.txt'), 'base');
    sh('git add base.txt');
    sh('git commit -q -m init');
    writeFileSync(join(tmpDir, 'a.txt'), 'a');
    sh('git add a.txt');
    sh('git commit -q -m "add a"');
    sh('git branch item/one HEAD');
    process.chdir(tmpDir);
    process.env.VPR_VCS = 'git';
  });

  afterEach(() => {
    delete process.env.VPR_VCS;
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores a claim whose id matches no commit', async () => {
    await saveMeta({
      items: {
        item: {
          wi: 1,
          wiTitle: 'Item',
          vprs: {
            'item/one': {
              title: 'One',
              story: 's',
              output: null,
              claims: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], // stale jj-era id
            },
          },
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const state = await buildState();
    const vpr = state.items[0].vprs.find(v => v.bookmark === 'item/one');
    // Partition still works off the branch ref; the stale claim is harmless.
    assert.equal(vpr.commits.length, 1);
    assert.equal(vpr.commits[0].subject, 'add a');
  });
});
