import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitBackend } from '../../src/core/git.mjs';

let tmpDir;
let originalCwd;

function sh(cmd) {
  return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function commit(filename, content, message) {
  writeFileSync(join(tmpDir, filename), content);
  sh(`git add ${filename}`);
  sh(`git commit -q -m "${message}"`);
  return sh('git rev-parse HEAD');
}

describe('gitBackend restack primitives', () => {
  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-restack-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    commit('base.txt', 'base', 'init');
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hasBookmark reflects branch existence', () => {
    assert.equal(gitBackend.hasBookmark('nope'), false);
    sh('git branch feat/x HEAD');
    assert.equal(gitBackend.hasBookmark('feat/x'), true);
  });

  it('moveBookmark creates then moves a branch (backwards allowed)', () => {
    const first = sh('git rev-parse HEAD');
    gitBackend.moveBookmark('slice/a', 'HEAD');
    assert.equal(sh('git rev-parse slice/a'), first);

    const second = commit('a.txt', 'a', 'add a');
    gitBackend.moveBookmark('slice/a', second); // forward
    assert.equal(sh('git rev-parse slice/a'), second);
    gitBackend.moveBookmark('slice/a', first); // backward
    assert.equal(sh('git rev-parse slice/a'), first);
  });

  it('renameBookmark renames a branch', () => {
    sh('git branch old/name HEAD');
    gitBackend.renameBookmark('old/name', 'new/name');
    assert.equal(gitBackend.hasBookmark('old/name'), false);
    assert.equal(gitBackend.hasBookmark('new/name'), true);
  });

  it('addBookmark no-ops when the target is the current branch', () => {
    sh('git checkout -q -b on/me');
    // must not throw ("cannot force update the branch used by worktree")
    gitBackend.addBookmark('on/me', new Set());
    assert.equal(gitBackend.hasBookmark('on/me'), true);
    sh('git checkout -q main');
  });

  it('moveBookmark refuses to move the checked-out branch to a different rev', () => {
    const head = sh('git rev-parse HEAD');
    sh(`git checkout -q -b cur/branch ${head}`);
    gitBackend.moveBookmark('cur/branch', 'HEAD'); // same rev -> no-op, no throw
    const other = sh('git rev-parse HEAD~1');
    assert.throws(() => gitBackend.moveBookmark('cur/branch', other), /check out another branch/);
    sh('git checkout -q main');
  });

  it('moveCommitAfter is unsupported in git mode', () => {
    assert.throws(() => gitBackend.moveCommitAfter('a', 'b'), /git rebase -i/);
  });

  it('rebaseOnto replays a branch onto a new base', () => {
    // main: base -> m1 ; topic branched from base with t1
    const base = sh('git rev-parse HEAD');
    const m1 = commit('m.txt', 'm', 'main work');
    sh(`git checkout -q -b topic ${base}`);
    writeFileSync(join(tmpDir, 't.txt'), 't');
    sh('git add t.txt');
    sh('git commit -q -m "topic work"');
    // move topic's commit (base..HEAD) onto m1
    gitBackend.rebaseOnto(m1, base);
    // topic tip now has m1 as ancestor
    const ancestors = sh('git rev-list HEAD').split('\n');
    assert.ok(ancestors.includes(m1), 'topic should now sit on top of main work');
    assert.equal(sh('cat t.txt'), 't', 'topic content preserved');
  });
});
