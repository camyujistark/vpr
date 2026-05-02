import { execSync } from 'node:child_process';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

const DEFAULT_LLM_CMD = 'claude -p';

/**
 * Build the prompt string for a VPR.
 *
 * @param {{
 *   item: { wi?: number|null, wiTitle?: string|null, wiDescription?: string|null,
 *           parentWi?: number|null, parentWiTitle?: string|null, parentWiDescription?: string|null },
 *   vpr: { title: string, story: string },
 *   commits: Array<{ subject: string }>,
 * }} args
 * @returns {string}
 */
export function buildPrompt({ item, vpr, commits }) {
  const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const commitLines = commits.map(c => `- ${oneLine(c.subject)}`).join('\n');
  const hasStory = Boolean(vpr.story && vpr.story.trim());
  const lines = [
    'Generate a terse PR description in markdown. Output ONLY the markdown. Two sections: ## Summary (1-2 bullets max) and ## Changes (one bullet per commit/component).',
    'STYLE: terse. No filler ("this PR", "lays groundwork for", "no UI wiring yet"). No restating the title. Each bullet ≤ 2 short sentences. No closing summaries.',
    hasStory
      ? 'Summary: MUST include the user-facing motivation from Story (the WHY, paraphrase Story\'s actual wording — domain terms, comparisons, goals). Then indicate scope of THIS PR honestly ("pure helper", "wiring only", "foundation") so reviewer knows what is/isn\'t in this diff. Do not drop the Story content for brevity — Story is the most important input. Stay terse but keep the story\'s substance.'
      : '',
    'Changes: technical and specific. WHAT the code does (algorithm/return shape/branching/API) — not what file it sits in. Tight phrasing. Example: NOT "add foo helper that does X", but "`foo(schema, col, val)` — maps enum codes to `{kind: \'mapped\'|\'unknown\'|\'no-enum\'}`, coerces value to string".',
    '',
  ];
  if (item && item.parentWi && item.parentWiDescription) {
    lines.push(`PARENT PRD (PBI #${item.parentWi}): ${item.parentWiTitle ?? ''}`);
    lines.push(item.parentWiDescription);
    lines.push('');
  }
  if (item && item.wi) {
    lines.push(`THIS SLICE (Task #${item.wi}): ${item.wiTitle ?? ''}`);
    if (item.wiDescription) lines.push(item.wiDescription);
    lines.push('');
  }
  lines.push(`PR Title: ${oneLine(vpr.title)}`, '');
  if (hasStory) {
    lines.push(`Story: ${vpr.story}`, '');
  } else {
    lines.push('No story provided — infer the PR description from the title and commits below.', '');
  }
  lines.push('Commits:', commitLines);
  return lines.join('\n');
}

/**
 * Resolve the LLM command to use.
 * Tries `claude` if no override given, throws if not available.
 *
 * @param {string} [generateCmd]
 * @returns {string}
 */
function resolveLlmCmd(generateCmd) {
  if (generateCmd) return generateCmd;

  // Check if `claude` is available
  try {
    execSync('which claude', { stdio: 'pipe', encoding: 'utf-8' });
    return DEFAULT_LLM_CMD;
  } catch {
    throw new Error(
      'No LLM command available. Install the Claude CLI (`npm i -g @anthropic-ai/claude-code`) or pass --generate-cmd.'
    );
  }
}

/**
 * Generate a PR description for a single VPR.
 *
 * @param {string} query  — bookmark name, partial bookmark, or partial title
 * @param {{ generateCmd?: string, story?: string }} [opts]
 * @returns {Promise<{ bookmark: string, output: string }>}
 */
export async function generate(query, { generateCmd, story } = {}) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;
  const item = meta.items[itemName];

  // Agent path: --story bypasses the editor. Persist the supplied story
  // onto the VPR before regenerating so the prompt reflects the new narrative.
  if (story !== undefined) {
    vpr.story = story;
    const stagingMeta = await loadMeta();
    if (stagingMeta.items[itemName]?.vprs[bookmark]) {
      stagingMeta.items[itemName].vprs[bookmark].story = story;
      await saveMeta(stagingMeta);
    }
  }

  // Get commits for this VPR from state
  const state = await buildState();
  const stateItem = state.items.find(i => i.name === itemName);
  const stateVpr = stateItem?.vprs.find(v => v.bookmark === bookmark);
  const commits = stateVpr?.commits ?? [];

  const prompt = buildPrompt({ item, vpr, commits });
  const cmd = resolveLlmCmd(generateCmd);

  let output;
  try {
    output = execSync(cmd, {
      input: prompt,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: '/bin/bash',
    }).trim();
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : err.message;
    throw new Error(`LLM command failed: ${msg}`);
  }

  // Save output back to meta
  const freshMeta = await loadMeta();
  freshMeta.items[itemName].vprs[bookmark].output = output;
  await saveMeta(freshMeta);
  await appendEvent('cli', 'vpr.generate', { bookmark });

  return { bookmark, output };
}

/**
 * Generate PR descriptions for all VPRs that don't yet have output.
 *
 * @param {{ generateCmd?: string }} [opts]
 * @returns {Promise<Array<{ bookmark: string, output: string }>>}
 */
export async function generateAll({ generateCmd } = {}) {
  const meta = await loadMeta();
  const results = [];

  for (const [itemName, itemData] of Object.entries(meta.items)) {
    for (const [bookmark, vpr] of Object.entries(itemData.vprs ?? {})) {
      if (!vpr.output) {
        try {
          const result = await generate(bookmark, { generateCmd });
          results.push(result);
        } catch (err) {
          console.warn(`Warning: generate failed for "${bookmark}": ${err.message}`);
        }
      }
    }
  }

  return results;
}
