import { execSync } from 'node:child_process';
import { loadMeta, saveMeta, appendEvent } from '../core/meta.mjs';
import { buildState } from '../core/state.mjs';
import { findVpr } from './edit.mjs';

const DEFAULT_LLM_CMD = 'claude -p';

/**
 * Build the prompt string for a VPR.
 *
 * @param {{ title: string, story: string }} vpr
 * @param {Array<{ subject: string }>} commits
 * @returns {string}
 */
function buildPrompt(vpr, commits) {
  const commitLines = commits.map(c => `- ${c.subject}`).join('\n');
  const hasStory = Boolean(vpr.story && vpr.story.trim());
  const lines = [
    'Generate a concise PR description in markdown. Output ONLY the markdown. Use ## Summary with 1-3 bullets, then ## Changes.',
    '',
    `PR Title: ${vpr.title}`,
    '',
  ];
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
 * @param {{ generateCmd?: string }} [opts]
 * @returns {Promise<{ bookmark: string, output: string }>}
 */
export async function generate(query, { generateCmd } = {}) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { itemName, bookmark, vpr } = found;

  // Get commits for this VPR from state
  const state = await buildState();
  const stateItem = state.items.find(i => i.name === itemName);
  const stateVpr = stateItem?.vprs.find(v => v.bookmark === bookmark);
  const commits = stateVpr?.commits ?? [];

  const prompt = buildPrompt(vpr, commits);
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
