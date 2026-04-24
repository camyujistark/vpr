import { describe, it } from 'node:test';
import assert from 'node:assert';

const PLAN = {
  epic: {
    title: 'MVP1',
    wi: 17065,
    wiType: 'PBI',
    story: 'epic story',
    description: 'epic desc',
  },
  tasks: [
    {
      title: 'Audio player',
      wi: 17066,
      wiType: 'Task',
      story: 'ap story',
      description: 'ap desc',
      prs: [
        { title: 'AudioPlayer component', targets: 'main', commits: 'a..b', story: 's', description: 'd' },
        { title: 'Wire', targets: 'AudioPlayer component', commits: 'b..c', story: 's', description: 'd' },
      ],
    },
    {
      title: 'Sandbox',
      wi: 17080,
      wiType: 'Task',
      story: 'sb story',
      description: 'sb desc',
      prs: [],
    },
  ],
};

describe('tui-v0.2/tree flattenPlan', () => {
  it('returns epic as the first node', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    assert.strictEqual(flat[0].level, 'epic');
    assert.strictEqual(flat[0].title, 'MVP1');
    assert.strictEqual(flat[0].depth, 0);
  });

  it('returns tasks as depth 1 nodes', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    const tasks = flat.filter(n => n.level === 'task');
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].depth, 1);
    assert.strictEqual(tasks[0].title, 'Audio player');
    assert.strictEqual(tasks[1].title, 'Sandbox');
  });

  it('returns prs as depth 2 nodes under each task', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    const prs = flat.filter(n => n.level === 'pr');
    assert.strictEqual(prs.length, 2);
    assert.strictEqual(prs[0].depth, 2);
    assert.strictEqual(prs[0].title, 'AudioPlayer component');
    assert.strictEqual(prs[1].title, 'Wire');
  });

  it('preserves document order: epic, task, its PRs, next task', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    const titles = flat.map(n => n.title);
    assert.deepStrictEqual(titles, [
      'MVP1',
      'Audio player',
      'AudioPlayer component',
      'Wire',
      'Sandbox',
    ]);
  });

  it('attaches parent task reference to each PR node', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    const prNode = flat.find(n => n.title === 'AudioPlayer component');
    assert.strictEqual(prNode.parentTaskTitle, 'Audio player');
  });

  it('attaches the underlying section object to each node', async () => {
    const { flattenPlan } = await import('../../src/tui-v0.2/tree.mjs');
    const flat = flattenPlan(PLAN);
    assert.strictEqual(flat[0].node, PLAN.epic);
    assert.strictEqual(flat[1].node, PLAN.tasks[0]);
  });
});
