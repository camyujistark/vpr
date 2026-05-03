import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveCommit } from '../../src/commands/move.mjs';
import { hasJj } from '../../src/core/jj-detect.mjs';
import { saveMeta } from '../../src/core/meta.mjs';

const JJ_AVAILABLE = (() => {
  try { execSync('which jj', { stdio: 'pipe' }); return true; } catch { return false; }
})();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-move-test-'));
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardown() {
  if (originalCwd) process.chdir(originalCwd);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('moveCommit — module export', () => {
  it('exports moveCommit as an async function (AC1)', () => {
    assert.strictEqual(typeof moveCommit, 'function');
    const result = moveCommit('abc', { toVpr: 'x' });
    assert.ok(result instanceof Promise, 'moveCommit should return a Promise');
    result.catch(() => {}); // suppress unhandled rejection
  });

  it('throws "Install jj for surgical commit moves" when jj is absent (AC2)', async () => {
    await assert.rejects(
      () => moveCommit('abc123', { toVpr: 'my-vpr' }),
      (err) => {
        assert.ok(
          err.message.includes('Install jj for surgical commit moves'),
          `unexpected message: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('moveCommit — AC14: non-existent target VPR', () => {
  before(() => { originalCwd = process.cwd(); setup(); });
  after(teardown);

  it('throws "No such VPR: <name>" when target VPR not in meta (AC14)', { skip: !hasJj() }, async () => {
    // Write a meta with a known VPR so the jj check passes first
    const meta = {
      items: {
        'my-item': {
          wi: 1,
          vprs: { 'real-vpr': { title: 'Real VPR', claims: [] } },
          dependsOn: [],
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    };
    writeFileSync(join(tmpDir, '.vpr', 'meta.json'), JSON.stringify(meta));
    await assert.rejects(
      () => moveCommit('abc123', { toVpr: 'nonexistent-vpr' }),
      (err) => {
        assert.ok(
          err.message.includes('No such VPR: nonexistent-vpr'),
          `unexpected message: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('vpr move — requires jj', () => {
  before(() => { originalCwd = process.cwd(); setup(); });
  after(teardown);

  it('exits with "Install jj for surgical commit moves" when jj is not in PATH (AC13)', () => {
    try {
      execSync(`node ${vprBin} move abc123 --to my-vpr`, {
        cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('Expected vpr move to exit non-zero');
    } catch (err) {
      const output = (err.stderr ?? '') + (err.stdout ?? '');
      assert.ok(
        output.includes('Install jj for surgical commit moves'),
        `Expected error message, got: ${output}`
      );
      assert.notStrictEqual(err.status, 0, 'Expected non-zero exit code');
    }
  });

  it('vpr --help includes vpr move (AC9)', () => {
    const out = execSync(`node ${vprBin} --help`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(out.includes('vpr move'), `--help missing "vpr move": ${out}`);
  });
});

// ---------------------------------------------------------------------------
// AC11: integration — clean move (requires jj)
// ---------------------------------------------------------------------------
describe('AC11: clean move — commit relocates without conflict', { skip: !JJ_AVAILABLE }, () => {
  let jjDir;
  let savedCwd;

  function sh(cmd, cwd = jjDir) {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  before(() => { savedCwd = process.cwd(); });
  after(() => {
    process.chdir(savedCwd);
    if (jjDir) rmSync(jjDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (jjDir) rmSync(jjDir, { recursive: true, force: true });
    jjDir = mkdtempSync(join(tmpdir(), 'vpr-move-ac11-'));
    mkdirSync(join(jjDir, '.vpr'), { recursive: true });
    process.chdir(jjDir);

    sh('git init');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    sh('jj git init --colocate');
    sh('jj config set --repo user.email "test@example.com"');
    sh('jj config set --repo user.name "Test"');

    // VPR-A: commit touching file-a.txt
    writeFileSync(join(jjDir, 'file-a.txt'), 'content-a');
    sh('jj describe -m "VPR-A commit"');
    sh('jj bookmark set item/vpr-a');
    const changeA = sh('jj log -r "item/vpr-a" --no-graph --template "change_id.short()"');
    sh('jj new');

    // VPR-B: commit touching file-b.txt (disjoint)
    writeFileSync(join(jjDir, 'file-b.txt'), 'content-b');
    sh('jj describe -m "VPR-B commit"');
    sh('jj bookmark set item/vpr-b');
    sh('jj new');

    await saveMeta({
      items: {
        item: {
          wi: 1, wiTitle: 'Item', dependsOn: [],
          vprs: {
            'item/vpr-a': { title: 'VPR A', story: '', acceptance: '', output: null, claims: [changeA] },
            'item/vpr-b': { title: 'VPR B', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });

    // store changeA on outer scope for assertions
    jjDir._changeA = changeA;
  });

  it('moves commit to target VPR, returns moved=true (AC11)', async () => {
    const changeA = sh('jj log -r "item/vpr-a" --no-graph --template "change_id.short()"');
    const result = await moveCommit(changeA, { toVpr: 'item/vpr-b' });
    assert.strictEqual(result.moved, true, 'expected moved=true');
    assert.strictEqual(result.changeId, changeA);
    assert.strictEqual(result.targetVpr, 'item/vpr-b');
    // No conflict files
    assert.ok(!result.conflicts, 'no conflicts on clean move');
  });
});

// ---------------------------------------------------------------------------
// AC12: integration — conflict + rollback (requires jj)
// ---------------------------------------------------------------------------
describe('AC12: conflict + rollback — rebase reverted when conflicts occur', { skip: !JJ_AVAILABLE }, () => {
  let jjDir;
  let savedCwd;

  function sh(cmd, cwd = jjDir) {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  before(() => { savedCwd = process.cwd(); });
  after(() => {
    process.chdir(savedCwd);
    if (jjDir) rmSync(jjDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (jjDir) rmSync(jjDir, { recursive: true, force: true });
    jjDir = mkdtempSync(join(tmpdir(), 'vpr-move-ac12-'));
    mkdirSync(join(jjDir, '.vpr'), { recursive: true });
    process.chdir(jjDir);

    sh('git init');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test"');
    sh('jj git init --colocate');
    sh('jj config set --repo user.email "test@example.com"');
    sh('jj config set --repo user.name "Test"');

    // Base commit
    writeFileSync(join(jjDir, 'shared.txt'), 'base-content');
    sh('jj describe -m "base"');
    sh('jj bookmark set base');
    const baseChange = sh('jj log -r "base" --no-graph --template "change_id.short()"');

    // VPR-A: modifies shared.txt line 1
    sh('jj new');
    writeFileSync(join(jjDir, 'shared.txt'), 'vpr-a-change');
    sh('jj describe -m "VPR-A edits shared"');
    sh('jj bookmark set item/vpr-a');
    const changeA = sh('jj log -r "item/vpr-a" --no-graph --template "change_id.short()"');

    // VPR-B: starts from base and ALSO modifies shared.txt — will conflict
    sh(`jj new ${baseChange}`);
    writeFileSync(join(jjDir, 'shared.txt'), 'vpr-b-change');
    sh('jj describe -m "VPR-B edits shared"');
    sh('jj bookmark set item/vpr-b');
    sh('jj new');

    await saveMeta({
      items: {
        item: {
          wi: 1, wiTitle: 'Item', dependsOn: [],
          vprs: {
            'item/vpr-a': { title: 'VPR A', story: '', acceptance: '', output: null, claims: [changeA] },
            'item/vpr-b': { title: 'VPR B', story: '', acceptance: '', output: null, claims: [] },
          },
        },
      },
      hold: [], sent: {}, eventLog: [],
    });
  });

  it('returns moved=false with conflict list and rolls back op (AC12)', async () => {
    const changeA = sh('jj log -r "item/vpr-a" --no-graph --template "change_id.short()"');
    const opBefore = sh("jj op log -n 1 -T 'self.id().short()'");

    const result = await moveCommit(changeA, { toVpr: 'item/vpr-b' });

    assert.strictEqual(result.moved, false, 'expected moved=false on conflict');
    assert.ok(Array.isArray(result.conflicts), 'conflicts is an array');
    assert.ok(Array.isArray(result.suggestions), 'suggestions is an array');

    // Op log should be restored (same head as before the move)
    const opAfter = sh("jj op log -n 1 -T 'self.id().short()'");
    assert.strictEqual(opAfter, opBefore, 'op log rolled back to pre-move state');
  });
});
