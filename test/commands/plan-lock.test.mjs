import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planLock, resolveWorkItemId } from '../../src/commands/plan-lock.mjs';
import { send } from '../../src/commands/send.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let repoDir;
let originalCwd;

function sh(cmd, cwd = repoDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function readConfig() {
  return JSON.parse(readFileSync(join(process.cwd(), '.vpr', 'config.json'), 'utf-8'));
}

describe('resolveWorkItemId() — the locked work-item model', () => {
  it('one-pbi links the parent PBI on every slice', () => {
    const item = { wi: 5, parentWi: 17570 };
    assert.equal(resolveWorkItemId(item, { wi: 9 }, 'one-pbi'), 17570);
  });
  it('one-pbi falls back to item.wi when no parent is set', () => {
    assert.equal(resolveWorkItemId({ wi: 5, parentWi: null }, {}, 'one-pbi'), 5);
  });
  it('per-slice links the slice work item, falling back to item.wi', () => {
    assert.equal(resolveWorkItemId({ wi: 5 }, { wi: 9 }, 'per-slice'), 9);
    assert.equal(resolveWorkItemId({ wi: 5 }, {}, 'per-slice'), 5);
  });
  it('defaults to per-slice', () => {
    assert.equal(resolveWorkItemId({ wi: 5 }, { wi: 9 }), 9);
  });
});

describe('vpr plan lock — persist send decisions at planning time', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-plan-lock-'));
    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    writeFileSync(join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ provider: 'none', repo: 'x' }));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes provider, workItemModel, and storySource without dropping other fields', async () => {
    const { changed } = await planLock({
      provider: 'azure-devops',
      workItemModel: 'one-pbi',
      storySource: 'pablo-doc',
    });
    assert.deepEqual(changed.sort(), ['provider', 'storySource', 'workItemModel']);
    const config = readConfig();
    assert.equal(config.provider, 'azure-devops');
    assert.equal(config.workItemModel, 'one-pbi');
    assert.equal(config.storySource, 'pablo-doc');
    assert.equal(config.repo, 'x', 'existing fields preserved');
  });

  it('only touches the fields passed', async () => {
    await planLock({ workItemModel: 'per-slice' });
    const config = readConfig();
    assert.equal(config.workItemModel, 'per-slice');
    assert.equal(config.provider, 'none', 'untouched');
    assert.equal(config.storySource, undefined);
  });

  it('rejects an invalid work-item-model', async () => {
    await assert.rejects(() => planLock({ workItemModel: 'nonsense' }), /Invalid work-item-model/);
  });

  it('rejects an empty lock', async () => {
    await assert.rejects(() => planLock({}), /Nothing to lock/);
  });
});

describe('send honours the locked work-item model', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-lock-send-'));
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
    sh('git checkout -q -b myitem/one');
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    sh('git add a.txt');
    sh('git commit -q -m work');
    sh('git checkout -q main');
    process.chdir(repoDir);
    process.env.VPR_VCS = 'git';
  });
  afterEach(() => {
    delete process.env.VPR_VCS;
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed() {
    await saveMeta({
      items: {
        myitem: {
          wi: 5,
          parentWi: 17570,
          wiTitle: 'My item',
          vprs: { 'myitem/one': { title: 'One', story: 'the story', output: null } },
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });
  }

  it('one-pbi links the parent PBI on the slice PR', async () => {
    await seed();
    const calls = [];
    const provider = {
      config: { index: true },
      getChainTop: () => 'main',
      getLatestPRIndex: () => 0,
      createPR: (src, tgt, title, body, wi) => { calls.push(wi); return { id: 1 }; },
    };
    await send('myitem/one', { provider, workItemModel: 'one-pbi' });
    assert.deepEqual(calls, [17570]);
  });

  it('per-slice (default) links the item work item', async () => {
    await seed();
    const calls = [];
    const provider = {
      config: { index: true },
      getChainTop: () => 'main',
      getLatestPRIndex: () => 0,
      createPR: (src, tgt, title, body, wi) => { calls.push(wi); return { id: 1 }; },
    };
    await send('myitem/one', { provider });
    assert.deepEqual(calls, [5]);
  });
});
