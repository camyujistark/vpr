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

  it('returns decision="send" when the user answers y at the [y/N/e] prompt — caller pushes only on send', async () => {
    const vpr = { title: 'Nav Bar', story: 's', output: 'o' };
    const openEditor = async () => buildSendEditContent({ vpr });
    const regenerate = async () => 'regen';
    const prompt = async () => 'y';

    const result = await runSendEditorFlow({ vpr, openEditor, regenerate, prompt });

    assert.equal(result.decision, 'send', 'y answer must surface as decision="send" so the caller knows to push');
  });

  it('aborts without prompting or regenerating when the saved story is empty/whitespace — matches `git commit` semantics', async () => {
    const vpr = { title: 'Nav Bar', story: 'old story', output: 'old output' };

    // User saves the buffer with a blank story — same as escaping the editor
    // without writing anything meaningful.
    const openEditor = async () =>
      buildSendEditContent({ vpr: { title: 'Nav Bar', story: '   \n\t  ' } });

    let regenerateCalled = false;
    const regenerate = async () => {
      regenerateCalled = true;
      return 'should not run';
    };

    let promptCalled = false;
    const prompt = async () => {
      promptCalled = true;
      return 'y';
    };

    const result = await runSendEditorFlow({ vpr, openEditor, regenerate, prompt });

    assert.equal(result.decision, 'abandon', 'empty story must surface as decision="abandon" — no push');
    assert.equal(regenerateCalled, false, 'must not regenerate when the story is empty');
    assert.equal(promptCalled, false, 'must not prompt the user when the story is empty');
  });

  it('re-opens the editor when the user answers e — loop continues until y or N', async () => {
    const vpr = { title: 'Nav Bar', story: 'first', output: 'o' };

    let openCalls = 0;
    const openEditor = async () => {
      openCalls += 1;
      const story = openCalls === 1 ? 'second' : 'third';
      return buildSendEditContent({ vpr: { title: 'Nav Bar', story } });
    };

    let regenCalls = 0;
    const regenerate = async () => {
      regenCalls += 1;
      return `regen-${regenCalls}`;
    };

    const answers = ['e', 'y'];
    const prompt = async () => answers.shift();

    const result = await runSendEditorFlow({ vpr, openEditor, regenerate, prompt });

    assert.equal(openCalls, 2, 'e must reopen the editor a second time');
    assert.equal(result.decision, 'send', 'second-pass y answer must end the loop with send');
    assert.equal(result.story, 'third', 'final story must come from the second editor pass');
    assert.equal(result.output, 'regen-2', 'output must reflect the regeneration triggered by the second edit');
  });
});
