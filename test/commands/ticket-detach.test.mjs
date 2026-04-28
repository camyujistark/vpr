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
