import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-push-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const PLAN = `# Epic: MVP1 — PBI 17065

Description:
Epic body.

## Task: Audio player — Task 17066

Description:
Task body.

### PR: AudioPlayer component — targets main

Description:
AudioPlayer PR body.

commits: a1b2c3..e4f5g6

### PR: Wire into ConversionView — targets AudioPlayer component

Description:
Wire PR body.

commits: e4f5g6..i7j8k9

## Task: Sandbox mode — Task 17080

Description:
Sandbox.

### PR: Sandbox toggle — targets main

Description:
Toggle body.

commits: x1y2z3..a4b5c6
`;

function makeJjApi(overrides = {}) {
  const calls = { setBookmark: [], pushBookmark: [], resolveLastCommit: [] };
  const api = {
    resolveLastCommit: (range) => {
      calls.resolveLastCommit.push(range);
      return `sha_${range.replace(/[^a-z0-9]/gi, '_')}`;
    },
    setBookmark: (name, commit) => {
      calls.setBookmark.push({ name, commit });
    },
    pushBookmark: (name) => {
      calls.pushBookmark.push(name);
    },
    ...overrides,
  };
  return { api, calls };
}

function makeProvider(overrides = {}) {
  const calls = [];
  const provider = {
    createPR: ({ branch, base, title, body, taskWi }) => {
      calls.push({ branch, base, title, body, taskWi });
      return { id: calls.length + 1000 };
    },
    ...overrides,
  };
  return { provider, calls };
}

describe('commands/ship ship', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('processes every PR in document order', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    const results = ship({ jjApi: api, provider });

    assert.strictEqual(results.length, 3);
    assert.deepStrictEqual(results.map(r => r.title), [
      'AudioPlayer component',
      'Wire into ConversionView',
      'Sandbox toggle',
    ]);
    assert.strictEqual(calls.length, 3);
  });

  it('generates bookmark name: feat/<pbi>-<task-slug>-<pr-slug>', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api, calls } = makeJjApi();
    const { provider } = makeProvider();

    ship({ jjApi: api, provider });

    assert.deepStrictEqual(calls.setBookmark.map(c => c.name), [
      'feat/17065-audio-player-audioplayer-component',
      'feat/17065-audio-player-wire-into-conversionview',
      'feat/17065-sandbox-mode-sandbox-toggle',
    ]);
  });

  it('sets bookmark at the last commit of the range', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api, calls } = makeJjApi();
    const { provider } = makeProvider();

    ship({ jjApi: api, provider });

    assert.strictEqual(calls.resolveLastCommit[0], 'a1b2c3..e4f5g6');
    assert.strictEqual(calls.setBookmark[0].commit, 'sha_a1b2c3__e4f5g6');
  });

  it('targets main for a top-of-stack PR', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    ship({ jjApi: api, provider });

    assert.strictEqual(calls[0].base, 'main');
    assert.strictEqual(calls[2].base, 'main');
  });

  it('targets the previous PR bookmark for a stacked PR', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    ship({ jjApi: api, provider });

    assert.strictEqual(calls[1].base, 'feat/17065-audio-player-audioplayer-component');
  });

  it('pushes each bookmark after setting it', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api, calls } = makeJjApi();
    const { provider } = makeProvider();

    ship({ jjApi: api, provider });

    assert.deepStrictEqual(calls.pushBookmark, [
      'feat/17065-audio-player-audioplayer-component',
      'feat/17065-audio-player-wire-into-conversionview',
      'feat/17065-sandbox-mode-sandbox-toggle',
    ]);
  });

  it('PR body = Description + Closes AB#<task-wi> trailer', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    ship({ jjApi: api, provider });

    assert.match(calls[0].body, /AudioPlayer PR body/);
    assert.match(calls[0].body, /Closes AB#17066/);
    assert.match(calls[2].body, /Closes AB#17080/);
  });

  it('omits Closes trailer when parent task has no WI', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    const planNoWi = `# Epic: E\n\n## Task: T\n\nDescription:\nbody.\n\n### PR: P\n\nDescription:\npr body.\n\ncommits: a..b\n`;
    fs.writeFileSync('plan.md', planNoWi);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    ship({ jjApi: api, provider });

    assert.doesNotMatch(calls[0].body, /Closes AB#/);
    assert.match(calls[0].body, /pr body/);
  });

  it('passes taskWi to provider.createPR', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider, calls } = makeProvider();

    ship({ jjApi: api, provider });

    assert.strictEqual(calls[0].taskWi, 17066);
    assert.strictEqual(calls[2].taskWi, 17080);
  });

  it('skips PRs with empty commits range', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    const planNoCommits = `# Epic: E — PBI 1\n\n## Task: T — Task 2\n\n### PR: No commits\n\nDescription:\nx\n`;
    fs.writeFileSync('plan.md', planNoCommits);
    const { api, calls: jjCalls } = makeJjApi();
    const { provider, calls: prCalls } = makeProvider();

    const results = ship({ jjApi: api, provider });

    assert.strictEqual(results[0].status, 'no-commits');
    assert.strictEqual(jjCalls.setBookmark.length, 0);
    assert.strictEqual(prCalls.length, 0);
  });

  it('skips PRs where resolveLastCommit returns null', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi({ resolveLastCommit: () => null });
    const { provider, calls } = makeProvider();

    const results = ship({ jjApi: api, provider });

    assert.ok(results.every(r => r.status === 'no-commits'));
    assert.strictEqual(calls.length, 0);
  });

  it('dry-run: computes plan without setting bookmarks or calling provider', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api, calls: jjCalls } = makeJjApi();
    const { provider, calls: prCalls } = makeProvider();

    const results = ship({ jjApi: api, provider, dryRun: true });

    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.status === 'dry'));
    assert.ok(results[0].bookmark);
    assert.strictEqual(jjCalls.setBookmark.length, 0);
    assert.strictEqual(jjCalls.pushBookmark.length, 0);
    assert.strictEqual(prCalls.length, 0);
  });

  it('dry-run still chains targets correctly', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider } = makeProvider();

    const results = ship({ jjApi: api, provider, dryRun: true });

    assert.strictEqual(results[0].target, 'main');
    assert.strictEqual(results[1].target, 'feat/17065-audio-player-audioplayer-component');
    assert.strictEqual(results[2].target, 'main');
  });

  it('records prId in results when provider returns one', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider } = makeProvider();

    const results = ship({ jjApi: api, provider });

    assert.strictEqual(results[0].prId, 1001);
    assert.strictEqual(results[1].prId, 1002);
  });

  it('records status=shipped when PR created successfully', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    const { provider } = makeProvider();

    const results = ship({ jjApi: api, provider });

    assert.ok(results.filter(r => r.status === 'shipped').length === 3);
  });

  it('records status=pushed when no provider given', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();

    const results = ship({ jjApi: api, provider: null });

    assert.ok(results.every(r => r.status === 'pushed'));
    assert.ok(results.every(r => r.prId === null));
  });

  it('errors when plan.md does not exist', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    const { api } = makeJjApi();
    const { provider } = makeProvider();

    assert.throws(
      () => ship({ jjApi: api, provider }),
      /plan\.md/i
    );
  });

  it('records error per-PR when provider.createPR throws, continues batch', async () => {
    const { ship } = await import('../../src/commands/ship.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const { api } = makeJjApi();
    let n = 0;
    const { provider } = makeProvider({
      createPR: () => {
        n++;
        if (n === 2) throw new Error('rate limited');
        return { id: n + 1000 };
      },
    });

    const results = ship({ jjApi: api, provider });

    assert.strictEqual(results[0].status, 'shipped');
    assert.strictEqual(results[1].status, 'error');
    assert.match(results[1].error, /rate limited/);
    assert.strictEqual(results[2].status, 'shipped');
  });
});
