/**
 * SQLite-backed archive for TERMINAL VPR work.
 *
 * The active pool (`.vpr/meta.json`) holds only in-flight items and VPRs.
 * When a VPR is sent (its PR is created) or an item is marked done, its record
 * leaves the active pool and lands here — a queryable store that never bloats
 * `meta.json`. One row per terminal record, keyed by `name` (the branch name
 * for a sent VPR, the item name for a done item — the same join key the rest of
 * the codebase uses).
 *
 * Store location tracks where the active state lives: `.vpr/archive.db`, right
 * next to `meta.json`, so the archive travels with the pool it drains.
 *
 * @typedef {object} ArchiveRecord
 * @property {string}  name              Join key — branch name (sent) / item name (done).
 * @property {'vpr'|'item'} kind         What was archived.
 * @property {'sent'|'done'} status      Terminal fate.
 * @property {string} [itemName]         Owning item.
 * @property {number} [wi]               Work item id.
 * @property {string} [provider]         Provider key (azure-devops/github/none).
 * @property {string} [ticket]           External ref (PR id / issue number).
 * @property {string} [title]            PR / item title.
 * @property {string} [story]            VPR story narrative.
 * @property {string} [acceptance]       Rendered output / acceptance criteria.
 * @property {string} [targetBranch]     Branch the PR targeted.
 * @property {string} [originalBookmark] Pre-send bookmark/branch name.
 * @property {string} [sentAt]           ISO timestamp of send.
 * @property {string} [doneAt]           ISO timestamp of done.
 * @property {object} [raw]              Full original record, for fidelity.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

/** @returns {string} path to .vpr/archive.db relative to cwd */
function archivePath() {
  return join(process.cwd(), '.vpr', 'archive.db');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS archive (
    name              TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    status            TEXT NOT NULL,
    item_name         TEXT,
    wi                INTEGER,
    provider          TEXT,
    ticket            TEXT,
    title             TEXT,
    story             TEXT,
    acceptance        TEXT,
    target_branch     TEXT,
    original_bookmark TEXT,
    sent_at           TEXT,
    done_at           TEXT,
    archived_at       TEXT NOT NULL,
    raw               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_archive_status ON archive(status);
`;

/**
 * Open the archive database at the current cwd.
 * Opens a fresh handle each call so `process.chdir` (used heavily in tests)
 * never leaves a handle pointing at a stale directory.
 *
 * @param {{ create?: boolean }} [opts]
 * @returns {DatabaseSync|null} null when create=false and no db exists yet.
 */
function openArchive({ create = false } = {}) {
  const path = archivePath();
  if (!create && !existsSync(path)) return null;
  if (create) {
    const dir = join(process.cwd(), '.vpr');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Map a raw DB row (snake_case) to the camelCase record shape. */
function rowToRecord(row) {
  return {
    name: row.name,
    kind: row.kind,
    status: row.status,
    itemName: row.item_name ?? null,
    wi: row.wi ?? null,
    provider: row.provider ?? null,
    ticket: row.ticket ?? null,
    title: row.title ?? null,
    story: row.story ?? null,
    acceptance: row.acceptance ?? null,
    targetBranch: row.target_branch ?? null,
    originalBookmark: row.original_bookmark ?? null,
    sentAt: row.sent_at ?? null,
    doneAt: row.done_at ?? null,
    archivedAt: row.archived_at,
    raw: row.raw ? safeParse(row.raw) : null,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Insert or replace a terminal record. Creates the db + `.vpr/` on first write.
 * @param {ArchiveRecord} record
 * @returns {void}
 */
export function archiveTerminal(record) {
  if (!record?.name) throw new Error('archiveTerminal: record.name is required');
  if (!record.kind) throw new Error('archiveTerminal: record.kind is required');
  if (!record.status) throw new Error('archiveTerminal: record.status is required');

  const db = openArchive({ create: true });
  try {
    const stmt = db.prepare(`
      INSERT INTO archive (
        name, kind, status, item_name, wi, provider, ticket, title, story,
        acceptance, target_branch, original_bookmark, sent_at, done_at,
        archived_at, raw
      ) VALUES (
        $name, $kind, $status, $item_name, $wi, $provider, $ticket, $title, $story,
        $acceptance, $target_branch, $original_bookmark, $sent_at, $done_at,
        $archived_at, $raw
      )
      ON CONFLICT(name) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        item_name = excluded.item_name,
        wi = excluded.wi,
        provider = excluded.provider,
        ticket = excluded.ticket,
        title = excluded.title,
        story = excluded.story,
        acceptance = excluded.acceptance,
        target_branch = excluded.target_branch,
        original_bookmark = excluded.original_bookmark,
        sent_at = excluded.sent_at,
        done_at = excluded.done_at,
        archived_at = excluded.archived_at,
        raw = excluded.raw
    `);
    stmt.run({
      $name: record.name,
      $kind: record.kind,
      $status: record.status,
      $item_name: record.itemName ?? null,
      $wi: record.wi ?? null,
      $provider: record.provider ?? null,
      $ticket: record.ticket ?? null,
      $title: record.title ?? null,
      $story: record.story ?? null,
      $acceptance: record.acceptance ?? null,
      $target_branch: record.targetBranch ?? null,
      $original_bookmark: record.originalBookmark ?? null,
      $sent_at: record.sentAt ?? null,
      $done_at: record.doneAt ?? null,
      $archived_at: record.archivedAt ?? new Date().toISOString(),
      $raw: record.raw ? JSON.stringify(record.raw) : null,
    });
  } finally {
    db.close();
  }
}

/**
 * List archived records, newest-archived first.
 * @param {{ status?: 'sent'|'done', name?: string }} [filter]
 * @returns {ArchiveRecord[]}
 */
export function listArchive({ status, name } = {}) {
  const db = openArchive();
  if (!db) return [];
  try {
    const where = [];
    const params = {};
    if (status) {
      where.push('status = $status');
      params.$status = status;
    }
    if (name) {
      where.push('name LIKE $name');
      params.$name = `%${name}%`;
    }
    const sql =
      'SELECT * FROM archive' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY archived_at DESC, rowid DESC';
    const rows = db.prepare(sql).all(params);
    return rows.map(rowToRecord);
  } finally {
    db.close();
  }
}

/**
 * Fetch a single archived record by exact name.
 * @param {string} name
 * @returns {ArchiveRecord|null}
 */
export function getArchive(name) {
  const db = openArchive();
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM archive WHERE name = $name').get({ $name: name });
    return row ? rowToRecord(row) : null;
  } finally {
    db.close();
  }
}

/**
 * Reconstruct a `sent` map (branch name → chain-state fields) from archived
 * sent VPRs, in the shape `computeChainState`/`buildState` expect from
 * `meta.sent`. Lets terminal sent VPRs still anchor the active chain (cascade
 * targeting, sent-bookmark barriers) without living in `meta.json`.
 *
 * @returns {Record<string, object>}
 */
export function archiveSentMap() {
  const map = {};
  for (const row of listArchive({ status: 'sent' })) {
    map[row.name] = {
      prId: row.ticket != null ? Number(row.ticket) : null,
      prTitle: row.title,
      targetBranch: row.targetBranch,
      itemName: row.itemName,
      wi: row.wi,
      originalBookmark: row.originalBookmark,
      sentAt: row.sentAt,
    };
  }
  return map;
}

/**
 * Count archived records, optionally by status.
 * @param {{ status?: 'sent'|'done' }} [filter]
 * @returns {number}
 */
export function countArchive({ status } = {}) {
  const db = openArchive();
  if (!db) return 0;
  try {
    const sql = status
      ? 'SELECT COUNT(*) AS n FROM archive WHERE status = $status'
      : 'SELECT COUNT(*) AS n FROM archive';
    const row = db.prepare(sql).get(status ? { $status: status } : {});
    return row.n;
  } finally {
    db.close();
  }
}
