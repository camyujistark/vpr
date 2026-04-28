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
});
