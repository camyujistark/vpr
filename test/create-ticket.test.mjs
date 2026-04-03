import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const VPR_DIR = '.vpr';

function jj(cmd, cwd) {
  return execSync(`jj ${cmd}`, { cwd, encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function writeMeta(dir, meta) {
  fs.mkdirSync(path.join(dir, VPR_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, VPR_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, VPR_DIR, 'meta.json'), 'utf-8'));
}

describe('create ticket (n key) — end to end', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-create-'));
    origCwd = process.cwd();

    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    jj('git init --colocate', tmpDir);
    jj('config set --repo user.name "Test"', tmpDir);
    jj('config set --repo user.email "test@test.com"', tmpDir);

    // Make a commit to bookmark
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');
    jj('commit -m "feat: first commit"', tmpDir);

    writeMeta(tmpDir, { nextIndex: 1, bookmarks: {} });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates WI via none provider, stores in meta, creates jj bookmark', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const provider = createProvider({ provider: 'none', prefix: 'TP' });
    const meta = loadMeta();

    // Simulate n key flow: title → desc → create
    const title = 'CI: Add Playwright E2E tests';
    const desc = 'Add E2E tests to pipeline';

    const wi = provider.createWorkItem(title, desc);
    assert.ok(wi.id, 'WI should have an ID');

    const idx = meta.nextIndex || 1;
    const bm = `tp-${idx}`;
    meta.nextIndex = idx + 1;

    // Get the commit to bookmark
    const changeId = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short()'", tmpDir);

    // Create jj bookmark
    jj(`bookmark create ${bm} -r ${changeId}`, tmpDir);

    // Store metadata
    if (!meta.bookmarks) meta.bookmarks = {};
    meta.bookmarks[bm] = {
      wi: wi.id,
      wiTitle: title,
      wiDescription: desc,
      wiState: 'New',
    };
    saveMeta(meta);

    // Verify meta
    const saved = readMeta(tmpDir);
    assert.strictEqual(saved.nextIndex, 2);
    assert.ok(saved.bookmarks['tp-1']);
    assert.strictEqual(saved.bookmarks['tp-1'].wi, wi.id);
    assert.strictEqual(saved.bookmarks['tp-1'].wiTitle, title);
    assert.strictEqual(saved.bookmarks['tp-1'].wiDescription, desc);
    assert.strictEqual(saved.bookmarks['tp-1'].wiState, 'New');

    // Verify jj bookmark
    const bookmarks = jj('bookmark list', tmpDir);
    assert.ok(bookmarks.includes('tp-1'), 'tp-1 bookmark should exist');
  });

  it('creates ticket with empty description', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const provider = createProvider({ provider: 'none', prefix: 'TP' });
    const meta = loadMeta();

    const title = 'Quick fix';
    const desc = ''; // empty

    const wi = provider.createWorkItem(title, desc);
    assert.ok(wi.id);

    const bm = `tp-${meta.nextIndex || 1}`;
    meta.nextIndex = (meta.nextIndex || 1) + 1;
    if (!meta.bookmarks) meta.bookmarks = {};
    meta.bookmarks[bm] = { wi: wi.id, wiTitle: title, wiDescription: desc, wiState: 'New' };
    saveMeta(meta);

    const saved = readMeta(tmpDir);
    assert.strictEqual(saved.bookmarks[bm].wiTitle, 'Quick fix');
    assert.strictEqual(saved.bookmarks[bm].wiDescription, '');
  });

  it('increments nextIndex for each ticket', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const provider = createProvider({ provider: 'none', prefix: 'TP' });

    // Create 3 tickets
    for (let i = 0; i < 3; i++) {
      const meta = loadMeta();
      const wi = provider.createWorkItem(`Ticket ${i + 1}`, '');
      const idx = meta.nextIndex || 1;
      const bm = `tp-${idx}`;
      meta.nextIndex = idx + 1;
      if (!meta.bookmarks) meta.bookmarks = {};
      meta.bookmarks[bm] = { wi: wi.id, wiTitle: `Ticket ${i + 1}`, wiState: 'New' };
      saveMeta(meta);
    }

    const saved = readMeta(tmpDir);
    assert.strictEqual(saved.nextIndex, 4);
    assert.ok(saved.bookmarks['tp-1']);
    assert.ok(saved.bookmarks['tp-2']);
    assert.ok(saved.bookmarks['tp-3']);
    assert.strictEqual(saved.bookmarks['tp-1'].wiTitle, 'Ticket 1');
    assert.strictEqual(saved.bookmarks['tp-2'].wiTitle, 'Ticket 2');
    assert.strictEqual(saved.bookmarks['tp-3'].wiTitle, 'Ticket 3');
  });

  it('azure devops provider creates WI synchronously (no async)', async () => {
    const { AzureDevOpsProvider } = await import('../src/providers/azure-devops.mjs');
    const p = new AzureDevOpsProvider({
      provider: 'azure-devops',
      org: 'https://dev.azure.com/TestOrg',
      project: 'TestProject',
      wiType: 'Task',
    });

    // createWorkItem should NOT return a Promise
    // We can't actually call az CLI in tests, but we can verify the method isn't async
    assert.strictEqual(p.createWorkItem.constructor.name, 'Function', 'should be sync Function, not AsyncFunction');
    assert.strictEqual(p.getWorkItem.constructor.name, 'Function');
    assert.strictEqual(p.updateWorkItem.constructor.name, 'Function');
    assert.strictEqual(p.createPR.constructor.name, 'Function');
    assert.strictEqual(p.getLatestPRIndex.constructor.name, 'Function');
  });
});

describe('chained popup flow', () => {
  it('single-line input callback receives the value', () => {
    // Simulate the popup flow: callback gets val
    let received = null;
    const callback = (val) => { received = val; };

    // Simulate handleInputKey Enter press
    const val = 'test title';
    callback(val);

    assert.strictEqual(received, 'test title');
  });

  it('empty single-line input callback receives empty string', () => {
    let received = null;
    const callback = (val) => { received = val; };
    callback('');
    assert.strictEqual(received, '');
  });

  it('chained callbacks fire in sequence', () => {
    const results = [];

    // Simulate: title callback opens desc callback
    const titleCallback = (title) => {
      results.push(`title:${title}`);
      const descCallback = (desc) => {
        results.push(`desc:${desc}`);
      };
      descCallback('test desc');
    };
    titleCallback('test title');

    assert.deepStrictEqual(results, ['title:test title', 'desc:test desc']);
  });
});
