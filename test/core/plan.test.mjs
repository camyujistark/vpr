import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir, origCwd;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-plan-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
}

function teardown() {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const FULL_PLAN = `# Epic: MVP1 — PBI 17065

Story:
- first milestone
- audio playback
- sandbox mode

Description:
First milestone of the ding Convertor app.

## Task: Audio player — Task 17066

Story:
- adds audio playback
- msw mocks /api/audio/:id

Description:
Adds audio playback to the ding app.

### PR: AudioPlayer component — targets main

Story:
- core react component
- web audio api

Description:
Adds the AudioPlayer React component.

commits: a1b2c3..e4f5g6

### PR: Wire into ConversionView — targets AudioPlayer component

Story:
- replace placeholder

Description:
Replaces the placeholder.

commits: e4f5g6..i7j8k9

## Task: Sandbox mode — Task 17080

Story:
- runs without auth

Description:
Sandbox mode for demos.

### PR: Sandbox toggle — targets main

Story:
- toggle in header

Description:
Adds sandbox toggle.

commits: x1y2z3..a4b5c6
`;

describe('core/plan parse', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('parses an epic heading with title and PBI number', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.title, 'MVP1');
    assert.strictEqual(plan.epic.wi, 17065);
    assert.strictEqual(plan.epic.wiType, 'PBI');
  });

  it('parses epic Story and Description fields', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    assert.match(plan.epic.story, /first milestone/);
    assert.match(plan.epic.story, /audio playback/);
    assert.match(plan.epic.description, /First milestone of the ding/);
  });

  it('parses two tasks under the epic with correct titles and WI numbers', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks.length, 2);
    assert.strictEqual(plan.tasks[0].title, 'Audio player');
    assert.strictEqual(plan.tasks[0].wi, 17066);
    assert.strictEqual(plan.tasks[0].wiType, 'Task');
    assert.strictEqual(plan.tasks[1].title, 'Sandbox mode');
    assert.strictEqual(plan.tasks[1].wi, 17080);
  });

  it('parses task Story and Description', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    assert.match(plan.tasks[0].story, /msw mocks/);
    assert.match(plan.tasks[0].description, /Adds audio playback/);
  });

  it('parses PRs under each task with targets and commits range', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const audioPrs = plan.tasks[0].prs;
    assert.strictEqual(audioPrs.length, 2);
    assert.strictEqual(audioPrs[0].title, 'AudioPlayer component');
    assert.strictEqual(audioPrs[0].targets, 'main');
    assert.strictEqual(audioPrs[0].commits, 'a1b2c3..e4f5g6');
    assert.strictEqual(audioPrs[1].title, 'Wire into ConversionView');
    assert.strictEqual(audioPrs[1].targets, 'AudioPlayer component');
  });

  it('parses PR Story and Description', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const pr = plan.tasks[0].prs[0];
    assert.match(pr.story, /web audio api/);
    assert.match(pr.description, /Adds the AudioPlayer React component/);
  });

  it('handles missing WI numbers in headings', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: Unlinked\n\n## Task: Also unlinked\n');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.wi, null);
    assert.strictEqual(plan.tasks[0].wi, null);
  });

  it('handles empty Story and Description fields', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: Test\n\nStory:\n\nDescription:\n\n## Task: T\n');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.story, '');
    assert.strictEqual(plan.epic.description, '');
  });

  it('handles a plan with only an epic (no tasks or PRs)', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: Just an epic — PBI 1\n');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.title, 'Just an epic');
    assert.strictEqual(plan.tasks.length, 0);
  });

  it('defaults PR targets to main when omitted on first PR', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: E\n\n## Task: T\n\n### PR: First\n\ncommits: a..b\n');
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].prs[0].targets, 'main');
  });

  it('defaults PR targets to previous sibling when omitted on second PR', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: E\n\n## Task: T\n\n### PR: First\n\ncommits: a..b\n\n### PR: Second\n\ncommits: b..c\n');
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].prs[1].targets, 'First');
  });

  it('errors on missing epic heading', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '## Task: Orphan\n');
    assert.throws(() => parse('plan.md'), /epic/i);
  });

  it('errors on task before epic', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '## Task: Orphan\n\n# Epic: Late\n');
    assert.throws(() => parse('plan.md'), /before|epic/i);
  });

  it('errors on PR before any task', async () => {
    const { parse } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: E\n\n### PR: Orphan\n');
    assert.throws(() => parse('plan.md'), /task/i);
  });
});

describe('core/plan writeDescription', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('replaces Description on the epic without touching Story', async () => {
    const { parse, writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    writeDescription('plan.md', { level: 'epic' }, 'NEW EPIC DESCRIPTION');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.description, 'NEW EPIC DESCRIPTION');
    assert.match(plan.epic.story, /first milestone/);
  });

  it('replaces Description on a task by title', async () => {
    const { parse, writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    writeDescription('plan.md', { level: 'task', name: 'Audio player' }, 'NEW TASK DESCRIPTION');
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].description, 'NEW TASK DESCRIPTION');
    assert.strictEqual(plan.tasks[1].description, 'Sandbox mode for demos.');
  });

  it('replaces Description on a PR by title', async () => {
    const { parse, writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    writeDescription('plan.md', { level: 'pr', name: 'AudioPlayer component' }, 'NEW PR DESCRIPTION');
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].prs[0].description, 'NEW PR DESCRIPTION');
    assert.match(plan.tasks[0].prs[1].description, /Replaces the placeholder/);
  });

  it('preserves commits line when replacing PR Description', async () => {
    const { parse, writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    writeDescription('plan.md', { level: 'pr', name: 'AudioPlayer component' }, 'NEW');
    const plan = parse('plan.md');
    assert.strictEqual(plan.tasks[0].prs[0].commits, 'a1b2c3..e4f5g6');
  });

  it('inserts Description block when section has Story but no Description yet', async () => {
    const { parse, writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', '# Epic: E — PBI 1\n\nStory:\n- note\n\n## Task: T\n');
    writeDescription('plan.md', { level: 'epic' }, 'POLISHED');
    const plan = parse('plan.md');
    assert.strictEqual(plan.epic.description, 'POLISHED');
    assert.match(plan.epic.story, /note/);
  });

  it('errors when target section not found', async () => {
    const { writeDescription } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    assert.throws(
      () => writeDescription('plan.md', { level: 'task', name: 'Nonexistent' }, 'X'),
      /not found/i
    );
  });
});

describe('core/plan findSection', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('finds task by exact title', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const found = findSection(plan, { level: 'task', name: 'Audio player' });
    assert.strictEqual(found.title, 'Audio player');
  });

  it('finds PR by exact title', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const found = findSection(plan, { level: 'pr', name: 'AudioPlayer component' });
    assert.strictEqual(found.title, 'AudioPlayer component');
  });

  it('finds by partial (case-insensitive substring) match', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const found = findSection(plan, { level: 'task', name: 'audio' });
    assert.strictEqual(found.title, 'Audio player');
  });

  it('errors on ambiguous partial match', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md',
      '# Epic: E\n\n## Task: AudioPlayer\n\n## Task: AudioUploader\n');
    const plan = parse('plan.md');
    assert.throws(() => findSection(plan, { level: 'task', name: 'Audio' }), /ambiguous/i);
  });

  it('returns epic for level=epic regardless of name', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const found = findSection(plan, { level: 'epic' });
    assert.strictEqual(found.title, 'MVP1');
  });

  it('returns null when not found', async () => {
    const { parse, findSection } = await import('../../src/core/plan.mjs');
    fs.writeFileSync('plan.md', FULL_PLAN);
    const plan = parse('plan.md');
    const found = findSection(plan, { level: 'pr', name: 'Nonexistent' });
    assert.strictEqual(found, null);
  });
});
