import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVcs, resolveVcsKind, parseJjLine } from '../../src/core/vcs.mjs';

describe('resolveVcsKind', () => {
  let tmpDir;
  let originalCwd;
  let originalEnv;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env.VPR_VCS;
    delete process.env.VPR_VCS;
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-vcs-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.VPR_VCS;
    else process.env.VPR_VCS = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to jj when nothing is set', () => {
    assert.equal(resolveVcsKind(), 'jj');
  });

  it('honours an explicit kind argument above everything else', () => {
    process.env.VPR_VCS = 'git';
    assert.equal(resolveVcsKind('jj'), 'jj');
  });

  it('reads VPR_VCS from the environment', () => {
    process.env.VPR_VCS = 'git';
    assert.equal(resolveVcsKind(), 'git');
  });

  it('reads "vcs" from .vpr/config.json', () => {
    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    writeFileSync(join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ vcs: 'git' }));
    assert.equal(resolveVcsKind(), 'git');
  });

  it('env beats config file', () => {
    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    writeFileSync(join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ vcs: 'git' }));
    process.env.VPR_VCS = 'jj';
    assert.equal(resolveVcsKind(), 'jj');
  });

  it('falls back to jj on unreadable config', () => {
    mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
    writeFileSync(join(tmpDir, '.vpr', 'config.json'), 'not json{');
    assert.equal(resolveVcsKind(), 'jj');
  });
});

describe('createVcs', () => {
  it('returns the jj backend by default with the read-side interface', () => {
    const vcs = createVcs({ kind: 'jj' });
    assert.equal(vcs.kind, 'jj');
    for (const method of [
      'getBase', 'getBaseBranch', 'getConflicts',
      'listChain', 'getRemoteTop', 'listChangeIds',
      'getDiff', 'getFiles', 'getVprFiles',
    ]) {
      assert.equal(typeof vcs[method], 'function', `jj backend must implement ${method}`);
    }
  });

  it('returns the git backend with the same read-side interface', () => {
    const vcs = createVcs({ kind: 'git' });
    assert.equal(vcs.kind, 'git');
    for (const method of [
      'getBase', 'getBaseBranch', 'getConflicts',
      'listChain', 'getRemoteTop', 'listChangeIds',
      'getDiff', 'getFiles', 'getVprFiles',
    ]) {
      assert.equal(typeof vcs[method], 'function', `git backend must implement ${method}`);
    }
  });

  it('throws for an unknown backend', () => {
    assert.throws(() => createVcs({ kind: 'hg' }), /Unknown vcs backend/);
  });
});

describe('parseJjLine', () => {
  it('parses a well-formed tab-separated line', () => {
    const row = parseJjLine('abcd\t1234\tfeat/x main@origin\tDo the thing');
    assert.deepEqual(row, {
      changeId: 'abcd',
      sha: '1234',
      bookmarks: ['feat/x'],
      hasRemote: true,
      subject: 'Do the thing',
    });
  });

  it('skips undescribed commits (empty subject)', () => {
    assert.equal(parseJjLine('abcd\t1234\t\t'), null);
  });

  it('skips malformed lines', () => {
    assert.equal(parseJjLine('abcd\t1234'), null);
  });
});
