import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir;
let originalCwd;

const EMPTY_META = { items: {}, hold: [], sent: {}, eventLog: [] };

function freshImport() {
  // We can't bust ESM cache, so we pass cwd via process.cwd() which meta.mjs uses.
  // All tests share the same imported module — we just change cwd between tests.
  return import('../../src/core/meta.mjs');
}

describe('meta core', () => {
  before(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-meta-test-'));
  });

  after(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test gets a clean temp dir
    tmpDir = mkdtempSync(join(tmpdir(), 'vpr-meta-test-'));
    process.chdir(tmpDir);
  });

  describe('loadMeta()', () => {
    it('returns empty structure when .vpr/meta.json does not exist', async () => {
      const { loadMeta } = await freshImport();
      const meta = await loadMeta();
      assert.deepStrictEqual(meta, EMPTY_META);
    });

    it('returns parsed object when .vpr/meta.json exists', async () => {
      const { saveMeta, loadMeta } = await freshImport();
      const data = { items: { foo: { wi: 1, wiTitle: 'Foo', vprs: {} } }, hold: [], sent: {}, eventLog: [] };
      await saveMeta(data);
      const loaded = await loadMeta();
      assert.deepStrictEqual(loaded, data);
    });
  });

  describe('saveMeta()', () => {
    it('creates .vpr/ directory if it does not exist', async () => {
      const { saveMeta } = await freshImport();
      assert.ok(!existsSync(join(tmpDir, '.vpr')), '.vpr should not exist yet');
      await saveMeta(EMPTY_META);
      assert.ok(existsSync(join(tmpDir, '.vpr', 'meta.json')), 'meta.json should exist after save');
    });

    it('writes valid JSON', async () => {
      const { saveMeta } = await freshImport();
      const data = { items: {}, hold: ['abc123'], sent: { 'feat/x': { prId: 42 } }, eventLog: [] };
      await saveMeta(data);
      const raw = readFileSync(join(tmpDir, '.vpr', 'meta.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, data);
    });

    it('overwrites existing file', async () => {
      const { saveMeta, loadMeta } = await freshImport();
      await saveMeta({ items: {}, hold: ['first'], sent: {}, eventLog: [] });
      await saveMeta({ items: {}, hold: ['second'], sent: {}, eventLog: [] });
      const meta = await loadMeta();
      assert.deepStrictEqual(meta.hold, ['second']);
    });
  });

  describe('appendEvent()', () => {
    it('adds an event entry to eventLog', async () => {
      const { loadMeta, appendEvent } = await freshImport();
      await appendEvent('claude', 'add', { item: 'foo', vpr: 'scaffold' });
      const meta = await loadMeta();
      assert.strictEqual(meta.eventLog.length, 1);
      const ev = meta.eventLog[0];
      assert.strictEqual(ev.actor, 'claude');
      assert.strictEqual(ev.action, 'add');
      assert.deepStrictEqual(ev.detail, { item: 'foo', vpr: 'scaffold' });
      assert.ok(typeof ev.ts === 'string', 'ts should be a string');
      assert.ok(!isNaN(Date.parse(ev.ts)), 'ts should be a valid ISO timestamp');
    });

    it('appends multiple events in order', async () => {
      const { loadMeta, appendEvent } = await freshImport();
      await appendEvent('cli', 'add', { item: 'a' });
      await appendEvent('tui', 'edit', { item: 'b' });
      await appendEvent('claude', 'remove', { item: 'c' });
      const meta = await loadMeta();
      assert.strictEqual(meta.eventLog.length, 3);
      assert.strictEqual(meta.eventLog[0].action, 'add');
      assert.strictEqual(meta.eventLog[1].action, 'edit');
      assert.strictEqual(meta.eventLog[2].action, 'remove');
    });

    it('saves after appending (persists to disk)', async () => {
      const { loadMeta, appendEvent } = await freshImport();
      await appendEvent('claude', 'generate', { item: 'x' });
      // Verify it's on disk by checking the raw JSON
      const raw = readFileSync(join(tmpDir, '.vpr', 'meta.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.eventLog.length, 1);
    });

    it('caps eventLog at 100 entries, keeping newest', async () => {
      const { loadMeta, appendEvent } = await freshImport();

      // Seed 99 existing events via saveMeta, then append 5 more
      const { saveMeta } = await freshImport();
      const existing = Array.from({ length: 99 }, (_, i) => ({
        ts: new Date(1000 + i).toISOString(),
        actor: 'cli',
        action: 'seed',
        detail: { i },
      }));
      await saveMeta({ items: {}, hold: [], sent: {}, eventLog: existing });

      // Now append — total would be 100, no cap needed yet
      await appendEvent('claude', 'add', { item: 'hundredth' });
      let meta = await loadMeta();
      assert.strictEqual(meta.eventLog.length, 100);

      // Append one more — should cap to 100 (drop the oldest)
      await appendEvent('claude', 'add', { item: 'hundred-first' });
      meta = await loadMeta();
      assert.strictEqual(meta.eventLog.length, 100);

      // The newest entry should be the last one
      const last = meta.eventLog[meta.eventLog.length - 1];
      assert.deepStrictEqual(last.detail, { item: 'hundred-first' });

      // The first entry should NOT be the original seed[0] any more
      const first = meta.eventLog[0];
      assert.notDeepStrictEqual(first.detail, { i: 0 });
    });
  });
});
