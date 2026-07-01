import { describe, it, before, after } from 'node:test';
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

function sh(cmd) {
  return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** Commit a file on the current branch; optionally point a branch ref at it. Returns full sha. */
function commit(filename, content, message, branch = null) {
  writeFileSync(join(tmpDir, filename), content);
  sh(`git add ${filename}`);
  sh(`git commit -q -m "${message}"`);
  const sha = sh('git rev-parse HEAD');
  if (branch) sh(`git branch ${branch} ${sha}`);
  return sha;
}

describe('gitBackend', () => {
  let root, c1, c2;

  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-test-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    root = commit('base.txt', 'base', 'init');
    c1 = commit('a.txt', 'aaa', 'add a', 'item/one');
    c2 = commit('b.txt', 'bbb', 'add b', 'item/two');
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getBase falls back to the root commit when nothing is pushed', () => {
    assert.equal(gitBackend.getBase(), root);
  });

  it('getRemoteTop is null with no remote refs', () => {
    assert.equal(gitBackend.getRemoteTop(), null);
  });

  it('listChain returns commits oldest-first with branch bookmarks', () => {
    const chain = gitBackend.listChain(root);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].changeId, c1);
    assert.equal(chain[0].subject, 'add a');
    assert.deepEqual(chain[0].bookmarks, ['item/one']);
    assert.equal(chain[1].changeId, c2);
    assert.equal(chain[1].subject, 'add b');
    // c2 is pointed at by both item/two and main
    assert.ok(chain[1].bookmarks.includes('item/two'));
    assert.ok(chain[1].bookmarks.includes('main'));
  });

  it('listChangeIds returns the sha set in a range', () => {
    const ids = gitBackend.listChangeIds(root, '@');
    assert.equal(ids.size, 2);
    assert.ok(ids.has(c1));
    assert.ok(ids.has(c2));
  });

  it('getConflicts is empty (git carries no stored conflicts)', () => {
    assert.equal(gitBackend.getConflicts().size, 0);
  });

  it('getFiles reports name-status lines', () => {
    assert.deepEqual(gitBackend.getFiles(c1), ['A a.txt']);
  });

  it('getDiff returns the patch for a commit', () => {
    const diff = gitBackend.getDiff(c1);
    assert.match(diff, /a\.txt/);
    assert.match(diff, /\+aaa/);
  });

  it('getVprFiles merges file lines across commits', () => {
    assert.deepEqual(gitBackend.getVprFiles([c1, c2]), ['A a.txt', 'A b.txt']);
  });
});

describe('buildState under the git backend', () => {
  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-state-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    commit('base.txt', 'base', 'init');
    commit('a.txt', 'aaa', 'add a', 'myitem/one');
    commit('b.txt', 'bbb', 'add b', 'myitem/two');
    process.chdir(tmpDir);
    process.env.VPR_VCS = 'git';
  });

  after(() => {
    delete process.env.VPR_VCS;
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('partitions commits into VPRs by branch ref', async () => {
    await saveMeta({
      items: {
        myitem: {
          wi: 1,
          wiTitle: 'My item',
          vprs: {
            'myitem/one': { title: 'One', story: 's', output: null },
            'myitem/two': { title: 'Two', story: 's', output: null },
          },
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });

    const state = await buildState();
    assert.equal(state.items.length, 1);
    const item = state.items[0];
    assert.equal(item.name, 'myitem');

    const one = item.vprs.find(v => v.bookmark === 'myitem/one');
    const two = item.vprs.find(v => v.bookmark === 'myitem/two');
    assert.equal(one.commits.length, 1);
    assert.equal(one.commits[0].subject, 'add a');
    assert.equal(two.commits.length, 1);
    assert.equal(two.commits[0].subject, 'add b');
    assert.equal(state.ungrouped.length, 0);
  });
});
