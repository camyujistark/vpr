import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { hasJj } from '../../src/core/jj-detect.mjs';

describe('hasJj()', () => {
  it('returns a boolean', () => {
    const result = hasJj();
    assert.strictEqual(typeof result, 'boolean');
  });

  it('returns true iff `which jj` exits 0', () => {
    let whichFound;
    try {
      execSync('which jj', { stdio: 'pipe' });
      whichFound = true;
    } catch {
      whichFound = false;
    }
    assert.strictEqual(hasJj(), whichFound);
  });
});
