#!/usr/bin/env node
/**
 * ship — v0.2 plan-first CLI. Reads plan.md, polishes Descriptions via LLM,
 * and pushes stacked PRs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function loadConfig() {
  const path = join(process.cwd(), '.vpr', 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function resolveProvider(flags) {
  if (flags['no-provider']) return null;
  const config = loadConfig();
  if (!config?.provider || config.provider === 'none') return null;

  const { createProvider } = await import('../src/providers/index.mjs');
  const base = createProvider(config);

  // Adapt BaseProvider positional createPR to ship's keyword-arg shape.
  return {
    createPR: async ({ branch, base: target, title, body, taskWi }) =>
      base.createPR(branch, target, title, body, taskWi),
  };
}

function helpGen() {
  return `
  ship gen <level> <name>     Polish Description for one section
  ship gen --all              Polish every section with a Story

  Levels: epic | task | pr

  Flags:
    --plan <path>   Path to plan file (default: plan.md)
    --dry           Print generated text; do not modify plan.md
    --pipe          Print the assembled prompt; do not call the LLM
    --fresh         Ignore current Description when building the prompt
    --yes           Skip \$EDITOR review; write LLM output directly
`;
}

function helpShip() {
  return `
  ship                       Push stacked PRs from plan.md
  ship push                  Alias for \`ship\`

  Flags:
    --plan <path>   Path to plan file (default: plan.md)
    --dry           Compute plan without pushing or creating PRs
    --no-provider   Push bookmarks only; skip PR creation
`;
}

function help() {
  return `
  ship — v0.2 plan-first PR tool

  Commands:
    ship                       Push stacked PRs from plan.md
    ship gen <level> [name]    Polish Description via LLM
    ship help                  Show this help
${helpShip()}${helpGen()}`;
}

async function runGen() {
  const { positional, flags } = parseFlags(rest);
  const { gen, genAll } = await import('../src/commands/gen.mjs');

  const opts = {
    planPath: flags.plan || 'plan.md',
    dry: !!flags.dry,
    pipe: !!flags.pipe,
    fresh: !!flags.fresh,
    yes: !!flags.yes,
  };

  if (flags.all) {
    const results = genAll(opts);
    printGenResults(results);
    const anyErrors = results.some(r => r.status === 'error');
    process.exit(anyErrors ? 1 : 0);
  }

  const [level, ...nameParts] = positional;
  if (!level) {
    console.error('Usage: ship gen <epic|task|pr> [name]');
    process.exit(2);
  }
  if (!['epic', 'task', 'pr'].includes(level)) {
    console.error(`Unknown level: ${level} (expected epic, task, or pr)`);
    process.exit(2);
  }
  const name = nameParts.length > 0 ? nameParts.join(' ') : null;
  if (level !== 'epic' && !name) {
    console.error(`Level "${level}" requires a name: ship gen ${level} "<section title>"`);
    process.exit(2);
  }

  const result = gen({ level, name, ...opts });
  printGenResult(result);
}

async function runShip(flagsArgs) {
  const { flags } = parseFlags(flagsArgs);
  const { ship } = await import('../src/commands/ship.mjs');

  const provider = await resolveProvider(flags);
  const opts = {
    planPath: flags.plan || 'plan.md',
    dryRun: !!flags.dry,
    provider,
  };

  const results = ship(opts);
  printShipResults(results, opts);

  const anyErrors = results.some(r => r.status === 'error');
  process.exit(anyErrors ? 1 : 0);
}

function printGenResult(r) {
  switch (r.status) {
    case 'written':
      console.log(`✓ wrote ${r.level}${r.name ? ` "${r.name}"` : ''}`);
      break;
    case 'discarded':
      console.log(`· discarded ${r.level}${r.name ? ` "${r.name}"` : ''} (editor returned empty)`);
      break;
    case 'dry':
      console.log(r.content);
      break;
    case 'pipe':
      console.log(r.prompt);
      break;
    default:
      console.log(JSON.stringify(r));
  }
}

function printGenResults(results) {
  for (const r of results) {
    const label = `${r.level}${r.name ? ` "${r.name}"` : ''}`;
    switch (r.status) {
      case 'written': console.log(`✓ ${label}`); break;
      case 'discarded': console.log(`· ${label} (discarded)`); break;
      case 'skipped-no-story': console.log(`- ${label} (no Story, skipped)`); break;
      case 'error': console.log(`✗ ${label} — ${r.error}`); break;
      case 'dry': console.log(`--- ${label} (dry) ---\n${r.content}\n`); break;
      case 'pipe': console.log(`--- ${label} (pipe) ---\n${r.prompt}\n`); break;
      default: console.log(`? ${label} — ${JSON.stringify(r)}`);
    }
  }
}

function printShipResults(results, { dryRun }) {
  const header = dryRun ? 'dry run — no changes applied' : 'shipped';
  console.log(`\n${header}\n`);
  for (const r of results) {
    const arrow = r.target ? ` → ${r.target}` : '';
    switch (r.status) {
      case 'shipped':
        console.log(`  ✓ ${r.bookmark}${arrow}  PR #${r.prId}`);
        break;
      case 'pushed':
        console.log(`  ✓ ${r.bookmark}${arrow}  (pushed; no PR)`);
        break;
      case 'dry':
        console.log(`  · ${r.bookmark}${arrow}  (dry)`);
        break;
      case 'no-commits':
        console.log(`  - "${r.title}"  (no commits, skipped)`);
        break;
      case 'error':
        console.log(`  ✗ ${r.bookmark || r.title}  — ${r.error}`);
        break;
      default:
        console.log(`  ? ${JSON.stringify(r)}`);
    }
  }
  console.log('');
}

try {
  switch (cmd) {
    case 'gen':
      await runGen();
      break;
    case 'push':
      await runShip(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(help());
      break;
    case undefined:
      // Bare `ship` → push
      await runShip([]);
      break;
    default:
      // Unknown first arg might be a flag to ship push
      if (cmd.startsWith('--')) {
        await runShip(argv);
        break;
      }
      console.error(`Unknown command: ${cmd}`);
      console.log(help());
      process.exit(2);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
