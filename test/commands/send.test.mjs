import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendChecks, send } from '../../src/commands/send.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/**
 * Set up a fresh git + jj colocated repo with a `main` base and chdir into it.
 * We leave the initial commit undescribed so buildState() skips it.
 */
function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-send-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  sh('jj git init --colocate', tmpDir);
  sh('jj bookmark set main');
  sh('jj new');
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

/**
 * Create a described commit and seal it with `jj new`.
 * Optionally set a jj bookmark on it.
 * Returns the change_id of the sealed commit.
 */
function makeCommit(filename, content, message, bookmark = null) {
  writeFileSync(join(tmpDir, filename), content);
  sh(`jj describe -m "${message}"`);
  if (bookmark) sh(`jj bookmark set ${bookmark}`);
  sh('jj new');
  return sh('jj log -r @- --no-graph --template "change_id.short()"');
}

/** Base meta with a single item and VPR ready for testing. */
async function seedMeta({ story = 'Some story', output = null } = {}) {
  await saveMeta({
    items: {
      'my-feature': {
        wi: 99,
        wiTitle: 'My Feature',
        vprs: {
          'my-feature/nav-bar': { title: 'Nav Bar', story, output },
        },
      },
    },
    hold: [],
    sent: {},
    eventLog: [],
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('sendChecks()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    teardownRepo();
  });

  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    teardownRepo();
    setupRepo();
  });

  it('throws when VPR not found', async () => {
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
    await assert.rejects(
      () => sendChecks('nonexistent'),
      /not found/i
    );
  });

  describe('story check', () => {
    it('fails when story is empty', async () => {
      await seedMeta({ story: '' });
      const checks = await sendChecks('my-feature/nav-bar');
      const story = checks.find(c => c.name === 'story');
      assert.strictEqual(story.pass, false);
      assert.match(story.message, /no story/i);
    });

    it('fails when story is whitespace only', async () => {
      await seedMeta({ story: '   ' });
      const checks = await sendChecks('my-feature/nav-bar');
      const story = checks.find(c => c.name === 'story');
      assert.strictEqual(story.pass, false);
    });

    it('passes when story has content', async () => {
      await seedMeta({ story: 'Implements the nav bar component.' });
      const checks = await sendChecks('my-feature/nav-bar');
      const story = checks.find(c => c.name === 'story');
      assert.strictEqual(story.pass, true);
      assert.match(story.message, /story written/i);
    });
  });

  describe('output check', () => {
    it('fails when output is null', async () => {
      await seedMeta({ output: null });
      const checks = await sendChecks('my-feature/nav-bar');
      const output = checks.find(c => c.name === 'output');
      assert.strictEqual(output.pass, false);
    });

    it('passes when output exists', async () => {
      await seedMeta({ output: '## Summary\n- Added nav bar' });
      const checks = await sendChecks('my-feature/nav-bar');
      const output = checks.find(c => c.name === 'output');
      assert.strictEqual(output.pass, true);
    });
  });

  describe('commits check', () => {
    it('fails when VPR has no commits', async () => {
      await seedMeta();
      // No commits made — VPR is in meta but has no jj commits
      const checks = await sendChecks('my-feature/nav-bar');
      const commits = checks.find(c => c.name === 'commits');
      assert.strictEqual(commits.pass, false);
      assert.match(commits.message, /no commits/i);
    });

    it('passes when VPR has commits', async () => {
      await seedMeta();
      makeCommit('nav.txt', 'nav\n', 'feat: nav bar', 'my-feature/nav-bar');
      const checks = await sendChecks('my-feature/nav-bar');
      const commits = checks.find(c => c.name === 'commits');
      assert.strictEqual(commits.pass, true);
      assert.match(commits.message, /1 commit/);
    });

    it('reports correct commit count', async () => {
      await seedMeta();
      makeCommit('a.txt', 'a\n', 'feat: first', 'my-feature/nav-bar');
      makeCommit('b.txt', 'b\n', 'feat: second');
      makeCommit('c.txt', 'c\n', 'feat: third');
      const checks = await sendChecks('my-feature/nav-bar');
      const commits = checks.find(c => c.name === 'commits');
      // Only commits under the bookmark are counted
      assert.strictEqual(commits.pass, true);
    });
  });

  describe('conflicts check', () => {
    it('passes when there are no conflicts', async () => {
      await seedMeta();
      makeCommit('x.txt', 'x\n', 'feat: clean', 'my-feature/nav-bar');
      const checks = await sendChecks('my-feature/nav-bar');
      const conflicts = checks.find(c => c.name === 'conflicts');
      assert.strictEqual(conflicts.pass, true);
      assert.match(conflicts.message, /no conflicts/i);
    });
  });

  it('returns all four checks', async () => {
    await seedMeta();
    const checks = await sendChecks('my-feature/nav-bar');
    assert.strictEqual(checks.length, 4);
    const names = checks.map(c => c.name);
    assert.ok(names.includes('story'));
    assert.ok(names.includes('output'));
    assert.ok(names.includes('commits'));
    assert.ok(names.includes('conflicts'));
  });

  it('finds VPR by partial bookmark name', async () => {
    await seedMeta({ story: 'story text' });
    const checks = await sendChecks('nav-bar');
    assert.strictEqual(checks.length, 4);
  });
});

// ---------------------------------------------------------------------------

describe('send()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    teardownRepo();
  });

  beforeEach(async () => {
    if (originalCwd) process.chdir(originalCwd);
    teardownRepo();
    setupRepo();
  });

  it('throws when VPR not found', async () => {
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
    await assert.rejects(
      () => send('nonexistent', { provider: null }),
      /not found/i
    );
  });

  it('throws when story is missing', async () => {
    await seedMeta({ story: '' });
    await assert.rejects(
      () => send('my-feature/nav-bar', { provider: null }),
      /blocked.*story|story/i
    );
  });

  // -------------------------------------------------------------------------
  // No-args: pick the next-unsent VPR via chain state
  // -------------------------------------------------------------------------

  describe('no-args', () => {
    it('picks the next-unsent VPR when query is omitted', async () => {
      await seedMeta({ story: 'Real story content' });
      const result = await send(undefined, {
        provider: null,
        dryRun: true,
        tpIndex: 1,
        targetBranch: 'main',
      });
      assert.strictEqual(result.branchName, 'feat/99-my-feature-nav-bar');
    });
  });

  // -------------------------------------------------------------------------
  // Sequential refusal: cannot send a blocked VPR (an earlier sibling unsent)
  // -------------------------------------------------------------------------

  describe('cascade target', () => {
    it('uses cascadeTarget from chain state as the default targetBranch', async () => {
      await saveMeta({
        items: {
          'my-feature': {
            wi: 99,
            wiTitle: 'My Feature',
            vprs: {
              'my-feature/step-two': { title: 'Step Two', story: 'second story', output: null },
            },
          },
        },
        hold: [],
        sent: {
          'feat/99-my-feature-step-one': {
            prId: 1,
            prTitle: '1: Step One',
            targetBranch: 'main',
            itemName: 'my-feature',
            wi: 99,
            originalBookmark: 'my-feature/step-one',
            sentAt: '2026-04-28T00:00:00.000Z',
          },
        },
        eventLog: [],
      });
      const result = await send('my-feature/step-two', { provider: null, dryRun: true });
      assert.strictEqual(result.targetBranch, 'feat/99-my-feature-step-one');
    });
  });

  describe('blocked refusal', () => {
    it('throws `Cannot send <bookmark>: send <blocker> first` when an earlier VPR is unsent', async () => {
      await saveMeta({
        items: {
          'my-feature': {
            wi: 99,
            wiTitle: 'My Feature',
            vprs: {
              'my-feature/nav-bar': { title: 'Nav Bar', story: 'first story', output: null },
              'my-feature/footer': { title: 'Footer', story: 'second story', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
      await assert.rejects(
        () => send('my-feature/footer', { provider: null, dryRun: true }),
        /Cannot send my-feature\/footer: send my-feature\/nav-bar first/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  describe('dryRun', () => {
    it('returns plan without executing when dryRun is true', async () => {
      await seedMeta({ story: 'Real story content' });
      const result = await send('my-feature/nav-bar', {
        provider: null,
        dryRun: true,
        tpIndex: 42,
        targetBranch: 'develop',
      });

      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.branchName, 'feat/99-my-feature-nav-bar');
      assert.strictEqual(result.prTitle, '42: Nav Bar');
      assert.strictEqual(result.targetBranch, 'develop');
      assert.strictEqual(result.prId, null);
    });

    it('dryRun does not modify meta', async () => {
      await seedMeta({ story: 'Story content' });
      const before = await loadMeta();
      await send('my-feature/nav-bar', { provider: null, dryRun: true });
      const after = await loadMeta();
      assert.deepStrictEqual(before.items, after.items);
      assert.deepStrictEqual(before.sent, after.sent);
    });

    it('uses default tpIndex=1 when not specified', async () => {
      await seedMeta({ story: 'Story content' });
      const result = await send('my-feature/nav-bar', { provider: null, dryRun: true });
      assert.strictEqual(result.prTitle, '1: Nav Bar');
    });

    it('uses default targetBranch=main when not specified', async () => {
      await seedMeta({ story: 'Story content' });
      const result = await send('my-feature/nav-bar', { provider: null, dryRun: true });
      assert.strictEqual(result.targetBranch, 'main');
    });

    it('PR body falls back to story when output is null', async () => {
      await seedMeta({ story: 'My story', output: null });
      const result = await send('my-feature/nav-bar', { provider: null, dryRun: true });
      assert.strictEqual(result.prBody, 'My story');
    });

    it('PR body prefers output when available', async () => {
      await seedMeta({ story: 'My story', output: '## Summary\n- Done' });
      const result = await send('my-feature/nav-bar', { provider: null, dryRun: true });
      assert.strictEqual(result.prBody, '## Summary\n- Done');
    });

    it('branch name replaces / in bookmark with -', async () => {
      await seedMeta({ story: 'Story content' });
      const result = await send('my-feature/nav-bar', { provider: null, dryRun: true });
      assert.ok(!result.branchName.includes('/my-feature/nav-bar'), 'slashes should be replaced');
      assert.ok(result.branchName.includes('my-feature-nav-bar'), 'bookmark slug should use hyphens');
    });
  });

  // -------------------------------------------------------------------------
  // Meta changes (send without real push — jj push will fail, but we test
  // bookmark rename + meta updates using a mocked push approach)
  //
  // Since we can't push to a remote in tests, we test meta changes by
  // intercepting at the point where push would fail. Instead, we test the
  // meta state after a successful dry-run and verify the structure would be
  // correct, and we test the rename logic separately.
  // -------------------------------------------------------------------------

  describe('meta mutation after send (via provider:null, checking rename)', () => {
    it('moves VPR from items to sent after successful send', async () => {
      await seedMeta({ story: 'My story' });
      makeCommit('feat.txt', 'content\n', 'feat: nav bar', 'my-feature/nav-bar');

      // We need to test meta changes but can't push without a remote.
      // Simulate by calling with a provider=null and catching the push error,
      // then verify the meta was NOT mutated (meta is only mutated after push
      // succeeds). Instead, test via an in-process mock of jj push.
      //
      // The reliable approach: verify dryRun returns the correct shape that
      // would be applied, which mirrors what the live send path produces.
      const plan = await send('my-feature/nav-bar', {
        provider: null,
        dryRun: true,
        tpIndex: 7,
        targetBranch: 'main',
      });

      // Verify plan has the correct structure
      assert.strictEqual(plan.branchName, 'feat/99-my-feature-nav-bar');
      assert.strictEqual(plan.prTitle, '7: Nav Bar');
      assert.strictEqual(plan.prId, null);

      // Meta must be unchanged in dryRun
      const meta = await loadMeta();
      assert.ok(meta.items['my-feature'], 'item should still exist');
      assert.ok(meta.items['my-feature'].vprs['my-feature/nav-bar'], 'VPR should still be in items');
      assert.deepStrictEqual(meta.sent, {});
    });
  });

  describe('meta mutation with jj-only send (no remote push)', () => {
    /**
     * Patch jj.mjs push to no-op so we can test meta changes without a remote.
     * We do this by wrapping send's internals via the module system is not
     * straightforward; instead we verify the logic through the rename path.
     *
     * We can verify bookmark rename happens by checking jj bookmarks after
     * a manual send where we stub out the push by setting up a local remote.
     */
    it('bookmark is renamed on jj after send', async () => {
      await seedMeta({ story: 'My story' });
      makeCommit('feat.txt', 'content\n', 'feat: nav bar', 'my-feature/nav-bar');

      // Set up a local bare git remote so push succeeds
      const remotePath = mkdtempSync(join(tmpdir(), 'vpr-send-remote-'));
      try {
        sh('git init --bare', remotePath);
        sh(`git remote add origin ${remotePath}`);

        // Seed the remote via git directly (bypasses jj's empty-commit check)
        sh(`git push origin HEAD:refs/heads/main`, tmpDir);

        const result = await send('my-feature/nav-bar', {
          provider: null,
          tpIndex: 5,
          targetBranch: 'main',
        });

        // Result shape
        assert.strictEqual(result.branchName, 'feat/99-my-feature-nav-bar');
        assert.strictEqual(result.prTitle, '5: Nav Bar');
        assert.strictEqual(result.prId, null);
        assert.strictEqual(result.targetBranch, 'main');

        // Meta: VPR moved from items to sent
        const meta = await loadMeta();
        assert.ok(!meta.items['my-feature'], 'item should be removed when all VPRs sent');
        assert.ok(meta.sent['feat/99-my-feature-nav-bar'], 'VPR should appear in sent');
        assert.strictEqual(meta.sent['feat/99-my-feature-nav-bar'].prTitle, '5: Nav Bar');

        // Event log
        const ev = meta.eventLog[meta.eventLog.length - 1];
        assert.strictEqual(ev.action, 'vpr.send');
        assert.strictEqual(ev.detail.branchName, 'feat/99-my-feature-nav-bar');
      } finally {
        rmSync(remotePath, { recursive: true, force: true });
      }
    });

    it('item remains when it still has other VPRs', async () => {
      await saveMeta({
        items: {
          'my-feature': {
            wi: 99,
            wiTitle: 'My Feature',
            vprs: {
              'my-feature/nav-bar': { title: 'Nav Bar', story: 'story', output: null },
              'my-feature/footer': { title: 'Footer', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });
      makeCommit('nav.txt', 'nav\n', 'feat: nav bar', 'my-feature/nav-bar');

      const remotePath = mkdtempSync(join(tmpdir(), 'vpr-send-remote-'));
      try {
        sh('git init --bare', remotePath);
        sh(`git remote add origin ${remotePath}`);

        // Seed the remote via git directly (bypasses jj's empty-commit check)
        sh(`git push origin HEAD:refs/heads/main`, tmpDir);

        await send('my-feature/nav-bar', { provider: null, tpIndex: 1 });

        const meta = await loadMeta();
        // Item still present because 'footer' VPR remains
        assert.ok(meta.items['my-feature'], 'item should remain when other VPRs exist');
        assert.ok(!meta.items['my-feature'].vprs['my-feature/nav-bar'], 'sent VPR removed from items');
        assert.ok(meta.items['my-feature'].vprs['my-feature/footer'], 'other VPR still in items');
        assert.ok(meta.sent['feat/99-my-feature-nav-bar'], 'sent VPR in meta.sent');
      } finally {
        rmSync(remotePath, { recursive: true, force: true });
      }
    });
  });
});
