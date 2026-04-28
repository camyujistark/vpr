import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeTicketSync } from '../../src/commands/ticket-sync.mjs';

describe('computeTicketSync', () => {
  it('updates wiTitle and wiDescription from fetched WI; reports both as changed', () => {
    const item = {
      wi: 100,
      wiTitle: 'old title',
      wiDescription: 'old desc',
      vprs: { 'foo/bar': { title: 'untouched', story: '', output: null } },
    };

    const out = computeTicketSync({
      itemName: 'foo',
      item,
      fetchedWi: { id: 100, title: 'new title', description: 'new desc' },
      fetchedParent: null,
    });

    assert.equal(out.item.wiTitle, 'new title');
    assert.equal(out.item.wiDescription, 'new desc');
    assert.equal(out.changed.wiTitle, true);
    assert.equal(out.changed.wiDescription, true);
    assert.equal(out.changed.parentWiTitle, false);
    assert.equal(out.changed.parentWiDescription, false);

    // vprs and other fields untouched
    assert.deepEqual(out.item.vprs, item.vprs);
    assert.equal(out.item.wi, 100);
  });
});
