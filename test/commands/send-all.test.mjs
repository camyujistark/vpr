import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendAll } from '../../src/commands/send.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let repoDir;
let originalCwd;

function sh(cmd, cwd = repoDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** A fake provider that records createPR calls so we can assert chaining. */
function fakeProvider() {
  const calls = [];
  return {
    calls,
    config: { index: true },
    getChainTop: () => 'main',
    getLatestPRIndex: () => 0,
    createPR(src, tgt, title, body, wi) {
      calls.push({ src, tgt, title, wi });
      return { id: calls.length };
    },
  };
}

/** Build a repo with three slice branches chained on `main`, oldest-first. */
function seedChain() {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-send-all-'));
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

  for (const [branch, file] of [
    ['myitem/one', 'a.txt'],
    ['myitem/two', 'b.txt'],
    ['myitem/three', 'c.txt'],
  ]) {
    sh(`git checkout -q -b ${branch}`);
    writeFileSync(join(repoDir, file), file);
    sh(`git add ${file}`);
    sh(`git commit -q -m "work ${branch}"`);
  }
  // Park HEAD on main so no slice branch is checked out during rename/push.
  sh('git checkout -q main');
  process.chdir(repoDir);
  process.env.VPR_VCS = 'git';
}

async function seedMeta() {
  await saveMeta({
    items: {
      myitem: {
        wi: 1,
        wiTitle: 'My item',
        vprs: {
          'myitem/one': { title: 'One', story: 'story one', output: null },
          'myitem/two': { title: 'Two', story: 'story two', output: null },
          'myitem/three': { title: 'Three', story: 'story three', output: null },
        },
      },
    },
    hold: [],
    sent: {},
    eventLog: [],
  });
}

describe('sendAll() — batch per-slice send', () => {
  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    seedChain();
    await seedMeta();
  });

  after(() => {
    delete process.env.VPR_VCS;
    if (originalCwd) process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run previews every unsent slice in order without pushing', async () => {
    const provider = fakeProvider();
    const { previews, sent } = await sendAll({ provider, dryRun: true });

    assert.equal(sent.length, 0);
    assert.deepEqual(previews.map(p => p.branchName), [
      'feat/1-myitem-one',
      'feat/1-myitem-two',
      'feat/1-myitem-three',
    ]);
    assert.equal(provider.calls.length, 0, 'dry-run must not create PRs');
    assert.equal(sh('git ls-remote --heads origin feat/1-myitem-one'), '', 'dry-run must not push');
  });

  it('sends all slices oldest-first, chaining each onto the previous branch', async () => {
    const provider = fakeProvider();
    const { sent, blocked } = await sendAll({ provider });

    assert.equal(blocked, null);
    assert.equal(sent.length, 3);

    // Each PR targets the branch below it in the stack.
    assert.deepEqual(provider.calls.map(c => c.tgt), [
      'main',
      'feat/1-myitem-one',
      'feat/1-myitem-two',
    ]);
    // Every PR links the same work item.
    assert.deepEqual(provider.calls.map(c => c.wi), [1, 1, 1]);

    // All three branches pushed to the remote.
    for (const b of ['feat/1-myitem-one', 'feat/1-myitem-two', 'feat/1-myitem-three']) {
      assert.ok(sh(`git ls-remote --heads origin ${b}`).includes(b), `${b} pushed`);
    }

    // Meta recorded all three as sent and pruned the emptied item.
    const meta = await loadMeta();
    assert.equal(Object.keys(meta.sent).length, 3);
    assert.ok(!meta.items.myitem, 'emptied item pruned');
  });

  it('stops at the first slice that fails its gate, returning what was sent', async () => {
    // Blank the middle slice's story so its send gate fails.
    const meta = await loadMeta();
    meta.items.myitem.vprs['myitem/two'].story = '';
    await saveMeta(meta);

    const provider = fakeProvider();
    const { sent, blocked } = await sendAll({ provider });

    assert.equal(sent.length, 1, 'only slice one sent before the blocker');
    assert.equal(sent[0].branchName, 'feat/1-myitem-one');
    assert.ok(blocked, 'reports the blocker');
    assert.equal(blocked.bookmark, 'myitem/two');
    assert.match(blocked.error, /story/i);
  });
});
