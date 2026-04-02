/**
 * Git helpers — thin wrappers around execSync.
 */

import { execSync } from 'child_process';

export function git(cmd) {
  return execSync(`git ${cmd}`, {
    encoding: 'utf-8',
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function gitSafe(cmd) {
  try { return git(cmd); } catch { return null; }
}

export function currentBranch() {
  return git('branch --show-current');
}

export function getBase() {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitSafe(`rev-parse --verify ${ref}`)) return ref;
  }
  return null;
}

export function getFilesForCommit(sha) {
  try {
    return git(`diff-tree --no-commit-id --name-only -r ${sha}`).split('\n').filter(Boolean);
  } catch { return []; }
}

export function getDiffForCommit(sha) {
  try { return git(`show --stat --patch --color=never ${sha}`); } catch { return ''; }
}

export function getNumstatForCommit(sha) {
  try {
    return git(`diff-tree --no-commit-id --numstat -r ${sha}`)
      .split('\n').filter(Boolean)
      .map(line => {
        const [added, removed, file] = line.split('\t');
        return { file, added: parseInt(added) || 0, removed: parseInt(removed) || 0 };
      });
  } catch { return []; }
}
