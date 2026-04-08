import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { init } from '../../src/commands/init.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// ---------------------------------------------------------------------------
// Suite 1 — fresh git repo with no flags
// ---------------------------------------------------------------------------

describe('init() — fresh git repo with no flags', () => {
  let tmpDir;
  let originalCwd;

  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-init-test-'));
    sh('git init', tmpDir);
    sh('git config user.email "test@example.com"', tmpDir);
    sh('git config user.name "Test"', tmpDir);
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .jj directory (runs jj git init --colocate)', async () => {
    await init({});
    assert.ok(existsSync(join(tmpDir, '.jj')), '.jj directory should exist');
  });

  it('creates .vpr/config.json with provider "none"', async () => {
    const configPath = join(tmpDir, '.vpr', 'config.json');
    assert.ok(existsSync(configPath), '.vpr/config.json should exist');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.provider, 'none');
  });

  it('creates .vpr/meta.json with empty structure', async () => {
    const metaPath = join(tmpDir, '.vpr', 'meta.json');
    assert.ok(existsSync(metaPath), '.vpr/meta.json should exist');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    assert.deepStrictEqual(meta.items, {});
    assert.deepStrictEqual(meta.hold, []);
    assert.deepStrictEqual(meta.sent, {});
    assert.deepStrictEqual(meta.eventLog, []);
  });

  it('adds .vpr/ and .jj/ to .git/info/exclude', async () => {
    const excludePath = join(tmpDir, '.git', 'info', 'exclude');
    assert.ok(existsSync(excludePath), '.git/info/exclude should exist');
    const content = readFileSync(excludePath, 'utf-8');
    assert.ok(content.includes('.vpr/'), 'exclude should contain .vpr/');
    assert.ok(content.includes('.jj/'), 'exclude should contain .jj/');
  });

  it('configures jj snapshot.auto-track to exclude .vpr', async () => {
    const output = sh('jj config get snapshot.auto-track', tmpDir);
    assert.ok(output.includes('.vpr'), 'snapshot.auto-track should mention .vpr');
    assert.ok(output.includes('~'), 'snapshot.auto-track should use negation ~');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — with azure-devops provider flags
// ---------------------------------------------------------------------------

describe('init() — with azure-devops provider flags', () => {
  let tmpDir;
  let originalCwd;

  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-init-test-'));
    sh('git init', tmpDir);
    sh('git config user.email "test@example.com"', tmpDir);
    sh('git config user.name "Test"', tmpDir);
    process.chdir(tmpDir);
    await init({
      provider: 'azure-devops',
      org: 'https://dev.azure.com/myorg',
      project: 'My Project',
      repo: 'my-repo',
      wiType: 'Bug',
    });
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes all provider fields to config.json', () => {
    const configPath = join(tmpDir, '.vpr', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.provider, 'azure-devops');
    assert.strictEqual(config.org, 'https://dev.azure.com/myorg');
    assert.strictEqual(config.project, 'My Project');
    assert.strictEqual(config.repo, 'my-repo');
    assert.strictEqual(config.wiType, 'Bug');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — idempotent re-run
// ---------------------------------------------------------------------------

describe('init() — idempotent re-run', () => {
  let tmpDir;
  let originalCwd;

  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-init-test-'));
    sh('git init', tmpDir);
    sh('git config user.email "test@example.com"', tmpDir);
    sh('git config user.name "Test"', tmpDir);
    // pre-init jj so .jj already exists
    sh('jj git init --colocate', tmpDir);
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when .jj already exists', async () => {
    await assert.doesNotReject(() => init({}));
  });

  it('creates .vpr/ even when .jj already existed', () => {
    assert.ok(existsSync(join(tmpDir, '.vpr')), '.vpr/ should exist');
  });

  it('does not duplicate exclude entries on re-run', async () => {
    // Run init a second time
    await init({});
    const excludePath = join(tmpDir, '.git', 'info', 'exclude');
    const content = readFileSync(excludePath, 'utf-8');
    const vprMatches = content.split('\n').filter(l => l.trim() === '.vpr/');
    const jjMatches = content.split('\n').filter(l => l.trim() === '.jj/');
    assert.strictEqual(vprMatches.length, 1, '.vpr/ should appear exactly once');
    assert.strictEqual(jjMatches.length, 1, '.jj/ should appear exactly once');
  });
});
