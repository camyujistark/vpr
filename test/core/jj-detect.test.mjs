import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { hasJj, jjExportIfAvailable } from '../../src/core/jj-detect.mjs';

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

describe('jjExportIfAvailable()', () => {
  it('returns false (no-op) when jj is not in PATH', () => {
    // In this test environment jj is not installed, so hasJj() === false.
    // The function should return false without throwing.
    if (hasJj()) return; // skip if jj IS available
    const result = jjExportIfAvailable();
    assert.strictEqual(result, false);
  });

  it('is a function', () => {
    assert.strictEqual(typeof jjExportIfAvailable, 'function');
  });
});
