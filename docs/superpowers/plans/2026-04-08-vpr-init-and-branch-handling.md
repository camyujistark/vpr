# VPR Init + Branch Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vpr init` to bootstrap new projects, and fix branch handling so VPR stays on the current working branch instead of defaulting to main.

**Architecture:** Two independent changes. `vpr init` is a new command that sets up jj + .vpr/ + exclusions in one shot. Branch handling is a fix to `getBase()` and a new `getBaseBranch()` function that derives the target branch from the jj graph, replacing hardcoded `'main'` fallbacks.

**Tech Stack:** Node.js ESM, jj CLI, node:test for testing

**Spec:** `docs/superpowers/specs/2026-04-08-vpr-init-and-branch-handling-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/commands/init.mjs` | Rewrite (currently empty) | Bootstrap jj, .vpr/, exclusions |
| `src/core/jj.mjs` | Modify | Add `getBaseBranch()`, fix already applied to `getBase()` |
| `src/providers/base.mjs` | Modify | Update `getChainTop()` default |
| `src/providers/azure-devops.mjs` | Modify | Update `getChainTop()` fallback |
| `src/commands/send.mjs` | Modify | Update targetBranch fallback |
| `bin/vpr.mjs` | Modify | Pass flags to init |
| `test/commands/init.test.mjs` | Create | Tests for init command |
| `test/core/jj.test.mjs` | Modify | Tests for getBaseBranch() |
| `test/commands/send.test.mjs` | Modify | Test targetBranch uses base branch |

---

### Task 1: `getBaseBranch()` — derive target branch from jj graph

**Files:**
- Modify: `src/core/jj.mjs:64-90`
- Modify: `test/core/jj.test.mjs`

- [ ] **Step 1: Write the failing test for getBaseBranch()**

Add to `test/core/jj.test.mjs` after the existing `getBase()` describe block:

```javascript
describe('getBaseBranch()', () => {
  it('returns null in a repo with no remote bookmarks', () => {
    const result = getBaseBranch();
    assert.strictEqual(result, null);
  });
});
```

Update the import at line 11 to include `getBaseBranch`:

```javascript
import { jj, jjSafe, hasJj, getBase, getBaseBranch, getConflicts, getDiff, getFiles } from '../../src/core/jj.mjs';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/core/jj.test.mjs`
Expected: FAIL — `getBaseBranch` is not exported from jj.mjs

- [ ] **Step 3: Implement getBaseBranch()**

Add to `src/core/jj.mjs` after the `getBase()` function (after line 90):

```javascript
/**
 * Return the bookmark name of the nearest ancestor commit with a remote bookmark.
 * Strips @origin suffix. Returns null if nothing found.
 * @returns {string|null}
 */
export function getBaseBranch() {
  const raw = jjSafe(
    'log -r "ancestors(@) & remote_bookmarks()" --no-graph --template "bookmarks" -n 1'
  );
  if (!raw) return null;

  // bookmarks template may return space-separated list like "main main@origin"
  // Find the first one with @origin suffix and strip it, or use the first local one
  const parts = raw.split(/\s+/).filter(Boolean);
  const remote = parts.find(b => b.includes('@'));
  if (remote) return remote.replace(/@.*$/, '');
  return parts[0] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/core/jj.test.mjs`
Expected: PASS — all existing tests plus the new one

- [ ] **Step 5: Commit**

```bash
cd /home/cam/Documents/sites/vpr && git add src/core/jj.mjs test/core/jj.test.mjs && git commit -m "feat: add getBaseBranch() to derive target branch from jj graph"
```

---

### Task 2: Update providers and send to use `getBaseBranch()`

**Files:**
- Modify: `src/providers/base.mjs:37-39`
- Modify: `src/providers/azure-devops.mjs:86-93`
- Modify: `src/commands/send.mjs:103`

- [ ] **Step 1: Update base provider getChainTop()**

In `src/providers/base.mjs`, replace:

```javascript
  getChainTop() {
    return 'main';
  }
```

With:

```javascript
  getChainTop() {
    try {
      const { getBaseBranch } = await import('../core/jj.mjs');
      return getBaseBranch() ?? 'main';
    } catch {
      return 'main';
    }
  }
```

Wait — `base.mjs` isn't async. Use a synchronous import instead. Since the module is ESM and `getBaseBranch` is a synchronous function, do a top-level import:

Add at the top of `src/providers/base.mjs`:

```javascript
import { getBaseBranch } from '../core/jj.mjs';
```

Replace `getChainTop()`:

```javascript
  getChainTop() {
    return getBaseBranch() ?? 'main';
  }
```

- [ ] **Step 2: Update azure-devops provider getChainTop() fallback**

In `src/providers/azure-devops.mjs`, replace the `getChainTop()` method:

```javascript
  getChainTop() {
    try {
      const prs = this._listActivePRs(1);
      if (prs.length === 0) return getBaseBranch() ?? 'main';
      return prs[0].sourceRefName?.replace('refs/heads/', '') || getBaseBranch() || 'main';
    } catch { return getBaseBranch() ?? 'main'; }
  }
```

Add import at top of `src/providers/azure-devops.mjs`:

```javascript
import { getBaseBranch } from '../core/jj.mjs';
```

- [ ] **Step 3: Update send.mjs targetBranch fallback**

In `src/commands/send.mjs` line 103, replace:

```javascript
  targetBranch = targetBranch ?? 'main';
```

With:

```javascript
  const { getBaseBranch } = await import('../core/jj.mjs');
  targetBranch = targetBranch ?? getBaseBranch() ?? 'main';
```

- [ ] **Step 4: Run all tests**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/**/*.test.mjs`
Expected: 144+ tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/cam/Documents/sites/vpr && git add src/providers/base.mjs src/providers/azure-devops.mjs src/commands/send.mjs && git commit -m "feat: use getBaseBranch() instead of hardcoded main fallback"
```

---

### Task 3: Implement `vpr init`

**Files:**
- Rewrite: `src/commands/init.mjs`
- Create: `test/commands/init.test.mjs`
- Modify: `bin/vpr.mjs:111-115`

- [ ] **Step 1: Write failing tests for init**

Create `test/commands/init.test.mjs`:

```javascript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init } from '../../src/commands/init.mjs';

let tmpDir;
let originalCwd;

function sh(cmd, cwd = tmpDir) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function setupBareGitRepo() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-init-test-'));
  sh('git init', tmpDir);
  sh('git config user.email "test@example.com"', tmpDir);
  sh('git config user.name "Test"', tmpDir);
  originalCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(originalCwd);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('vpr init', () => {
  describe('fresh git repo with no flags', () => {
    before(() => setupBareGitRepo());
    after(() => teardown());

    it('creates .jj directory', async () => {
      await init({});
      assert.ok(existsSync(join(tmpDir, '.jj')), '.jj should exist');
    });

    it('creates .vpr/config.json with none provider', () => {
      const config = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'config.json'), 'utf-8'));
      assert.strictEqual(config.provider, 'none');
    });

    it('creates .vpr/meta.json with empty structure', () => {
      const meta = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'meta.json'), 'utf-8'));
      assert.deepStrictEqual(meta, { items: {}, hold: [], sent: {}, eventLog: [] });
    });

    it('adds .vpr/ and .jj/ to .git/info/exclude', () => {
      const exclude = readFileSync(join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      assert.ok(exclude.includes('.vpr/'), 'exclude should contain .vpr/');
      assert.ok(exclude.includes('.jj/'), 'exclude should contain .jj/');
    });

    it('configures jj snapshot.auto-track to exclude .vpr/', () => {
      const output = sh('jj config list --repo snapshot.auto-track');
      assert.ok(output.includes('.vpr'), 'auto-track should exclude .vpr');
    });
  });

  describe('with azure-devops provider flags', () => {
    before(() => setupBareGitRepo());
    after(() => teardown());

    it('writes provider config from flags', async () => {
      await init({
        provider: 'azure-devops',
        org: 'https://dev.azure.com/myorg',
        project: 'My Project',
        repo: 'my-repo',
        wiType: 'Bug',
      });
      const config = JSON.parse(readFileSync(join(tmpDir, '.vpr', 'config.json'), 'utf-8'));
      assert.strictEqual(config.provider, 'azure-devops');
      assert.strictEqual(config.org, 'https://dev.azure.com/myorg');
      assert.strictEqual(config.project, 'My Project');
      assert.strictEqual(config.repo, 'my-repo');
      assert.strictEqual(config.wiType, 'Bug');
    });
  });

  describe('idempotent — re-running on already initialized repo', () => {
    before(() => {
      setupBareGitRepo();
      sh('jj git init --colocate', tmpDir);
    });
    after(() => teardown());

    it('does not fail when .jj already exists', async () => {
      await assert.doesNotReject(() => init({}));
    });

    it('creates .vpr/ even when jj already exists', () => {
      assert.ok(existsSync(join(tmpDir, '.vpr', 'config.json')));
    });

    it('does not duplicate exclude entries on re-run', async () => {
      await init({});
      const exclude = readFileSync(join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
      const vprMatches = exclude.match(/^\.vpr\/$/gm);
      assert.strictEqual(vprMatches?.length, 1, 'should have exactly one .vpr/ entry');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/commands/init.test.mjs`
Expected: FAIL — init is not a named export / does nothing

- [ ] **Step 3: Implement init**

Write `src/commands/init.mjs`:

```javascript
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] };

/**
 * Derive the repo name from git remote or directory name.
 * @returns {string}
 */
function detectRepoName() {
  try {
    const remote = execSync('git remote get-url origin', EXEC_OPTS).trim();
    // Extract repo name from URL: git@host:org/repo.git or https://host/org/repo
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch { /* no remote */ }
  return basename(process.cwd());
}

/**
 * Initialize VPR in the current directory.
 *
 * Idempotent — skips steps where artifacts already exist.
 *
 * @param {{
 *   provider?: string,
 *   org?: string,
 *   project?: string,
 *   repo?: string,
 *   wiType?: string
 * }} opts
 * @returns {Promise<{ steps: string[] }>}
 */
export async function init(opts = {}) {
  const cwd = process.cwd();
  const steps = [];

  // 1. jj colocate
  const jjDir = join(cwd, '.jj');
  if (!existsSync(jjDir)) {
    execSync('jj git init --colocate', { ...EXEC_OPTS, cwd });
    steps.push('Initialized jj (colocated)');
  } else {
    steps.push('jj already initialized — skipped');
  }

  // 2. .vpr/config.json
  const vprDir = join(cwd, '.vpr');
  const configPath = join(vprDir, 'config.json');
  if (!existsSync(configPath)) {
    if (!existsSync(vprDir)) mkdirSync(vprDir, { recursive: true });
    const config = {
      provider: opts.provider || 'none',
    };
    if (opts.org) config.org = opts.org;
    if (opts.project) config.project = opts.project;
    config.repo = opts.repo || detectRepoName();
    if (opts.wiType) config.wiType = opts.wiType;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    steps.push(`Created .vpr/config.json (provider: ${config.provider})`);
  } else {
    steps.push('.vpr/config.json exists — skipped');
  }

  // 3. .vpr/meta.json
  const metaPath = join(vprDir, 'meta.json');
  if (!existsSync(metaPath)) {
    if (!existsSync(vprDir)) mkdirSync(vprDir, { recursive: true });
    const meta = { items: {}, hold: [], sent: {}, eventLog: [] };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    steps.push('Created .vpr/meta.json');
  } else {
    steps.push('.vpr/meta.json exists — skipped');
  }

  // 4. .git/info/exclude
  const excludePath = join(cwd, '.git', 'info', 'exclude');
  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, 'utf-8');
    const toAdd = [];
    if (!content.split('\n').includes('.vpr/')) toAdd.push('.vpr/');
    if (!content.split('\n').includes('.jj/')) toAdd.push('.jj/');
    if (toAdd.length > 0) {
      const suffix = content.endsWith('\n') ? '' : '\n';
      appendFileSync(excludePath, suffix + toAdd.join('\n') + '\n', 'utf-8');
      steps.push(`Added ${toAdd.join(', ')} to .git/info/exclude`);
    } else {
      steps.push('.git/info/exclude already configured — skipped');
    }
  }

  // 5. jj snapshot.auto-track exclude .vpr/
  try {
    const current = execSync('jj config list --repo snapshot.auto-track', EXEC_OPTS).trim();
    if (!current.includes('.vpr')) {
      execSync(
        'jj config set --repo snapshot.auto-track \'glob:"**" ~ glob:".vpr/**"\'',
        { ...EXEC_OPTS, cwd }
      );
      steps.push('Configured jj to exclude .vpr/ from tracking');
    } else {
      steps.push('jj auto-track already excludes .vpr/ — skipped');
    }
  } catch {
    // jj config may not be set yet — set it fresh
    execSync(
      'jj config set --repo snapshot.auto-track \'glob:"**" ~ glob:".vpr/**"\'',
      { ...EXEC_OPTS, cwd }
    );
    steps.push('Configured jj to exclude .vpr/ from tracking');
  }

  return { steps };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/commands/init.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/cam/Documents/sites/vpr && git add src/commands/init.mjs test/commands/init.test.mjs && git commit -m "feat: implement vpr init — bootstrap jj + .vpr/ + exclusions"
```

---

### Task 4: Wire CLI flags to init

**Files:**
- Modify: `bin/vpr.mjs:107-115`

- [ ] **Step 1: Update CLI dispatch to pass flags**

In `bin/vpr.mjs`, replace the init case (lines 111-114):

```javascript
    case 'init': {
      const { init } = await import('../src/commands/init.mjs');
      await init();
      break;
    }
```

With:

```javascript
    case 'init': {
      const flags = parseFlags(args);
      const { init } = await import('../src/commands/init.mjs');
      const result = await init(flags);
      for (const step of result.steps) {
        console.log(`  ${step}`);
      }
      console.log('\nVPR initialized.');
      break;
    }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/**/*.test.mjs`
Expected: All tests PASS (144+ existing + new init tests)

- [ ] **Step 3: Manual smoke test**

```bash
cd $(mktemp -d) && git init && vpr init --provider azure-devops --org https://dev.azure.com/test --project "Test" --repo test-repo
```

Expected output:
```
  Initialized jj (colocated)
  Created .vpr/config.json (provider: azure-devops)
  Created .vpr/meta.json
  Added .vpr/, .jj/ to .git/info/exclude
  Configured jj to exclude .vpr/ from tracking

VPR initialized.
```

- [ ] **Step 4: Commit**

```bash
cd /home/cam/Documents/sites/vpr && git add bin/vpr.mjs && git commit -m "feat: wire vpr init CLI flags"
```

---

### Task 5: Update HELP text

**Files:**
- Modify: `bin/vpr.mjs:67-98` (HELP constant)

- [ ] **Step 1: Add init to help text**

In `bin/vpr.mjs`, add the init section to the HELP constant, before the "Items:" section:

```javascript
  Setup:
    vpr init                            Initialize VPR in current repo
    vpr init --provider azure-devops    With provider config
      --org <url> --project <name>
      --repo <name> --wiType <type>
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/cam/Documents/sites/vpr && node --test test/**/*.test.mjs`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/cam/Documents/sites/vpr && git add bin/vpr.mjs && git commit -m "docs: add vpr init to help text"
```
