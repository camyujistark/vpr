/**
 * vpr init — bootstrap a jj-colocated repo with .vpr/ metadata and exclusions.
 */

import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';

const EXEC_OPTS = { encoding: 'utf-8', shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] };

/**
 * Idempotently initialise a VPR workspace in the current directory.
 *
 * Steps performed (each skipped if already done):
 *   1. `jj git init --colocate` (if no .jj/)
 *   2. Create .vpr/config.json from opts
 *   3. Create .vpr/meta.json with empty structure
 *   4. Append .vpr/ and .jj/ to .git/info/exclude
 *   5. Set jj snapshot.auto-track to exclude .vpr/
 *
 * @param {{ provider?: string, org?: string, project?: string, repo?: string, wiType?: string }} opts
 * @returns {Promise<{ steps: string[] }>}
 */
export async function init(opts = {}) {
  const cwd = process.cwd();
  const steps = [];

  // 1. jj git init --colocate
  if (!existsSync(join(cwd, '.jj'))) {
    execSync('jj git init --colocate', { ...EXEC_OPTS, cwd });
    steps.push('jj git init --colocate');
  }

  // 2. .vpr/config.json
  const vprDir = join(cwd, '.vpr');
  const configPath = join(vprDir, 'config.json');
  if (!existsSync(configPath)) {
    mkdirSync(vprDir, { recursive: true });

    // Derive a default repo name from git remote or directory basename
    let repoName = opts.repo;
    if (!repoName) {
      try {
        const remote = execSync('git remote get-url origin', { ...EXEC_OPTS, cwd }).trim();
        // extract repo name from URL (handles both ssh and https)
        repoName = basename(remote).replace(/\.git$/, '');
      } catch {
        repoName = basename(cwd);
      }
    }

    const config = {
      provider: opts.provider || 'none',
      repo: repoName,
    };
    if (opts.org) config.org = opts.org;
    if (opts.project) config.project = opts.project;
    if (opts.wiType) config.wiType = opts.wiType;

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    steps.push('created .vpr/config.json');
  }

  // 3. .vpr/meta.json
  const metaPath = join(vprDir, 'meta.json');
  if (!existsSync(metaPath)) {
    mkdirSync(vprDir, { recursive: true });
    const meta = { items: {}, hold: [], sent: {}, eventLog: [] };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    steps.push('created .vpr/meta.json');
  }

  // 4. .git/info/exclude — append .vpr/ and .jj/ if not already present
  const infoDir = join(cwd, '.git', 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, 'exclude');

  let excludeContent = '';
  if (existsSync(excludePath)) {
    excludeContent = readFileSync(excludePath, 'utf-8');
  }

  const lines = excludeContent.split('\n');
  const toAppend = [];

  if (!lines.some(l => l.trim() === '.vpr/')) {
    toAppend.push('.vpr/');
  }
  if (!lines.some(l => l.trim() === '.jj/')) {
    toAppend.push('.jj/');
  }

  if (toAppend.length > 0) {
    // Ensure we start on a new line
    const prefix = excludeContent.length > 0 && !excludeContent.endsWith('\n') ? '\n' : '';
    appendFileSync(excludePath, prefix + toAppend.join('\n') + '\n', 'utf-8');
    steps.push(`added ${toAppend.join(', ')} to .git/info/exclude`);
  }

  // 5. jj config — snapshot.auto-track should exclude .vpr/
  let autoTrack = '';
  try {
    autoTrack = execSync('jj config get snapshot.auto-track', { ...EXEC_OPTS, cwd }).trim();
  } catch {
    // not set yet
  }

  if (!autoTrack.includes('.vpr')) {
    // Default jj auto-track is "all()" — we want "all() & ~glob:'.vpr/**'"
    const base = autoTrack || 'all()';
    const newVal = `${base} & ~glob:'.vpr/**'`;
    // The value must be wrapped in escaped double quotes so jj receives a valid TOML string
    execSync(`jj config set --repo snapshot.auto-track "\\"${newVal}\\""`, { ...EXEC_OPTS, cwd });
    steps.push('configured jj snapshot.auto-track');
  }

  return { steps };
}
