# VPR v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite VPR as a thin metadata + push automation layer on top of jj. Parallel items, linear VPRs within, linearize at push time only.

**Architecture:** Fresh rewrite on `v2` branch. Core modules (jj, meta, state) → CLI commands → TUI. Providers carry over from v1. Each task is a commit with tests.

**Tech Stack:** Node.js 20+, jj (jujutsu), node:test runner, no external dependencies.

**Repo:** `/home/cam/Documents/sites/vpr`

**Branch:** Create `v2` branch from `main` before starting.

**Test command:** `node --test test/*.test.mjs`

**Existing code to carry over unchanged:** `src/providers/` (252 lines — azure-devops, github, none, base, index)

---

### Task 1: Create v2 branch and scaffold directory structure

**Files:**
- Create: `src/core/jj.mjs`, `src/core/meta.mjs`, `src/core/state.mjs`
- Create: `src/commands/` (empty files)
- Create: `src/tui/` (empty files)
- Create: `test/core/`, `test/commands/`

- [ ] **Step 1: Create v2 branch**

```bash
cd /home/cam/Documents/sites/vpr
git checkout -b v2
```

- [ ] **Step 2: Remove v1 src files, keep providers**

```bash
rm src/tui.mjs src/commands/cli.mjs src/commands/init.mjs src/config.mjs src/entries.mjs src/git.mjs
```

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p src/core src/commands src/tui/modes test/core test/commands
touch src/core/jj.mjs src/core/meta.mjs src/core/state.mjs
touch src/commands/ticket.mjs src/commands/add.mjs src/commands/edit.mjs
touch src/commands/list.mjs src/commands/status.mjs src/commands/log.mjs
touch src/commands/generate.mjs src/commands/send.mjs src/commands/hold.mjs
touch src/commands/remove.mjs src/commands/init.mjs
touch src/tui/tui.mjs src/tui/render.mjs src/tui/tree.mjs src/tui/editor.mjs
touch src/tui/modes/normal.mjs src/tui/modes/interactive.mjs src/tui/modes/split.mjs
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold v2 directory structure"
```

---

### Task 2: core/jj.mjs — jj subprocess helpers

**Files:**
- Create: `src/core/jj.mjs`
- Create: `test/core/jj.test.mjs`

Carry over the proven helpers from v1's `git.mjs` but cleaned up. No `git()` helpers — v2 is jj-only.

- [ ] **Step 1: Write tests**

```js
// test/core/jj.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-jj-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.name Test', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('core/jj', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('jj() executes a jj command and returns output', async () => {
    const { jj } = await import('../../src/core/jj.mjs');
    const result = jj('log --no-graph -r @ -T "change_id.short()"');
    assert.ok(result.length > 0);
  });

  it('jjSafe() returns null on failure', async () => {
    const { jjSafe } = await import('../../src/core/jj.mjs');
    const result = jjSafe('log -r nonexistent');
    assert.strictEqual(result, null);
  });

  it('hasJj() returns true in a jj repo', async () => {
    const { hasJj } = await import('../../src/core/jj.mjs');
    assert.strictEqual(hasJj(), true);
  });

  it('getBase() returns a commit ID', async () => {
    const { getBase } = await import('../../src/core/jj.mjs');
    const base = getBase();
    assert.ok(base);
  });

  it('getConflicts() returns empty set when no conflicts', async () => {
    const { getConflicts } = await import('../../src/core/jj.mjs');
    const conflicts = getConflicts();
    assert.strictEqual(conflicts.size, 0);
  });

  it('getDiff() returns diff string for a commit', async () => {
    const { jj, getDiff } = await import('../../src/core/jj.mjs');
    fs.writeFileSync('test.txt', 'hello');
    jj('commit -m "add test"');
    const diff = getDiff('@-');
    assert.ok(diff.includes('test.txt'));
  });

  it('getFiles() returns file list for a commit', async () => {
    const { jj, getFiles } = await import('../../src/core/jj.mjs');
    fs.writeFileSync('test.txt', 'hello');
    jj('commit -m "add test"');
    const files = getFiles('@-');
    assert.ok(files.some(f => f.includes('test.txt')));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/core/jj.test.mjs
```
Expected: FAIL — module not implemented

- [ ] **Step 3: Implement core/jj.mjs**

```js
// src/core/jj.mjs
import { execSync } from 'child_process';

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

let _hasJj = null;
export function hasJj() {
  if (_hasJj !== null) return _hasJj;
  try { exec('jj root'); _hasJj = true; } catch { _hasJj = false; }
  return _hasJj;
}

export function jj(cmd) {
  return exec(`jj ${cmd}`);
}

export function jjSafe(cmd) {
  try { return jj(cmd); } catch { return null; }
}

export function getBase() {
  // Find nearest ancestor with a remote bookmark, using commit_id to avoid divergent change IDs
  const nearestRemote = jjSafe(`log --no-graph -r 'ancestors(@) & remote_bookmarks()' -T 'commit_id.short() ++ "\\n"' --limit 1`);
  if (nearestRemote?.trim()) return nearestRemote.trim();
  for (const ref of ['main@origin', 'master@origin']) {
    if (jjSafe(`log --no-graph -r '${ref}' -T 'commit_id.short()'`)) return ref;
  }
  return 'trunk()';
}

export function getConflicts() {
  const raw = jjSafe(`log --no-graph -r 'conflicts()' -T 'change_id.short() ++ "\\n"'`) || '';
  return new Set(raw.split('\n').filter(Boolean));
}

export function getDiff(changeId) {
  try { return jj(`diff --git -r ${changeId}`); } catch { return ''; }
}

export function getFiles(changeId) {
  try { return jj(`diff --summary -r ${changeId}`).split('\n').filter(Boolean); } catch { return []; }
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/core/jj.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/jj.mjs test/core/jj.test.mjs
git commit -m "feat(core): jj subprocess helpers with tests"
```

---

### Task 3: core/meta.mjs — meta.json read/write

**Files:**
- Create: `src/core/meta.mjs`
- Create: `test/core/meta.test.mjs`

- [ ] **Step 1: Write tests**

```js
// test/core/meta.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-meta-'));
  origCwd = process.cwd();
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('core/meta', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('loadMeta returns empty structure when no file', async () => {
    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.deepStrictEqual(meta.items, {});
    assert.deepStrictEqual(meta.hold, []);
    assert.deepStrictEqual(meta.sent, {});
    assert.ok(Array.isArray(meta.eventLog));
  });

  it('saveMeta writes and loadMeta reads', async () => {
    const { loadMeta, saveMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    meta.items['test'] = { wi: 123, wiTitle: 'Test', vprs: {} };
    saveMeta(meta);
    const loaded = loadMeta();
    assert.strictEqual(loaded.items['test'].wi, 123);
  });

  it('appendEvent adds to eventLog', async () => {
    const { loadMeta, saveMeta, appendEvent } = await import('../../src/core/meta.mjs');
    saveMeta(loadMeta());
    appendEvent('claude', 'add', { item: 'test', vpr: 'scaffold' });
    const meta = loadMeta();
    assert.strictEqual(meta.eventLog.length, 1);
    assert.strictEqual(meta.eventLog[0].actor, 'claude');
    assert.strictEqual(meta.eventLog[0].action, 'add');
  });

  it('appendEvent caps at 100 entries', async () => {
    const { loadMeta, saveMeta, appendEvent } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    meta.eventLog = Array.from({ length: 100 }, (_, i) => ({ ts: '', actor: 'test', action: `a${i}` }));
    saveMeta(meta);
    appendEvent('test', 'overflow', {});
    const loaded = loadMeta();
    assert.strictEqual(loaded.eventLog.length, 100);
    assert.strictEqual(loaded.eventLog[99].action, 'overflow');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/core/meta.test.mjs
```

- [ ] **Step 3: Implement core/meta.mjs**

```js
// src/core/meta.mjs
import fs from 'fs';
import path from 'path';

const META_DIR = '.vpr';
const META_FILE = path.join(META_DIR, 'meta.json');

function metaPath() {
  return path.resolve(META_FILE);
}

const EMPTY_META = { items: {}, hold: [], sent: {}, eventLog: [] };

export function loadMeta() {
  try {
    const raw = fs.readFileSync(metaPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_META, ...parsed };
  } catch {
    return { ...EMPTY_META };
  }
}

export function saveMeta(meta) {
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2) + '\n');
}

export function appendEvent(actor, action, detail) {
  const meta = loadMeta();
  meta.eventLog.push({ ts: new Date().toISOString(), actor, action, ...detail });
  if (meta.eventLog.length > 100) meta.eventLog = meta.eventLog.slice(-100);
  saveMeta(meta);
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/core/meta.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/meta.mjs test/core/meta.test.mjs
git commit -m "feat(core): meta.json read/write with event log"
```

---

### Task 4: core/state.mjs — unified state builder

**Files:**
- Create: `src/core/state.mjs`
- Create: `test/core/state.test.mjs`

This is the key module — reads jj graph + meta.json and returns a single state object that both CLI and TUI consume.

- [ ] **Step 1: Write tests**

```js
// test/core/state.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function jjCmd(cmd) {
  return execSync(`jj ${cmd}`, { cwd: tmpDir, encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-state-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  jjCmd('git init --colocate');
  jjCmd('config set --repo user.name Test');
  jjCmd('config set --repo user.email test@test.com');
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({
    items: {}, hold: [], sent: {}, eventLog: []
  }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('core/state', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty state with no items', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    const state = buildState();
    assert.deepStrictEqual(state.items, []);
    assert.deepStrictEqual(state.ungrouped, []);
    assert.deepStrictEqual(state.hold, []);
  });

  it('detects commits as ungrouped when no bookmarks exist', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    fs.writeFileSync('a.txt', 'a');
    jjCmd('commit -m "feat: add a"');
    const state = buildState();
    assert.ok(state.ungrouped.length >= 1);
  });

  it('groups commits under item/vpr bookmarks', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    const { saveMeta } = await import('../../src/core/meta.mjs');

    // Create commits and bookmarks
    fs.writeFileSync('a.txt', 'a');
    jjCmd('commit -m "feat: scaffold"');
    jjCmd('bookmark create ding/scaffold -r @-');

    // Register in meta
    saveMeta({
      items: {
        'ding-app': {
          wi: 123,
          wiTitle: 'Ding App',
          vprs: {
            'ding/scaffold': { title: 'Scaffold', story: '', output: null }
          }
        }
      },
      hold: [], sent: {}, eventLog: []
    });

    const state = buildState();
    assert.strictEqual(state.items.length, 1);
    assert.strictEqual(state.items[0].name, 'ding-app');
    assert.strictEqual(state.items[0].vprs.length, 1);
    assert.strictEqual(state.items[0].vprs[0].bookmark, 'ding/scaffold');
    assert.ok(state.items[0].vprs[0].commits.length >= 1);
  });

  it('marks held commits', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    const { saveMeta } = await import('../../src/core/meta.mjs');

    fs.writeFileSync('a.txt', 'a');
    jjCmd('commit -m "feat: held"');
    const changeId = jjCmd('log --no-graph -r @- -T "change_id.short()"');

    saveMeta({ items: {}, hold: [changeId], sent: {}, eventLog: [] });

    const state = buildState();
    assert.ok(state.hold.length >= 1);
  });

  it('detects conflicts', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    const state = buildState();
    assert.strictEqual(state.conflicts.size, 0);
  });

  it('detects sent VPRs', async () => {
    const { buildState } = await import('../../src/core/state.mjs');
    const { saveMeta } = await import('../../src/core/meta.mjs');

    saveMeta({
      items: {
        'ding-app': {
          wi: 123, wiTitle: 'Ding',
          vprs: { 'ding/scaffold': { title: 'Scaffold', story: '', output: null } }
        }
      },
      hold: [],
      sent: { 'feat/123-ding-scaffold': { prId: 99 } },
      eventLog: []
    });

    const state = buildState();
    // sent info is available in state
    assert.ok(state.sent);
    assert.strictEqual(state.sent['feat/123-ding-scaffold'].prId, 99);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/core/state.test.mjs
```

- [ ] **Step 3: Implement core/state.mjs**

```js
// src/core/state.mjs
import { jjSafe, getBase, getConflicts } from './jj.mjs';
import { loadMeta } from './meta.mjs';

export function buildState() {
  const meta = loadMeta();
  const base = getBase();
  const conflicts = getConflicts();
  const holdSet = new Set(meta.hold || []);

  // Load all commits from jj
  const range = `${base}..(visible_heads() & descendants(${base}))`;
  const raw = jjSafe(
    `log --no-graph --reversed -r '${range}' -T 'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ bookmarks ++ "\\t" ++ description.first_line() ++ "\\n"'`
  );

  const allCommits = [];
  if (raw) {
    for (const line of raw.split('\n')) {
      if (!line.includes('\t')) continue;
      const [changeId, sha, bookmarkStr, subject] = line.split('\t');
      if (!subject?.trim()) continue; // skip empty working copy
      const bookmarks = bookmarkStr?.trim().split(/\s+/).filter(Boolean) || [];
      allCommits.push({
        changeId: changeId?.trim(),
        sha: sha?.trim(),
        subject: subject?.trim(),
        bookmarks,
        conflict: conflicts.has(changeId?.trim()),
        held: holdSet.has(changeId?.trim()),
      });
    }
  }

  // Build items from meta, match commits to VPR bookmarks
  const items = [];
  const claimedCommits = new Set();

  for (const [itemName, itemMeta] of Object.entries(meta.items || {})) {
    const vprs = [];
    for (const [bookmark, vprMeta] of Object.entries(itemMeta.vprs || {})) {
      // Find commits that belong to this bookmark
      // In jj's model: commits between the previous bookmark and this one
      const vprCommits = [];
      for (const commit of allCommits) {
        if (commit.bookmarks.includes(bookmark) || commit.bookmarks.length === 0) {
          // Simple approach: commit belongs to the last bookmark it's an ancestor of
          // For now, assign commits to bookmarks by checking if the bookmark is in their bookmark list
        }
        if (commit.bookmarks.includes(bookmark)) {
          vprCommits.push(commit);
          claimedCommits.add(commit.changeId);
        }
      }

      vprs.push({
        bookmark,
        title: vprMeta.title || '',
        story: vprMeta.story || '',
        output: vprMeta.output || null,
        commits: vprCommits,
        sent: !!Object.keys(meta.sent || {}).find(k => k.includes(bookmark.split('/').pop())),
        conflict: vprCommits.some(c => c.conflict),
      });
    }

    items.push({
      name: itemName,
      wi: itemMeta.wi,
      wiTitle: itemMeta.wiTitle,
      vprs,
    });
  }

  // Ungrouped: commits not claimed by any VPR and not held
  const ungrouped = allCommits.filter(c => !claimedCommits.has(c.changeId) && !c.held);
  const hold = allCommits.filter(c => c.held);

  return {
    items,
    ungrouped,
    hold,
    conflicts,
    sent: meta.sent || {},
    eventLog: meta.eventLog || [],
  };
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/core/state.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/state.mjs test/core/state.test.mjs
git commit -m "feat(core): unified state builder from jj + meta"
```

---

### Task 5: commands/ticket.mjs — vpr ticket new/list/edit/done

**Files:**
- Create: `src/commands/ticket.mjs`
- Create: `test/commands/ticket.test.mjs`

- [ ] **Step 1: Write tests**

```js
// test/commands/ticket.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-ticket-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.name Test', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ provider: 'none', prefix: 'TP' }));
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({ items: {}, hold: [], sent: {}, eventLog: [] }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/ticket', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('ticketNew creates an item in meta and a jj bookmark', async () => {
    const { ticketNew } = await import('../../src/commands/ticket.mjs');
    const result = ticketNew('Ding Convertor');
    assert.ok(result.name);
    assert.ok(result.wi !== undefined);

    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.ok(meta.items[result.name]);
  });

  it('ticketList returns all items', async () => {
    const { ticketNew, ticketList } = await import('../../src/commands/ticket.mjs');
    ticketNew('Item A');
    ticketNew('Item B');
    const list = ticketList();
    assert.strictEqual(list.length, 2);
  });

  it('ticketEdit updates item title', async () => {
    const { ticketNew, ticketEdit } = await import('../../src/commands/ticket.mjs');
    const result = ticketNew('Old Title');
    ticketEdit(result.name, { wiTitle: 'New Title' });

    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.strictEqual(meta.items[result.name].wiTitle, 'New Title');
  });

  it('ticketDone moves item to done', async () => {
    const { ticketNew, ticketDone } = await import('../../src/commands/ticket.mjs');
    const result = ticketNew('To Close');
    ticketDone(result.name);

    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.strictEqual(meta.items[result.name], undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/commands/ticket.test.mjs
```

- [ ] **Step 3: Implement commands/ticket.mjs**

```js
// src/commands/ticket.mjs
import { jj } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-');
}

export function ticketNew(titleOrId, { provider } = {}) {
  const meta = loadMeta();
  const isExistingId = typeof titleOrId === 'number' || /^\d+$/.test(titleOrId);

  let wi = null;
  let wiTitle = '';
  let name = '';

  if (isExistingId) {
    // Attach to existing work item
    wi = parseInt(titleOrId);
    wiTitle = `Work Item #${wi}`;
    if (provider) {
      try {
        const item = provider.getWorkItem(wi);
        if (item?.title) wiTitle = item.title;
      } catch {}
    }
    name = slugify(wiTitle);
  } else {
    wiTitle = titleOrId;
    name = slugify(titleOrId);
    if (provider) {
      try {
        const item = provider.createWorkItem(titleOrId, '');
        if (item?.id) wi = item.id;
      } catch {}
    }
  }

  // Ensure unique name
  while (meta.items[name]) name = name + '-2';

  meta.items[name] = { wi, wiTitle, vprs: {} };
  saveMeta(meta);
  appendEvent('cli', 'ticket-new', { item: name });

  return { name, wi, wiTitle };
}

export function ticketList() {
  const meta = loadMeta();
  return Object.entries(meta.items).map(([name, item]) => ({
    name,
    wi: item.wi,
    wiTitle: item.wiTitle,
    vprCount: Object.keys(item.vprs || {}).length,
  }));
}

export function ticketEdit(name, updates) {
  const meta = loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);
  Object.assign(meta.items[name], updates);
  saveMeta(meta);
  appendEvent('cli', 'ticket-edit', { item: name });
}

export function ticketDone(name) {
  const meta = loadMeta();
  if (!meta.items[name]) throw new Error(`Item not found: ${name}`);
  delete meta.items[name];
  saveMeta(meta);
  appendEvent('cli', 'ticket-done', { item: name });
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/commands/ticket.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/ticket.mjs test/commands/ticket.test.mjs
git commit -m "feat(commands): vpr ticket new/list/edit/done"
```

---

### Task 6: commands/add.mjs — vpr add (create VPR)

**Files:**
- Create: `src/commands/add.mjs`
- Create: `test/commands/add.test.mjs`

- [ ] **Step 1: Write tests**

```js
// test/commands/add.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-add-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.name Test', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ provider: 'none', prefix: 'TP' }));
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({
    items: { 'ding-app': { wi: 123, wiTitle: 'Ding', vprs: {} } },
    hold: [], sent: {}, eventLog: []
  }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/add', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates a VPR bookmark and registers in meta', async () => {
    const { addVpr } = await import('../../src/commands/add.mjs');
    const result = addVpr('Scaffold', { item: 'ding-app' });
    assert.ok(result.bookmark);

    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.ok(meta.items['ding-app'].vprs[result.bookmark]);
  });

  it('creates bookmark with item prefix', async () => {
    const { addVpr } = await import('../../src/commands/add.mjs');
    const result = addVpr('Scaffold', { item: 'ding-app' });
    assert.ok(result.bookmark.startsWith('ding-app/'));
  });

  it('sets title in meta', async () => {
    const { addVpr } = await import('../../src/commands/add.mjs');
    const result = addVpr('Scaffold', { item: 'ding-app' });

    const { loadMeta } = await import('../../src/core/meta.mjs');
    const meta = loadMeta();
    assert.strictEqual(meta.items['ding-app'].vprs[result.bookmark].title, 'Scaffold');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/commands/add.test.mjs
```

- [ ] **Step 3: Implement commands/add.mjs**

```js
// src/commands/add.mjs
import { jj, jjSafe } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function addVpr(title, { item } = {}) {
  const meta = loadMeta();

  if (!item) {
    // Find the first item or error
    const itemNames = Object.keys(meta.items);
    if (itemNames.length === 0) throw new Error('No items. Create one first: vpr ticket new "title"');
    if (itemNames.length === 1) item = itemNames[0];
    else throw new Error('Multiple items. Specify with --item: vpr add "title" --item <name>');
  }

  if (!meta.items[item]) throw new Error(`Item not found: ${item}`);

  const slug = slugify(title);
  const bookmark = `${item}/${slug}`;

  // Create jj bookmark at current position
  const atDesc = jjSafe(`log --no-graph -r @ -T 'description.first_line()'`)?.trim();
  const target = atDesc ? '@' : '@-';
  jj(`bookmark create ${bookmark} -r ${target}`);

  // Register in meta
  meta.items[item].vprs[bookmark] = { title, story: '', output: null };
  saveMeta(meta);
  appendEvent('cli', 'add', { item, vpr: bookmark });

  return { bookmark, item, title };
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/commands/add.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/add.mjs test/commands/add.test.mjs
git commit -m "feat(commands): vpr add — create VPR within item"
```

---

### Task 7: commands/edit.mjs — vpr edit

**Files:**
- Create: `src/commands/edit.mjs`
- Create: `test/commands/edit.test.mjs`

- [ ] **Step 1: Write tests**

```js
// test/commands/edit.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-edit-'));
  origCwd = process.cwd();
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({
    items: {
      'ding-app': {
        wi: 123, wiTitle: 'Ding',
        vprs: { 'ding-app/scaffold': { title: 'Scaffold', story: '', output: null } }
      }
    },
    hold: [], sent: {}, eventLog: []
  }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/edit', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('updates story', async () => {
    const { editVpr } = await import('../../src/commands/edit.mjs');
    editVpr('ding-app/scaffold', { story: 'Sets up the app' });
    const { loadMeta } = await import('../../src/core/meta.mjs');
    assert.strictEqual(loadMeta().items['ding-app'].vprs['ding-app/scaffold'].story, 'Sets up the app');
  });

  it('updates title', async () => {
    const { editVpr } = await import('../../src/commands/edit.mjs');
    editVpr('ding-app/scaffold', { title: 'New Title' });
    const { loadMeta } = await import('../../src/core/meta.mjs');
    assert.strictEqual(loadMeta().items['ding-app'].vprs['ding-app/scaffold'].title, 'New Title');
  });

  it('throws on unknown VPR', async () => {
    const { editVpr } = await import('../../src/commands/edit.mjs');
    assert.throws(() => editVpr('nonexistent', { story: 'x' }), /not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/commands/edit.test.mjs
```

- [ ] **Step 3: Implement commands/edit.mjs**

```js
// src/commands/edit.mjs
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

export function findVpr(meta, query) {
  for (const [itemName, item] of Object.entries(meta.items || {})) {
    for (const [bookmark, vpr] of Object.entries(item.vprs || {})) {
      if (bookmark === query || bookmark.endsWith('/' + query) || vpr.title?.toLowerCase() === query.toLowerCase()) {
        return { itemName, bookmark, vpr };
      }
    }
  }
  return null;
}

export function editVpr(query, updates) {
  const meta = loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const vpr = meta.items[found.itemName].vprs[found.bookmark];
  if (updates.title !== undefined) vpr.title = updates.title;
  if (updates.story !== undefined) vpr.story = updates.story;
  if (updates.output !== undefined) vpr.output = updates.output;

  saveMeta(meta);
  appendEvent('cli', 'edit', { item: found.itemName, vpr: found.bookmark });
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/commands/edit.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/edit.mjs test/commands/edit.test.mjs
git commit -m "feat(commands): vpr edit — update VPR title/story/output"
```

---

### Task 8: commands/list.mjs + commands/status.mjs

**Files:**
- Create: `src/commands/list.mjs`
- Create: `src/commands/status.mjs`
- Create: `test/commands/list.test.mjs`

- [ ] **Step 1: Write tests**

```js
// test/commands/list.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-list-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.name Test', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ provider: 'none', prefix: 'TP' }));
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({
    items: {
      'ding-app': {
        wi: 123, wiTitle: 'Ding App',
        vprs: { 'ding-app/scaffold': { title: 'Scaffold', story: 'The story', output: null } }
      }
    },
    hold: [], sent: {}, eventLog: []
  }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/list', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns JSON with items and eventLog', async () => {
    const { list } = await import('../../src/commands/list.mjs');
    const result = list();
    assert.ok(Array.isArray(result.items));
    assert.ok(Array.isArray(result.eventLog));
  });

  it('includes VPR metadata', async () => {
    const { list } = await import('../../src/commands/list.mjs');
    const result = list();
    assert.strictEqual(result.items[0].vprs[0].title, 'Scaffold');
    assert.strictEqual(result.items[0].vprs[0].story, 'The story');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/commands/list.test.mjs
```

- [ ] **Step 3: Implement commands/list.mjs**

```js
// src/commands/list.mjs
import { buildState } from '../core/state.mjs';

export function list() {
  const state = buildState();
  return {
    items: state.items.map(item => ({
      name: item.name,
      wi: item.wi,
      wiTitle: item.wiTitle,
      vprs: item.vprs.map(vpr => ({
        bookmark: vpr.bookmark,
        title: vpr.title,
        story: vpr.story,
        output: vpr.output,
        commits: vpr.commits.map(c => ({
          changeId: c.changeId,
          subject: c.subject,
          conflict: c.conflict,
        })),
        sent: vpr.sent,
        conflict: vpr.conflict,
      })),
    })),
    ungrouped: state.ungrouped.map(c => ({ changeId: c.changeId, subject: c.subject })),
    hold: state.hold.map(c => ({ changeId: c.changeId, subject: c.subject })),
    sent: state.sent,
    eventLog: state.eventLog,
  };
}
```

- [ ] **Step 4: Implement commands/status.mjs**

```js
// src/commands/status.mjs
import { buildState } from '../core/state.mjs';

const B = '\x1b[1m';
const D = '\x1b[2m';
const R = '\x1b[0m';
const C = '\x1b[36m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';

export function status() {
  const state = buildState();
  const totalVprs = state.items.reduce((n, i) => n + i.vprs.length, 0);

  console.log(`\n  ${B}${state.items.length} items, ${totalVprs} vprs${R}\n`);

  for (const item of state.items) {
    console.log(`  ${C}${B}${item.wiTitle}${R} ${D}#${item.wi || ''}${R}`);
    for (const vpr of item.vprs) {
      const status = vpr.sent ? `${G}✓ sent${R}` : vpr.conflict ? `${RED}! conflict${R}` : `${D}· pending${R}`;
      console.log(`    ${status}  ${vpr.title} ${D}(${vpr.commits.length} commits)${R}`);
    }
    console.log('');
  }

  if (state.ungrouped.length > 0) {
    console.log(`  ${Y}Ungrouped (${state.ungrouped.length})${R}`);
    for (const c of state.ungrouped) {
      console.log(`    ${D}${c.changeId.slice(0, 8)}${R} ${c.subject}`);
    }
    console.log('');
  }

  const sentCount = Object.keys(state.sent).length;
  if (sentCount > 0) console.log(`  ${D}${sentCount} sent${R}\n`);
}
```

- [ ] **Step 5: Run tests**

```bash
node --test test/commands/list.test.mjs
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/list.mjs src/commands/status.mjs test/commands/list.test.mjs
git commit -m "feat(commands): vpr list (JSON) and vpr status (human-readable)"
```

---

### Task 9: commands/log.mjs — jj graph view

**Files:**
- Create: `src/commands/log.mjs`

- [ ] **Step 1: Implement commands/log.mjs**

```js
// src/commands/log.mjs
import { jj, jjSafe, getBase } from '../core/jj.mjs';

export function log(limit = 30) {
  const base = getBase();
  const range = `${base}..(visible_heads() & descendants(${base}))`;
  try {
    const output = jj(`log --limit ${limit} -r '${range}'`);
    console.log(output);
  } catch {
    try {
      console.log(jj(`log --limit ${limit}`));
    } catch (err) {
      console.error('Failed to show log');
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/log.mjs
git commit -m "feat(commands): vpr log — jj graph view"
```

---

### Task 10: commands/hold.mjs + commands/remove.mjs + commands/generate.mjs

**Files:**
- Create: `src/commands/hold.mjs`
- Create: `src/commands/remove.mjs`
- Create: `src/commands/generate.mjs`
- Create: `test/commands/hold.test.mjs`

- [ ] **Step 1: Write hold tests**

```js
// test/commands/hold.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-hold-'));
  origCwd = process.cwd();
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'meta.json'), JSON.stringify({ items: {}, hold: [], sent: {}, eventLog: [] }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/hold', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('hold adds changeId to hold list', async () => {
    const { hold } = await import('../../src/commands/hold.mjs');
    hold('abc123');
    const { loadMeta } = await import('../../src/core/meta.mjs');
    assert.ok(loadMeta().hold.includes('abc123'));
  });

  it('unhold removes changeId', async () => {
    const { hold, unhold } = await import('../../src/commands/hold.mjs');
    hold('abc123');
    unhold('abc123');
    const { loadMeta } = await import('../../src/core/meta.mjs');
    assert.ok(!loadMeta().hold.includes('abc123'));
  });
});
```

- [ ] **Step 2: Implement all three**

```js
// src/commands/hold.mjs
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';

export function hold(changeId) {
  const meta = loadMeta();
  if (!meta.hold.includes(changeId)) meta.hold.push(changeId);
  saveMeta(meta);
  appendEvent('cli', 'hold', { changeId });
}

export function unhold(changeId) {
  const meta = loadMeta();
  meta.hold = meta.hold.filter(id => id !== changeId);
  saveMeta(meta);
  appendEvent('cli', 'unhold', { changeId });
}
```

```js
// src/commands/remove.mjs
import { jjSafe } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { findVpr } from './edit.mjs';

export function removeVpr(query) {
  const meta = loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  // Delete jj bookmark
  jjSafe(`bookmark delete ${found.bookmark}`);

  // Remove from meta
  delete meta.items[found.itemName].vprs[found.bookmark];
  saveMeta(meta);
  appendEvent('cli', 'remove', { item: found.itemName, vpr: found.bookmark });
}
```

```js
// src/commands/generate.mjs
import { execSync } from 'child_process';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

export function generate(query, { generateCmd } = {}) {
  const meta = loadMeta();
  const state = buildState();

  // Find command
  let cmd = generateCmd || null;
  if (!cmd) {
    try { execSync('which claude', { stdio: 'pipe' }); cmd = 'claude -p'; } catch {}
  }
  if (!cmd) throw new Error('No LLM configured. Add "generateCmd" to .vpr/config.json or install claude CLI');

  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);
  if (!found.vpr.story?.trim()) throw new Error(`No story for ${query}. Write one first: vpr edit ${query} --story "..."`);

  // Find commits for this VPR
  const item = state.items.find(i => i.name === found.itemName);
  const vpr = item?.vprs.find(v => v.bookmark === found.bookmark);
  const commitList = (vpr?.commits || []).map(c => `- ${c.changeId?.slice(0, 8)} ${c.subject}`).join('\n');

  const prompt = [
    'Generate a concise PR description in markdown.',
    'Output ONLY the markdown — no preamble.',
    'Use ## Summary with 1-3 bullet points, then ## Changes with details.',
    '',
    `PR Title: ${found.vpr.title || ''}`,
    '',
    'Story:',
    found.vpr.story,
    '',
    'Commits:',
    commitList,
  ].join('\n');

  const result = execSync(cmd, {
    input: prompt, encoding: 'utf-8', timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash',
  }).trim();

  if (!result) throw new Error('LLM returned empty response');

  meta.items[found.itemName].vprs[found.bookmark].output = result;
  saveMeta(meta);
  appendEvent('cli', 'generate', { item: found.itemName, vpr: found.bookmark });

  return result;
}

export function generateAll({ generateCmd } = {}) {
  const meta = loadMeta();
  const results = [];
  for (const [itemName, item] of Object.entries(meta.items)) {
    for (const [bookmark, vpr] of Object.entries(item.vprs)) {
      if (vpr.story?.trim() && !vpr.output?.trim()) {
        try {
          generate(bookmark, { generateCmd });
          results.push({ bookmark, status: 'ok' });
        } catch (err) {
          results.push({ bookmark, status: 'failed', error: err.message });
        }
      }
    }
  }
  return results;
}
```

- [ ] **Step 3: Run tests**

```bash
node --test test/commands/hold.test.mjs
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/hold.mjs src/commands/remove.mjs src/commands/generate.mjs test/commands/hold.test.mjs
git commit -m "feat(commands): hold/unhold, remove, generate"
```

---

### Task 11: commands/send.mjs — linearize + push + create PRs

**Files:**
- Create: `src/commands/send.mjs`
- Create: `test/commands/send.test.mjs`

This is the most complex command. It linearizes, renames bookmarks, pushes, creates PRs.

- [ ] **Step 1: Write tests**

```js
// test/commands/send.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-send-'));
  origCwd = process.cwd();
  execSync('git init -b main', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj git init --colocate', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.name Test', { cwd: tmpDir, stdio: 'pipe' });
  execSync('jj config set --repo user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(tmpDir, '.vpr'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.vpr', 'config.json'), JSON.stringify({ provider: 'none', prefix: 'TP' }));
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('commands/send', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('blocks if story is empty', async () => {
    const { saveMeta } = await import('../../src/core/meta.mjs');
    saveMeta({
      items: { 'test': { wi: 1, wiTitle: 'Test', vprs: { 'test/a': { title: 'A', story: '', output: null } } } },
      hold: [], sent: {}, eventLog: []
    });
    const { sendChecks } = await import('../../src/commands/send.mjs');
    const checks = sendChecks('test/a');
    assert.ok(checks.some(c => !c.pass && c.name === 'story'));
  });

  it('passes checks when story exists', async () => {
    const { saveMeta } = await import('../../src/core/meta.mjs');
    const { jj } = await import('../../src/core/jj.mjs');
    fs.writeFileSync('a.txt', 'a');
    jj('commit -m "feat: a"');
    jj('bookmark create test/a -r @-');
    saveMeta({
      items: { 'test': { wi: 1, wiTitle: 'Test', vprs: { 'test/a': { title: 'A', story: 'The story', output: null } } } },
      hold: [], sent: {}, eventLog: []
    });
    const { sendChecks } = await import('../../src/commands/send.mjs');
    const checks = sendChecks('test/a');
    const storyCheck = checks.find(c => c.name === 'story');
    assert.ok(storyCheck.pass);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/commands/send.test.mjs
```

- [ ] **Step 3: Implement commands/send.mjs**

```js
// src/commands/send.mjs
import { jj, jjSafe, getConflicts } from '../core/jj.mjs';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

export function sendChecks(query) {
  const meta = loadMeta();
  const found = findVpr(meta, query);
  if (!found) return [{ name: 'exists', pass: false, message: `VPR not found: ${query}` }];

  const conflicts = getConflicts();
  const state = buildState();
  const item = state.items.find(i => i.name === found.itemName);
  const vpr = item?.vprs.find(v => v.bookmark === found.bookmark);

  return [
    { name: 'story', pass: !!found.vpr.story?.trim(), message: found.vpr.story?.trim() ? 'Story written' : 'No story — write with vpr edit --story' },
    { name: 'output', pass: !!found.vpr.output?.trim(), message: found.vpr.output?.trim() ? 'Output generated' : 'No output — generate with vpr generate' },
    { name: 'commits', pass: (vpr?.commits.length || 0) > 0, message: `${vpr?.commits.length || 0} commits` },
    { name: 'conflicts', pass: !vpr?.conflict, message: vpr?.conflict ? 'Has conflicts — resolve first' : 'No conflicts' },
  ];
}

export function send(query, { provider, dryRun = false, tpIndex = 1, targetBranch = 'main' } = {}) {
  const meta = loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const checks = sendChecks(query);
  const failures = checks.filter(c => !c.pass && c.name !== 'output'); // output is optional
  if (failures.length > 0) throw new Error(`Pre-send checks failed:\n${failures.map(c => `  ✗ ${c.message}`).join('\n')}`);

  // Generate branch name
  const wi = meta.items[found.itemName].wi;
  const slug = found.bookmark.replace(/\//g, '-');
  const branchName = wi ? `feat/${wi}-${slug}` : `feat/${slug}`;
  const prefix = 'TP'; // TODO: read from config
  const prTitle = `${prefix}-${tpIndex}: ${found.vpr.title}`;
  const prBody = found.vpr.output || found.vpr.story || '';

  if (dryRun) {
    return { branchName, prTitle, targetBranch, prBody, dryRun: true };
  }

  // Rename bookmark
  try { jj(`bookmark rename ${found.bookmark} ${branchName}`); } catch {
    jj(`bookmark create ${branchName} -r ${found.bookmark}`);
    jjSafe(`bookmark delete ${found.bookmark}`);
  }

  // Push
  jj(`git push --bookmark ${branchName}`);

  // Create PR
  let prId = null;
  if (provider) {
    try {
      const result = provider.createPR(branchName, targetBranch, prTitle, prBody, wi);
      prId = result?.id;
    } catch (err) {
      console.error(`PR creation failed: ${err.message}`);
    }
  }

  // Update meta — move to sent, remove from items
  if (!meta.sent) meta.sent = {};
  meta.sent[branchName] = { prId };
  delete meta.items[found.itemName].vprs[found.bookmark];
  // Clean up empty items
  if (Object.keys(meta.items[found.itemName].vprs).length === 0) {
    delete meta.items[found.itemName];
  }
  saveMeta(meta);
  appendEvent('cli', 'send', { item: found.itemName, vpr: found.bookmark, branch: branchName, prId });

  return { branchName, prTitle, prId, targetBranch };
}
```

- [ ] **Step 4: Run tests**

```bash
node --test test/commands/send.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/send.mjs test/commands/send.test.mjs
git commit -m "feat(commands): vpr send — checks, linearize, push, create PR"
```

---

### Task 12: bin/vpr.mjs — CLI entry point

**Files:**
- Modify: `bin/vpr.mjs`

- [ ] **Step 1: Rewrite bin/vpr.mjs**

```js
#!/usr/bin/env node
import { loadMeta } from '../src/core/meta.mjs';

const cmd = process.argv[2];
const args = process.argv.slice(3);

switch (cmd) {
  case 'ticket': {
    const sub = args[0];
    const { ticketNew, ticketList, ticketEdit, ticketDone } = await import('../src/commands/ticket.mjs');
    if (sub === 'new') {
      const result = ticketNew(args[1]);
      console.log(JSON.stringify(result));
    } else if (sub === 'list') {
      console.log(JSON.stringify(ticketList(), null, 2));
    } else if (sub === 'edit') {
      ticketEdit(args[1], { wiTitle: args[3] });
    } else if (sub === 'done') {
      ticketDone(args[1]);
    } else {
      console.error('Usage: vpr ticket new|list|edit|done');
    }
    break;
  }

  case 'add': {
    const { addVpr } = await import('../src/commands/add.mjs');
    const itemFlag = args.indexOf('--item');
    const item = itemFlag >= 0 ? args[itemFlag + 1] : undefined;
    const title = args.find(a => !a.startsWith('--') && a !== item);
    const result = addVpr(title, { item });
    console.log(JSON.stringify(result));
    break;
  }

  case 'edit': {
    const { editVpr } = await import('../src/commands/edit.mjs');
    const query = args[0];
    const updates = {};
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i]?.replace('--', '');
      const val = args[i + 1];
      if (flag && val) updates[flag] = val;
    }
    editVpr(query, updates);
    console.log('Updated');
    break;
  }

  case 'remove': {
    const { removeVpr } = await import('../src/commands/remove.mjs');
    removeVpr(args[0]);
    console.log('Removed');
    break;
  }

  case 'list': case 'l': {
    const { list } = await import('../src/commands/list.mjs');
    console.log(JSON.stringify(list(), null, 2));
    break;
  }

  case 'status': case 's': {
    const { status } = await import('../src/commands/status.mjs');
    status();
    break;
  }

  case 'log': {
    const { log } = await import('../src/commands/log.mjs');
    log(parseInt(args[0]) || 30);
    break;
  }

  case 'generate': {
    const { generate, generateAll } = await import('../src/commands/generate.mjs');
    if (args.includes('--all')) {
      const results = generateAll();
      console.log(JSON.stringify(results, null, 2));
    } else {
      const result = generate(args[0]);
      console.log(result);
    }
    break;
  }

  case 'hold': {
    const { hold } = await import('../src/commands/hold.mjs');
    hold(args[0]);
    console.log('Held');
    break;
  }

  case 'unhold': {
    const { unhold } = await import('../src/commands/hold.mjs');
    unhold(args[0]);
    console.log('Released');
    break;
  }

  case 'send': {
    const { send, sendChecks } = await import('../src/commands/send.mjs');
    const dryRun = args.includes('--dry-run');
    const query = args.find(a => !a.startsWith('--'));
    if (args.includes('--all')) {
      console.log('Send all — not yet implemented. Send one at a time.');
    } else if (query) {
      if (dryRun) {
        const checks = sendChecks(query);
        for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.message}`);
      } else {
        const result = send(query);
        console.log(JSON.stringify(result));
      }
    } else {
      console.error('Usage: vpr send <vpr> [--dry-run]');
    }
    break;
  }

  case 'init': {
    const { init } = await import('../src/commands/init.mjs');
    await init();
    break;
  }

  case 'help': case '--help': case '-h': {
    console.log(`
  VPR v2 — Virtual Pull Request Manager

  Items:
    vpr ticket new "title"          Create item + work item
    vpr ticket new 17065            Attach to existing work item
    vpr ticket list                 List items
    vpr ticket edit <name>          Edit item
    vpr ticket done <name>          Close item

  VPRs:
    vpr add "title"                 Create VPR in current item
    vpr add "title" --item <name>   Create VPR in specific item
    vpr edit <vpr> --story "..."    Write story
    vpr edit <vpr> --title "..."    Set title
    vpr remove <vpr>                Dissolve VPR
    vpr list                        JSON output
    vpr status                      Human-readable overview
    vpr log [N]                     jj graph

  AI:
    vpr generate <vpr>              Generate output from story
    vpr generate --all              Generate all empty outputs

  Work:
    vpr hold <changeId>             Park a commit
    vpr unhold <changeId>           Release

  Push:
    vpr send <vpr>                  Send one VPR
    vpr send --all                  Send all
    vpr send --dry-run              Preview
`);
    break;
  }

  default: {
    // TUI
    const { startTui } = await import('../src/tui/tui.mjs');
    startTui();
    break;
  }
}
```

- [ ] **Step 2: Test CLI commands manually**

```bash
vpr help
vpr ticket new "Test Item"
vpr ticket list
vpr add "First VPR"
vpr list
vpr status
```

- [ ] **Step 3: Commit**

```bash
git add bin/vpr.mjs
git commit -m "feat: rewrite CLI entry point for v2 commands"
```

---

### Task 13-20: TUI (deferred)

The TUI tasks (tree builder, render, modes, editor helpers) follow the same pattern but are larger. They should be implemented after the CLI is working and tested end-to-end.

**Task 13:** `tui/tree.mjs` — build tree from state + tests
**Task 14:** `tui/render.mjs` — draw split pane with tree
**Task 15:** `tui/editor.mjs` — $EDITOR helpers (open, parse sections, bulk edit)
**Task 16:** `tui/modes/normal.mjs` — normal mode key handler
**Task 17:** `tui/modes/interactive.mjs` — rebase -i style in $EDITOR
**Task 18:** `tui/modes/split.mjs` — file split mode
**Task 19:** `tui/tui.mjs` — main loop wiring
**Task 20:** Skill files + README finalization

Each of these follows the same pattern: write test → implement → test → commit.

---

### Task 21: Copy providers from v1

**Files:**
- Keep: `src/providers/*` (unchanged from v1)

- [ ] **Step 1: Verify providers still work**

```bash
node -e "import('./src/providers/index.mjs').then(m => console.log(Object.keys(m)))"
```

- [ ] **Step 2: Commit if any path changes needed**

```bash
git add -A
git commit -m "chore: verify providers carry over from v1"
```

---

### Task 22: Skill files update

**Files:**
- Modify: `skills/vpr.md` (or `~/.claude/skills/vpr/SKILL.md`)

- [ ] **Step 1: Update skill file with v2 commands**

Update to reference new commands: `vpr ticket new`, `vpr add`, `vpr edit --story`, `vpr generate`, `vpr list`, `vpr send`.

- [ ] **Step 2: Commit**

```bash
git add skills/
git commit -m "docs: update skill files for v2 commands"
```
