/**
 * Verifies that the sandcastle main.ts template auto-invokes vpr sync after
 * each successful run. The full integration test (hook fires end-to-end) lives
 * in the AC-15 integration suite; this test guards the source structure so the
 * sync call can't be accidentally removed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('sandcastle main.ts — post-run vpr sync', () => {
  for (const file of ['templates/sandcastle-main.ts', '.sandcastle/main.ts']) {
    it(`${file} invokes vpr sync after runOne`, () => {
      const src = readFileSync(resolve(root, file), 'utf-8');
      assert.ok(
        src.includes('vpr sync') || src.includes('vpr.mjs sync') || src.includes('syncAfterRun'),
        `Expected ${file} to invoke vpr sync after runOne. Got excerpt:\n${src.slice(0, 300)}`
      );
    });
  }
});
