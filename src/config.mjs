/**
 * VPR project config — loaded from .vpr/config.json in the repo root.
 *
 * Created by `vpr init`. Provider-specific settings live here.
 */

import fs from 'fs';
import path from 'path';
import { git } from './git.mjs';

const CONFIG_DIR = '.vpr';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const META_FILE = path.join(CONFIG_DIR, 'meta.json');

function repoRoot() {
  return git('rev-parse --show-toplevel');
}

export function configPath() {
  return path.join(repoRoot(), CONFIG_FILE);
}

export function metaPath() {
  return path.join(repoRoot(), META_FILE);
}

export function configDirPath() {
  return path.join(repoRoot(), CONFIG_DIR);
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  const dir = configDirPath();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

export function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
  } catch {
    return {};
  }
}

export function saveMeta(meta) {
  const dir = configDirPath();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2) + '\n');
}

/**
 * Default config templates per provider
 */
export const PROVIDERS = {
  'azure-devops': {
    provider: 'azure-devops',
    prefix: 'TP',
    org: '',
    project: '',
    repo: '',
    wiType: 'Task',
  },
  'github': {
    provider: 'github',
    prefix: 'GH',
    repo: '', // owner/repo
  },
  'bitbucket': {
    provider: 'bitbucket',
    prefix: 'BB',
    workspace: '',
    repo: '',
  },
  'gitlab': {
    provider: 'gitlab',
    prefix: 'GL',
    repo: '', // project path
  },
  'none': {
    provider: 'none',
    prefix: 'VPR',
  },
};
