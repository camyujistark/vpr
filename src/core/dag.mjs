import { isReleased, isDone } from './lifecycle.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @returns {object} items map from state or view */
function itemsMap(stateOrView) {
  if (stateOrView instanceof Map || (stateOrView.nodes instanceof Map)) {
    return stateOrView; // already a view — caller must use .nodes
  }
  return stateOrView.items ?? {};
}

/** True if the argument looks like a pre-built view from analyze() */
function isView(x) {
  return x != null && x.nodes instanceof Map;
}

/**
 * Compute depth (longest path from root) for each non-cycle node using
 * a post-order DFS on the dependency graph (edges go dep → dependent).
 *
 * @param {string[]} order   - topological order (deps before dependents)
 * @param {Map<string, string[]>} deps - item → its dependsOn (known-item deps only)
 * @param {Set<string>} cycleMembers
 * @returns {Map<string, number>}
 */
function computeDepths(order, deps, cycleMembers) {
  const depth = new Map();
  for (const name of order) {
    if (cycleMembers.has(name)) {
      depth.set(name, -Infinity);
      continue;
    }
    const itemDeps = deps.get(name) ?? [];
    let max = -1;
    for (const d of itemDeps) {
      if (cycleMembers.has(d)) continue; // ignore cycle edges for depth
      const dd = depth.get(d) ?? 0;
      if (dd > max) max = dd;
    }
    depth.set(name, max + 1);
  }
  return depth;
}

/**
 * Tarjan's SCC to find all strongly connected components with size > 1
 * (genuine cycles) or self-loops.
 *
 * Returns an array of SCCs, each as an array of item names.
 */
function findCycles(names, adjIn) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  function strongconnect(v) {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of (adjIn.get(v) ?? [])) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const n of names) {
    if (!index.has(n)) strongconnect(n);
  }

  // Keep SCCs that are genuine cycles: size>1 OR self-loop
  const selfLoops = new Set();
  for (const [v, deps] of adjIn) {
    if (deps.includes(v)) selfLoops.add(v);
  }

  return sccs.filter(scc => scc.length > 1 || selfLoops.has(scc[0]));
}

/**
 * Kahn's algorithm for topological sort.
 * Returns names in topo order (roots first). Cycle members appended at end.
 *
 * @param {string[]} names
 * @param {Map<string, string[]>} depsMap - item → known-item deps only
 * @param {Set<string>} cycleMembers
 */
function topoSort(names, depsMap, cycleMembers) {
  const nonCycle = names.filter(n => !cycleMembers.has(n));

  // Build in-degree and adjacency for Kahn's
  const inDegree = new Map(nonCycle.map(n => [n, 0]));
  const outEdges = new Map(nonCycle.map(n => [n, []]));

  for (const n of nonCycle) {
    const deps = depsMap.get(n) ?? [];
    for (const d of deps) {
      if (!cycleMembers.has(d) && inDegree.has(d)) {
        // edge: d → n (d must come before n)
        outEdges.get(d).push(n);
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }
  }

  const queue = nonCycle.filter(n => inDegree.get(n) === 0).sort();
  const order = [];

  while (queue.length > 0) {
    // stable sort: sort within same depth tier by name
    queue.sort();
    const n = queue.shift();
    order.push(n);
    for (const m of (outEdges.get(n) ?? [])) {
      inDegree.set(m, inDegree.get(m) - 1);
      if (inDegree.get(m) === 0) {
        queue.push(m);
      }
    }
  }

  // Append cycle members at end (stable sort by name)
  const cycleArr = [...cycleMembers].sort();
  return [...order, ...cycleArr];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, wi: number|null, status: string, blockers: string[], depth: number, vprCount: number, released: boolean, done: boolean, ready: boolean }} ItemView
 */

/**
 * Analyze state and return a full DAG view.
 *
 * @param {{ items: object, sent: object }} state
 * @returns {{ nodes: Map<string, ItemView>, cycles: string[][], order: string[], byWi: Map<number, string> }}
 */
export function analyze(state) {
  const itemsObj = state.items ?? {};
  const sentObj = state.sent ?? {};
  const names = Object.keys(itemsObj);

  // Build dep map filtering out dangling refs
  const knownNames = new Set(names);
  /** @type {Map<string, string[]>} */
  const depsMap = new Map();
  for (const name of names) {
    const item = itemsObj[name];
    const raw = item.dependsOn ?? [];
    // Only keep deps that exist in items (dangling = treated as released)
    depsMap.set(name, raw.filter(d => knownNames.has(d)));
  }

  // Build adjacency for cycle detection (v depends on its depsMap entries)
  const adjIn = new Map(names.map(n => [n, depsMap.get(n) ?? []]));

  // Find cycles
  const rawCycles = findCycles(names, adjIn);
  const cycleMembers = new Set(rawCycles.flat());

  // Build order
  const order = topoSort(names, depsMap, cycleMembers);

  // Compute depths
  const depthMap = computeDepths(order, depsMap, cycleMembers);

  // Build byWi
  const byWi = new Map();
  for (const name of names) {
    const wi = itemsObj[name].wi;
    if (wi != null) byWi.set(wi, name);
  }

  // Build nodes
  const nodes = new Map();
  for (const name of names) {
    const item = itemsObj[name];
    const releasedFlag = isReleased(name, sentObj);
    const doneFlag = isDone(name, sentObj);

    // blockers = known deps that are not released
    const rawDeps = item.dependsOn ?? [];
    const blockers = rawDeps.filter(d => knownNames.has(d) && !isReleased(d, sentObj));

    const readyFlag = !doneFlag && blockers.length === 0;
    const depth = depthMap.get(name) ?? 0;
    const vprCount = Object.keys(item.vprs ?? {}).length;

    // status: simple string derived from flags
    const statusStr = doneFlag ? 'done' : releasedFlag ? 'released' : readyFlag ? 'ready' : 'blocked';

    nodes.set(name, {
      name,
      wi: item.wi ?? null,
      status: statusStr,
      blockers,
      depth,
      vprCount,
      released: releasedFlag,
      done: doneFlag,
      ready: readyFlag,
    });
  }

  return { nodes, cycles: rawCycles, order, byWi };
}

// ---------------------------------------------------------------------------
// Canonical queries — accept raw state OR pre-built view
// ---------------------------------------------------------------------------

function ensureView(stateOrView) {
  return isView(stateOrView) ? stateOrView : analyze(stateOrView);
}

/** @returns {string[]} item names that are ready, sorted by depth asc then name asc */
export function ready(stateOrView) {
  const { nodes } = ensureView(stateOrView);
  return [...nodes.values()]
    .filter(n => n.ready)
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
    .map(n => n.name);
}

/** @returns {string[]} item names that have blockers */
export function blocked(stateOrView) {
  const { nodes } = ensureView(stateOrView);
  return [...nodes.values()].filter(n => n.blockers.length > 0).map(n => n.name);
}

/** @returns {string[]} item names that are released */
export function released(stateOrView) {
  const { nodes } = ensureView(stateOrView);
  return [...nodes.values()].filter(n => n.released).map(n => n.name);
}

/** @returns {string|null} first ready item (depth asc, name asc) or null */
export function next(stateOrView) {
  return ready(stateOrView)[0] ?? null;
}

/** @returns {string[]} all items that the given item depends on (direct + transitive) */
export function upstream(name, stateOrView) {
  const state = isView(stateOrView) ? null : stateOrView;
  const itemsObj = state ? (state.items ?? {}) : null;

  // Need items for deps; if view passed, re-derive from view
  const getItem = (n) => {
    if (itemsObj) return itemsObj[n];
    return null;
  };

  // Re-derive items from state only
  const src = state ?? stateOrView;
  const items = (isView(src) ? null : src.items) ?? {};

  const visited = new Set();
  const queue = [name];
  while (queue.length) {
    const cur = queue.shift();
    const deps = (items[cur]?.dependsOn) ?? [];
    for (const d of deps) {
      if (!visited.has(d)) {
        visited.add(d);
        queue.push(d);
      }
    }
  }
  return [...visited];
}

/** @returns {string[]} all items that depend on the given item (direct + transitive) */
export function downstream(name, stateOrView) {
  const src = isView(stateOrView) ? null : stateOrView;
  const items = (src ? src.items : null) ?? {};
  const names = Object.keys(items);

  const visited = new Set();
  const queue = [name];
  while (queue.length) {
    const cur = queue.shift();
    for (const n of names) {
      if (!visited.has(n) && n !== name) {
        const deps = items[n]?.dependsOn ?? [];
        if (deps.includes(cur)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
  }
  return [...visited];
}

/** @returns {ItemView|null} */
export function status(name, stateOrView) {
  const { nodes } = ensureView(stateOrView);
  return nodes.get(name) ?? null;
}

/** @returns {string|null} item name for the given wi number */
export function findByWi(wi, stateOrView) {
  const { byWi } = ensureView(stateOrView);
  return byWi.get(wi) ?? null;
}

/**
 * Check if adding dep `to` on item `from` would create a cycle.
 * Lighter than analyze() — just walks the dep graph.
 *
 * @param {{ items: object }} state
 * @param {string} from - the item that would gain the dep
 * @param {string} to   - the dep being added
 * @returns {string[]|null} cycle path or null
 */
export function wouldCycle(state, from, to) {
  // Semantics: "to would gain from as a dep" — would adding (to dependsOn from) cycle?
  // Cycle exists iff we can already reach `to` from `from` through existing deps.
  if (from === to) return [from, to];

  const items = state.items ?? {};
  const visited = new Set();
  const path = [];

  function dfs(cur) {
    if (cur === to) return true;
    if (visited.has(cur)) return false;
    visited.add(cur);
    path.push(cur);
    for (const d of (items[cur]?.dependsOn ?? [])) {
      if (dfs(d)) return true;
    }
    path.pop();
    return false;
  }

  if (dfs(from)) {
    return [to, ...path, to];
  }
  return null;
}
