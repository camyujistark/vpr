import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const skillPath = join(homedir(), '.claude/skills/vpr/SKILL.md');

test('vpr SKILL.md tells the agent to always ask the human for the story narrative — never fabricate it', () => {
  const body = readFileSync(skillPath, 'utf8');
  assert.match(
    body,
    /always ask the human for the story/i,
    'agent contract requires explicit "always ask the human for the story" rule (spec §Implementation Decisions, Agent contract)'
  );
  assert.match(
    body,
    /never fabricate/i,
    'agent contract requires explicit "never fabricate" prohibition so the agent does not invent narrative'
  );
});
