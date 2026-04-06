import { execSync } from 'node:child_process';
import { loadMeta, appendEvent } from '../core/meta.mjs';
import { jj, getFiles } from '../core/jj.mjs';
import { findVpr } from './edit.mjs';

/** Run jj squash with JJ_EDITOR=true to avoid editor prompt. */
function jjSquash(changeId) {
  return execSync(`jj squash -r ${changeId}`, {
    encoding: 'utf-8',
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JJ_EDITOR: 'true' },
  }).trim();
}

/**
 * Analyze commits in a VPR and group adjacent commits that touch the same files.
 * Returns a list of { action: 'squash'|'keep', commits: [...] } groups.
 *
 * @param {Array<{ changeId: string, sha: string, subject: string }>} commits
 * @returns {Array<{ action: string, changeId: string, subject: string, files: string[], groupIdx: number }>}
 */
export function analyzeSquashCandidates(commits) {
  if (commits.length === 0) return [];

  // Get files for each commit
  const withFiles = commits.map(c => ({
    ...c,
    files: getFiles(c.changeId),
  }));

  // Group adjacent commits that share files
  const result = [];
  let groupIdx = 0;
  let prevFiles = new Set(withFiles[0].files.map(f => f.replace(/^[AMD] /, '')));
  result.push({ ...withFiles[0], groupIdx, action: 'keep' });

  for (let i = 1; i < withFiles.length; i++) {
    const currFiles = new Set(withFiles[i].files.map(f => f.replace(/^[AMD] /, '')));
    const overlap = [...currFiles].some(f => prevFiles.has(f));

    if (overlap) {
      // Same group — mark for squash
      result.push({ ...withFiles[i], groupIdx, action: 'squash' });
    } else {
      // New group
      groupIdx++;
      result.push({ ...withFiles[i], groupIdx, action: 'keep' });
    }
    prevFiles = currFiles;
  }

  return result;
}

/**
 * Build editor content for squash review.
 *
 * @param {Array} candidates — from analyzeSquashCandidates()
 * @returns {string}
 */
export function buildSquashContent(candidates) {
  const lines = [
    '# VPR Squash — review proposed squashes',
    '# Adjacent commits touching the same files are marked "squash".',
    '# Change "squash" to "keep" to preserve a commit as independent.',
    '# Change "keep" to "squash" to squash into the commit above.',
    '#',
  ];

  let lastGroup = -1;
  for (const c of candidates) {
    if (c.groupIdx !== lastGroup && lastGroup >= 0) {
      lines.push('');
    }
    lastGroup = c.groupIdx;

    const filesStr = c.files.length > 0
      ? `        (${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? ', …' : ''})`
      : '';
    lines.push(`${c.action} ${c.changeId} ${c.subject}${filesStr}`);
  }

  return lines.join('\n');
}

/**
 * Parse squash editor content back into actions.
 *
 * @param {string} content
 * @returns {Array<{ action: 'squash'|'keep', changeId: string, subject: string }>}
 */
export function parseSquashContent(content) {
  const results = [];
  const re = /^(squash|keep)\s+(\S+)\s*(.*)?$/;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(re);
    if (!m) continue;
    results.push({ action: m[1], changeId: m[2], subject: (m[3] || '').trim() });
  }

  return results;
}

/**
 * Execute squash actions. Processes from bottom to top to avoid
 * invalidating change IDs of earlier commits.
 *
 * @param {Array<{ action: 'squash'|'keep', changeId: string }>} actions
 * @returns {{ squashed: number, kept: number, errors: string[] }}
 */
export function executeSquash(actions) {
  let squashed = 0;
  let kept = 0;
  const errors = [];

  // Process bottom-up so squashing doesn't shift earlier commits
  const reversed = [...actions].reverse();
  for (const action of reversed) {
    if (action.action === 'keep') {
      kept++;
      continue;
    }
    try {
      jjSquash(action.changeId);
      squashed++;
    } catch (err) {
      errors.push(`${action.changeId}: ${err.message}`);
    }
  }

  return { squashed, kept, errors };
}

/**
 * Run the full squash flow for a VPR: analyze, build editor content,
 * and return the candidates. Caller handles the editor + execution.
 *
 * @param {string} query — VPR bookmark or partial match
 * @returns {Promise<{ bookmark: string, candidates: Array }>}
 */
export async function prepareSquash(query) {
  const meta = await loadMeta();
  const found = findVpr(meta, query);
  if (!found) throw new Error(`VPR not found: ${query}`);

  const { buildState } = await import('../core/state.mjs');
  const state = await buildState();
  const item = state.items.find(i => i.name === found.itemName);
  const vpr = item?.vprs.find(v => v.bookmark === found.bookmark);

  if (!vpr || vpr.commits.length === 0) {
    throw new Error(`No commits in VPR: ${found.bookmark}`);
  }

  const candidates = analyzeSquashCandidates(vpr.commits);

  await appendEvent('cli', 'vpr.squash.prepare', { bookmark: found.bookmark, commitCount: vpr.commits.length });

  return { bookmark: found.bookmark, candidates };
}
