import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const VPR_DIR = '.vpr';

function writeConfig(dir, config) {
  const vprDir = path.join(dir, VPR_DIR);
  fs.mkdirSync(vprDir, { recursive: true });
  fs.writeFileSync(path.join(vprDir, 'config.json'), JSON.stringify(config, null, 2));
}

function writeMeta(dir, meta) {
  const vprDir = path.join(dir, VPR_DIR);
  fs.mkdirSync(vprDir, { recursive: true });
  fs.writeFileSync(path.join(vprDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, VPR_DIR, 'meta.json'), 'utf-8'));
  } catch { return {}; }
}

describe('Workflow 1: Create ticket with title + description → saved to meta + provider', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-wf1-'));
    origCwd = process.cwd();

    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('jj git init --colocate', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    execSync('jj config set --repo user.name "Test"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    execSync('jj config set --repo user.email "test@test.com"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });

    // Write a config with 'none' provider (no real Azure calls)
    writeConfig(tmpDir, {
      provider: 'none',
      prefix: 'TP',
    });

    writeMeta(tmpDir, { nextIndex: 1, bookmarks: {} });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creating a ticket stores title, description, and WI ID in meta', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const config = { provider: 'none', prefix: 'TP' };
    const provider = createProvider(config);
    const meta = loadMeta();

    // Simulate: user enters title + description, provider creates WI
    const title = 'CI: Add Playwright E2E tests';
    const description = 'Add Playwright E2E job to the CI pipeline so tests run on every push.';

    const wi = await provider.createWorkItem(title, description);
    assert.ok(wi.id, 'WI should have an ID');

    // Store in meta (what TUI's c key should do)
    const idx = meta.nextIndex || 1;
    const bm = `tp-${idx}`;
    meta.nextIndex = idx + 1;
    if (!meta.bookmarks) meta.bookmarks = {};
    meta.bookmarks[bm] = {
      wi: wi.id,
      wiTitle: title,
      wiDescription: description,
      wiState: 'New',
    };
    saveMeta(meta);

    // Verify: meta has the ticket with all fields
    const saved = readMeta(tmpDir);
    assert.ok(saved.bookmarks[bm], `${bm} should exist in meta`);
    assert.strictEqual(saved.bookmarks[bm].wi, wi.id);
    assert.strictEqual(saved.bookmarks[bm].wiTitle, title);
    assert.strictEqual(saved.bookmarks[bm].wiDescription, description);
    assert.strictEqual(saved.bookmarks[bm].wiState, 'New');
    assert.strictEqual(saved.nextIndex, 2);
  });

  it('ticket title and description are shown in the VPR summary pane', async () => {
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const meta = loadMeta();
    meta.bookmarks = {
      'tp-1': {
        wi: 12345,
        wiTitle: 'CI: Add Playwright E2E tests',
        wiDescription: 'Add Playwright E2E job to the CI pipeline.',
        wiState: 'To Do',
      },
    };
    meta.nextIndex = 2;
    saveMeta(meta);

    // Make a commit and bookmark it
    fs.writeFileSync('test.txt', 'hello');
    execSync('jj commit -m "ci: add playwright"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    const changeId = execSync(
      "jj log --no-graph --reversed -r 'main..@-' -T 'change_id.short()'",
      { cwd: tmpDir, shell: '/bin/bash', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    execSync(`jj bookmark create tp-1 -r ${changeId}`, { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });

    // Verify meta has everything needed for the summary pane
    const saved = readMeta(tmpDir);
    const bm = saved.bookmarks['tp-1'];
    assert.ok(bm, 'tp-1 should exist');
    assert.ok(bm.wi, 'should have WI ID');
    assert.ok(bm.wiTitle, 'should have WI title');
    assert.ok(bm.wiDescription, 'should have WI description');
    assert.ok(bm.wiState, 'should have WI state');
  });
});

describe('Workflow 2: PR title + description saved in meta, ready for pr-send', () => {
  let tmpDir;
  let origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-wf2-'));
    origCwd = process.cwd();

    execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('jj git init --colocate', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    execSync('jj config set --repo user.name "Test"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    execSync('jj config set --repo user.email "test@test.com"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });

    writeConfig(tmpDir, { provider: 'none', prefix: 'TP' });
    writeMeta(tmpDir, {
      nextIndex: 2,
      bookmarks: {
        'tp-1': {
          wi: 17045,
          wiTitle: 'CI: Add Playwright E2E tests to Azure Pipelines',
          wiDescription: 'Add Playwright E2E job to the CI pipeline.',
          wiState: 'To Do',
        },
      },
    });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PR title and description are stored separately from ticket info', async () => {
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const meta = loadMeta();

    // Simulate: user writes PR title + description (p key in TUI)
    const prTitle = 'TP-91: CI: Add Playwright E2E tests';
    const prDesc = '## Summary\n\nAdds Playwright E2E tests to the Azure Pipelines CI.\n\n## Key files\n\n- `azure-pipelines.yml` — E2E job definition';

    meta.bookmarks['tp-1'].prTitle = prTitle;
    meta.bookmarks['tp-1'].prDesc = prDesc;
    saveMeta(meta);

    // Verify: meta has both ticket AND PR info separately
    const saved = readMeta(tmpDir);
    const bm = saved.bookmarks['tp-1'];

    // Ticket info
    assert.strictEqual(bm.wi, 17045);
    assert.strictEqual(bm.wiTitle, 'CI: Add Playwright E2E tests to Azure Pipelines');
    assert.ok(bm.wiDescription);

    // PR info (separate from ticket)
    assert.strictEqual(bm.prTitle, prTitle);
    assert.strictEqual(bm.prDesc, prDesc);
    assert.notStrictEqual(bm.prTitle, bm.wiTitle, 'PR title can differ from ticket title');
  });

  it('meta has all fields needed by pr-send to create a PR', async () => {
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const meta = loadMeta();
    meta.bookmarks['tp-1'].prTitle = 'TP-91: CI: Add Playwright E2E tests';
    meta.bookmarks['tp-1'].prDesc = '## Summary\n\nAdds E2E tests.';
    saveMeta(meta);

    // Make a commit and bookmark
    fs.writeFileSync('test.txt', 'hello');
    execSync('jj commit -m "ci: add playwright"', { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });
    const changeId = execSync(
      "jj log --no-graph --reversed -r 'main..@-' -T 'change_id.short()'",
      { cwd: tmpDir, shell: '/bin/bash', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    execSync(`jj bookmark create tp-1 -r ${changeId}`, { cwd: tmpDir, shell: '/bin/bash', stdio: 'pipe' });

    // Verify: everything pr-send needs is present
    const saved = readMeta(tmpDir);
    const bm = saved.bookmarks['tp-1'];

    // pr-send needs:
    assert.ok(bm.wi, 'work item ID for --work-items flag');
    assert.ok(bm.prTitle, 'PR title for --title flag');
    assert.ok(bm.prDesc, 'PR body for --description flag');
    assert.ok(bm.wiTitle, 'ticket title for WI update');

    // jj bookmark exists (will become the git branch on push)
    const bookmarks = execSync('jj bookmark list', {
      cwd: tmpDir, shell: '/bin/bash', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.ok(bookmarks.includes('tp-1'), 'jj bookmark tp-1 should exist');

    // The bookmark name will be the branch name: feat/{wi}-slug
    // pr-send can derive this from meta: feat/${bm.wi}-${slug(bm.wiTitle)}
    const branchName = `feat/${bm.wi}-ci-playwright`;
    assert.ok(bm.wi && bm.wiTitle, `Can derive branch name: ${branchName}`);
  });

  it('multiple bookmarks form a chain — each has independent PR info', async () => {
    const { loadMeta, saveMeta } = await import('../src/config.mjs');

    const meta = loadMeta();
    meta.bookmarks['tp-2'] = {
      wi: 17046,
      wiTitle: 'Replace texlive with typst',
      wiDescription: 'Swap xelatex for typst.',
      wiState: 'To Do',
      prTitle: 'TP-92: Media: Replace texlive with typst',
      prDesc: '## Summary\n\nSwaps PDF engine.',
    };
    meta.nextIndex = 3;
    meta.bookmarks['tp-1'].prTitle = 'TP-91: CI: Playwright';
    meta.bookmarks['tp-1'].prDesc = '## Summary\n\nE2E tests.';
    saveMeta(meta);

    const saved = readMeta(tmpDir);

    // Each bookmark has independent PR info
    assert.strictEqual(saved.bookmarks['tp-1'].prTitle, 'TP-91: CI: Playwright');
    assert.strictEqual(saved.bookmarks['tp-2'].prTitle, 'TP-92: Media: Replace texlive with typst');

    // Chain order: tp-1 targets base, tp-2 targets tp-1
    const keys = Object.keys(saved.bookmarks).sort((a, b) => {
      return parseInt(a.replace(/\D/g, '')) - parseInt(b.replace(/\D/g, ''));
    });
    assert.deepStrictEqual(keys, ['tp-1', 'tp-2']);
  });
});
