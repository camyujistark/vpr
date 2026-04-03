import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const VPR_BIN = path.resolve(import.meta.dirname, '..', 'bin', 'vpr.mjs');
let tmpDir;
let origCwd;

function run(cmd) {
  return execSync(`node ${VPR_BIN} ${cmd}`, {
    cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runJSON(cmd) {
  return JSON.parse(run(cmd));
}

function jj(cmd) {
  return execSync(`jj ${cmd}`, { cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function readMeta() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.vpr', 'meta.json'), 'utf-8'));
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-cli-'));
  origCwd = process.cwd();

  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  jj('git init --colocate');
  jj('config set --repo user.name "Test"');
  jj('config set --repo user.email "test@test.com"');

  // Init VPR with none provider
  const vprDir = path.join(tmpDir, '.vpr');
  fs.mkdirSync(vprDir, { recursive: true });
  fs.writeFileSync(path.join(vprDir, 'config.json'), JSON.stringify({
    provider: 'none', prefix: 'TP',
  }));
  fs.writeFileSync(path.join(vprDir, 'meta.json'), JSON.stringify({
    nextIndex: 1, bookmarks: {},
  }));

  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeCommit(msg) {
  fs.writeFileSync(path.join(tmpDir, `${Date.now()}-${Math.random()}.txt`), msg);
  jj(`commit -m '${msg}'`);
}

describe('vpr new', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates a ticket with title and description', () => {
    makeCommit('feat: first');
    const result = runJSON('new "CI: Add tests" "Add E2E tests"');
    assert.ok(result.wi, 'should have WI ID');
    assert.ok(result.bookmark.startsWith('feat/'), 'bookmark should start with feat/');
    assert.ok(result.tpIndex, 'should have TP index');
    assert.strictEqual(result.tpIndex, 'TP-1');

    const meta = readMeta();
    assert.ok(meta.bookmarks[result.bookmark]);
    assert.strictEqual(meta.bookmarks[result.bookmark].wiTitle, 'CI: Add tests');
    assert.strictEqual(meta.bookmarks[result.bookmark].wiDescription, 'Add E2E tests');
    assert.strictEqual(meta.nextIndex, 2);
  });

  it('creates ticket with empty description', () => {
    makeCommit('feat: first');
    const result = runJSON('new "Quick fix"');
    assert.ok(result.wi);
    assert.strictEqual(result.tpIndex, 'TP-1');
  });

  it('increments TP index', () => {
    makeCommit('feat: a');
    const r1 = runJSON('new "First"');
    makeCommit('feat: b');
    const r2 = runJSON('new "Second"');
    assert.strictEqual(r1.tpIndex, 'TP-1');
    assert.strictEqual(r2.tpIndex, 'TP-2');
  });

  it('creates jj bookmark', () => {
    makeCommit('feat: first');
    const result = runJSON('new "Test ticket"');
    const bookmarks = jj('bookmark list');
    assert.ok(bookmarks.includes(result.bookmark), 'jj bookmark should exist');
  });
});

describe('vpr edit', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('edits ticket title', () => {
    makeCommit('feat: first');
    const r = runJSON('new "Old title"');
    runJSON(`edit tp-1 --title "New title"`);
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks).find(k => meta.bookmarks[k].tpIndex === 'TP-1');
    assert.strictEqual(meta.bookmarks[bm].wiTitle, 'New title');
  });

  it('edits ticket description', () => {
    makeCommit('feat: first');
    runJSON('new "Test"');
    runJSON('edit tp-1 --desc "Updated description"');
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks).find(k => meta.bookmarks[k].tpIndex === 'TP-1');
    assert.strictEqual(meta.bookmarks[bm].wiDescription, 'Updated description');
  });

  it('edits PR title', () => {
    makeCommit('feat: first');
    runJSON('new "Test"');
    runJSON('edit tp-1 --pr-title "TP-1: Custom PR title"');
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks).find(k => meta.bookmarks[k].tpIndex === 'TP-1');
    assert.strictEqual(meta.bookmarks[bm].prTitle, 'TP-1: Custom PR title');
  });

  it('edits PR description', () => {
    makeCommit('feat: first');
    runJSON('new "Test"');
    runJSON('edit tp-1 --pr-desc "## Summary"');
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks).find(k => meta.bookmarks[k].tpIndex === 'TP-1');
    assert.strictEqual(meta.bookmarks[bm].prDesc, '## Summary');
  });

  it('edits multiple fields at once', () => {
    makeCommit('feat: first');
    runJSON('new "Test"');
    runJSON('edit tp-1 --title "New" --pr-desc "Body text"');
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks).find(k => meta.bookmarks[k].tpIndex === 'TP-1');
    assert.strictEqual(meta.bookmarks[bm].wiTitle, 'New');
    assert.strictEqual(meta.bookmarks[bm].prDesc, 'Body text');
  });

  it('title edit renames jj bookmark', () => {
    makeCommit('feat: first');
    const r = runJSON('new "Old name"');
    const oldBm = r.bookmark;
    runJSON('edit tp-1 --title "New name"');
    const bookmarks = jj('bookmark list');
    assert.ok(!bookmarks.includes(oldBm), 'old bookmark should be gone');
    assert.ok(bookmarks.includes('feat/'), 'new bookmark should exist with feat/ prefix');
  });
});

describe('vpr move', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('moves commit after target', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    makeCommit('feat: c');

    const ids = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short() ++ \"\\n\"'").split('\n').filter(Boolean);

    // Move c before a
    const result = runJSON(`move ${ids[2]} --before ${ids[0]}`);
    assert.strictEqual(result.moved, ids[2]);

    const log = jj("log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ \"\\n\"'");
    const lines = log.split('\n').filter(Boolean);
    assert.ok(lines[0].includes('feat: c'), 'c should be first');
    assert.ok(lines[1].includes('feat: a'), 'a should be second');
  });

  it('moves commit after target with --after', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');

    const ids = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short() ++ \"\\n\"'").split('\n').filter(Boolean);

    const result = runJSON(`move ${ids[0]} --after ${ids[1]}`);
    assert.strictEqual(result.flag, '--after');
  });
});

describe('vpr delete', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('deletes a single commit', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    const ids = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short() ++ \"\\n\"'").split('\n').filter(Boolean);

    const result = runJSON(`delete ${ids[0]}`);
    assert.strictEqual(result.abandoned, ids[0]);

    const log = jj("log --no-graph --reversed -r 'main..@-' -T 'description.first_line() ++ \"\\n\"'");
    assert.ok(!log.includes('feat: a'), 'a should be gone');
    assert.ok(log.includes('feat: b'), 'b should remain');
  });

  it('deletes a group by TP index', () => {
    makeCommit('feat: a');
    runJSON('new "Test group"');
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks)[0];

    const result = runJSON('delete tp-1');
    assert.ok(result.deleted);

    const newMeta = readMeta();
    assert.ok(!newMeta.bookmarks[bm], 'bookmark should be removed from meta');
  });
});

describe('vpr list', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns JSON array of groups', () => {
    makeCommit('feat: a');
    runJSON('new "First group"');
    makeCommit('feat: b');
    runJSON('new "Second group"');

    const groups = runJSON('list');
    assert.ok(Array.isArray(groups));
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].tpIndex, 'TP-1');
    assert.strictEqual(groups[1].tpIndex, 'TP-2');
  });

  it('each group has commits array', () => {
    makeCommit('feat: a');
    runJSON('new "Group"');

    const groups = runJSON('list');
    assert.ok(groups[0].commits.length >= 1);
    assert.ok(groups[0].commits[0].changeId);
    assert.ok(groups[0].commits[0].subject);
  });

  it('shows target branch', () => {
    makeCommit('feat: a');
    runJSON('new "First"');
    makeCommit('feat: b');
    runJSON('new "Second"');

    const groups = runJSON('list');
    // First group targets base (main)
    assert.ok(groups[0].target);
    // Second group targets first group's bookmark
    assert.strictEqual(groups[1].target, groups[0].bookmark);
  });

  it('includes PR title and description', () => {
    makeCommit('feat: a');
    runJSON('new "Test"');
    runJSON('edit tp-1 --pr-title "Custom PR" --pr-desc "## Summary"');

    const groups = runJSON('list');
    assert.strictEqual(groups[0].prTitle, 'Custom PR');
    assert.strictEqual(groups[0].prDesc, '## Summary');
  });
});

describe('vpr status', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('outputs human-readable chain', () => {
    makeCommit('feat: a');
    runJSON('new "First"');

    const output = run('status');
    assert.ok(output.includes('TP-1'), 'should show TP index');
    assert.ok(output.includes('First'), 'should show title');
    assert.ok(output.includes('branch:'), 'should show branch');
    assert.ok(output.includes('target:'), 'should show target');
    assert.ok(output.includes('commits:'), 'should show commit count');
  });
});

describe('vpr send --dry-run', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('shows chain summary without pushing', () => {
    makeCommit('feat: a');
    runJSON('new "First PR"');
    runJSON('edit tp-1 --pr-title "TP-1: First PR" --pr-desc "## Summary"');
    makeCommit('feat: b');
    runJSON('new "Second PR"');
    runJSON('edit tp-2 --pr-title "TP-2: Second PR"');

    const output = run('send --dry-run');
    assert.ok(output.includes('DRY RUN'), 'should say dry run');
    assert.ok(output.includes('2 PRs'), 'should show 2 PRs');
    assert.ok(output.includes('TP-1'), 'should show TP-1');
    assert.ok(output.includes('TP-2'), 'should show TP-2');
    assert.ok(output.includes('First PR'), 'should show title');
    assert.ok(output.includes('Branch:'), 'should show branch');
    assert.ok(output.includes('Target:'), 'should show target');
  });

  it('shows target chain — PR 2 targets PR 1', () => {
    makeCommit('feat: a');
    runJSON('new "First"');
    makeCommit('feat: b');
    runJSON('new "Second"');

    const output = run('send --dry-run');
    const lines = output.split('\n');
    const pr2Target = lines.find(l => l.includes('Target:') && !l.includes('main'));
    assert.ok(pr2Target, 'PR 2 should target PR 1\'s branch');
  });

  it('validates missing PR title', () => {
    makeCommit('feat: a');
    runJSON('new "Test"');
    // Clear the auto-generated PR title
    const meta = readMeta();
    const bm = Object.keys(meta.bookmarks)[0];
    meta.bookmarks[bm].prTitle = '';
    fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify(meta));

    const output = run('send --dry-run');
    assert.ok(output.includes('Missing PR title') || output.includes('not set'), 'should flag missing title');
  });

  it('shows commits per PR', () => {
    makeCommit('feat: a');
    makeCommit('feat: b');
    runJSON('new "Group with 2 commits"');

    const output = run('send --dry-run');
    assert.ok(output.includes('Commits: 2'), 'should show 2 commits');
  });
});

describe('vpr help', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('shows help text', () => {
    const output = run('help');
    assert.ok(output.includes('vpr new'));
    assert.ok(output.includes('vpr edit'));
    assert.ok(output.includes('vpr move'));
    assert.ok(output.includes('vpr delete'));
    assert.ok(output.includes('vpr list'));
    assert.ok(output.includes('vpr push'));
  });
});
