import { buildState } from '../core/state.mjs';

/**
 * Return a JSON-friendly snapshot of the current VPR state.
 *
 * @returns {Promise<{
 *   items: Array,
 *   ungrouped: Array,
 *   hold: Array,
 *   sent: object,
 *   eventLog: Array
 * }>}
 */
export async function list() {
  const state = await buildState();
  return {
    items: state.items,
    ungrouped: state.ungrouped,
    hold: state.hold,
    sent: state.sent,
    eventLog: state.eventLog,
  };
}
