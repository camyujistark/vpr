import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runSendEditorFlow } from '../../src/commands/send-flow.mjs';
import { buildSendEditContent } from '../../src/tui/editor.mjs';

describe('runSendEditorFlow()', () => {
  it('regenerates output when the user changes the story in the editor — preview reflects the new story', async () => {
    const vpr = { title: 'Nav Bar', story: 'old story', output: 'old output' };

    // User opens the editor and changes the story.
    const openEditor = async () =>
      buildSendEditContent({ vpr: { title: 'Nav Bar', story: 'new story body' } });

    // Capture regenerate invocation; return the new output so we can assert
    // the preview gets the regenerated content.
    let regenerateCalledWith = null;
    const regenerate = async (next) => {
      regenerateCalledWith = next;
      return 'regenerated output';
    };

    const result = await runSendEditorFlow({ vpr, openEditor, regenerate });

    assert.equal(regenerateCalledWith?.story, 'new story body', 'regenerate must receive the edited story');
    assert.equal(result.story, 'new story body');
    assert.equal(result.output, 'regenerated output', 'preview output must be the regenerated content, not the stale one');
  });
});
