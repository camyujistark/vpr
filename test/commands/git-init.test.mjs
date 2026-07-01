import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init } from '../../src/commands/init.mjs';
import { resolveVcsKind } from '../../src/core/vcs.mjs';

let tmpDir;
let originalCwd;

describe('vpr init --git', () => {
  before(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-git-init-'));
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps a git repo without jj colocation', async () => {
    await init({ git: true });

    assert.ok(existsSync(join(tmpDir, '.git')), 'git repo created');
    assert.ok(!existsSync(join(tmpDir, '.jj')), 'no jj colocation');

    const config = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'config.json'), 'utf-8'));
    assert.equal(config.vcs, 'git');
    assert.ok(existsSync(join(tmpDir, '.vpr', 'meta.json')), 'meta.json created');

    const exclude = readFileSync(join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
    assert.match(exclude, /\.vpr\//);

    // The selector now resolves git from the written config.
    assert.equal(resolveVcsKind(), 'git');
  });
});
