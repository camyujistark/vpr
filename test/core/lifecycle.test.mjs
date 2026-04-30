import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isReleased, isDone, isReady } from '../../src/core/lifecycle.mjs';

// sent is keyed by branchName; each record has itemName, and optional abandoned/itemDone flags

describe('isReleased(itemName, sent)', () => {
  it('returns false for empty sent', () => {
    assert.strictEqual(isReleased('foo', {}), false);
  });

  it('returns true for a single clean sent record', () => {
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1 } };
    assert.strictEqual(isReleased('foo', sent), true);
  });

  it('returns false when all sent records for item are abandoned', () => {
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1, abandoned: true } };
    assert.strictEqual(isReleased('foo', sent), false);
  });

  it('returns true when at least one non-abandoned sent record exists among mixed records', () => {
    const sent = {
      'feat/foo-1': { itemName: 'foo', prId: 1, abandoned: true },
      'feat/foo-2': { itemName: 'foo', prId: 2 },
    };
    assert.strictEqual(isReleased('foo', sent), true);
  });

  it('ignores sent records for other items', () => {
    const sent = { 'feat/bar-1': { itemName: 'bar', prId: 1 } };
    assert.strictEqual(isReleased('foo', sent), false);
  });
});

describe('isDone(itemName, sent)', () => {
  it('returns false for empty sent', () => {
    assert.strictEqual(isDone('foo', {}), false);
  });

  it('returns true when single sent record has itemDone: true', () => {
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1, itemDone: true } };
    assert.strictEqual(isDone('foo', sent), true);
  });

  it('returns false when single sent record lacks itemDone', () => {
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1 } };
    assert.strictEqual(isDone('foo', sent), false);
  });

  it('returns false when any sent record lacks itemDone', () => {
    const sent = {
      'feat/foo-1': { itemName: 'foo', prId: 1, itemDone: true },
      'feat/foo-2': { itemName: 'foo', prId: 2 },
    };
    assert.strictEqual(isDone('foo', sent), false);
  });

  it('returns true when all sent records have itemDone: true', () => {
    const sent = {
      'feat/foo-1': { itemName: 'foo', prId: 1, itemDone: true },
      'feat/foo-2': { itemName: 'foo', prId: 2, itemDone: true },
    };
    assert.strictEqual(isDone('foo', sent), true);
  });

  it('ignores sent records for other items', () => {
    const sent = { 'feat/bar-1': { itemName: 'bar', prId: 1, itemDone: true } };
    assert.strictEqual(isDone('foo', sent), false);
  });
});

describe('isReady(item, sent)', () => {
  it('returns false when item is done', () => {
    const item = { name: 'foo', dependsOn: [] };
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1, itemDone: true } };
    assert.strictEqual(isReady(item, sent), false);
  });

  it('returns true when item has no deps and is not done', () => {
    const item = { name: 'foo', dependsOn: [] };
    const sent = {};
    assert.strictEqual(isReady(item, sent), true);
  });

  it('returns true when all deps are released', () => {
    const item = { name: 'baz', dependsOn: ['foo', 'bar'] };
    const sent = {
      'feat/foo-1': { itemName: 'foo', prId: 1 },
      'feat/bar-1': { itemName: 'bar', prId: 2 },
    };
    assert.strictEqual(isReady(item, sent), true);
  });

  it('returns false when a dep is not released (not in sent)', () => {
    const item = { name: 'baz', dependsOn: ['foo'] };
    const sent = {};
    assert.strictEqual(isReady(item, sent), false);
  });

  it('returns false when a dep is abandoned (not released)', () => {
    const item = { name: 'baz', dependsOn: ['foo'] };
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1, abandoned: true } };
    assert.strictEqual(isReady(item, sent), false);
  });

  it('returns false when a dep name does not appear in sent at all', () => {
    const item = { name: 'baz', dependsOn: ['missing-dep'] };
    const sent = { 'feat/foo-1': { itemName: 'foo', prId: 1 } };
    assert.strictEqual(isReady(item, sent), false);
  });
});
