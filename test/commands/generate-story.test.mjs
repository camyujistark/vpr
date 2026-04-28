import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generate } from '../../src/commands/generate.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function setupRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-generate-story-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
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

describe('generate() — --story agent path', () => {
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
    await saveMeta({
      items: {
        foo: {
          wi: 1,
          wiTitle: 'Foo item',
          wiDescription: null,
          parentWi: null,
          parentWiTitle: null,
          parentWiDescription: null,
          vprs: {
            'foo/bar': { title: 'Bar slice', story: '', output: null },
          },
        },
      },
      hold: [],
      sent: {},
      eventLog: [],
    });
  });

  it('persists the supplied story onto the VPR before regenerating — agent path bypasses the editor', async () => {
    // `cat` echoes the prompt straight back as output, so we can prove the
    // supplied story made it into the prompt that drove the regeneration.
    const result = await generate('foo/bar', {
      story: 'agent-supplied story body',
      generateCmd: 'cat',
    });

    const meta = await loadMeta();
    assert.equal(
      meta.items.foo.vprs['foo/bar'].story,
      'agent-supplied story body',
      'story option must be persisted to meta — agent path sets the story without an editor',
    );
    assert.ok(
      result.output.includes('agent-supplied story body'),
      `regenerated output must reflect the supplied story; got:\n${result.output}`,
    );
  });
});
