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
});
