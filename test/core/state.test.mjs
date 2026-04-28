import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildState } from '../../src/core/state.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/**
 * Create a file, describe the working-copy commit, then `jj new` to seal it.
 * Returns the change_id.short() of the sealed commit (now @-).
 */
function makeCommit(filename, content, message, bookmark = null) {
  writeFileSync(join(tmpDir, filename), content);
  sh(`jj describe -m "${message}"`);
  if (bookmark) {
    sh(`jj bookmark set ${bookmark}`);
  }
  sh('jj new');
  return sh('jj log -r @- --no-graph --template "change_id.short()"');
}

/**
 * Wire up a fresh temp git + jj repo and chdir into it.
 *
 * We set a `main` local bookmark on the initial (undescribed) working-copy
 * commit, then `jj new` so subsequent test commits sit above it.
 * The initial commit is left undescribed so buildState() skips it (the spec
 * filters commits with no description). getBase() falls through to trunk()
 * (000000000000) so the range covers everything above the jj root, but the
 * undescribed base tip is filtered before it reaches state output.
 */
function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-state-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  sh('jj git init --colocate', tmpDir);

  // Mark the current (empty, undescribed) working-copy as main, then move on.
  // Leaving it undescribed means buildState() will skip it.
  sh('jj bookmark set main');
  sh('jj new');

  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('buildState()', () => {
  before(() => {
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    teardownRepo();
  });

  beforeEach(() => {
    // Restore to a known cwd first in case a previous test left us somewhere else,
    // then rebuild a fresh repo for isolation.
    if (originalCwd) process.chdir(originalCwd);
    teardownRepo();
    setupRepo();
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('returns valid shape with no commits beyond base', async () => {
      const state = await buildState();

      assert.ok(Array.isArray(state.items), 'items should be an array');
      assert.strictEqual(state.items.length, 0);

      assert.ok(Array.isArray(state.ungrouped), 'ungrouped should be an array');
      assert.strictEqual(state.ungrouped.length, 0);

      assert.ok(Array.isArray(state.hold), 'hold should be an array');
      assert.strictEqual(state.hold.length, 0);

      assert.ok(state.conflicts instanceof Set, 'conflicts should be a Set');
      assert.strictEqual(state.conflicts.size, 0);

      assert.ok(typeof state.sent === 'object' && state.sent !== null, 'sent should be an object');
      assert.ok(Array.isArray(state.eventLog), 'eventLog should be an array');
    });

    it('items array is empty when meta has no items', async () => {
      await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
      const state = await buildState();
      assert.strictEqual(state.items.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Ungrouped commits
  // -------------------------------------------------------------------------

  describe('commits without bookmarks', () => {
    it('shows commits as ungrouped when no meta bookmarks match', async () => {
      makeCommit('a.txt', 'a\n', 'feat: alpha');
      makeCommit('b.txt', 'b\n', 'feat: beta');

      const state = await buildState();

      assert.strictEqual(state.ungrouped.length, 2, 'Both commits should be ungrouped');
      assert.strictEqual(state.items.length, 0);

      const subjects = state.ungrouped.map(c => c.subject);
      assert.ok(subjects.some(s => s.includes('alpha')), 'alpha commit should be ungrouped');
      assert.ok(subjects.some(s => s.includes('beta')), 'beta commit should be ungrouped');
    });

    it('each ungrouped commit has changeId, sha, and subject fields', async () => {
      makeCommit('x.txt', 'x\n', 'feat: xray');

      const state = await buildState();
      assert.strictEqual(state.ungrouped.length, 1);

      const commit = state.ungrouped[0];
      assert.ok(typeof commit.changeId === 'string' && commit.changeId.length > 0, 'changeId must be a non-empty string');
      assert.ok(typeof commit.sha === 'string' && commit.sha.length > 0, 'sha must be a non-empty string');
      assert.ok(typeof commit.subject === 'string' && commit.subject.length > 0, 'subject must be a non-empty string');
      assert.ok(commit.subject.includes('xray'), 'subject should include commit message');
    });

    it('commits appear oldest-first in ungrouped', async () => {
      makeCommit('first.txt', '1\n', 'feat: first');
      makeCommit('second.txt', '2\n', 'feat: second');
      makeCommit('third.txt', '3\n', 'feat: third');

      const state = await buildState();
      assert.strictEqual(state.ungrouped.length, 3);

      const subjects = state.ungrouped.map(c => c.subject);
      assert.ok(subjects[0].includes('first'), `First commit should be oldest. Got: ${subjects}`);
      assert.ok(subjects[2].includes('third'), `Last commit should be newest. Got: ${subjects}`);
    });
  });

  // -------------------------------------------------------------------------
  // Grouping under items/VPRs
  // -------------------------------------------------------------------------

  describe('commits grouped under items and VPRs', () => {
    it('commits with matching bookmarks appear in the correct VPR', async () => {
      const changeId = makeCommit('scaffold.txt', 'scaffold\n', 'feat: scaffold', 'ding-app/scaffold');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();

      assert.strictEqual(state.items.length, 1);
      assert.strictEqual(state.ungrouped.length, 0, 'Bookmarked commit should not be in ungrouped');

      const item = state.items[0];
      assert.strictEqual(item.name, 'ding-app');
      assert.strictEqual(item.wi, 17065);
      assert.strictEqual(item.wiTitle, 'Ding Convertor app');

      assert.strictEqual(item.vprs.length, 1);
      const vpr = item.vprs[0];
      assert.strictEqual(vpr.bookmark, 'ding-app/scaffold');
      assert.strictEqual(vpr.title, 'Scaffold');
      assert.strictEqual(vpr.story, '');
      assert.strictEqual(vpr.output, null);

      assert.ok(Array.isArray(vpr.commits), 'vpr.commits should be an array');
      assert.strictEqual(vpr.commits.length, 1);

      const commit = vpr.commits[0];
      assert.strictEqual(commit.changeId, changeId);
      assert.ok(typeof commit.sha === 'string');
      assert.ok(commit.subject.includes('scaffold'));
      assert.strictEqual(commit.conflict, false);
    });

    it('VPR with no matching commits has empty commits array', async () => {
      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      assert.strictEqual(state.items.length, 1);
      assert.strictEqual(state.items[0].vprs[0].commits.length, 0);
      assert.strictEqual(state.ungrouped.length, 0);
    });

    it('multiple VPRs under one item each get their commits', async () => {
      makeCommit('s1.txt', '1\n', 'feat: scaffold', 'ding-app/scaffold');
      makeCommit('s2.txt', '2\n', 'feat: logic', 'ding-app/logic');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
              'ding-app/logic': { title: 'Logic', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      assert.strictEqual(state.items.length, 1);
      assert.strictEqual(state.items[0].vprs.length, 2);
      assert.strictEqual(state.ungrouped.length, 0);

      const scaffoldVpr = state.items[0].vprs.find(v => v.bookmark === 'ding-app/scaffold');
      const logicVpr = state.items[0].vprs.find(v => v.bookmark === 'ding-app/logic');

      assert.ok(scaffoldVpr, 'scaffold VPR should exist');
      assert.ok(logicVpr, 'logic VPR should exist');
      assert.strictEqual(scaffoldVpr.commits.length, 1);
      assert.strictEqual(logicVpr.commits.length, 1);
      assert.ok(scaffoldVpr.commits[0].subject.includes('scaffold'));
      assert.ok(logicVpr.commits[0].subject.includes('logic'));
    });

    it('attributes intermediate commits to the next bookmark even when chain is not on @ ancestry', async () => {
      // Build: base → c1 (bookmark v1) → c2 (no bookmark) → c3 (bookmark v2)
      // Then move @ off this chain entirely (simulate post-squash divergence
      // where v1/v2 sit on a sibling line to @). buildState() must still
      // attribute c2 to v2 — previously it dropped because the partition
      // walk gated on @'s ancestor set via afterRemote.
      makeCommit('c1.txt', '1\n', 'feat: c1', 'item-x/v1');
      makeCommit('c2.txt', '2\n', 'feat: c2 between bookmarks');
      makeCommit('c3.txt', '3\n', 'feat: c3', 'item-x/v2');

      // Move @ off the chain so c2 is no longer an ancestor of @.
      sh('jj new main');

      await saveMeta({
        items: {
          'item-x': {
            wi: 17000,
            wiTitle: 'Item X',
            vprs: {
              'item-x/v1': { title: 'V1', story: '', output: null },
              'item-x/v2': { title: 'V2', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      const v1 = state.items[0].vprs.find(v => v.bookmark === 'item-x/v1');
      const v2 = state.items[0].vprs.find(v => v.bookmark === 'item-x/v2');

      assert.strictEqual(v1.commits.length, 1, 'v1 should claim c1');
      assert.ok(v1.commits[0].subject.includes('c1'));
      assert.strictEqual(v2.commits.length, 2, 'v2 should claim c2 (between bookmarks) AND c3');
      const subjects = v2.commits.map(c => c.subject).join('|');
      assert.ok(subjects.includes('c2'), `expected c2 attributed to v2, got: ${subjects}`);
      assert.ok(subjects.includes('c3'), `expected c3 attributed to v2, got: ${subjects}`);
    });

    it('mix of bookmarked and plain commits splits correctly', async () => {
      makeCommit('a.txt', 'a\n', 'feat: claimed', 'ding-app/scaffold');
      makeCommit('b.txt', 'b\n', 'feat: free');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      assert.strictEqual(state.items[0].vprs[0].commits.length, 1);
      assert.strictEqual(state.ungrouped.length, 1);
      assert.ok(state.ungrouped[0].subject.includes('free'));
    });

    it('VPR sent status reflects meta.sent', async () => {
      makeCommit('x.txt', 'x\n', 'feat: sent commit', 'ding-app/scaffold');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: { 'ding-app/scaffold': { prId: 4952 } },
        eventLog: [],
      });

      const state = await buildState();
      const vpr = state.items[0].vprs[0];
      assert.strictEqual(vpr.sent, true, 'VPR should be marked sent when in meta.sent');
      assert.deepStrictEqual(state.sent, { 'ding-app/scaffold': { prId: 4952 } });
    });

    it('VPR sent is false when not in meta.sent', async () => {
      makeCommit('x.txt', 'x\n', 'feat: unsent', 'ding-app/scaffold');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      const vpr = state.items[0].vprs[0];
      assert.strictEqual(vpr.sent, false);
    });
  });

  // -------------------------------------------------------------------------
  // Hold list
  // -------------------------------------------------------------------------

  describe('held commits', () => {
    it('commits in the hold list appear in state.hold', async () => {
      const changeId = makeCommit('h.txt', 'h\n', 'feat: held commit');

      await saveMeta({
        items: {},
        hold: [changeId],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      assert.strictEqual(state.hold.length, 1, 'One commit should be in hold');
      assert.strictEqual(state.hold[0].changeId, changeId);
      assert.ok(state.hold[0].subject.includes('held'));

      // Must not appear in ungrouped
      assert.strictEqual(state.ungrouped.length, 0, 'Held commit should not be in ungrouped');
    });

    it('held commits do not appear in ungrouped', async () => {
      const c1 = makeCommit('h1.txt', 'h1\n', 'feat: held one');
      makeCommit('u1.txt', 'u1\n', 'feat: ungrouped one');

      await saveMeta({ items: {}, hold: [c1], sent: {}, eventLog: [] });

      const state = await buildState();
      assert.strictEqual(state.hold.length, 1);
      assert.strictEqual(state.ungrouped.length, 1);
      assert.ok(state.ungrouped[0].subject.includes('ungrouped'));
    });
  });

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  describe('conflict detection', () => {
    it('conflicts Set is present (empty when no conflicts)', async () => {
      makeCommit('c.txt', 'c\n', 'feat: clean commit');

      const state = await buildState();
      assert.ok(state.conflicts instanceof Set, 'conflicts should be a Set');
    });

    it('VPR conflict flag is false when no conflicts', async () => {
      makeCommit('clean.txt', 'clean\n', 'feat: clean', 'ding-app/scaffold');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      const vpr = state.items[0].vprs[0];
      assert.strictEqual(vpr.conflict, false);
      assert.strictEqual(vpr.commits[0].conflict, false);
    });
  });

  // -------------------------------------------------------------------------
  // Sent / eventLog pass-through
  // -------------------------------------------------------------------------

  describe('meta pass-through fields', () => {
    it('state.sent mirrors meta.sent', async () => {
      const sent = {
        'feat/17065-scaffold': { prId: 4952 },
        'feat/17066-logic': { prId: 4953 },
      };
      await saveMeta({ items: {}, hold: [], sent, eventLog: [] });

      const state = await buildState();
      assert.deepStrictEqual(state.sent, sent);
    });

    it('state.eventLog mirrors meta.eventLog', async () => {
      const eventLog = [
        { ts: '2025-01-01T00:00:00.000Z', actor: 'claude', action: 'add', detail: { item: 'foo' } },
      ];
      await saveMeta({ items: {}, hold: [], sent: {}, eventLog });

      const state = await buildState();
      assert.deepStrictEqual(state.eventLog, eventLog);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('commits are distributed across multiple items correctly', async () => {
      makeCommit('d1.txt', 'd1\n', 'feat: ding scaffold', 'ding-app/scaffold');
      makeCommit('p1.txt', 'p1\n', 'feat: portal nav', 'portal/nav');

      await saveMeta({
        items: {
          'ding-app': {
            wi: 17065,
            wiTitle: 'Ding Convertor app',
            vprs: {
              'ding-app/scaffold': { title: 'Scaffold', story: '', output: null },
            },
          },
          portal: {
            wi: 17066,
            wiTitle: 'Portal Updates',
            vprs: {
              'portal/nav': { title: 'Nav', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const state = await buildState();
      assert.strictEqual(state.items.length, 2);
      assert.strictEqual(state.ungrouped.length, 0);

      const dingItem = state.items.find(i => i.name === 'ding-app');
      const portalItem = state.items.find(i => i.name === 'portal');

      assert.ok(dingItem, 'ding-app item should exist');
      assert.ok(portalItem, 'portal item should exist');

      assert.strictEqual(dingItem.vprs[0].commits.length, 1);
      assert.strictEqual(portalItem.vprs[0].commits.length, 1);
    });
  });
});
