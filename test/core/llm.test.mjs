import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('core/llm runLLM', () => {
  it('defaults to "claude -p" when no command or env var', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    let seenCmd = null;
    const runShell = (cmd) => { seenCmd = cmd; return 'OK'; };
    runLLM('prompt', { env: {}, runShell });
    assert.strictEqual(seenCmd, 'claude -p');
  });

  it('uses SHIP_LLM env var when set', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    let seenCmd = null;
    const runShell = (cmd) => { seenCmd = cmd; return 'OK'; };
    runLLM('prompt', { env: { SHIP_LLM: 'my-llm -p' }, runShell });
    assert.strictEqual(seenCmd, 'my-llm -p');
  });

  it('command option overrides env var', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    let seenCmd = null;
    const runShell = (cmd) => { seenCmd = cmd; return 'OK'; };
    runLLM('prompt', { command: 'explicit', env: { SHIP_LLM: 'env-cmd' }, runShell });
    assert.strictEqual(seenCmd, 'explicit');
  });

  it('passes prompt to runShell as stdin argument', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    let seenStdin = null;
    const runShell = (_cmd, stdin) => { seenStdin = stdin; return 'OK'; };
    runLLM('my prompt here', { env: {}, runShell });
    assert.strictEqual(seenStdin, 'my prompt here');
  });

  it('returns trimmed stdout from runShell', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    const runShell = () => '  polished description  \n\n';
    const result = runLLM('prompt', { env: {}, runShell });
    assert.strictEqual(result, 'polished description');
  });

  it('throws when runShell throws', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    const runShell = () => { throw new Error('LLM offline'); };
    assert.throws(
      () => runLLM('prompt', { env: {}, runShell }),
      /LLM offline/
    );
  });

  it('throws when runShell returns empty string', async () => {
    const { runLLM } = await import('../../src/core/llm.mjs');
    const runShell = () => '   \n\n  ';
    assert.throws(
      () => runLLM('prompt', { env: {}, runShell }),
      /empty/i
    );
  });
});
