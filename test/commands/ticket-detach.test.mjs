import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ticketHold } from '../../src/commands/ticket.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-detach-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  sh('jj git init --colocate', tmpDir);
  sh(`jj config set --repo snapshot.auto-track "\\"all() & ~glob:'.vpr/**'\\""`, tmpDir);
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('ticketHold() — detach-on-hold', () => {
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
    await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
  });

  describe('held with no other items', () => {
    it('returns detached:false with reason "no-other-items" — nothing to rebase against when the item is alone in meta', async () => {
      sh('jj describe -m "feat: foo"');
      sh('jj bookmark set scaffold-app/feat-foo -r @');

      await saveMeta({
        items: {
          'scaffold-app': {
            wi: 10,
            wiTitle: 'Scaffold',
            vprs: {
              'scaffold-app/feat-foo': { title: 'Feat foo', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await ticketHold('scaffold-app');

      assert.strictEqual(result.held, true);
      assert.strictEqual(result.detached, false);
      assert.strictEqual(result.reason, 'no-other-items');
    });
  });

  describe('held with overlap to other items', () => {
    it('first call detaches; second call is a no-op with reason "already-detached" — idempotent', async () => {
      sh('jj describe -m "feat: held foo"');
      sh('jj bookmark set held-item/feat-foo -r @');
      sh('jj new -m "feat: active bar"');
      sh('jj bookmark set active-item/feat-bar -r @');

      await saveMeta({
        items: {
          'held-item': {
            wi: 10,
            wiTitle: 'Held',
            vprs: {
              'held-item/feat-foo': { title: 'Held foo', story: '', output: null },
            },
          },
          'active-item': {
            wi: 11,
            wiTitle: 'Active',
            vprs: {
              'active-item/feat-bar': { title: 'Active bar', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const first = await ticketHold('held-item');
      assert.strictEqual(first.detached, true);

      const second = await ticketHold('held-item');
      assert.strictEqual(second.held, true);
      assert.strictEqual(second.detached, false);
      assert.strictEqual(second.reason, 'already-detached');
    });
  });

  describe('held in the middle of the chain', () => {
    it('peels the middle item off the active chain — bottom and top active items reparent onto the shared boundary, held lives off the same boundary on a sidebranch', async () => {
      // Chain: bottom (active) → middle (held) → top (active).
      // Holding middle should leave bottom→top intact on the active chain,
      // with middle on a sidebranch off bottom (the boundary commit).
      sh('jj describe -m "feat: bottom active"');
      sh('jj bookmark set bottom-item/feat-bottom -r @');
      sh('jj new -m "feat: middle held"');
      sh('jj bookmark set middle-item/feat-middle -r @');
      sh('jj new -m "feat: top active"');
      sh('jj bookmark set top-item/feat-top -r @');

      await saveMeta({
        items: {
          'bottom-item': {
            wi: 10,
            wiTitle: 'Bottom',
            vprs: {
              'bottom-item/feat-bottom': { title: 'Bottom', story: '', output: null },
            },
          },
          'middle-item': {
            wi: 11,
            wiTitle: 'Middle',
            vprs: {
              'middle-item/feat-middle': { title: 'Middle', story: '', output: null },
            },
          },
          'top-item': {
            wi: 12,
            wiTitle: 'Top',
            vprs: {
              'top-item/feat-top': { title: 'Top', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await ticketHold('middle-item');
      assert.strictEqual(result.detached, true);

      // The middle held commit must NOT be an ancestor of either active
      // bookmark — both bottom and top must be on a clean sidebranch-free
      // chain that skips the held commit.
      const middleOnTop = sh(
        `jj log -r '::top-item/feat-top & description(substring:"middle held")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.strictEqual(middleOnTop, '', 'middle must not remain on the active chain (top)');

      const middleOnBottom = sh(
        `jj log -r '::bottom-item/feat-bottom & description(substring:"middle held")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.strictEqual(middleOnBottom, '', 'middle must not remain on the active chain (bottom)');

      // Middle is still reachable on its own bookmark — moved to a sidebranch,
      // not deleted.
      const middleOnHeld = sh(
        `jj log -r '::middle-item/feat-middle & description(substring:"middle held")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.notStrictEqual(middleOnHeld, '', 'middle must still be reachable on its bookmark');

      // The active chain must still connect: bottom is an ancestor of top.
      const bottomOnTop = sh(
        `jj log -r '::top-item/feat-top & bottom-item/feat-bottom' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.notStrictEqual(bottomOnTop, '', 'bottom must remain an ancestor of top after detach');

      // No conflicts on the rebased sidebranch (and active chain).
      const conflicts = sh(`jj log -r 'conflicts()' --no-graph -T 'change_id ++ "\\n"'`);
      assert.strictEqual(conflicts, '', 'no conflicts after rebase');
    });
  });

  describe('held at the top of the chain', () => {
    it('reports already-detached — held topmost item does not share ancestry with active items below, so no rebase is needed and no conflicts arise', async () => {
      // Chain: bottom (active) → top (held).
      // Topologically, no active bookmark has the held top commit as ancestor,
      // so the held item is already a sidebranch off the active boundary —
      // detach is a no-op. Holding still records the held flag, but reports
      // already-detached and leaves the chain untouched.
      sh('jj describe -m "feat: bottom active"');
      sh('jj bookmark set bottom-item/feat-bottom -r @');
      sh('jj new -m "feat: top held"');
      sh('jj bookmark set top-item/feat-top -r @');

      await saveMeta({
        items: {
          'bottom-item': {
            wi: 10,
            wiTitle: 'Bottom',
            vprs: {
              'bottom-item/feat-bottom': { title: 'Bottom', story: '', output: null },
            },
          },
          'top-item': {
            wi: 11,
            wiTitle: 'Top',
            vprs: {
              'top-item/feat-top': { title: 'Top', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await ticketHold('top-item');
      assert.strictEqual(result.held, true);
      assert.strictEqual(result.detached, false);
      assert.strictEqual(result.reason, 'already-detached');

      // The held top commit is not an ancestor of the active bottom (topology
      // alone keeps them separated — that is the whole point of already-detached).
      const topOnBottom = sh(
        `jj log -r '::bottom-item/feat-bottom & description(substring:"top held")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.strictEqual(topOnBottom, '', 'top held must not be on the active chain');

      // Held top still reachable on its bookmark.
      const topOnHeld = sh(
        `jj log -r '::top-item/feat-top & description(substring:"top held")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.notStrictEqual(topOnHeld, '', 'top held must still be reachable on its bookmark');

      // No conflicts.
      const conflicts = sh(`jj log -r 'conflicts()' --no-graph -T 'change_id ++ "\\n"'`);
      assert.strictEqual(conflicts, '', 'no conflicts');
    });
  });

  describe('held with unbookmarked predecessor', () => {
    it('moves the unbookmarked predecessor onto the sidebranch with the held item — active chain no longer has it as ancestor', async () => {
      // Chain: prelude (no bookmark) → held foo (held-item) → active bar (active-item).
      // The unbookmarked prelude commit conceptually belongs to held-item per
      // state.mjs's "bookmark claims preceding unbookmarked commits" rule.
      sh('jj describe -m "feat: prelude"');
      sh('jj new -m "feat: held foo"');
      sh('jj bookmark set held-item/feat-foo -r @');
      sh('jj new -m "feat: active bar"');
      sh('jj bookmark set active-item/feat-bar -r @');

      await saveMeta({
        items: {
          'held-item': {
            wi: 10,
            wiTitle: 'Held',
            vprs: {
              'held-item/feat-foo': { title: 'Held foo', story: '', output: null },
            },
          },
          'active-item': {
            wi: 11,
            wiTitle: 'Active',
            vprs: {
              'active-item/feat-bar': { title: 'Active bar', story: '', output: null },
            },
          },
        },
        hold: [],
        sent: {},
        eventLog: [],
      });

      const result = await ticketHold('held-item');
      assert.strictEqual(result.detached, true);

      // The prelude commit (matched by description substring) must NOT be an
      // ancestor of the active-chain bookmark after detach. If it were,
      // holding failed to peel it off and active still drags prelude along.
      const preludeOnActive = sh(
        `jj log -r '::active-item/feat-bar & description(substring:"prelude")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.strictEqual(preludeOnActive, '', 'prelude must not remain on the active chain');

      // It must still be an ancestor of the held bookmark — the prelude moved
      // with the held item onto the sidebranch, not deleted.
      const preludeOnHeld = sh(
        `jj log -r '::held-item/feat-foo & description(substring:"prelude")' --no-graph -T 'change_id ++ "\\n"'`
      );
      assert.notStrictEqual(preludeOnHeld, '', 'prelude must travel with the held item');
    });
  });
});
