import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planSlices } from '../../src/commands/plan-slices.mjs';
import { loadMeta, saveMeta } from '../../src/core/meta.mjs';

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** Fresh plain-git repo (git is the v2 default backend) with one described commit. */
function setupRepo() {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-plan-test-'));
  sh('git init -b main', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  sh('git add -A', tmpDir);
  sh('git commit -m "base"', tmpDir);
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  writeFileSync(join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ vcs: 'git', provider: 'none', repo: 'x' }));
  process.chdir(tmpDir);
}

function teardownRepo() {
  if (originalCwd) process.chdir(originalCwd);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

async function seedItem() {
  await saveMeta({
    items: { 'my-feature': { wi: 99, wiTitle: 'My Feature', vprs: {} } },
    hold: [],
    sent: {},
    eventLog: [],
  });
}

describe('vpr plan slices — pointer-based materialization', () => {
  beforeEach(async () => {
    setupRepo();
    await seedItem();
  });
  afterEach(teardownRepo);

  it('materializes slices as branch pointers WITHOUT creating any commits', async () => {
    const before = Number(sh('git rev-list --count HEAD'));

    await planSlices(['Scaffold', 'Audio components', 'Upload flow'], { item: 'my-feature' });

    const after = Number(sh('git rev-list --count HEAD'));
    assert.equal(after, before, 'planning must not add commits — slices are pointers, not scaffolds');
  });

  it('creates one local branch per slice, all pointing at the chain base', async () => {
    await planSlices(['Scaffold', 'Audio components'], { item: 'my-feature' });

    const head = sh('git rev-parse HEAD');
    const scaffold = sh('git rev-parse my-feature/scaffold');
    const audio = sh('git rev-parse my-feature/audio-components');
    assert.equal(scaffold, head);
    assert.equal(audio, head);
  });

  it('registers every slice in meta with an empty story/output', async () => {
    const { slices } = await planSlices(['Scaffold', 'Audio components'], { item: 'my-feature' });
    assert.deepEqual(slices.map(s => s.status), ['planned', 'planned']);

    const meta = await loadMeta();
    const vprs = meta.items['my-feature'].vprs;
    assert.deepEqual(Object.keys(vprs), ['my-feature/scaffold', 'my-feature/audio-components']);
    assert.equal(vprs['my-feature/scaffold'].title, 'Scaffold');
    assert.equal(vprs['my-feature/scaffold'].story, '');
    assert.equal(vprs['my-feature/scaffold'].output, null);
  });

  it('is idempotent — re-planning an existing slice reports exists and adds no commit', async () => {
    await planSlices(['Scaffold'], { item: 'my-feature' });
    const before = Number(sh('git rev-list --count HEAD'));

    const { slices } = await planSlices(['Scaffold', 'New slice'], { item: 'my-feature' });
    assert.equal(slices.find(s => s.bookmark === 'my-feature/scaffold').status, 'exists');
    assert.equal(slices.find(s => s.bookmark === 'my-feature/new-slice').status, 'planned');

    const after = Number(sh('git rev-list --count HEAD'));
    assert.equal(after, before);
  });

  it('infers the single item when --item is omitted', async () => {
    const { item } = await planSlices(['Scaffold']);
    assert.equal(item, 'my-feature');
  });
});
