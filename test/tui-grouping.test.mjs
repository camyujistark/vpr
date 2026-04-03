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

describe('drop on bookmark tip — insert below + move bookmark', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-tip-test-'));
    origCwd = process.cwd();
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

  it('inserting after bookmark tip + moving bookmark keeps commit inside group', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    makeCommit('feat: d');
    const ids = getChangeIds();
    // ids: [a, b, c, d]

    // tp-1 caps a+b, tp-2 caps c+d
    jj(`bookmark create tp-1 -r ${ids[1]}`);
    jj(`bookmark create tp-2 -r ${ids[3]}`);

    // Move d (tp-2 group) after b (tp-1 bookmark tip)
    // Should: insert after b, then move tp-1 bookmark to d
    jj(`rebase -r ${ids[3]} -A ${ids[1]}`);
    jj(`bookmark set tp-1 -r ${ids[3]}`);

    // Verify: d is now after b in the log
    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    const bLine = lines.findIndex(l => l.includes('feat: b'));
    const dLine = lines.findIndex(l => l.includes('feat: d'));
    assert.ok(dLine > bLine, 'd should be after b');

    // tp-1 bookmark should now be on d (new tip)
    const dBookmarks = lines[dLine];
    assert.ok(dBookmarks.includes('tp-1'), 'tp-1 should be on d (new tip)');

    // b should no longer have tp-1
    const bBookmarks = lines[bLine];
    assert.ok(!bBookmarks.includes('tp-1'), 'b should not have tp-1 anymore');
  });

  it('d stays inside tp-1 group (between a and c) — tp-2 follows d then gets moved to tp-1', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    makeCommit('feat: d');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[1]}`);
    jj(`bookmark create tp-2 -r ${ids[3]}`);

    // Simulate VPR drop: delete tp-2 from picked commit, rebase, set tp-1 to new tip
    jj('bookmark delete tp-2');
    jj(`rebase -r ${ids[3]} -A ${ids[1]}`);
    jj(`bookmark set tp-1 -r ${ids[3]}`);

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    // Order should be: a, b, d(tp-1), c
    assert.ok(lines[0].includes('feat: a'), `first should be a, got: ${lines[0]}`);
    assert.ok(lines[1].includes('feat: b'), `second should be b, got: ${lines[1]}`);
    assert.ok(lines[2].includes('feat: d') && lines[2].includes('tp-1'), `third should be d with tp-1, got: ${lines[2]}`);
    assert.ok(lines[3].includes('feat: c'), `fourth should be c, got: ${lines[3]}`);
    // tp-2 was deleted — c has no bookmark (meta keeps the empty group)
    assert.ok(!lines[3].includes('tp-2'), 'c should not have tp-2 (it was deleted)');
  });
});

describe('drop into empty group', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-empty-test-'));
    origCwd = process.cwd();
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

  it('moving commit into position of empty group (between two bookmarks)', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    // tp-1 on a, tp-2 on b, tp-3 on c
    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);
    jj(`bookmark create tp-3 -r ${ids[2]}`);

    // Delete tp-2 bookmark (making it empty)
    jj('bookmark delete tp-2');

    // b is now between tp-1(a) and tp-3(c) with no bookmark
    // To put a commit into "tp-2's position" we need to insert after tp-1's tip (a)
    // Then recreate tp-2 bookmark on it

    // Move c after a (simulating drop into empty tp-2 position)
    jj(`rebase -r ${ids[2]} -A ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[2]}`);

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    // c should now be between a and b, with tp-2 on c
    const cLine = lines.findIndex(l => l.includes('feat: c'));
    assert.ok(lines[cLine].includes('tp-2'), `c should have tp-2, got: ${lines[cLine]}`);
  });
});

describe('full move cycle: move out then back into empty group', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-cycle-test-'));
    origCwd = process.cwd();
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

  it('delete bookmark then recreate on same commit', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[0]}`);
    jj(`bookmark create tp-2 -r ${ids[1]}`);

    jj('bookmark delete tp-2');
    assert.ok(!getBookmarks()['tp-2'], 'tp-2 deleted');

    jj(`bookmark create tp-2 -r ${ids[1]}`);
    assert.ok(getBookmarks()['tp-2'], 'tp-2 recreated');
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
