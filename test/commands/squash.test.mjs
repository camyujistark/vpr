import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeSquashCandidates,
  buildSquashContent,
  parseSquashContent,
  executeSquash,
} from '../../src/commands/squash.mjs';
import { saveMeta, loadMeta } from '../../src/core/meta.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let originalCwd;

function sh(cmd) {
  return execSync(cmd, { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-squash-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  // Create initial commit so git has a HEAD
  writeFileSync(join(tmpDir, 'README.md'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

async function emptyMeta() {
  await saveMeta({ items: {}, hold: [], sent: {}, eventLog: [] });
}

/** Create a commit touching specific files, return its change_id. */
function makeCommit(files, message) {
  for (const f of files) {
    const dir = join(tmpDir, ...f.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tmpDir, f), `${message}\n${Date.now()}\n`);
  }
  sh(`jj commit -m "${message}"`);
  // Get the change_id of the commit we just made (parent of @)
  return sh("jj log -r '@-' --no-graph --template 'change_id.short()'");
}

// ---------------------------------------------------------------------------
// Unit tests — analyzeSquashCandidates (mocked file data)
// ---------------------------------------------------------------------------

describe('analyzeSquashCandidates()', () => {
  it('returns empty for empty input', () => {
    assert.deepStrictEqual(analyzeSquashCandidates([]), []);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — buildSquashContent / parseSquashContent
// ---------------------------------------------------------------------------

describe('buildSquashContent() and parseSquashContent()', () => {
  it('round-trips candidates through build and parse', () => {
    const candidates = [
      { action: 'keep', changeId: 'aaa11111', subject: 'first commit', files: ['M foo.ts'], groupIdx: 0 },
      { action: 'squash', changeId: 'bbb22222', subject: 'second commit', files: ['M foo.ts'], groupIdx: 0 },
      { action: 'keep', changeId: 'ccc33333', subject: 'third commit', files: ['M bar.ts'], groupIdx: 1 },
    ];

    const content = buildSquashContent(candidates);
    const parsed = parseSquashContent(content);

    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0].action, 'keep');
    assert.strictEqual(parsed[0].changeId, 'aaa11111');
    assert.strictEqual(parsed[1].action, 'squash');
    assert.strictEqual(parsed[1].changeId, 'bbb22222');
    assert.strictEqual(parsed[2].action, 'keep');
    assert.strictEqual(parsed[2].changeId, 'ccc33333');
  });

  it('ignores comment lines and empty lines', () => {
    const content = '# comment\n\nkeep abc12345 some commit\n# another comment\nsquash def67890 other';
    const parsed = parseSquashContent(content);
    assert.strictEqual(parsed.length, 2);
  });

  it('allows changing squash to keep', () => {
    const content = 'keep abc12345 was squash now keep\nkeep def67890 always keep';
    const parsed = parseSquashContent(content);
    assert.strictEqual(parsed[0].action, 'keep');
    assert.strictEqual(parsed[1].action, 'keep');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real jj repo
// ---------------------------------------------------------------------------

describe('squash integration', () => {
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
    await emptyMeta();
  });

  describe('executeSquash()', () => {
    it('squashes adjacent commits touching the same file', async () => {
      const id1 = makeCommit(['src/app.ts'], 'feat: initial app');
      const id2 = makeCommit(['src/app.ts'], 'fix: update app');

      const logBefore = sh('jj log --no-graph --template \'change_id.short() ++ "\\n"\'');
      const countBefore = logBefore.split('\n').filter(Boolean).length;

      const result = executeSquash([
        { action: 'keep', changeId: id1 },
        { action: 'squash', changeId: id2 },
      ]);

      assert.strictEqual(result.squashed, 1);
      assert.strictEqual(result.kept, 1);
      assert.strictEqual(result.errors.length, 0);

      const logAfter = sh('jj log --no-graph --template \'change_id.short() ++ "\\n"\'');
      assert.strictEqual(logAfter.split('\n').filter(Boolean).length, countBefore - 1);
    });

    it('keeps commits marked as keep', async () => {
      const id1 = makeCommit(['src/app.ts'], 'feat: initial app');
      const id2 = makeCommit(['src/app.ts'], 'feat: more app');

      const result = executeSquash([
        { action: 'keep', changeId: id1 },
        { action: 'keep', changeId: id2 },
      ]);

      assert.strictEqual(result.squashed, 0);
      assert.strictEqual(result.kept, 2);
    });

    it('handles errors gracefully', async () => {
      const result = executeSquash([
        { action: 'squash', changeId: 'nonexistent12' },
      ]);

      assert.strictEqual(result.squashed, 0);
      assert.strictEqual(result.errors.length, 1);
    });
  });

  describe('analyzeSquashCandidates() with real commits', () => {
    it('groups adjacent same-file commits', async () => {
      const id1 = makeCommit(['src/app.ts'], 'feat: initial');
      const id2 = makeCommit(['src/app.ts'], 'fix: tweak');
      const id3 = makeCommit(['src/other.ts'], 'feat: other');
      const id4 = makeCommit(['src/other.ts'], 'fix: other tweak');

      const commits = [
        { changeId: id1, sha: '', subject: 'feat: initial' },
        { changeId: id2, sha: '', subject: 'fix: tweak' },
        { changeId: id3, sha: '', subject: 'feat: other' },
        { changeId: id4, sha: '', subject: 'fix: other tweak' },
      ];

      const result = analyzeSquashCandidates(commits);

      // id1 + id2 should be same group (both touch app.ts)
      assert.strictEqual(result[0].groupIdx, result[1].groupIdx);
      assert.strictEqual(result[0].action, 'keep');
      assert.strictEqual(result[1].action, 'squash');

      // id3 + id4 should be same group (both touch other.ts)
      assert.strictEqual(result[2].groupIdx, result[3].groupIdx);
      assert.strictEqual(result[2].action, 'keep');
      assert.strictEqual(result[3].action, 'squash');

      // Groups should be different
      assert.notStrictEqual(result[0].groupIdx, result[2].groupIdx);
    });

    it('keeps non-overlapping commits independent', async () => {
      const id1 = makeCommit(['src/a.ts'], 'feat: a');
      const id2 = makeCommit(['src/b.ts'], 'feat: b');
      const id3 = makeCommit(['src/c.ts'], 'feat: c');

      const commits = [
        { changeId: id1, sha: '', subject: 'feat: a' },
        { changeId: id2, sha: '', subject: 'feat: b' },
        { changeId: id3, sha: '', subject: 'feat: c' },
      ];

      const result = analyzeSquashCandidates(commits);

      // All different groups, all keep
      assert.strictEqual(result[0].action, 'keep');
      assert.strictEqual(result[1].action, 'keep');
      assert.strictEqual(result[2].action, 'keep');
      assert.notStrictEqual(result[0].groupIdx, result[1].groupIdx);
      assert.notStrictEqual(result[1].groupIdx, result[2].groupIdx);
    });
  });
});
