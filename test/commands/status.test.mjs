/**
 * Tests for vpr status — meta-only placeholder vs. with-commits rendering.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatStatus } from '../../src/commands/status.mjs';

let tmpDir;
let originalCwd;

before(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-status-test-'));
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(originalCwd);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(vprs = []) {
  return {
    items: [{
      name: 'my-item',
      wi: 42,
      wiTitle: 'My Item',
      held: false,
      vprs,
    }],
    ungrouped: [],
    hold: [],
    conflicts: new Set(),
    sent: {},
    eventLog: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers for lifecycle grouping tests
// ---------------------------------------------------------------------------

function makeItemView(name, overrides = {}) {
  return {
    name,
    wi: null,
    status: 'ready',
    blockers: [],
    depth: 0,
    vprCount: 0,
    released: false,
    done: false,
    ready: true,
    ...overrides,
  };
}

function makeDagView(nodeMap) {
  const nodes = new Map(Object.entries(nodeMap));
  return { nodes };
}

function makeTwoItemState(name1, name2) {
  return {
    items: [
      { name: name1, wi: 1, wiTitle: 'Item One', held: false, vprs: [] },
      { name: name2, wi: 2, wiTitle: 'Item Two', held: false, vprs: [] },
    ],
    ungrouped: [],
    hold: [],
    conflicts: new Set(),
    sent: {},
    eventLog: [],
  };
}

// ---------------------------------------------------------------------------

describe('formatStatus lifecycle grouping (tui-state-viz)', () => {
  it('ready items appear before in-flight (released) items — AC1 ready-first ordering', () => {
    const state = makeTwoItemState('in-flight-item', 'ready-item');
    const dagView = makeDagView({
      'in-flight-item': makeItemView('in-flight-item', { status: 'released', released: true, done: false, ready: false }),
      'ready-item': makeItemView('ready-item', { status: 'ready', depth: 0, ready: true }),
    });
    const output = formatStatus(state, dagView);
    const readyPos = output.indexOf('ready-item');
    const inFlightPos = output.indexOf('in-flight-item');
    assert.ok(readyPos !== -1 && inFlightPos !== -1, `Both items must appear in output: ${output}`);
    assert.ok(readyPos < inFlightPos, `ready-item (pos ${readyPos}) must appear before in-flight-item (pos ${inFlightPos})\n${output}`);
  });

  it('hides done items by default when dagView is provided — AC5', () => {
    const state = makeTwoItemState('done-item', 'ready-item');
    const dagView = makeDagView({
      'done-item': makeItemView('done-item', { done: true, ready: false, released: true }),
      'ready-item': makeItemView('ready-item', { ready: true }),
    });
    const output = formatStatus(state, dagView);
    assert.ok(!output.includes('done-item'), `Done items must be hidden by default: ${output}`);
    assert.ok(output.includes('ready-item'), `Ready items must still appear: ${output}`);
  });

  it('shows done items when showAll is true — AC5/AC9', () => {
    const state = makeTwoItemState('done-item', 'ready-item');
    const dagView = makeDagView({
      'done-item': makeItemView('done-item', { done: true, ready: false, released: true }),
      'ready-item': makeItemView('ready-item', { ready: true }),
    });
    const output = formatStatus(state, dagView, { showAll: true });
    assert.ok(output.includes('done-item'), `Done items must appear with showAll: ${output}`);
    assert.ok(output.includes('ready-item'), `Ready items must still appear: ${output}`);
  });

  it('shows blocker names on items with unmet dependencies — AC6', () => {
    const state = makeTwoItemState('blocking-item', 'blocked-item');
    const dagView = makeDagView({
      'blocking-item': makeItemView('blocking-item', { ready: true, released: false }),
      'blocked-item': makeItemView('blocked-item', { ready: false, blockers: ['blocking-item'] }),
    });
    const output = formatStatus(state, dagView);
    // The blocked item should list its blocker
    const blockedItemSection = output.slice(output.indexOf('blocked-item'));
    assert.ok(blockedItemSection.includes('blocking-item'), `Blocker name must appear near blocked item: ${output}`);
  });

  it('shows chain depth on items — AC7', () => {
    const state = makeTwoItemState('root-item', 'leaf-item');
    const dagView = makeDagView({
      'root-item': makeItemView('root-item', { depth: 0, ready: true }),
      'leaf-item': makeItemView('leaf-item', { depth: 1, ready: true }),
    });
    const output = formatStatus(state, dagView);
    assert.ok(output.includes('depth=0'), `root-item must show depth=0: ${output}`);
    assert.ok(output.includes('depth=1'), `leaf-item must show depth=1: ${output}`);
  });

  it('shows in-flight indicator with open PR count for released items — AC3', () => {
    const state = {
      items: [{ name: 'in-flight-item', wi: 5, wiTitle: 'In Flight', held: false, vprs: [] }],
      ungrouped: [],
      hold: [],
      conflicts: new Set(),
      sent: {
        'in-flight-item/pr-1': { itemName: 'in-flight-item', abandoned: false, itemDone: false },
        'in-flight-item/pr-2': { itemName: 'in-flight-item', abandoned: false, itemDone: false },
      },
      eventLog: [],
    };
    const dagView = makeDagView({
      'in-flight-item': makeItemView('in-flight-item', { released: true, ready: false, done: false }),
    });
    const output = formatStatus(state, dagView);
    // Strip ANSI for content check
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    // Should show "2 open" PRs indicator on the header line
    assert.ok(stripped.includes('2 open'), `In-flight item must show "2 open": ${stripped}`);
  });

  it('shows a visual ready marker on items where ready is true — AC2', () => {
    const state = makeTwoItemState('ready-item', 'blocked-item');
    const dagView = makeDagView({
      'ready-item': makeItemView('ready-item', { ready: true }),
      'blocked-item': makeItemView('blocked-item', { ready: false, blockers: ['some-dep'] }),
    });
    const output = formatStatus(state, dagView);
    // Strip ANSI for position check
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    const readyLine = stripped.split('\n').find(l => l.includes('ready-item'));
    const blockedLine = stripped.split('\n').find(l => l.includes('blocked-item'));
    assert.ok(readyLine, `ready-item line must exist: ${stripped}`);
    assert.ok(blockedLine, `blocked-item line must exist: ${stripped}`);
    // Ready marker should appear on the ready item's header line but not on the blocked one
    assert.ok(readyLine.includes('✓') || readyLine.includes('▶') || readyLine.includes('→') || readyLine.includes('*') || readyLine.includes('[ready]'),
      `ready-item header must have a ready marker: ${readyLine}`);
  });
});

// ---------------------------------------------------------------------------

describe('formatStatus()', () => {
  it('shows "planned, no work yet" for a VPR with 0 commits', () => {
    const state = makeState([{
      bookmark: 'my-item/my-feature',
      title: 'My Feature',
      story: '',
      acceptance: '',
      output: null,
      commits: [],
      sent: false,
      held: false,
      conflict: false,
    }]);
    const output = formatStatus(state);
    assert.ok(output.includes('planned, no work yet'), `Expected "planned, no work yet" in: ${output}`);
  });

  it('shows commit count for a VPR with commits', () => {
    const state = makeState([{
      bookmark: 'my-item/my-feature',
      title: 'My Feature',
      story: '',
      acceptance: '',
      output: null,
      commits: [
        { changeId: 'abc123', sha: 'def456', subject: 'feat: add foo', conflict: false },
      ],
      sent: false,
      held: false,
      conflict: false,
    }]);
    const output = formatStatus(state);
    assert.ok(output.includes('1 commit'), `Expected "1 commit" in: ${output}`);
    assert.ok(!output.includes('planned'), `Should not say "planned" when commits exist: ${output}`);
  });

  it('shows empty message when no items and no ungrouped', () => {
    const state = { items: [], ungrouped: [], hold: [], conflicts: new Set(), sent: {}, eventLog: [] };
    const output = formatStatus(state);
    assert.ok(output.includes('No VPRs'), `Expected "No VPRs" in: ${output}`);
  });
});
