import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vprIcon, vprTargetLabel } from '../../src/tui/render.mjs';

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('vprIcon()', () => {
  it('returns ▶ for a next-up VPR — drives the eye to the actionable row', () => {
    const icon = vprIcon({ nextUp: true });
    assert.equal(stripAnsi(icon), '▶');
  });

  it('returns ◦ for a blocked VPR — distinct from the default unsent · so blockers stand out', () => {
    const icon = vprIcon({ blocked: true });
    assert.equal(stripAnsi(icon), '◦');
  });
});

describe('vprTargetLabel()', () => {
  it('returns `→ <blockedBy>` for a blocked VPR — points the eye at what to send first', () => {
    const label = vprTargetLabel({ blocked: true, blockedBy: 'feat/foo/step-one' });
    assert.equal(stripAnsi(label), '→ feat/foo/step-one');
  });
});
