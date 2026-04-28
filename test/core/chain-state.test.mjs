import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeChainState } from '../../src/core/state.mjs';

describe('computeChainState()', () => {
  it('marks the only unsent VPR as nextUp with cascadeTarget=main and no blocker', () => {
    const items = [
      {
        name: 'foo',
        vprs: [{ bookmark: 'foo/a', sent: false, held: false }],
      },
    ];

    const enriched = computeChainState(items, { sent: {}, baseBranch: 'main' });

    const vpr = enriched[0].vprs[0];
    assert.strictEqual(vpr.nextUp, true);
    assert.strictEqual(vpr.blocked, false);
    assert.strictEqual(vpr.blockedBy, null);
    assert.strictEqual(vpr.cascadeTarget, 'main');
  });

  it('blocks every unsent VPR after the first; blockedBy points at the immediate predecessor', () => {
    const items = [
      {
        name: 'foo',
        vprs: [
          { bookmark: 'foo/a', sent: false, held: false },
          { bookmark: 'foo/b', sent: false, held: false },
          { bookmark: 'foo/c', sent: false, held: false },
        ],
      },
    ];

    const enriched = computeChainState(items, { sent: {}, baseBranch: 'main' });
    const [a, b, c] = enriched[0].vprs;

    assert.strictEqual(a.nextUp, true);
    assert.strictEqual(a.blocked, false);
    assert.strictEqual(a.blockedBy, null);

    assert.strictEqual(b.nextUp, false);
    assert.strictEqual(b.blocked, true);
    assert.strictEqual(b.blockedBy, 'foo/a');

    assert.strictEqual(c.nextUp, false);
    assert.strictEqual(c.blocked, true);
    assert.strictEqual(c.blockedBy, 'foo/b');
  });
});
