import { execSync } from 'child_process';

function defaultRunShell(cmd, stdin) {
  return execSync(cmd, {
    input: stdin,
    encoding: 'utf-8',
    shell: '/bin/bash',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function runLLM(prompt, { command, env = process.env, runShell = defaultRunShell } = {}) {
  const cmd = command || env.SHIP_LLM || 'claude -p';
  const output = runShell(cmd, prompt);
  const trimmed = (output || '').trim();
  if (!trimmed) throw new Error('LLM returned empty response');
  return trimmed;
}
