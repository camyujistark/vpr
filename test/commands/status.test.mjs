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
