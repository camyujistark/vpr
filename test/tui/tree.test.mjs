import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTree, findNextUpCursor } from '../../src/tui/tree.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseCommit = { changeId: 'abc', sha: '123', subject: 'feat: a', conflict: false };

const mockState = {
  items: [
    {
      name: 'test-item',
      wi: 1,
      wiTitle: 'Test',
      vprs: [
        {
          bookmark: 'test-item/first',
          title: 'First',
          story: 'story',
          output: null,
          commits: [baseCommit],
          sent: false,
          conflict: false,
        },
      ],
    },
  ],
  ungrouped: [{ changeId: 'xyz', sha: '789', subject: 'docs: spec' }],
  hold: [{ changeId: 'held1', sha: '000', subject: 'parked' }],
  conflicts: new Set(),
  sent: {},
  eventLog: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function types(rows) {
  return rows.map(r => r.type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTree()', () => {
  describe('correct order', () => {
    it('produces item → vpr → commit → ungrouped-header → ungrouped → hold-header → hold', () => {
      const tree = buildTree(mockState);
      assert.deepStrictEqual(types(tree), [
        'item',
        'vpr',
        'commit',
        'ungrouped-header',
        'ungrouped',
        'hold-header',
        'hold',
      ]);
    });
  });

  describe('item rows', () => {
    it('item row has correct shape', () => {
      const tree = buildTree(mockState);
      const item = tree.find(r => r.type === 'item');
      assert.ok(item, 'item row missing');
      assert.strictEqual(item.name, 'test-item');
      assert.strictEqual(item.wi, 1);
      assert.strictEqual(item.wiTitle, 'Test');
      assert.strictEqual(item.vprCount, 1);
      assert.strictEqual(item.collapsed, false);
    });
  });

  describe('vpr rows', () => {
    it('vpr row has correct shape', () => {
      const tree = buildTree(mockState);
      const vpr = tree.find(r => r.type === 'vpr');
      assert.ok(vpr, 'vpr row missing');
      assert.strictEqual(vpr.bookmark, 'test-item/first');
      assert.strictEqual(vpr.title, 'First');
      assert.strictEqual(vpr.story, 'story');
      assert.strictEqual(vpr.output, null);
      assert.strictEqual(vpr.sent, false);
      assert.strictEqual(vpr.conflict, false);
      assert.strictEqual(vpr.commitCount, 1);
      assert.strictEqual(vpr.itemName, 'test-item');
    });
  });

  describe('commit rows', () => {
    it('commit row has correct shape', () => {
      const tree = buildTree(mockState);
      const commit = tree.find(r => r.type === 'commit');
      assert.ok(commit, 'commit row missing');
      assert.strictEqual(commit.changeId, 'abc');
      assert.strictEqual(commit.sha, '123');
      assert.strictEqual(commit.subject, 'feat: a');
      assert.strictEqual(commit.conflict, false);
      assert.strictEqual(commit.vprBookmark, 'test-item/first');
      assert.strictEqual(commit.itemName, 'test-item');
    });
  });

  describe('ungrouped rows', () => {
    it('ungrouped-header has correct count', () => {
      const tree = buildTree(mockState);
      const header = tree.find(r => r.type === 'ungrouped-header');
      assert.ok(header, 'ungrouped-header missing');
      assert.strictEqual(header.count, 1);
    });

    it('ungrouped commit row has correct shape', () => {
      const tree = buildTree(mockState);
      const uc = tree.find(r => r.type === 'ungrouped');
      assert.ok(uc, 'ungrouped row missing');
      assert.strictEqual(uc.changeId, 'xyz');
      assert.strictEqual(uc.sha, '789');
      assert.strictEqual(uc.subject, 'docs: spec');
    });
  });

  describe('hold rows', () => {
    it('hold-header has correct count', () => {
      const tree = buildTree(mockState);
      const header = tree.find(r => r.type === 'hold-header');
      assert.ok(header, 'hold-header missing');
      assert.strictEqual(header.count, 1);
    });

    it('hold row has correct shape', () => {
      const tree = buildTree(mockState);
      const hc = tree.find(r => r.type === 'hold');
      assert.ok(hc, 'hold row missing');
      assert.strictEqual(hc.changeId, 'held1');
      assert.strictEqual(hc.sha, '000');
      assert.strictEqual(hc.subject, 'parked');
    });
  });

  describe('empty state', () => {
    it('returns empty array for fully empty state', () => {
      const empty = {
        items: [],
        ungrouped: [],
        hold: [],
        conflicts: new Set(),
        sent: {},
        eventLog: [],
      };
      assert.deepStrictEqual(buildTree(empty), []);
    });

    it('omits ungrouped-header when ungrouped is empty', () => {
      const state = { ...mockState, ungrouped: [] };
      const tree = buildTree(state);
      assert.ok(!tree.some(r => r.type === 'ungrouped-header'), 'ungrouped-header should not appear when empty');
    });

    it('omits hold-header when hold is empty', () => {
      const state = { ...mockState, hold: [] };
      const tree = buildTree(state);
      assert.ok(!tree.some(r => r.type === 'hold-header'), 'hold-header should not appear when empty');
    });
  });

  describe('multiple items', () => {
    it('produces interleaved item/vpr/commit blocks in order', () => {
      const state = {
        items: [
          {
            name: 'alpha',
            wi: 10,
            wiTitle: 'Alpha',
            vprs: [
              {
                bookmark: 'alpha/one',
                title: 'One',
                story: '',
                output: null,
                commits: [
                  { changeId: 'a1', sha: 's1', subject: 'feat: a1', conflict: false },
                  { changeId: 'a2', sha: 's2', subject: 'feat: a2', conflict: false },
                ],
                sent: false,
                conflict: false,
              },
            ],
          },
          {
            name: 'beta',
            wi: 20,
            wiTitle: 'Beta',
            vprs: [
              {
                bookmark: 'beta/first',
                title: 'First',
                story: '',
                output: null,
                commits: [{ changeId: 'b1', sha: 'bs1', subject: 'feat: b1', conflict: false }],
                sent: true,
                conflict: false,
              },
            ],
          },
        ],
        ungrouped: [],
        hold: [],
        conflicts: new Set(),
        sent: {},
        eventLog: [],
      };

      const tree = buildTree(state);
      assert.deepStrictEqual(types(tree), [
        'item',   // alpha
        'vpr',    // alpha/one
        'commit', // a1
        'commit', // a2
        'item',   // beta
        'vpr',    // beta/first
        'commit', // b1
      ]);

      // Verify vprCount and commitCount
      assert.strictEqual(tree[0].vprCount, 1);
      assert.strictEqual(tree[1].commitCount, 2);
      assert.strictEqual(tree[4].name, 'beta');
      assert.strictEqual(tree[5].sent, true);
    });
  });

  describe('vpr with multiple commits preserves commit order', () => {
    it('commits appear in the same order as the vpr.commits array', () => {
      const state = {
        items: [
          {
            name: 'x',
            wi: 99,
            wiTitle: 'X',
            vprs: [
              {
                bookmark: 'x/feat',
                title: 'Feat',
                story: '',
                output: null,
                commits: [
                  { changeId: 'c1', sha: 'h1', subject: 'first', conflict: false },
                  { changeId: 'c2', sha: 'h2', subject: 'second', conflict: false },
                  { changeId: 'c3', sha: 'h3', subject: 'third', conflict: false },
                ],
                sent: false,
                conflict: false,
              },
            ],
          },
        ],
        ungrouped: [],
        hold: [],
        conflicts: new Set(),
        sent: {},
        eventLog: [],
      };

      const tree = buildTree(state);
      const commits = tree.filter(r => r.type === 'commit');
      assert.strictEqual(commits[0].changeId, 'c1');
      assert.strictEqual(commits[1].changeId, 'c2');
      assert.strictEqual(commits[2].changeId, 'c3');
    });
  });
});

describe('findNextUpCursor()', () => {
  it('returns the row index of the first vpr row marked nextUp — TUI cursor lands on the actionable VPR on open', () => {
    const tree = [
      { type: 'item', name: 'i1' },
      { type: 'vpr', bookmark: 'i1/sent', sent: true, nextUp: false },
      { type: 'commit', changeId: 'c1' },
      { type: 'vpr', bookmark: 'i1/next', sent: false, nextUp: true },
      { type: 'commit', changeId: 'c2' },
      { type: 'vpr', bookmark: 'i1/blocked', sent: false, nextUp: false, blocked: true },
    ];
    assert.strictEqual(findNextUpCursor(tree), 3);
  });
});
