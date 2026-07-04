import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from '../core/meta.mjs';

const WORK_ITEM_MODELS = ['one-pbi', 'per-slice'];

/** @returns {string} path to .vpr/config.json relative to cwd */
function configPath() {
  return join(process.cwd(), '.vpr', 'config.json');
}

/**
 * Lock the load-bearing send decisions at PLANNING time (to-prd / to-issues)
 * so `vpr send` is mechanical and never stalls mid-push asking for them.
 *
 * Persists to `.vpr/config.json`:
 *   - `provider`        — where PRs/work-items go (azure-devops | github | none).
 *   - `workItemModel`   — how PRs link work items:
 *                           'one-pbi'   → every slice's PR links the ONE feature
 *                                         PBI (item.parentWi), matching the
 *                                         map-url-facets run (Cam's choice).
 *                           'per-slice' → each slice links its own work item.
 *   - `storySource`     — where slice stories come from (e.g. 'pablo-doc',
 *                         'prd', 'inline'); a planning hint the story flow reads.
 *
 * Only the fields passed are changed; the rest of the config is preserved.
 * Deciding these once, up front, is what the map-url-facets retro asked for —
 * choosing them mid-send is what stalled that push.
 *
 * @param {{ provider?: string, workItemModel?: string, storySource?: string }} opts
 * @returns {Promise<{ config: object, changed: string[] }>}
 */
export async function planLock(opts = {}) {
  const path = configPath();
  let config = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const changed = [];

  if (opts.provider !== undefined) {
    config.provider = opts.provider;
    changed.push('provider');
  }
  if (opts.workItemModel !== undefined) {
    if (!WORK_ITEM_MODELS.includes(opts.workItemModel)) {
      throw new Error(
        `Invalid work-item-model: ${opts.workItemModel}. Use one of: ${WORK_ITEM_MODELS.join(', ')}`
      );
    }
    config.workItemModel = opts.workItemModel;
    changed.push('workItemModel');
  }
  if (opts.storySource !== undefined) {
    config.storySource = opts.storySource;
    changed.push('storySource');
  }

  if (changed.length === 0) {
    throw new Error('Nothing to lock — pass --provider, --work-item-model, and/or --story-source');
  }

  const dir = join(process.cwd(), '.vpr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
  await appendEvent('cli', 'plan.lock', { changed });

  return { config, changed };
}

/**
 * Resolve which work item id a slice's PR should link, given the locked model.
 *   - 'one-pbi'  → the feature PBI (item.parentWi), falling back to item.wi.
 *   - otherwise  → the slice's own work item (vpr.wi), falling back to item.wi.
 *
 * @param {{ wi?: string|number|null, parentWi?: string|number|null }} item
 * @param {{ wi?: string|number|null }} vpr
 * @param {string} [model]
 * @returns {string|number|null}
 */
export function resolveWorkItemId(item, vpr, model = 'per-slice') {
  if (model === 'one-pbi') {
    return item.parentWi ?? item.wi ?? null;
  }
  return vpr?.wi ?? item.wi ?? null;
}
