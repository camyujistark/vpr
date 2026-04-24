import { describe, it } from 'node:test';
import assert from 'node:assert';

const NODES = [
  { level: 'epic', title: 'MVP1', depth: 0, node: { wi: 17065 } },
  { level: 'task', title: 'Audio player', depth: 1, node: { wi: 17066 } },
  { level: 'pr',   title: 'AudioPlayer component', depth: 2, node: { commits: 'a..b' }, parentTaskTitle: 'Audio player' },
  { level: 'pr',   title: 'Wire', depth: 2, node: { commits: 'b..c' }, parentTaskTitle: 'Audio player' },
  { level: 'task', title: 'Sandbox', depth: 1, node: { wi: 17080 } },
];

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

describe('tui-v0.2/render renderTree', () => {
  it('renders one line per node in document order', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    const lines = stripAnsi(output).split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 5);
  });

  it('includes epic title on the first line', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    assert.match(stripAnsi(output), /MVP1/);
  });

  it('indents tasks deeper than epic', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    const lines = stripAnsi(output).split('\n');
    const epicLine = lines.find(l => l.includes('MVP1'));
    const taskLine = lines.find(l => l.includes('Audio player'));
    assert.ok(taskLine.indexOf('Audio') > epicLine.indexOf('MVP1'));
  });

  it('indents prs deeper than tasks', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    const lines = stripAnsi(output).split('\n');
    const taskLine = lines.find(l => l.includes('Audio player'));
    const prLine = lines.find(l => l.includes('AudioPlayer component'));
    assert.ok(prLine.indexOf('AudioPlayer') > taskLine.indexOf('Audio'));
  });

  it('marks the cursor line with a caret or similar', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 2);
    const lines = stripAnsi(output).split('\n');
    const prLine = lines.find(l => l.includes('AudioPlayer component'));
    assert.match(prLine, /[▸>→]/);
  });

  it('does not mark non-cursor lines', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 2);
    const lines = stripAnsi(output).split('\n');
    const epicLine = lines.find(l => l.includes('MVP1'));
    assert.doesNotMatch(epicLine, /[▸>→]/);
  });

  it('shows commit range for pr nodes', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    assert.match(stripAnsi(output), /a\.\.b/);
  });

  it('shows WI number for epic and tasks', async () => {
    const { renderTree } = await import('../../src/tui-v0.2/render.mjs');
    const output = renderTree(NODES, 0);
    const out = stripAnsi(output);
    assert.match(out, /17065/);
    assert.match(out, /17066/);
    assert.match(out, /17080/);
  });
});

describe('tui-v0.2/render renderHelp', () => {
  it('lists the core keybindings', async () => {
    const { renderHelp } = await import('../../src/tui-v0.2/render.mjs');
    const help = stripAnsi(renderHelp());
    assert.match(help, /j.*down/i);
    assert.match(help, /k.*up/i);
    assert.match(help, /g.*gen/i);
    assert.match(help, /e.*edit/i);
    assert.match(help, /p.*ship/i);
    assert.match(help, /q.*quit/i);
  });
});
