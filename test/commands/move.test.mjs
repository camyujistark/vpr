import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveCommit } from '../../src/commands/move.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

let tmpDir;
let originalCwd;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-move-test-'));
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
}

function teardown() {
  if (originalCwd) process.chdir(originalCwd);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

describe('moveCommit — module export', () => {
  it('exports moveCommit as an async function (AC1)', () => {
    assert.strictEqual(typeof moveCommit, 'function');
    const result = moveCommit('abc', { toVpr: 'x' });
    assert.ok(result instanceof Promise, 'moveCommit should return a Promise');
    result.catch(() => {}); // suppress unhandled rejection
  });

  it('throws "Install jj for surgical commit moves" when jj is absent (AC2)', async () => {
    await assert.rejects(
      () => moveCommit('abc123', { toVpr: 'my-vpr' }),
      (err) => {
        assert.ok(
          err.message.includes('Install jj for surgical commit moves'),
          `unexpected message: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('vpr move — requires jj', () => {
  before(() => { originalCwd = process.cwd(); setup(); });
  after(teardown);

  it('exits with "Install jj for surgical commit moves" when jj is not in PATH', () => {
    try {
      execSync(`node ${vprBin} move abc123 --to my-vpr`, {
        cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('Expected vpr move to exit non-zero');
    } catch (err) {
      const output = (err.stderr ?? '') + (err.stdout ?? '');
      assert.ok(
        output.includes('Install jj for surgical commit moves'),
        `Expected error message, got: ${output}`
      );
      assert.notStrictEqual(err.status, 0, 'Expected non-zero exit code');
    }
  });

  it('vpr --help includes vpr move (AC9)', () => {
    const out = execSync(`node ${vprBin} --help`, {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(out.includes('vpr move'), `--help missing "vpr move": ${out}`);
  });
});
