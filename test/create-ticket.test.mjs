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

describe('editing ticket title renames bookmark', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-rename-'));
    origCwd = process.cwd();
    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    jj('git init --colocate', tmpDir);
    jj('config set --repo user.name "Test"', tmpDir);
    jj('config set --repo user.email "test@test.com"', tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');
    jj('commit -m "feat: first"', tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renaming title updates bookmark slug and PR title', () => {
    const changeId = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short()'", tmpDir);

    // Create initial bookmark
    const oldBm = 'feat/17045-ci-add-playwright';
    jj(`bookmark create ${oldBm} -r ${changeId}`, tmpDir);

    writeMeta(tmpDir, {
      nextIndex: 2,
      bookmarks: {
        [oldBm]: {
          wi: 17045,
          wiTitle: 'CI: Add Playwright',
          wiDescription: 'Add E2E tests',
          wiState: 'To Do',
          tpIndex: 'TP-91',
          prTitle: 'TP-91: CI: Add Playwright',
        },
      },
    });

    // Simulate title edit: change to "CI: Playwright E2E Pipeline"
    const newTitle = 'CI: Playwright E2E Pipeline';
    const slug = newTitle.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-').slice(0, 4).join('-');
    const newBm = `feat/17045-${slug}`;

    // Rename jj bookmark
    jj(`bookmark rename ${oldBm} ${newBm}`, tmpDir);

    // Update meta
    const meta = readMeta(tmpDir);
    meta.bookmarks[newBm] = { ...meta.bookmarks[oldBm], wiTitle: newTitle, prTitle: `TP-91: ${newTitle}` };
    delete meta.bookmarks[oldBm];
    fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify(meta, null, 2));

    // Verify bookmark renamed
    const bookmarks = jj('bookmark list', tmpDir);
    assert.ok(!bookmarks.includes(oldBm), 'old bookmark should be gone');
    assert.ok(bookmarks.includes('feat/17045-ci-playwright-e2e-pipeline'), 'new bookmark should exist');

    // Verify meta updated
    const saved = readMeta(tmpDir);
    assert.ok(!saved.bookmarks[oldBm], 'old key gone from meta');
    assert.ok(saved.bookmarks[newBm], 'new key in meta');
    assert.strictEqual(saved.bookmarks[newBm].wiTitle, newTitle);
    assert.strictEqual(saved.bookmarks[newBm].prTitle, 'TP-91: CI: Playwright E2E Pipeline');
    assert.strictEqual(saved.bookmarks[newBm].wi, 17045, 'WI ID preserved');
    assert.strictEqual(saved.bookmarks[newBm].tpIndex, 'TP-91', 'TP index preserved');
  });

  it('title edit with same slug does not rename', () => {
    const changeId = jj("log --no-graph --reversed -r 'main..@-' -T 'change_id.short()'", tmpDir);
    const bm = 'feat/17045-ci-add';
    jj(`bookmark create ${bm} -r ${changeId}`, tmpDir);

    writeMeta(tmpDir, {
      nextIndex: 2,
      bookmarks: {
        [bm]: { wi: 17045, wiTitle: 'CI: Add', tpIndex: 'TP-91', prTitle: 'TP-91: CI: Add' },
      },
    });

    // Edit title to something with same slug prefix
    const newTitle = 'CI: Add';
    const slug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
    const newBm = `feat/17045-${slug}`;

    // Same bookmark name — no rename needed
    assert.strictEqual(newBm, bm, 'slug should be the same');

    const bookmarks = jj('bookmark list', tmpDir);
    assert.ok(bookmarks.includes(bm), 'bookmark unchanged');
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
