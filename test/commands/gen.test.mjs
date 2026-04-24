import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-gen-'));
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
Old epic description.

## Task: Audio player — Task 17066

Story:
- adds audio playback

Description:
Old task description.

### PR: AudioPlayer component — targets main

Story:
- core react component

Description:
Old pr description.

commits: a1b2c3..e4f5g6
`;

function makeDeps(overrides = {}) {
  return {
    runShell: (_cmd, _stdin) => 'POLISHED',
    runEditor: (_editor, tmpFile) => {
      // simulate user accepting LLM output unchanged (no edits)
      // content is already seeded — leave it as-is
    },
    readDiff: () => 'FAKE_DIFF',
    readCommits: () => [{ changeId: 'abc', message: 'commit msg' }],
    readProjectContext: () => 'PROJECT',
    ...overrides,
  };
}

describe('commands/gen gen', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('writes polished description to plan.md at epic level', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', PLAN);

    const result = gen({ level: 'epic', deps: makeDeps() });

    assert.strictEqual(result.status, 'written');
    assert.strictEqual(result.content, 'POLISHED');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.description, 'POLISHED');
    assert.match(plan.epic.story, /first milestone/);
  });

  it('writes polished description at task level', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', PLAN);

    gen({ level: 'task', name: 'Audio player', deps: makeDeps() });

    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].description, 'POLISHED');
  });

  it('writes polished description at pr level', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', PLAN);

    gen({ level: 'pr', name: 'AudioPlayer component', deps: makeDeps() });

    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].prs[0].description, 'POLISHED');
    assert.strictEqual(plan.tasks[0].prs[0].commits, 'a1b2c3..e4f5g6');
  });

  it('--dry returns content and does not modify plan.md', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    const result = gen({ level: 'epic', dry: true, deps: makeDeps() });

    assert.strictEqual(result.status, 'dry');
    assert.strictEqual(result.content, 'POLISHED');
    const after = fs.readFileSync('plan.md', 'utf-8');
    assert.strictEqual(after, PLAN);
  });

  it('--pipe returns the rendered prompt and does not call runShell', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    let runShellCalled = false;
    const deps = makeDeps({
      runShell: () => { runShellCalled = true; return 'X'; },
    });
    const result = gen({ level: 'epic', pipe: true, deps });

    assert.strictEqual(result.status, 'pipe');
    assert.match(result.prompt, /first milestone/);
    assert.match(result.prompt, /Old epic description/);
    assert.strictEqual(runShellCalled, false);
  });

  it('--yes skips editor review and writes LLM output directly', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', PLAN);

    let runEditorCalled = false;
    const deps = makeDeps({
      runEditor: () => { runEditorCalled = true; },
    });
    const result = gen({ level: 'epic', yes: true, deps });

    assert.strictEqual(result.status, 'written');
    assert.strictEqual(runEditorCalled, false);
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.description, 'POLISHED');
  });

  it('--fresh omits currentDescription from the prompt', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    let seenPrompt = null;
    const deps = makeDeps({
      runShell: (_cmd, stdin) => { seenPrompt = stdin; return 'POLISHED'; },
    });
    gen({ level: 'epic', fresh: true, yes: true, deps });

    assert.doesNotMatch(seenPrompt, /Old epic description/);
  });

  it('editor-discard (null return) does not modify plan.md', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    const deps = makeDeps({
      runEditor: (_editor, tmpFile) => fs.writeFileSync(tmpFile, ''),
    });
    const result = gen({ level: 'epic', deps });

    assert.strictEqual(result.status, 'discarded');
    const after = fs.readFileSync('plan.md', 'utf-8');
    assert.strictEqual(after, PLAN);
  });

  it('editor-modified content lands in plan.md', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', PLAN);

    const deps = makeDeps({
      runEditor: (_editor, tmpFile) => fs.writeFileSync(tmpFile, 'HUMAN-EDITED'),
    });
    gen({ level: 'epic', deps });

    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.description, 'HUMAN-EDITED');
  });

  it('errors when section not found', async () => {
    const { gen } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    assert.throws(
      () => gen({ level: 'task', name: 'Nonexistent', deps: makeDeps() }),
      /not found/i
    );
  });
});

describe('commands/gen genAll', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('iterates epic, every task, and every pr', async () => {
    const { genAll } = await import('../../src/commands/gen.mjs');
    fs.writeFileSync('plan.md', PLAN);

    const seenTargets = [];
    const deps = makeDeps({
      runShell: (_cmd, stdin) => {
        // extract section's Story to determine which target is running
        if (stdin.includes('first milestone')) seenTargets.push('epic');
        else if (stdin.includes('adds audio playback')) seenTargets.push('task:audio');
        else if (stdin.includes('core react component')) seenTargets.push('pr:audioplayer');
        return 'POLISHED';
      },
    });

    const results = genAll({ yes: true, deps });

    assert.deepStrictEqual(seenTargets, ['epic', 'task:audio', 'pr:audioplayer']);
    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.status === 'written'));
  });

  it('continues past a section with empty story, recording a skip', async () => {
    const { genAll } = await import('../../src/commands/gen.mjs');
    const PLAN_MIXED = `# Epic: E — PBI 1

Story:
- has notes

## Task: Has story

Story:
- notes here

## Task: Empty story
`;
    fs.writeFileSync('plan.md', PLAN_MIXED);

    const results = genAll({ yes: true, deps: makeDeps() });

    const byTarget = Object.fromEntries(
      results.map(r => [`${r.level}:${r.name || ''}`, r.status])
    );
    assert.strictEqual(byTarget['epic:'], 'written');
    assert.strictEqual(byTarget['task:Has story'], 'written');
    assert.strictEqual(byTarget['task:Empty story'], 'skipped-no-story');
  });
});
