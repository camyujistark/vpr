import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findNextUpBookmark } from '../../src/tui/send-pick.mjs';

describe('findNextUpBookmark()', () => {
  it('returns the bookmark of the first nextUp VPR — TUI P-key picks the next-unsent VPR regardless of cursor position', () => {
    const items = [
      {
        name: 'item-a',
        vprs: [
          { bookmark: 'item-a/one', sent: true, nextUp: false },
          { bookmark: 'item-a/two', sent: false, nextUp: true, blocked: false },
          { bookmark: 'item-a/three', sent: false, nextUp: false, blocked: true },
        ],
      },
    ];

    assert.equal(findNextUpBookmark(items), 'item-a/two');
  });
});
