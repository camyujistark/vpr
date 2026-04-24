import { describe, it } from 'node:test';
import assert from 'node:assert';

const NODES = [
  { level: 'epic', title: 'MVP1', depth: 0, node: {} },
  { level: 'task', title: 'Audio player', depth: 1, node: {} },
  { level: 'pr', title: 'AudioPlayer component', depth: 2, node: {}, parentTaskTitle: 'Audio player' },
  { level: 'task', title: 'Sandbox', depth: 1, node: {} },
];

function s(overrides = {}) {
  return { cursor: 0, showHelp: false, status: '', ...overrides };
}

describe('tui-v0.2/keys handleKey navigation', () => {
  it('j moves cursor down', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'j', NODES);
    assert.strictEqual(out.state.cursor, 1);
  });

  it('k moves cursor up', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 2 }), 'k', NODES);
    assert.strictEqual(out.state.cursor, 1);
  });

  it('j at end stays at end', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 3 }), 'j', NODES);
    assert.strictEqual(out.state.cursor, 3);
  });

  it('k at top stays at top', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 0 }), 'k', NODES);
    assert.strictEqual(out.state.cursor, 0);
  });

  it('g (lowercase g as "top") and G handled separately', async () => {
    // We don't overload g for vim top-of-document in this MVP;
    // g fires the gen action, G fires gen-all.
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const outG = handleKey(s({ cursor: 1 }), 'g', NODES);
    assert.strictEqual(outG.action.type, 'gen');
    const outGG = handleKey(s(), 'G', NODES);
    assert.strictEqual(outGG.action.type, 'gen-all');
  });
});

describe('tui-v0.2/keys handleKey actions', () => {
  it('q returns quit action', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'q', NODES);
    assert.strictEqual(out.action.type, 'quit');
  });

  it('Ctrl-C returns quit action', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), '\x03', NODES);
    assert.strictEqual(out.action.type, 'quit');
  });

  it('r returns refresh action', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'r', NODES);
    assert.strictEqual(out.action.type, 'refresh');
  });

  it('e returns edit-plan action', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'e', NODES);
    assert.strictEqual(out.action.type, 'edit-plan');
  });

  it('g on epic returns gen action with level=epic, no name', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 0 }), 'g', NODES);
    assert.deepStrictEqual(out.action, { type: 'gen', level: 'epic', name: null });
  });

  it('g on task returns gen action with level=task and name', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 1 }), 'g', NODES);
    assert.deepStrictEqual(out.action, { type: 'gen', level: 'task', name: 'Audio player' });
  });

  it('g on pr returns gen action with level=pr and name', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s({ cursor: 2 }), 'g', NODES);
    assert.deepStrictEqual(out.action, { type: 'gen', level: 'pr', name: 'AudioPlayer component' });
  });

  it('p returns ship action', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'p', NODES);
    assert.strictEqual(out.action.type, 'ship');
    assert.strictEqual(!!out.action.dry, false);
  });

  it('P returns ship action with dry=true', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out = handleKey(s(), 'P', NODES);
    assert.strictEqual(out.action.type, 'ship');
    assert.strictEqual(out.action.dry, true);
  });

  it('? toggles showHelp in state', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const out1 = handleKey(s(), '?', NODES);
    assert.strictEqual(out1.state.showHelp, true);
    const out2 = handleKey(s({ showHelp: true }), '?', NODES);
    assert.strictEqual(out2.state.showHelp, false);
  });

  it('unknown key does nothing', async () => {
    const { handleKey } = await import('../../src/tui-v0.2/keys.mjs');
    const before = s({ cursor: 2, status: 'prior' });
    const out = handleKey(before, 'z', NODES);
    assert.deepStrictEqual(out.state, before);
    assert.strictEqual(out.action, null);
  });
});
