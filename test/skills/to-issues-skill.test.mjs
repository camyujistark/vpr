import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const skillPath = join(homedir(), '.claude/skills/to-issues/SKILL.md');

test('to-issues SKILL.md captures parentWi on vpr items and integrates with /to-prd', () => {
  const body = readFileSync(skillPath, 'utf8');

  // AC: to-issues SKILL.md updated to capture parentWi when creating vpr items
  assert.match(
    body,
    /parentWi/,
    'skill must reference the parentWi meta.items field so it knows where to write the parent work-item id'
  );

  // AC: skill instructs to fetch parent WI title + description and cache locally
  assert.match(
    body,
    /parentWiTitle/,
    'skill must instruct caching of parentWiTitle in meta.items so generate-prompt-enrichment has a parent header'
  );
  assert.match(
    body,
    /parentWiDescription/,
    'skill must instruct caching of parentWiDescription in meta.items so generate-prompt-enrichment can include the PARENT PRD section'
  );

  // AC: documentation of the workflow integration with /to-prd
  assert.match(
    body,
    /\/to-prd/,
    'skill must document the upstream /to-prd flow that produces the parent PBI to-issues then references via parentWi'
  );
});
