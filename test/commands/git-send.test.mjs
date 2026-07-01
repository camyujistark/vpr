import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { send } from '../../src/commands/send.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let repoDir;
let originalCwd;

function sh(cmd, cwd = repoDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

describe('send under the git backend', () => {
  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-send-'));
    const bare = join(tmpDir, 'origin.git');
    repoDir = join(tmpDir, 'work');
    execSync(`git init --bare -b main ${bare}`, { stdio: 'pipe' });
    execSync(`git init -b main ${repoDir}`, { stdio: 'pipe' });
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    writeFileSync(join(repoDir, '.git', 'info', 'exclude'), '.vpr/\n');
    sh(`git remote add origin ${bare}`);
    writeFileSync(join(repoDir, 'base.txt'), 'base');
    sh('git add base.txt');
    sh('git commit -q -m init');
    sh('git push -q -u origin main');
    // Develop a VPR on its own branch.
    sh('git checkout -q -b myitem/one');
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    sh('git add a.txt');
    sh('git commit -q -m "work"');

    process.chdir(repoDir);
    process.env.VPR_VCS = 'git';
    await saveMeta({
      items: {
        myitem: {
          wi: 1,
          wiTitle: 'My item',
          vprs: { 'myitem/one': { title: 'One', story: 'the story', output: null } },
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

  it('dry-run resolves branch name and target without pushing', async () => {
    const res = await send('myitem/one', { provider: null, dryRun: true });
    assert.equal(res.branchName, 'feat/1-myitem-one');
    assert.equal(res.targetBranch, 'main');
    assert.equal(res.dryRun, true);
    // nothing pushed yet
    assert.equal(sh('git ls-remote --heads origin feat/1-myitem-one'), '');
  });

  it('renames the branch, pushes it, and moves the VPR to sent', async () => {
    const res = await send('myitem/one', { provider: null });
    assert.equal(res.branchName, 'feat/1-myitem-one');
    assert.equal(res.targetBranch, 'main');

    // Branch is on the remote.
    assert.ok(sh('git ls-remote --heads origin feat/1-myitem-one').includes('feat/1-myitem-one'));

    // Meta moved the VPR into sent and pruned the emptied item.
    const meta = await loadMeta();
    assert.ok(meta.sent['feat/1-myitem-one'], 'sent should record the branch');
    assert.equal(meta.sent['feat/1-myitem-one'].itemName, 'myitem');
    assert.ok(!meta.items.myitem, 'emptied item should be pruned');
  });
});
