import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addVpr } from '../../src/commands/add.mjs';
import { removeVpr } from '../../src/commands/remove.mjs';
import { clearAll } from '../../src/commands/clear.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd) {
  return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function branchExists(name) {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${name}`, { cwd: tmpDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('VPR lifecycle under the git backend', () => {
  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-life-'));
    sh('git init -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    writeFileSync(join(tmpDir, 'base.txt'), 'base');
    sh('git add base.txt');
    sh('git commit -q -m init');
    process.chdir(tmpDir);
    process.env.VPR_VCS = 'git';
    await saveMeta({
      items: { myitem: { wi: 1, wiTitle: 'My item', vprs: {} } },
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

  it('addVpr creates a git branch and registers it in meta', async () => {
    const res = await addVpr('Scaffold');
    assert.equal(res.bookmark, 'myitem/scaffold');
    assert.ok(branchExists('myitem/scaffold'), 'branch should exist');
    const meta = await loadMeta();
    assert.ok(meta.items.myitem.vprs['myitem/scaffold'], 'meta should register the VPR');
  });

  it('removeVpr deletes the branch and prunes the empty item', async () => {
    await removeVpr('myitem/scaffold');
    assert.ok(!branchExists('myitem/scaffold'), 'branch should be gone');
    const meta = await loadMeta();
    assert.ok(!meta.items.myitem, 'empty item should be pruned');
  });

  it('clearAll removes every VPR branch', async () => {
    await saveMeta({
      items: { myitem: { wi: 1, wiTitle: 'My item', vprs: {} } },
      hold: [],
      sent: {},
      eventLog: [],
    });
    await addVpr('Alpha');
    await addVpr('Beta');
    assert.ok(branchExists('myitem/alpha'));
    assert.ok(branchExists('myitem/beta'));

    const { bookmarks } = await clearAll();
    assert.equal(bookmarks.length, 2);
    assert.ok(!branchExists('myitem/alpha'));
    assert.ok(!branchExists('myitem/beta'));
    const meta = await loadMeta();
    assert.deepEqual(meta.items, {});
  });
});
