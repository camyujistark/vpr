import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSendEditContent } from '../../src/tui/editor.mjs';

describe('buildSendEditContent()', () => {
  it('emits editable --- Title --- and --- Story --- sections with the VPR title and story', () => {
    const content = buildSendEditContent({
      vpr: { title: 'My slice title', story: 'My story body.' },
    });

    const lines = content.split('\n');
    const titleMarkerIdx = lines.indexOf('--- Title ---');
    const storyMarkerIdx = lines.indexOf('--- Story ---');

    assert.ok(titleMarkerIdx >= 0, `expected --- Title --- marker; got:\n${content}`);
    assert.ok(storyMarkerIdx > titleMarkerIdx, `expected --- Story --- marker after --- Title ---; got:\n${content}`);

    const titleSection = lines.slice(titleMarkerIdx + 1, storyMarkerIdx).join('\n').trim();
    const storySection = lines.slice(storyMarkerIdx + 1).join('\n').trim();

    assert.equal(titleSection, 'My slice title');
    assert.ok(storySection.startsWith('My story body.'), `expected story section to start with body; got: ${JSON.stringify(storySection)}`);
  });
});
