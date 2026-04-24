import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pull-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeProvider(overrides = {}) {
  const items = {
    17065: {
      id: 17065,
      type: 'Product Backlog Item',
      title: 'MVP1',
      description: 'First milestone. Audio playback, sandbox mode, upload flow.',
      state: 'Active',
      url: 'https://dev.azure.com/org/proj/_workitems/edit/17065',
    },
    17066: {
      id: 17066,
      type: 'Task',
      title: 'Audio player',
      description: 'Core audio playback with Web Audio API.',
      state: 'New',
      url: 'https://dev.azure.com/org/proj/_workitems/edit/17066',
    },
    17080: {
      id: 17080,
      type: 'Task',
      title: 'Sandbox mode',
      description: 'Demo mode without auth.',
      state: 'New',
      url: 'https://dev.azure.com/org/proj/_workitems/edit/17080',
    },
  };
  const children = {
    17065: [17066, 17080],
  };
  return {
    getWorkItem: (id) => items[id] || null,
    getChildren: (id) => (children[id] || []).map(cid => items[cid]),
    ...overrides,
  };
}

describe('commands/plan-pull planPull', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes plan.md with Epic heading and PBI id', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider });

    const content = fs.readFileSync('plan.md', 'utf-8');
    assert.match(content, /^# Epic: MVP1 — PBI 17065/m);
  });

  it('populates Epic Story with WI description, leaves Description empty', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.match(plan.epic.story, /First milestone/);
    assert.strictEqual(plan.epic.description, '');
  });

  it('writes H2 Task sections for each child Task', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.strictEqual(plan.tasks.length, 2);
    assert.strictEqual(plan.tasks[0].title, 'Audio player');
    assert.strictEqual(plan.tasks[0].wi, 17066);
    assert.strictEqual(plan.tasks[1].title, 'Sandbox mode');
    assert.strictEqual(plan.tasks[1].wi, 17080);
  });

  it('populates Task Story with task WI description', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.match(plan.tasks[0].story, /Web Audio API/);
    assert.match(plan.tasks[1].story, /Demo mode/);
  });

  it('creates no H3 PR sections (that is the user\'s job)', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.strictEqual(plan.tasks[0].prs.length, 0);
    assert.strictEqual(plan.tasks[1].prs.length, 0);
  });

  it('returns summary with counts', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const provider = makeProvider();

    const result = planPull({ pbiId: 17065, provider });

    assert.strictEqual(result.epicWi, 17065);
    assert.strictEqual(result.taskCount, 2);
    assert.strictEqual(result.written, 'plan.md');
  });

  it('handles a PBI with no children (epic-only plan)', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider({ getChildren: () => [] });

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.strictEqual(plan.tasks.length, 0);
    assert.strictEqual(plan.epic.title, 'MVP1');
  });

  it('throws when PBI not found', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const provider = makeProvider({ getWorkItem: () => null });

    assert.throws(
      () => planPull({ pbiId: 99999, provider }),
      /not found|99999/i
    );
  });

  it('refuses to overwrite existing plan.md without --append', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    fs.writeFileSync('plan.md', '# existing plan\n');
    const provider = makeProvider();

    assert.throws(
      () => planPull({ pbiId: 17065, provider }),
      /exist|append/i
    );
    const after = fs.readFileSync('plan.md', 'utf-8');
    assert.match(after, /# existing plan/);
  });

  it('appends to existing plan.md with append=true', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    fs.writeFileSync('plan.md', '# Epic: Older — PBI 1\n\nStory:\n- prior work\n');
    const provider = makeProvider();

    planPull({ pbiId: 17065, provider, append: true });

    const content = fs.readFileSync('plan.md', 'utf-8');
    assert.match(content, /# Epic: Older/);
    // Note: multiple Epics in one file is rejected by parse(), but append
    // writes second epic for the user to split later. We verify the new
    // content made it to disk.
    assert.match(content, /# Epic: MVP1 — PBI 17065/);
  });

  it('strips basic HTML tags from Azure descriptions when writing Story', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider({
      getWorkItem: (id) => id === 17065
        ? {
          id, type: 'Product Backlog Item', title: 'HTML Test',
          description: '<p>First <strong>bold</strong> line.</p><p>Second line.</p>',
          state: 'Active', url: 'x',
        }
        : null,
      getChildren: () => [],
    });

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.match(plan.epic.story, /First\s+bold\s+line/);
    assert.doesNotMatch(plan.epic.story, /<p>|<\/p>|<strong>/);
  });

  it('omits Story block when WI has no description', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    const provider = makeProvider({
      getWorkItem: (id) => id === 17065
        ? { id, type: 'Product Backlog Item', title: 'Empty', description: '', state: 'New', url: 'x' }
        : null,
      getChildren: () => [],
    });

    planPull({ pbiId: 17065, provider });
    const plan = parse('plan.md');

    assert.strictEqual(plan.epic.story, '');
  });

  it('writes to custom planPath when given', async () => {
    const { planPull } = await import('../../src/commands/plan-pull.mjs');
    const provider = makeProvider();

    planPull({ pbiId: 17065, planPath: 'custom.md', provider });

    assert.ok(fs.existsSync('custom.md'));
    assert.ok(!fs.existsSync('plan.md'));
  });
});
