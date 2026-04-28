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

  it('returns kind="message" with the send error when send throws — TUI footer surfaces blocked refusal cleanly instead of crashing the loop', async () => {
    const nextUpVpr = {
      bookmark: 'item-a/two',
      title: 'Two',
      story: 'ready',
      output: 'ready output',
      sent: false,
      nextUp: true,
    };
    const state = {
      items: [
        { name: 'item-a', vprs: [nextUpVpr] },
      ],
    };

    const runEditorFlow = async () => ({ decision: 'send' });
    const send = async () => {
      throw new Error('Cannot send item-a/two: send item-a/one first');
    };

    const result = await runTuiSendFlow({ state, runEditorFlow, send });

    assert.deepEqual(
      result,
      { kind: 'message', message: 'Cannot send item-a/two: send item-a/one first' },
      'send errors must be returned as a message kind so the TUI footer can render the blocker without the keypress handler throwing',
    );
  });
});
