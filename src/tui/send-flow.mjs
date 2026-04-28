import { pickSendBookmark } from './send-pick.mjs';

/**
 * Orchestrate the TUI P-key send flow.
 *
 * Cursor-independent: walks chain state to pick the next-unsent VPR via
 * `pickSendBookmark`, then drives the editor flow before delegating to send.
 * Pure orchestration — editor + send + state lookup are injected so the flow
 * is unit-testable without a TTY.
 *
 * @param {{
 *   state: { items: Array<{ name: string, vprs: Array<{ bookmark: string, nextUp?: boolean }> }> },
 *   runEditorFlow: (vpr: object) => Promise<{ decision?: 'send'|'abandon' }>,
 *   send: (bookmark: string) => Promise<{ branchName: string }>,
 * }} args
 * @returns {Promise<{ kind: 'message', message: string } | { kind: 'abandoned' } | { kind: 'sent', branchName: string }>}
 */
export async function runTuiSendFlow({ state, runEditorFlow, send }) {
  const pick = pickSendBookmark(state);
  if (pick.message) return { kind: 'message', message: pick.message };

  const vpr = findVpr(state, pick.bookmark);
  const decision = await runEditorFlow(vpr);
  if (decision?.decision !== 'send') return { kind: 'abandoned' };

  try {
    const result = await send(pick.bookmark);
    return { kind: 'sent', branchName: result.branchName };
  } catch (err) {
    return { kind: 'message', message: err?.message ?? String(err) };
  }
}

function findVpr(state, bookmark) {
  for (const item of state.items) {
    for (const vpr of item.vprs) {
      if (vpr.bookmark === bookmark) return vpr;
    }
  }
  return null;
}
