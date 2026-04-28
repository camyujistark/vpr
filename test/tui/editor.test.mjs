import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSendEditContent, parseSendEditContent } from '../../src/tui/editor.mjs';

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

describe('parseSendEditContent()', () => {
  it('strips lines starting with # — they are read-only comments, not story content', () => {
    const content = [
      '# This is a comment line that must be ignored on parse',
      '# Another comment with context like commits or last output',
      '--- Title ---',
      'Refined title',
      '',
      '--- Story ---',
      'Story body line one.',
      '# inline comment between story lines — also stripped',
      'Story body line two.',
      '',
    ].join('\n');

    const parsed = parseSendEditContent(content);

    assert.equal(parsed.title, 'Refined title');
    assert.equal(parsed.story, 'Story body line one.\nStory body line two.');
  });

  it('preserves `#` appearing mid-line — only line-leading `#` marks a comment, so issue refs and hashtags survive', () => {
    const content = [
      '--- Title ---',
      'Refined title',
      '',
      '--- Story ---',
      'Track issue #42 for details.',
      'Tagged with #context-cleanup mid-line.',
    ].join('\n');

    const parsed = parseSendEditContent(content);

    assert.equal(
      parsed.story,
      'Track issue #42 for details.\nTagged with #context-cleanup mid-line.',
    );
  });

  it('preserves --- Title --- and --- Story --- lines inside the story body — only the first of each marker is a section header', () => {
    const content = [
      '--- Title ---',
      'Refined title',
      '',
      '--- Story ---',
      'Story explains the buffer format:',
      '--- Title ---',
      'this should be the editable title section.',
      '--- Story ---',
      'this should be the editable story section.',
    ].join('\n');

    const parsed = parseSendEditContent(content);

    assert.equal(parsed.title, 'Refined title');
    assert.equal(
      parsed.story,
      [
        'Story explains the buffer format:',
        '--- Title ---',
        'this should be the editable title section.',
        '--- Story ---',
        'this should be the editable story section.',
      ].join('\n'),
    );
  });
});
