/**
 * `vpr archive` command surface — migrate terminal state out of meta.json into
 * the SQLite archive, and list/query what's been archived.
 *
 * The archive itself (schema, read/write) lives in `src/core/archive.mjs`.
 * This module is the CLI-facing glue: the one-time migration and thin list
 * wrappers matching the existing command style (small async functions returning
 * plain data, JSON-printed by bin/vpr.mjs).
 */

import { loadMeta, saveMeta } from '../core/meta.mjs';
import { archiveTerminal, getArchive, listArchive, countArchive } from '../core/archive.mjs';

/**
 * One-time migration: drain terminal state from the active pool into the
 * archive, then shrink meta.json.
 *
 *  1. Every `meta.sent` entry becomes an archived sent VPR.
 *  2. Every `ticket.done` in the eventLog whose item is no longer active (and
 *     isn't already archived) is recovered as an archived done item — the
 *     original delete-on-done dropped everything but this log line.
 *  3. `meta.sent` is emptied and meta.json rewritten (shrunk).
 *
 * Idempotent: entries already present in the archive are skipped, so a second
 * run migrates nothing new.
 *
 * @returns {Promise<{
 *   sentMigrated: number,
 *   doneRecovered: number,
 *   metaBytesBefore: number,
 *   metaBytesAfter: number,
 * }>}
 */
export async function migrateArchive() {
  const meta = await loadMeta();
  const metaBytesBefore = Buffer.byteLength(JSON.stringify(meta, null, 2), 'utf-8');

  // 1. Sent VPRs → archive.
  let sentMigrated = 0;
  for (const [branch, entry] of Object.entries(meta.sent ?? {})) {
    if (getArchive(branch)) continue;
    archiveTerminal({
      name: branch,
      kind: 'vpr',
      status: 'sent',
      itemName: entry?.itemName ?? null,
      wi: entry?.wi ?? null,
      provider: entry?.provider ?? null,
      ticket: entry?.prId != null ? String(entry.prId) : null,
      title: entry?.prTitle ?? null,
      targetBranch: entry?.targetBranch ?? null,
      originalBookmark: entry?.originalBookmark ?? null,
      sentAt: entry?.sentAt ?? null,
      raw: entry,
    });
    sentMigrated++;
  }

  // 2. Recover done items from the eventLog (best-effort — only the name and
  //    timestamp survived the original delete).
  const activeItems = new Set(Object.keys(meta.items ?? {}));
  const seen = new Set();
  let doneRecovered = 0;
  for (const ev of meta.eventLog ?? []) {
    if (ev?.action !== 'ticket.done') continue;
    const name = ev?.detail?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (activeItems.has(name)) continue; // still active — not terminal
    if (getArchive(name)) continue; // already archived
    archiveTerminal({
      name,
      kind: 'item',
      status: 'done',
      itemName: name,
      doneAt: ev.ts ?? null,
      raw: { recoveredFrom: 'eventLog', event: ev },
    });
    doneRecovered++;
  }

  // 3. Shrink meta.json — sent is now owned by the archive.
  meta.sent = {};
  await saveMeta(meta);
  const metaBytesAfter = Buffer.byteLength(JSON.stringify(meta, null, 2), 'utf-8');

  return { sentMigrated, doneRecovered, metaBytesBefore, metaBytesAfter };
}

/**
 * List archived records (thin wrapper for the CLI).
 * @param {{ status?: 'sent'|'done', name?: string }} [filter]
 * @returns {ArchiveRecord[]}
 */
export function archiveLs(filter = {}) {
  return listArchive(filter);
}

/**
 * Fetch a single archived record by exact name.
 * @param {string} name
 * @returns {ArchiveRecord|null}
 */
export function archiveGet(name) {
  return getArchive(name);
}

/**
 * Summary counts for the archive.
 * @returns {{ total: number, sent: number, done: number }}
 */
export function archiveStats() {
  return {
    total: countArchive(),
    sent: countArchive({ status: 'sent' }),
    done: countArchive({ status: 'done' }),
  };
}
