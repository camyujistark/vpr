import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, ready as readyQ, blocked, released as releasedQ, next, upstream, downstream, status, findByWi, wouldCycle } from '../../src/core/dag.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState({ items = {}, sent = {} } = {}) {
  return { items, sent };
}

function makeItem(name, { wi = null, dependsOn = [], vprs = [] } = {}) {
  return { name, wi, dependsOn, vprs };
}

// items as array; state.items stays as object keyed by name for dag-engine
function stateFromItems(itemArr, sent = {}) {
  const items = Object.fromEntries(itemArr.map(it => [it.name, it]));
  return { items, sent };
}

// ---------------------------------------------------------------------------
// Criterion 1: analyze(state) returns { nodes, cycles, order, byWi }
// ---------------------------------------------------------------------------

describe('analyze() — return shape', () => {
  it('returns nodes, cycles, order, byWi for empty state', () => {
    const result = analyze(makeState());
    assert.ok(result.nodes instanceof Map, 'nodes is a Map');
    assert.ok(Array.isArray(result.cycles), 'cycles is an array');
    assert.ok(Array.isArray(result.order), 'order is an array');
    assert.ok(result.byWi instanceof Map, 'byWi is a Map');
  });

  it('empty state produces empty collections', () => {
    const result = analyze(makeState());
    assert.equal(result.nodes.size, 0);
    assert.equal(result.cycles.length, 0);
    assert.equal(result.order.length, 0);
    assert.equal(result.byWi.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: nodes ItemView shape
// ---------------------------------------------------------------------------

describe('analyze() — ItemView shape', () => {
  it('each node has the required fields', () => {
    const state = stateFromItems([makeItem('foo', { wi: 42 })]);
    const { nodes } = analyze(state);
    const node = nodes.get('foo');
    assert.ok(node, 'node exists for item');
    const requiredFields = ['name', 'wi', 'status', 'blockers', 'depth', 'vprCount', 'released', 'done', 'ready'];
    for (const f of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(node, f), `node has field: ${f}`);
    }
  });

  it('node.name and node.wi match item', () => {
    const state = stateFromItems([makeItem('alpha', { wi: 7 })]);
    const { nodes } = analyze(state);
    const node = nodes.get('alpha');
    assert.equal(node.name, 'alpha');
    assert.equal(node.wi, 7);
  });

  it('single item with no deps has no blockers', () => {
    const state = stateFromItems([makeItem('foo', { wi: 1 })]);
    const { nodes } = analyze(state);
    assert.deepEqual(nodes.get('foo').blockers, []);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 & 4: cycles and order
// ---------------------------------------------------------------------------

describe('analyze() — topological order (no cycles)', () => {
  it('single item with no deps', () => {
    const state = stateFromItems([makeItem('a')]);
    const { order, cycles } = analyze(state);
    assert.deepEqual(cycles, []);
    assert.deepEqual(order, ['a']);
  });

  it('linear chain a→b→c: order is [a, b, c]', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const c = makeItem('c', { dependsOn: ['b'] });
    const state = stateFromItems([a, b, c]);
    const { order, cycles } = analyze(state);
    assert.deepEqual(cycles, []);
    // a before b before c
    assert.ok(order.indexOf('a') < order.indexOf('b'), 'a before b');
    assert.ok(order.indexOf('b') < order.indexOf('c'), 'b before c');
  });
});

describe('analyze() — cycle detection', () => {
  it('self-loop: a depends on a', () => {
    const a = makeItem('a', { dependsOn: ['a'] });
    const state = stateFromItems([a]);
    const { cycles } = analyze(state);
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0].includes('a'));
  });

  it('2-node cycle: a→b, b→a', () => {
    const a = makeItem('a', { dependsOn: ['b'] });
    const b = makeItem('b', { dependsOn: ['a'] });
    const state = stateFromItems([a, b]);
    const { cycles } = analyze(state);
    assert.ok(cycles.length >= 1, 'detects 2-node cycle');
    const names = cycles.flat();
    assert.ok(names.includes('a') && names.includes('b'));
  });

  it('3-node cycle: a→b→c→a', () => {
    const a = makeItem('a', { dependsOn: ['c'] });
    const b = makeItem('b', { dependsOn: ['a'] });
    const c = makeItem('c', { dependsOn: ['b'] });
    const state = stateFromItems([a, b, c]);
    const { cycles } = analyze(state);
    assert.ok(cycles.length >= 1, 'detects 3-node cycle');
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: byWi map
// ---------------------------------------------------------------------------

describe('analyze() — byWi', () => {
  it('maps wi numbers to item names', () => {
    const state = stateFromItems([makeItem('foo', { wi: 10 }), makeItem('bar', { wi: 20 })]);
    const { byWi } = analyze(state);
    assert.equal(byWi.get(10), 'foo');
    assert.equal(byWi.get(20), 'bar');
  });

  it('skips items with null wi', () => {
    const state = stateFromItems([makeItem('no-wi'), makeItem('has-wi', { wi: 5 })]);
    const { byWi } = analyze(state);
    assert.equal(byWi.size, 1);
    assert.equal(byWi.get(5), 'has-wi');
  });
});

// ---------------------------------------------------------------------------
// Criterion 9 & 10: released / blockers rules
// ---------------------------------------------------------------------------

describe('analyze() — released and blockers', () => {
  it('unreleased dep blocks downstream item', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const state = stateFromItems([a, b]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('b').released, false);
    assert.deepEqual(nodes.get('b').blockers, ['a']);
  });

  it('released dep does not block downstream', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const sent = { 'feat/a-1': { itemName: 'a', prId: 1 } };
    const state = stateFromItems([a, b], sent);
    const { nodes } = analyze(state);
    assert.deepEqual(nodes.get('b').blockers, []);
  });

  it('abandoned dep re-blocks downstream', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const sent = { 'feat/a-1': { itemName: 'a', prId: 1, abandoned: true } };
    const state = stateFromItems([a, b], sent);
    const { nodes } = analyze(state);
    assert.deepEqual(nodes.get('b').blockers, ['a']);
  });

  it('dangling dep name (not in items) treated as released — does not block', () => {
    const b = makeItem('b', { dependsOn: ['ghost'] });
    const state = stateFromItems([b]);
    const { nodes } = analyze(state);
    assert.deepEqual(nodes.get('b').blockers, []);
  });
});

// ---------------------------------------------------------------------------
// Criterion 11: ready
// ---------------------------------------------------------------------------

describe('analyze() — ready', () => {
  it('item with no deps and not done is ready', () => {
    const state = stateFromItems([makeItem('a')]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').ready, true);
  });

  it('item that is done is not ready', () => {
    const a = makeItem('a');
    const sent = { 'feat/a-1': { itemName: 'a', prId: 1, itemDone: true } };
    const state = stateFromItems([a], sent);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').done, true);
    assert.equal(nodes.get('a').ready, false);
  });

  it('item with unreleased dep is not ready', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const state = stateFromItems([a, b]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('b').ready, false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 12: depth
// ---------------------------------------------------------------------------

describe('analyze() — depth', () => {
  it('root item has depth 0', () => {
    const state = stateFromItems([makeItem('a')]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').depth, 0);
  });

  it('linear chain: depths 0, 1, 2', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const c = makeItem('c', { dependsOn: ['b'] });
    const state = stateFromItems([a, b, c]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').depth, 0);
    assert.equal(nodes.get('b').depth, 1);
    assert.equal(nodes.get('c').depth, 2);
  });

  it('branching DAG: depth is longest path', () => {
    // a(0) → c(1), b(0) → c(1), so c has depth 1 from both
    // But if a→b→c, then c has depth 2
    // Setup: a(0)→c, b(0)→c. c's longest path is 1 from any direction
    const a = makeItem('a');
    const b = makeItem('b');
    const c = makeItem('c', { dependsOn: ['a', 'b'] });
    const state = stateFromItems([a, b, c]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').depth, 0);
    assert.equal(nodes.get('b').depth, 0);
    assert.equal(nodes.get('c').depth, 1);
  });

  it('cycle members get depth -Infinity (sentinel)', () => {
    const a = makeItem('a', { dependsOn: ['b'] });
    const b = makeItem('b', { dependsOn: ['a'] });
    const state = stateFromItems([a, b]);
    const { nodes } = analyze(state);
    assert.equal(nodes.get('a').depth, -Infinity);
    assert.equal(nodes.get('b').depth, -Infinity);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 & 7: canonical queries
// ---------------------------------------------------------------------------

describe('canonical queries', () => {

  it('ready() returns items with ready===true', () => {
    const state = stateFromItems([makeItem('a'), makeItem('b', { dependsOn: ['a'] })]);
    const result = readyQ(state);
    assert.deepEqual(result, ['a']);
  });

  it('blocked() returns items with blockers.length > 0', () => {
    const state = stateFromItems([makeItem('a'), makeItem('b', { dependsOn: ['a'] })]);
    const result = blocked(state);
    assert.deepEqual(result, ['b']);
  });

  it('released() returns items that are released', () => {
    const a = makeItem('a');
    const b = makeItem('b');
    const sent = { 'feat/a-1': { itemName: 'a', prId: 1 } };
    const state = stateFromItems([a, b], sent);
    const result = releasedQ(state);
    assert.deepEqual(result, ['a']);
  });

  it('next() returns first ready item sorted by depth then name', () => {
    const a = makeItem('a');
    const b = makeItem('b');
    const state = stateFromItems([a, b]);
    const result = next(state);
    // Both depth 0, sort by name: 'a' < 'b'
    assert.equal(result, 'a');
  });

  it('next() returns null when no ready items', () => {
    const a = makeItem('a', { dependsOn: ['b'] });
    const b = makeItem('b', { dependsOn: ['a'] });
    const state = stateFromItems([a, b]);
    assert.equal(next(state), null);
  });

  it('upstream() returns direct and transitive deps', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const c = makeItem('c', { dependsOn: ['b'] });
    const state = stateFromItems([a, b, c]);
    const result = upstream('c', state);
    assert.ok(result.includes('b'));
    assert.ok(result.includes('a'));
    assert.ok(!result.includes('c'));
  });

  it('downstream() returns items that depend on given item', () => {
    const a = makeItem('a');
    const b = makeItem('b', { dependsOn: ['a'] });
    const c = makeItem('c', { dependsOn: ['a'] });
    const state = stateFromItems([a, b, c]);
    const result = downstream('a', state);
    assert.ok(result.includes('b'));
    assert.ok(result.includes('c'));
  });

  it('status() returns the node for an item', () => {
    const state = stateFromItems([makeItem('a', { wi: 3 })]);
    const node = status('a', state);
    assert.equal(node.name, 'a');
    assert.equal(node.wi, 3);
  });

  it('findByWi() returns item name for a wi number', () => {
    const state = stateFromItems([makeItem('foo', { wi: 99 })]);
    assert.equal(findByWi(99, state), 'foo');
    assert.equal(findByWi(0, state), null);
  });

  it('queries accept pre-built view from analyze()', () => {
    const state = stateFromItems([makeItem('a'), makeItem('b', { dependsOn: ['a'] })]);
    const view = analyze(state);
    assert.deepEqual(readyQ(view), ['a']);
    assert.deepEqual(blocked(view), ['b']);
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: wouldCycle
// ---------------------------------------------------------------------------

describe('wouldCycle()', () => {

  it('returns null when adding dep would not cause a cycle', () => {
    const state = stateFromItems([makeItem('a'), makeItem('b')]);
    assert.equal(wouldCycle(state, 'b', 'a'), null);
  });

  it('returns cycle path when adding dep would cause a cycle', () => {
    // a depends on b; adding b→a would cycle
    const a = makeItem('a', { dependsOn: ['b'] });
    const b = makeItem('b');
    const state = stateFromItems([a, b]);
    const result = wouldCycle(state, 'a', 'b');
    assert.ok(result !== null, 'detects cycle');
    assert.ok(Array.isArray(result));
  });

  it('self-loop: from === to', () => {
    const state = stateFromItems([makeItem('a')]);
    const result = wouldCycle(state, 'a', 'a');
    assert.ok(result !== null);
  });
});

// ---------------------------------------------------------------------------
// Criterion 14: fan-out ≥10 items
// ---------------------------------------------------------------------------

describe('analyze() — fan-out ≥10 items', () => {
  it('handles 10+ items branching from a single root', () => {
    const root = makeItem('root');
    const leaves = Array.from({ length: 10 }, (_, i) => makeItem(`leaf-${i}`, { dependsOn: ['root'] }));
    const state = stateFromItems([root, ...leaves]);
    const { nodes, cycles, order } = analyze(state);
    assert.equal(cycles.length, 0);
    assert.equal(nodes.get('root').depth, 0);
    for (let i = 0; i < 10; i++) {
      assert.equal(nodes.get(`leaf-${i}`).depth, 1);
    }
    assert.equal(order.length, 11);
    assert.equal(order[0], 'root');
  });
});
