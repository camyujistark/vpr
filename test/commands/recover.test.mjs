import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const vprBin = join(repoRoot, 'bin/vpr.mjs');

let tmpDir;
let originalCwd;

before(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vpr-recover-test-'));
  mkdirSync(join(tmpDir, '.vpr'), { recursive: true });
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(originalCwd);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('vpr recover — requires jj', () => {
  it('exits with "Install jj" message when jj is not in PATH', () => {
    try {
      execSync(`node ${vprBin} recover --yes`, {
        cwd: tmpDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('Expected vpr recover to exit non-zero');
    } catch (err) {
      const output = (err.stderr ?? '') + (err.stdout ?? '');
      assert.ok(
        output.includes('Install jj'),
        `Expected "Install jj" in output, got: ${output}`
      );
      assert.notStrictEqual(err.status, 0, 'Expected non-zero exit code');
    }
  });
});
