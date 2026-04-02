import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir;
let origCwd;

describe('git helpers', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-git-test-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);

    execSync('git init -b main', { stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { stdio: 'pipe' });
    execSync('git commit --allow-empty -m "on main"', { stdio: 'pipe' });
    execSync('git checkout -b feature', { stdio: 'pipe' });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('git() runs commands and returns output', async () => {
    const { git } = await import('../src/git.mjs');
    const branch = git('branch --show-current');
    assert.strictEqual(branch, 'feature');
  });

  it('gitSafe() returns null on failure', async () => {
    const { gitSafe } = await import('../src/git.mjs');
    const result = gitSafe('rev-parse --verify nonexistent');
    assert.strictEqual(result, null);
  });

  it('currentBranch() returns current branch name', async () => {
    const { currentBranch } = await import('../src/git.mjs');
    assert.strictEqual(currentBranch(), 'feature');
  });

  it('getBase() finds main', async () => {
    const { getBase } = await import('../src/git.mjs');
    assert.strictEqual(getBase(), 'main');
  });

  it('getFilesForCommit() lists changed files', async () => {
    fs.writeFileSync('test.txt', 'hello');
    execSync('git add test.txt && git commit -m "add test"', { stdio: 'pipe' });
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();

    const { getFilesForCommit } = await import('../src/git.mjs');
    const files = getFilesForCommit(sha);
    assert.ok(files.includes('test.txt'));
  });
});

describe('VPR trailer parsing', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-trailer-test-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);

    execSync('git init', { stdio: 'pipe' });
    execSync('git checkout -b main', { stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { stdio: 'pipe' });
    execSync('git checkout -b feature', { stdio: 'pipe' });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads VPR trailer from commit', () => {
    execSync(`git commit --allow-empty -m $'feat(test): add feature\\n\\nVPR: TP-1'`, { stdio: 'pipe', shell: '/bin/bash' });

    const raw = execSync(
      `git log --format='%H%x09%s%x09%(trailers:key=VPR,valueonly)' main..HEAD`,
      { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const [sha, subject, trailer] = raw.split('\t');
    assert.strictEqual(subject, 'feat(test): add feature');
    assert.strictEqual(trailer.trim(), 'TP-1');
  });

  it('commit without trailer has empty trailer field', () => {
    execSync('git commit --allow-empty -m "no trailer"', { stdio: 'pipe' });

    const raw = execSync(
      `git log --format='%H%x09%s%x09%(trailers:key=VPR,valueonly)' main..HEAD`,
      { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const [, subject, trailer] = raw.split('\t');
    assert.strictEqual(subject, 'no trailer');
    assert.strictEqual((trailer || '').trim(), '');
  });

  it('conventional commit type is parsed correctly', () => {
    const subject = 'feat(media): replace texlive with typst';
    const match = subject.match(/^(feat|fix|chore|docs|test|refactor|ci|style|perf)(?:\(([^)]+)\))?:\s*(.*)$/);
    assert.ok(match);
    assert.strictEqual(match[1], 'feat');
    assert.strictEqual(match[2], 'media');
    assert.strictEqual(match[3], 'replace texlive with typst');
  });

  it('conventional commit without scope is parsed', () => {
    const subject = 'ci: add pipeline';
    const match = subject.match(/^(feat|fix|chore|docs|test|refactor|ci|style|perf)(?:\(([^)]+)\))?:\s*(.*)$/);
    assert.ok(match);
    assert.strictEqual(match[1], 'ci');
    assert.strictEqual(match[2], undefined);
    assert.strictEqual(match[3], 'add pipeline');
  });
});
