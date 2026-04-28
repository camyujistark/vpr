import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTuiSendFlow } from '../../src/tui/send-flow.mjs';

describe('runTuiSendFlow()', () => {
  it('invokes the editor flow for the next-up VPR — sendable state opens the editor (or preview) instead of the old confirm prompt', async () => {
    const nextUpVpr = {
      bookmark: 'item-a/one',
      title: 'One',
      story: 'already-good',
      output: 'already-good output',
      sent: false,
      nextUp: true,
    };
    const state = {
      items: [
        { name: 'item-a', vprs: [nextUpVpr] },
      ],
    };

    let editorCalledWith = null;
    const runEditorFlow = async (vpr) => {
      editorCalledWith = vpr;
      return { decision: 'abandon' };
    };

    await runTuiSendFlow({
      state,
      runEditorFlow,
      send: async () => ({ branchName: 'feat/x' }),
    });

    assert.equal(
      editorCalledWith?.bookmark,
      'item-a/one',
      'editor flow must receive the next-up VPR — TUI P key triggers editor flow, not the legacy y/N confirm',
    );
  });
});
