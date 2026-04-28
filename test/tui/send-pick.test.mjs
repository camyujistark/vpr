import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findNextUpBookmark, pickSendBookmark } from '../../src/tui/send-pick.mjs';

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

describe('pickSendBookmark()', () => {
  it('returns { bookmark } for the first nextUp VPR — P-key sends this bookmark regardless of cursor position', () => {
    const state = {
      items: [
        {
          name: 'item-a',
          vprs: [
            { bookmark: 'item-a/one', sent: true, nextUp: false },
            { bookmark: 'item-a/two', sent: false, nextUp: true, blocked: false },
          ],
        },
      ],
    };

    assert.deepEqual(pickSendBookmark(state), { bookmark: 'item-a/two' });
  });

  it('returns { message } when no VPR is nextUp — P-key surfaces a clear footer message instead of throwing', () => {
    const state = {
      items: [
        {
          name: 'item-a',
          vprs: [
            { bookmark: 'item-a/one', sent: true, nextUp: false },
            { bookmark: 'item-a/two', sent: true, nextUp: false },
          ],
        },
      ],
    };

    const result = pickSendBookmark(state);
    assert.equal(result.bookmark, undefined);
    assert.match(result.message, /No sendable VPR/);
  });
});
