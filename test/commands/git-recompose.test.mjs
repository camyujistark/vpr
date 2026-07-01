import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recompose } from '../../src/commands/recompose.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd) {
  return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

describe('recompose under the git backend', () => {
  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-recompose-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    // vpr metadata lives outside version control (as `vpr init` arranges).
    writeFileSync(join(tmpDir, '.git', 'info', 'exclude'), '.vpr/\n');
    writeFileSync(join(tmpDir, 'base.txt'), 'base');
    sh('git add base.txt');
    sh('git commit -q -m init');
    // Develop the slice on its own branch with messy WIP commits.
    sh('git checkout -q -b item/slice');
    for (const [f, msg] of [['a.txt', 'wip a'], ['b.txt', 'wip b'], ['c.txt', 'fix a typo']]) {
      writeFileSync(join(tmpDir, f), f);
      sh(`git add ${f}`);
      sh(`git commit -q -m "${msg}"`);
    }
    process.chdir(tmpDir);
    process.env.VPR_VCS = 'git';
    await saveMeta({
      items: {
        item: {
          wi: 1,
          wiTitle: 'Item',
          vprs: { 'item/slice': { title: 'The Feature', story: 's', output: null } },
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });
  });

  after(() => {
    delete process.env.VPR_VCS;
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collapses the slice into one clean commit, preserving the tree', async () => {
    const base = sh('git rev-parse HEAD~3'); // the init commit
    const res = await recompose('item/slice', { message: 'clean feature' });
    assert.equal(res.collapsed, 3);

    // Exactly one commit now sits above the base.
    const count = sh(`git rev-list --count ${base}..HEAD`);
    assert.equal(count, '1');
    // With the intended message.
    assert.equal(sh('git log -1 --format=%s'), 'clean feature');
    // The working tree / resulting diff is unchanged — all three files present.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(existsSync(join(tmpDir, f)), `${f} should still exist`);
    }
    assert.equal(sh('git status --porcelain'), '', 'working tree should be clean');
    // The slice's branch moved with HEAD.
    assert.equal(sh('git rev-parse item/slice'), sh('git rev-parse HEAD'));
  });
});
