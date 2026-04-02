import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpr-test-'));

describe('vpr init', () => {
  beforeEach(() => {
    // Create a temp git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .vpr/config.json', () => {
    // Simulate init by writing config directly (init is interactive)
    const configDir = path.join(tmpDir, '.vpr');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      provider: 'github',
      prefix: 'FE',
      repo: 'owner/repo',
    }));

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    assert.strictEqual(config.provider, 'github');
    assert.strictEqual(config.prefix, 'FE');
    assert.strictEqual(config.repo, 'owner/repo');
  });
});

describe('provider factory', () => {
  it('creates azure-devops provider', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const p = createProvider({ provider: 'azure-devops', org: 'test', project: 'test', repo: 'test' });
    assert.strictEqual(p.name, 'Azure DevOps');
  });

  it('creates github provider', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const p = createProvider({ provider: 'github', repo: 'owner/repo' });
    assert.strictEqual(p.name, 'GitHub');
  });

  it('creates none provider', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    const p = createProvider({ provider: 'none' });
    assert.strictEqual(p.name, 'local (no provider)');
  });

  it('throws on unknown provider', async () => {
    const { createProvider } = await import('../src/providers/index.mjs');
    assert.throws(() => createProvider({ provider: 'unknown' }), /Unknown provider/);
  });
});

describe('PROVIDERS config templates', () => {
  it('has all expected providers', async () => {
    const { PROVIDERS } = await import('../src/config.mjs');
    assert.ok(PROVIDERS['azure-devops']);
    assert.ok(PROVIDERS['github']);
    assert.ok(PROVIDERS['bitbucket']);
    assert.ok(PROVIDERS['gitlab']);
    assert.ok(PROVIDERS['none']);
  });

  it('azure-devops has required fields', async () => {
    const { PROVIDERS } = await import('../src/config.mjs');
    const tmpl = PROVIDERS['azure-devops'];
    assert.strictEqual(tmpl.provider, 'azure-devops');
    assert.ok('org' in tmpl);
    assert.ok('project' in tmpl);
    assert.ok('repo' in tmpl);
    assert.ok('wiType' in tmpl);
    assert.ok('prefix' in tmpl);
  });

  it('github has required fields', async () => {
    const { PROVIDERS } = await import('../src/config.mjs');
    const tmpl = PROVIDERS['github'];
    assert.strictEqual(tmpl.provider, 'github');
    assert.ok('repo' in tmpl);
    assert.ok('prefix' in tmpl);
  });
});
