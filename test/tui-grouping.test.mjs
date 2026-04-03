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

  it('move commit to group tip, emptying source, then move it back', () => {
    // Reproduces: pick uwrqqztp, drop on yrolouku (tp-93 tip), emptying tp-94
    // Then pick uwrqqztp again, drop on tp-94 (empty group header)
    makeCommit('feat: a');       // will be tp-91
    makeCommit('feat: b');       // will be tp-93
    makeCommit('feat: c');       // will be tp-94
    makeCommit('feat: d');       // will be tp-95
    const ids = getChangeIds();  // [a, b, c, d]

    jj(`bookmark create tp-91 -r ${ids[0]}`);
    jj(`bookmark create tp-93 -r ${ids[1]}`);
    jj(`bookmark create tp-94 -r ${ids[2]}`);
    jj(`bookmark create tp-95 -r ${ids[3]}`);

    // Step 1: VPR picks c (tp-94 tip), drops on b (tp-93 tip)
    // TUI does: delete tp-94 bookmark, rebase c after b, move tp-93 to c
    jj('bookmark delete tp-94');
    jj(`rebase -r ${ids[2]} -A ${ids[1]}`);
    jj(`bookmark set tp-93 -r ${ids[2]}`);

    // Verify: tp-94 is gone, c is now tp-93 tip
    assert.ok(!getBookmarks()['tp-94'], 'tp-94 should be deleted');
    assert.ok(getBookmarks()['tp-93'], 'tp-93 should exist');

    // Log should be: a(tp-91), b, c(tp-93), d(tp-95)
    let log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    let lines = log.split('\n').filter(Boolean);
    assert.ok(lines[0].includes('feat: a'));
    assert.ok(lines[1].includes('feat: b'));
    assert.ok(lines[2].includes('feat: c') && lines[2].includes('tp-93'));
    assert.ok(lines[3].includes('feat: d') && lines[3].includes('tp-95'));

    // Step 2: VPR picks c (now tp-93 tip), drops on empty tp-94
    // Use bookmark refs instead of change IDs for robustness
    // tp-93 currently points to c. Move it to c's parent (b).
    jj(`bookmark set tp-93 -r 'tp-93-' --allow-backwards`);
    // Create tp-94 on c (use change ID — it's stable)
    jj(`bookmark create tp-94 -r ${ids[2]}`);

    // Verify: both bookmarks restored
    const finalBookmarks = getBookmarks();
    assert.ok(finalBookmarks['tp-91'], 'tp-91 exists');
    assert.ok(finalBookmarks['tp-93'], 'tp-93 exists');
    assert.ok(finalBookmarks['tp-94'], 'tp-94 recreated');
    assert.ok(finalBookmarks['tp-95'], 'tp-95 exists');

    // Log should be back to: a(tp-91), b(tp-93), c(tp-94), d(tp-95)
    log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    lines = log.split('\n').filter(Boolean);
    assert.ok(lines[0].includes('feat: a') && lines[0].includes('tp-91'), `got: ${lines[0]}`);
    assert.ok(lines[1].includes('feat: b') && lines[1].includes('tp-93'), `got: ${lines[1]}`);
    assert.ok(lines[2].includes('feat: c') && lines[2].includes('tp-94'), `got: ${lines[2]}`);
    assert.ok(lines[3].includes('feat: d') && lines[3].includes('tp-95'), `got: ${lines[3]}`);
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

describe('cross-bookmark move: tp-94 → tp-93 → tp-94', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-cross-test-'));
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

  it('move commit from tp-94 into tp-93, then back to tp-94', () => {
    // Setup: a(tp-91), b, c(tp-93), d(tp-94), e(tp-95)
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    makeCommit('feat: d');
    makeCommit('feat: e');
    const ids = getChangeIds(); // [a, b, c, d, e]

    jj(`bookmark create tp-91 -r ${ids[0]}`);
    jj(`bookmark create tp-93 -r ${ids[2]}`);
    jj(`bookmark create tp-94 -r ${ids[3]}`);
    jj(`bookmark create tp-95 -r ${ids[4]}`);

    // Verify initial state
    let bm = getBookmarks();
    assert.ok(bm['tp-93'], 'tp-93 on c');
    assert.ok(bm['tp-94'], 'tp-94 on d');

    // === Step 1: Move d (tp-94 tip) into tp-93 ===
    // Drop on c (tp-93 tip): rebase -A c, then move tp-93 to d
    jj(`rebase -r ${ids[3]} -A ${ids[2]}`);
    jj(`bookmark set tp-93 -r ${ids[3]} --allow-backwards`);

    // tp-94 followed d (jj default), so now both tp-93 and tp-94 on d
    // Delete tp-94 since it was absorbed into tp-93... no wait
    // Actually tp-94 bookmark followed d. Need to check.
    let log1 = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    let lines1 = log1.split('\n').filter(Boolean);
    // d should be after c and have tp-93 (and tp-94 followed it)
    const dLine1 = lines1.find(l => l.includes('feat: d'));
    assert.ok(dLine1.includes('tp-93'), `d should have tp-93, got: ${dLine1}`);

    // === Step 2: Move d back to tp-94 (now empty in meta) ===
    // Move tp-93 back to parent of d (which is c)
    jj(`bookmark set tp-93 -r '${ids[3]}-' --allow-backwards`);
    // tp-94 is already on d (followed it), so just verify
    // If tp-94 was deleted, recreate it
    bm = getBookmarks();
    if (!bm['tp-94']) {
      jj(`bookmark create tp-94 -r ${ids[3]}`);
    }

    // Verify final state: tp-93 on c, tp-94 on d
    let log2 = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    let lines2 = log2.split('\n').filter(Boolean);

    const cLine = lines2.find(l => l.includes('feat: c'));
    const dLine = lines2.find(l => l.includes('feat: d'));
    assert.ok(cLine.includes('tp-93'), `c should have tp-93, got: ${cLine}`);
    assert.ok(dLine.includes('tp-94'), `d should have tp-94, got: ${dLine}`);

    // Verify order: a, b, c(tp-93), d(tp-94), e(tp-95)
    const aIdx = lines2.findIndex(l => l.includes('feat: a'));
    const bIdx = lines2.findIndex(l => l.includes('feat: b'));
    const cIdx = lines2.findIndex(l => l.includes('feat: c'));
    const dIdx = lines2.findIndex(l => l.includes('feat: d'));
    const eIdx = lines2.findIndex(l => l.includes('feat: e'));
    assert.ok(aIdx < bIdx && bIdx < cIdx && cIdx < dIdx && dIdx < eIdx,
      `Order should be a,b,c,d,e got indices: ${aIdx},${bIdx},${cIdx},${dIdx},${eIdx}`);
  });
});

describe('within-group move should stay in group', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-within-test-'));
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

  it('reorder non-tip within a group — bookmark stays on tip', () => {
    // Setup: a, b, c(tp-1) — all three in tp-1's group
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    const ids = getChangeIds();

    jj(`bookmark create tp-1 -r ${ids[2]}`); // tip on c

    // Move a after b (reorder within group): a,b,c → b,a,c
    jj(`rebase -r ${ids[0]} -A ${ids[1]}`);

    // tp-1 should still be on c (bookmark follows c, not a)
    const bm = getBookmarks();
    assert.ok(bm['tp-1'], 'tp-1 should still exist');

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    const cLine = lines.find(l => l.includes('feat: c'));
    assert.ok(cLine.includes('tp-1'), `c should have tp-1, got: ${cLine}`);

    const bIdx = lines.findIndex(l => l.includes('feat: b'));
    const aIdx = lines.findIndex(l => l.includes('feat: a'));
    const cIdx = lines.findIndex(l => l.includes('feat: c'));
    assert.ok(bIdx < aIdx && aIdx < cIdx, `Order should be b,a,c got: ${bIdx},${aIdx},${cIdx}`);
  });

  it('swap tip with commit below — [1,2,3(tip)] pick 3 drop on 2 → [1,3,2(tip)]', () => {
    makeCommit('feat: 1');
    makeCommit('feat: 2');
    makeCommit('feat: 3');
    makeCommit('feat: 4');
    const ids = getChangeIds(); // [1, 2, 3, 4]

    jj(`bookmark create tp-1 -r ${ids[2]}`); // tip on 3
    jj(`bookmark create tp-2 -r ${ids[3]}`); // tip on 4

    // Pick 3 (tp-1 tip), drop on 2 → swap: rebase 2 after 3, move bookmark to 2
    jj(`rebase -r ${ids[1]} -A ${ids[2]}`);
    jj(`bookmark set tp-1 -r ${ids[1]} --allow-backwards`);

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    // Order: 1, 3, 2(tp-1), 4(tp-2)
    const i1 = lines.findIndex(l => l.includes('feat: 1'));
    const i3 = lines.findIndex(l => l.includes('feat: 3'));
    const i2 = lines.findIndex(l => l.includes('feat: 2'));
    const i4 = lines.findIndex(l => l.includes('feat: 4'));

    assert.ok(i1 < i3 && i3 < i2 && i2 < i4,
      `Order should be 1,3,2,4 got indices: ${i1},${i3},${i2},${i4}`);

    // tp-1 on 2 (new tip), tp-2 on 4
    assert.ok(lines[i2].includes('tp-1'), `2 should have tp-1, got: ${lines[i2]}`);
    assert.ok(lines[i4].includes('tp-2'), `4 should have tp-2, got: ${lines[i4]}`);

    // 3 should have no bookmark (it was old tip, now inside group)
    assert.ok(!lines[i3].includes('tp-1'), `3 should not have tp-1, got: ${lines[i3]}`);
  });

  it('move tip to top of group — [1,2,3(tip)] pick 3 drop on 1 → [1,3,2(tip)]', () => {
    makeCommit('feat: 1');
    makeCommit('feat: 2');
    makeCommit('feat: 3');
    makeCommit('feat: 4');
    const ids = getChangeIds(); // [1, 2, 3, 4]

    jj(`bookmark create tp-1 -r ${ids[2]}`); // tip on 3
    jj(`bookmark create tp-2 -r ${ids[3]}`); // tip on 4

    // Pick 3 (tp-1 tip), drop on 1 (non-adjacent) → -A: insert after 1
    jj(`rebase -r ${ids[2]} -A ${ids[0]}`);
    // New last in group (excluding 3): 2
    jj(`bookmark set tp-1 -r ${ids[1]} --allow-backwards`);

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    const i1 = lines.findIndex(l => l.includes('feat: 1'));
    const i3 = lines.findIndex(l => l.includes('feat: 3'));
    const i2 = lines.findIndex(l => l.includes('feat: 2'));
    const i4 = lines.findIndex(l => l.includes('feat: 4'));

    assert.ok(i1 < i3 && i3 < i2 && i2 < i4,
      `Order should be 1,3,2,4 got indices: ${i1},${i3},${i2},${i4}`);

    assert.ok(lines[i2].includes('tp-1'), `2 should have tp-1, got: ${lines[i2]}`);
    assert.ok(lines[i4].includes('tp-2'), `4 should have tp-2, got: ${lines[i4]}`);
    assert.ok(!lines[i3].includes('tp-1'), `3 should not have tp-1, got: ${lines[i3]}`);
  });

  it('move tip within group — bookmark moves to predecessor, commit reorders', () => {
    // Setup: a, b, c(tp-1), d(tp-2) — tp-1 has a,b,c
    // Pick c (tp-1 tip), drop on a → c goes after a, tp-1 moves to b
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');
    makeCommit('feat: d');
    const ids = getChangeIds(); // [a, b, c, d]

    jj(`bookmark create tp-1 -r ${ids[2]}`); // tip on c
    jj(`bookmark create tp-2 -r ${ids[3]}`); // tip on d

    // Simulate VPR: pick c (tp-1 tip), rebase after a, move tp-1 to b (predecessor)
    jj(`rebase -r ${ids[2]} -A ${ids[0]}`);
    jj(`bookmark set tp-1 -r ${ids[1]} --allow-backwards`);

    const log = jj(`log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ " " ++ bookmarks ++ "\\n"'`);
    const lines = log.split('\n').filter(Boolean);

    // Order: a, c, b(tp-1), d(tp-2)
    const aIdx = lines.findIndex(l => l.includes('feat: a'));
    const cIdx = lines.findIndex(l => l.includes('feat: c'));
    const bIdx = lines.findIndex(l => l.includes('feat: b'));
    const dIdx = lines.findIndex(l => l.includes('feat: d'));

    assert.ok(aIdx < cIdx && cIdx < bIdx && bIdx < dIdx,
      `Order should be a,c,b,d got indices: ${aIdx},${cIdx},${bIdx},${dIdx}`);

    // tp-1 should be on b (predecessor of c, the old tip)
    const bLine = lines[bIdx];
    assert.ok(bLine.includes('tp-1'), `b should have tp-1, got: ${bLine}`);

    // tp-2 should still be on d
    const dLine = lines[dIdx];
    assert.ok(dLine.includes('tp-2'), `d should have tp-2, got: ${dLine}`);

    // c should have no bookmark (it was the old tip, now just a regular commit)
    const cLine = lines[cIdx];
    assert.ok(!cLine.includes('tp-1') && !cLine.includes('tp-2'), `c should have no bookmark, got: ${cLine}`);
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
