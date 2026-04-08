import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to import the module under test. Since it caches hasJj(), we import fresh each test
// by using dynamic import with a cache-busting query string isn't supported in Node ESM.
// Instead we test in a single suite, resetting cwd as needed.
import { jj, jjSafe, hasJj, getBase, getBaseBranch, getConflicts, getDiff, getFiles } from '../../src/core/jj.mjs';

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-jj-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
}

function teardown() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('jj core helpers', () => {
  before(() => {
    setup();
    // Change process cwd so jj commands run in the temp repo
    process.chdir(tmpDir);
  });

  after(() => {
    teardown();
  });

  describe('jj()', () => {
    it('executes a jj command and returns trimmed stdout', () => {
      const result = jj('--version');
      assert.ok(result.startsWith('jj'), `Expected output starting with "jj", got: ${result}`);
    });

    it('throws on failure', () => {
      assert.throws(() => jj('this-command-does-not-exist'), /Command failed/);
    });
  });

  describe('jjSafe()', () => {
    it('returns output on success', () => {
      const result = jjSafe('--version');
      assert.ok(result !== null);
      assert.ok(result.startsWith('jj'));
    });

    it('returns null on failure', () => {
      const result = jjSafe('this-command-does-not-exist');
      assert.strictEqual(result, null);
    });
  });

  describe('hasJj()', () => {
    it('returns true when jj is available and repo is initialized', () => {
      const result = hasJj();
      assert.strictEqual(result, true);
    });
  });

  describe('getBase()', () => {
    it('returns a commit id string (or null in empty repo)', () => {
      const result = getBase();
      // In a fresh repo with no remote bookmarks, may return null or a root commit id
      // We just assert it doesn't throw and returns string or null
      assert.ok(result === null || typeof result === 'string');
    });
  });

  describe('getBaseBranch()', () => {
    it('returns null in a repo with no remote bookmarks', () => {
      const result = getBaseBranch();
      assert.strictEqual(result, null);
    });
  });

  describe('getConflicts()', () => {
    it('returns an empty Set when no conflicts exist', () => {
      const result = getConflicts();
      assert.ok(result instanceof Set);
      assert.strictEqual(result.size, 0);
    });
  });

  describe('getDiff() and getFiles() after a commit', () => {
    let changeId;

    before(() => {
      // Create a file and commit it via jj
      writeFileSync(join(tmpDir, 'hello.txt'), 'hello world\n');
      // jj describe to set a message on the working-copy commit, then new to finalize
      execSync('jj describe -m "feat: add hello"', { cwd: tmpDir, stdio: 'pipe' });
      execSync('jj new', { cwd: tmpDir, stdio: 'pipe' });
      // Get the change_id of the commit we just described (it's now the parent)
      const log = execSync(
        'jj log -r @- --no-graph --template "change_id.short()"',
        { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      changeId = log;
    });

    it('getDiff() returns a non-empty diff string', () => {
      const diff = getDiff(changeId);
      assert.ok(typeof diff === 'string');
      assert.ok(diff.length > 0, 'Expected non-empty diff');
      assert.ok(diff.includes('hello.txt') || diff.includes('hello'), `Diff should mention hello.txt, got: ${diff.slice(0, 200)}`);
    });

    it('getFiles() returns array of file summary lines', () => {
      const files = getFiles(changeId);
      assert.ok(Array.isArray(files));
      assert.ok(files.length > 0, 'Expected at least one file');
      assert.ok(files.some(f => f.includes('hello.txt')), `Expected hello.txt in files: ${files}`);
    });
  });
});
