import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir;
let origCwd;

function jj(cmd) {
  return execSync(`jj ${cmd}`, { cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeCommit(msg) {
  fs.writeFileSync(path.join(tmpDir, `${Date.now()}.txt`), msg);
  jj(`commit -m '${msg}'`);
}

function getChangeIds() {
  return jj(`log --no-graph --reversed -r 'main..@-' -T 'change_id.short() ++ "\\n"'`)
    .split('\n').filter(Boolean);
}

function getBookmarks() {
  const raw = jj('bookmark list');
  if (!raw) return {};
  const result = {};
  for (const line of raw.split('\n').filter(Boolean)) {
    const match = line.match(/^(\S+):\s+(\S+)/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

describe('TUI grouping logic', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-tui-test-'));
    origCwd = process.cwd();

    // Init git + jj colocated
    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    jj('git init --colocate');
    jj('config set --repo user.name "Test"');
    jj('config set --repo user.email "test@test.com"');
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bookmark caps a group — commits below belong to it', () => {
    makeCommit('feat: first');
    makeCommit('feat: second');
    const ids = getChangeIds();
    assert.strictEqual(ids.length, 2);

    // Create bookmark on the second commit (tip)
    jj(`bookmark create tp-1 -r ${ids[1]}`);

    // Both commits should be in tp-1's group
    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'change_id.short() ++ "\\t" ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    // First commit has no bookmark, second has tp-1
    assert.ok(!lines[0].includes('tp-1'));
    assert.ok(lines[1].includes('tp-1'));
  });

  it('multiple bookmarks create separate groups', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[2]}`);

    // tp-1: [a], tp-2: [b, c]
    const bookmarks = getBookmarks();
    assert.ok(bookmarks['tp-1']);
    assert.ok(bookmarks['tp-2']);
  });

  it('rebase -B moves commit before target (into group)', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[2]}`);

    // Move commit b (ids[1]) before commit a (tp-1 tip) — into tp-1's group
    jj(`rebase -r ${ids[1]} -B ${ids[0]}`);

    // Now tp-1 should cap both a and b
    const newIds = getChangeIds();
    assert.strictEqual(newIds.length, 3);

    // Verify b is now before a in the log
    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ "\\n"'`);
    const subjects = log.split('\n').filter(Boolean);
    const aIdx = subjects.findIndex(s => s.includes('feat: a'));
    const bIdx = subjects.findIndex(s => s.includes('feat: b'));
    assert.ok(bIdx < aIdx, 'b should be before a after rebase -B');
  });

  it('rebase -A moves commit after target', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[2]}`);

    // Move commit a (ids[0]) after commit c (tp-2 tip)
    jj(`rebase -r ${ids[0]} -A ${ids[2]}`);

    // a should now be after c
    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ "\\n"'`);
    const subjects = log.split('\n').filter(Boolean);
    const aIdx = subjects.findIndex(s => s.includes('feat: a'));
    const cIdx = subjects.findIndex(s => s.includes('feat: c'));
    assert.ok(aIdx > cIdx, 'a should be after c after rebase -A');
  });

  it('bookmark follows its commit on rebase', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);

    // Rebase tp-1's commit after tp-2
    jj(`rebase -r ${ids[0]} -A ${ids[1]}`);

    // tp-1 bookmark should have followed the commit
    const bookmarks = getBookmarks();
    assert.ok(bookmarks['tp-1'], 'tp-1 bookmark should still exist');
    assert.ok(bookmarks['tp-2'], 'tp-2 bookmark should still exist');
  });

  it('deleting a bookmark keeps the commit', () => {
    makeCommit('feat: a');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj('bookmark delete tp-1');

    // Commit still exists
    const newIds = getChangeIds();
    assert.strictEqual(newIds.length, 1);
    // Bookmark gone
    const bookmarks = getBookmarks();
    assert.ok(!bookmarks['tp-1']);
  });

  it('recreating a bookmark on a moved commit restores the group', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);

    // Delete tp-1, then recreate on same commit
    jj('bookmark delete tp-1');
    jj(`bookmark create tp-1 -r ${ids[0]}`);

    const bookmarks = getBookmarks();
    assert.ok(bookmarks['tp-1'], 'tp-1 recreated');
    assert.ok(bookmarks['tp-2'], 'tp-2 unchanged');
  });

  it('jj undo reverses a rebase', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = getChangeIds();
    const originalLog = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ "\\n"'`);

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`rebase -r ${ids[1]} -B ${ids[0]}`);

    // Undo
    jj('undo');

    const restoredLog = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ "\\n"'`);
    assert.strictEqual(restoredLog, originalLog, 'undo should restore original order');
  });

  it('moving last commit out of a group empties it (bookmark deleted, commit stays)', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);

    // Delete tp-1 bookmark (simulating VPR moving its only commit out)
    jj('bookmark delete tp-1');

    // Commit a still exists, just no bookmark
    const newIds = getChangeIds();
    assert.strictEqual(newIds.length, 2);
    const bookmarks = getBookmarks();
    assert.ok(!bookmarks['tp-1'], 'tp-1 should be gone');
    assert.ok(bookmarks['tp-2'], 'tp-2 should remain');
  });

  it('dropping into empty group — bookmark is recreated on the moved commit', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);
    jj(`bookmark create tp-3 -r ${ids[2]}`);

    // Delete tp-2 (empty it)
    jj('bookmark delete tp-2');

    // Recreate tp-2 on commit b (simulating VPR dropping a commit into empty group)
    jj(`bookmark create tp-2 -r ${ids[1]}`);

    const bookmarks = getBookmarks();
    assert.ok(bookmarks['tp-2'], 'tp-2 recreated');
  });
});

describe('ascending sort', () => {
  it('sorts tp-1, tp-2, tp-10 correctly (numeric not lexical)', () => {
    const groups = [
      { bookmark: 'tp-10' },
      { bookmark: 'tp-2' },
      { bookmark: null },
      { bookmark: 'tp-1' },
    ];

    groups.sort((a, b) => {
      if (!a.bookmark) return 1;
      if (!b.bookmark) return -1;
      const aNum = parseInt(a.bookmark.replace(/\D/g, '')) || 0;
      const bNum = parseInt(b.bookmark.replace(/\D/g, '')) || 0;
      return aNum - bNum;
    });

    assert.deepStrictEqual(
      groups.map(g => g.bookmark),
      ['tp-1', 'tp-2', 'tp-10', null]
    );
  });
});
