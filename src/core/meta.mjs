import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrateMeta } from './migration.mjs';

const MAX_EVENT_LOG = 100;

/** @returns {string} path to .vpr/meta.json relative to cwd */
function metaPath() {
  return join(process.cwd(), '.vpr', 'meta.json');
}

/** @returns {{ items: {}, hold: [], sent: {}, eventLog: [] }} */
function emptyMeta() {
  return { items: {}, hold: [], sent: {}, eventLog: [] };
}

/**
 * Read .vpr/meta.json. Returns empty structure if file doesn't exist.
 * @returns {Promise<object>}
 */
export async function loadMeta() {
  const path = metaPath();
  if (!existsSync(path)) return emptyMeta();
  try {
    const raw = readFileSync(path, 'utf-8');
    const meta = JSON.parse(raw);
    const migrated = migrateMeta(meta);
    if (JSON.stringify(migrated) !== JSON.stringify(meta)) {
      await saveMeta(migrated);
    }
    return migrated;
  } catch {
    return emptyMeta();
  }
}

/**
 * Write meta to .vpr/meta.json. Creates .vpr/ dir if needed.
 * @param {object} meta
 * @returns {Promise<void>}
 */
export async function saveMeta(meta) {
  const path = metaPath();
  const dir = join(process.cwd(), '.vpr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Append an event to eventLog, cap at 100 (newest kept), then save.
 * @param {'claude'|'tui'|'cli'} actor
 * @param {string} action
 * @param {object} detail
 * @returns {Promise<void>}
 */
export async function appendEvent(actor, action, detail) {
  const meta = await loadMeta();
  const entry = { ts: new Date().toISOString(), actor, action, detail };
  meta.eventLog.push(entry);
  if (meta.eventLog.length > MAX_EVENT_LOG) {
    meta.eventLog = meta.eventLog.slice(-MAX_EVENT_LOG);
  }
  await saveMeta(meta);
}
