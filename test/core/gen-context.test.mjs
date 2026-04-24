import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-ctx-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const PLAN = `# Epic: MVP1 — PBI 17065

Story:
- first milestone
- audio playback

Description:
First milestone of the app.

## Task: Audio player — Task 17066

Story:
- adds audio playback

Description:
Adds audio playback to the app.

### PR: AudioPlayer component — targets main

Story:
- core react component

Description:
Adds the AudioPlayer React component.

commits: a1b2c3..e4f5g6

## Task: Sandbox mode — Task 17080

Story:
- runs without auth

Description:
Sandbox mode.
`;

const stubDeps = {
  readDiff: () => 'FAKE_DIFF_CONTENT',
  readCommits: () => [
    { changeId: 'abc123', message: 'feat: add component\n\nbody' },
    { changeId: 'def456', message: 'feat: wire playback' },
  ],
  readProjectContext: () => 'FAKE_PROJECT_CONTEXT',
};

describe('core/gen-context buildContext', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('builds epic context with story, child task titles, project context', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    const ctx = buildContext({ level: 'epic', plan, deps: stubDeps });

    assert.match(ctx.story, /first milestone/);
    assert.match(ctx.currentDescription, /First milestone of the app/);
    assert.deepStrictEqual(ctx.childTaskTitles, ['Audio player', 'Sandbox mode']);
    assert.strictEqual(ctx.projectContext, 'FAKE_PROJECT_CONTEXT');
  });

  it('builds task context with parent epic description and child PR titles', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    const ctx = buildContext({ level: 'task', name: 'Audio player', plan, deps: stubDeps });

    assert.match(ctx.story, /adds audio playback/);
    assert.match(ctx.parentEpicDescription, /First milestone/);
    assert.deepStrictEqual(ctx.childPrTitles, ['AudioPlayer component']);
  });

  it('builds pr context with diff, commits, parent task + epic descriptions', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    const ctx = buildContext({ level: 'pr', name: 'AudioPlayer component', plan, deps: stubDeps });

    assert.match(ctx.story, /core react component/);
    assert.strictEqual(ctx.diff, 'FAKE_DIFF_CONTENT');
    assert.match(ctx.commitsText, /abc123/);
    assert.match(ctx.commitsText, /feat: add component/);
    assert.strictEqual(ctx.commitCount, 2);
    assert.match(ctx.parentTaskDescription, /Adds audio playback/);
    assert.match(ctx.parentEpicDescription, /First milestone/);
  });

  it('passes commits range to readDiff and readCommits', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    let seenRange = null;
    const deps = {
      ...stubDeps,
      readDiff: (range) => { seenRange = range; return ''; },
      readCommits: () => [],
    };

    buildContext({ level: 'pr', name: 'AudioPlayer component', plan, deps });
    assert.strictEqual(seenRange, 'a1b2c3..e4f5g6');
  });

  it('returns empty diff and zero commits when commits range is empty', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    const planText = '# Epic: E\n\n## Task: T\n\n### PR: P\n\nStory:\n- x\n';
    fs.writeFileSync('plan.md', planText);
    const plan = parse('plan.md');

    let readDiffCalled = false;
    let readCommitsCalled = false;
    const ctx = buildContext({
      level: 'pr', name: 'P', plan,
      deps: {
        readDiff: () => { readDiffCalled = true; return 'should not be called'; },
        readCommits: () => { readCommitsCalled = true; return []; },
      },
    });

    assert.strictEqual(ctx.diff, '');
    assert.strictEqual(ctx.commitCount, 0);
    assert.strictEqual(readDiffCalled, false);
    assert.strictEqual(readCommitsCalled, false);
  });

  it('throws when task name not found', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    assert.throws(
      () => buildContext({ level: 'task', name: 'Nonexistent', plan, deps: stubDeps }),
      /not found/i
    );
  });

  it('throws when pr name not found', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    assert.throws(
      () => buildContext({ level: 'pr', name: 'Nonexistent', plan, deps: stubDeps }),
      /not found/i
    );
  });

  it('throws on unknown level', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    const { buildContext } = await import('../../src/core/gen-context.mjs');
    fs.writeFileSync('plan.md', PLAN);
    const plan = parse('plan.md');

    assert.throws(
      () => buildContext({ level: 'bogus', plan, deps: stubDeps }),
      /level/i
    );
  });
});

describe('core/gen-context renderPrompt', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('substitutes simple string placeholders', async () => {
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('Hello {{name}}!', { name: 'world' });
    assert.strictEqual(out, 'Hello world!');
  });

  it('joins array values with newlines', async () => {
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('Items:\n{{items}}', { items: ['a', 'b', 'c'] });
    assert.match(out, /a\nb\nc/);
  });

  it('treats missing keys as empty string', async () => {
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('Before {{missing}} after', {});
    assert.strictEqual(out, 'Before  after');
  });

  it('handles numeric values', async () => {
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('Count: {{n}}', { n: 42 });
    assert.strictEqual(out, 'Count: 42');
  });

  it('leaves unknown placeholders with no match untouched', async () => {
    // "unknown" in context is empty string → empty replacement
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('Has {{defined}} and {{undef}}', { defined: 'yes' });
    assert.strictEqual(out, 'Has yes and ');
  });

  it('supports multiple occurrences of the same placeholder', async () => {
    const { renderPrompt } = await import('../../src/core/gen-context.mjs');
    const out = renderPrompt('{{x}} + {{x}}', { x: 'foo' });
    assert.strictEqual(out, 'foo + foo');
  });
});

describe('core/gen-context loadPrompt', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('loads the epic prompt template', async () => {
    const { loadPrompt } = await import('../../src/core/gen-context.mjs');
    const template = loadPrompt('epic');
    assert.match(template, /epic/i);
    assert.match(template, /\{\{story\}\}/);
  });

  it('loads the task prompt template', async () => {
    const { loadPrompt } = await import('../../src/core/gen-context.mjs');
    const template = loadPrompt('task');
    assert.match(template, /task/i);
    assert.match(template, /\{\{story\}\}/);
  });

  it('loads the pr prompt template', async () => {
    const { loadPrompt } = await import('../../src/core/gen-context.mjs');
    const template = loadPrompt('pr');
    assert.match(template, /\{\{diff\}\}/);
    assert.match(template, /\{\{commitsText\}\}/);
  });

  it('throws on unknown level', async () => {
    const { loadPrompt } = await import('../../src/core/gen-context.mjs');
    assert.throws(() => loadPrompt('bogus'), /prompt|level/i);
  });
});
