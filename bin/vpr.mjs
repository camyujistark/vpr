#!/usr/bin/env node
/**
 * VPR v2 — Virtual Pull Request Manager CLI entry point.
 *
 * Dispatches to command modules in src/commands/.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load .vpr/config.json from cwd, or return null. */
function loadConfig() {
  const path = join(process.cwd(), '.vpr', 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Parse --flag value pairs from an args array.
 * Returns an object of { flagName: value }.
 * Boolean flags (--flag with no following value) are set to true.
 *
 * @param {string[]} args
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

/** Print checks from sendChecks() in human-readable form. */
function printChecks(checks) {
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
VPR v2 — Virtual Pull Request Manager

  Items:
    vpr ticket new "title"          Create item + work item
    vpr ticket new 17065            Attach to existing work item
    vpr ticket list                 List items
    vpr ticket edit <name>          Edit item
    vpr ticket done <name>          Close item

  VPRs:
    vpr add "title"                 Create VPR in current item
    vpr add "title" --item <name>   Create VPR in specific item
    vpr edit <vpr> --story "..."    Write story
    vpr edit <vpr> --title "..."    Set title
    vpr remove <vpr>                Dissolve VPR
    vpr list                        JSON output
    vpr status                      Human-readable overview

  Commits:
    vpr log [N]                     jj graph

  AI:
    vpr generate <vpr>              Generate output from story
    vpr generate --all              Generate all empty outputs

  Work:
    vpr hold <changeId>             Park a commit
    vpr unhold <changeId>           Release

  Push:
    vpr send <vpr>                  Send one VPR
    vpr send --all                  Send all
    vpr send --dry-run              Preview
`.trim();

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    // -----------------------------------------------------------------------
    // vpr init
    // -----------------------------------------------------------------------
    case 'init': {
      const { init } = await import('../src/commands/init.mjs');
      await init();
      break;
    }

    // -----------------------------------------------------------------------
    // vpr ticket <sub> [...]
    // -----------------------------------------------------------------------
    case 'ticket': {
      const [sub, ...ticketArgs] = args;
      const { ticketNew, ticketList, ticketEdit, ticketDone } = await import('../src/commands/ticket.mjs');

      switch (sub) {
        case 'new': {
          const raw = ticketArgs[0];
          if (!raw) {
            console.error('Usage: vpr ticket new "title" | <workItemId>');
            process.exit(1);
          }
          const titleOrId = /^\d+$/.test(raw) ? Number(raw) : raw;

          const config = loadConfig() ?? {};
          const { createProvider } = await import('../src/providers/index.mjs');
          const provider = createProvider({ provider: 'none', ...config });

          const result = await ticketNew(titleOrId, { provider });
          console.log(JSON.stringify(result, null, 2));
          break;
        }

        case 'list': {
          const items = await ticketList();
          console.log(JSON.stringify(items, null, 2));
          break;
        }

        case 'edit': {
          const name = ticketArgs[0];
          if (!name) {
            console.error('Usage: vpr ticket edit <name> [--title "..."]');
            process.exit(1);
          }
          const flags = parseFlags(ticketArgs.slice(1));
          const updates = {};
          if (flags.title) updates.wiTitle = flags.title;
          await ticketEdit(name, updates);
          break;
        }

        case 'done': {
          const name = ticketArgs[0];
          if (!name) {
            console.error('Usage: vpr ticket done <name>');
            process.exit(1);
          }
          await ticketDone(name);
          break;
        }

        default: {
          console.error(`Unknown ticket sub-command: ${sub ?? '(none)'}`);
          console.error('Available: new, list, edit, done');
          process.exit(1);
        }
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr add "title" [--item <name>]
    // -----------------------------------------------------------------------
    case 'add': {
      const title = args[0];
      if (!title) {
        console.error('Usage: vpr add "title" [--item <name>]');
        process.exit(1);
      }
      const flags = parseFlags(args.slice(1));
      const { addVpr } = await import('../src/commands/add.mjs');
      const result = await addVpr(title, { item: flags.item || undefined });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr edit <vpr> [--story "..." | --title "..." | --output "..."]
    // -----------------------------------------------------------------------
    case 'edit': {
      const query = args[0];
      if (!query) {
        console.error('Usage: vpr edit <vpr> [--story "..." | --title "..." | --output "..."]');
        process.exit(1);
      }
      const flags = parseFlags(args.slice(1));
      const updates = {};
      if (flags.story !== undefined) updates.story = flags.story;
      if (flags.title !== undefined) updates.title = flags.title;
      if (flags.output !== undefined) updates.output = flags.output;
      const { editVpr } = await import('../src/commands/edit.mjs');
      await editVpr(query, updates);
      break;
    }

    // -----------------------------------------------------------------------
    // vpr remove <vpr>
    // -----------------------------------------------------------------------
    case 'remove': {
      const query = args[0];
      if (!query) {
        console.error('Usage: vpr remove <vpr>');
        process.exit(1);
      }
      const { removeVpr } = await import('../src/commands/remove.mjs');
      await removeVpr(query);
      break;
    }

    // -----------------------------------------------------------------------
    // vpr list  — JSON to stdout
    // -----------------------------------------------------------------------
    case 'list': {
      const { list } = await import('../src/commands/list.mjs');
      const result = await list();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr status  — human-readable overview
    // -----------------------------------------------------------------------
    case 'status': {
      const { status } = await import('../src/commands/status.mjs');
      await status();
      break;
    }

    // -----------------------------------------------------------------------
    // vpr log [N]
    // -----------------------------------------------------------------------
    case 'log': {
      const limit = args[0] ? Number(args[0]) : undefined;
      const { log } = await import('../src/commands/log.mjs');
      log(limit);
      break;
    }

    // -----------------------------------------------------------------------
    // vpr generate <vpr>  |  vpr generate --all
    // -----------------------------------------------------------------------
    case 'generate': {
      const { generate, generateAll } = await import('../src/commands/generate.mjs');
      const flags = parseFlags(args);
      const config = loadConfig() ?? {};

      if (flags.all) {
        await generateAll({ generateCmd: config.generateCmd });
      } else {
        const query = args.find(a => !a.startsWith('--'));
        if (!query) {
          console.error('Usage: vpr generate <vpr> | vpr generate --all');
          process.exit(1);
        }
        const result = await generate(query, { generateCmd: config.generateCmd });
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr hold <changeId>
    // -----------------------------------------------------------------------
    case 'hold': {
      const changeId = args[0];
      if (!changeId) {
        console.error('Usage: vpr hold <changeId>');
        process.exit(1);
      }
      const { hold } = await import('../src/commands/hold.mjs');
      await hold(changeId);
      break;
    }

    // -----------------------------------------------------------------------
    // vpr unhold <changeId>
    // -----------------------------------------------------------------------
    case 'unhold': {
      const changeId = args[0];
      if (!changeId) {
        console.error('Usage: vpr unhold <changeId>');
        process.exit(1);
      }
      const { unhold } = await import('../src/commands/hold.mjs');
      await unhold(changeId);
      break;
    }

    // -----------------------------------------------------------------------
    // vpr send <vpr>  |  vpr send --dry-run  |  vpr send --all
    // -----------------------------------------------------------------------
    case 'send': {
      const { send, sendChecks } = await import('../src/commands/send.mjs');
      const flags = parseFlags(args);

      if (flags.all) {
        console.log('not yet implemented');
        break;
      }

      const query = args.find(a => !a.startsWith('--'));

      if (flags['dry-run']) {
        if (!query) {
          console.error('Usage: vpr send <vpr> --dry-run');
          process.exit(1);
        }
        const checks = await sendChecks(query);
        printChecks(checks);
        break;
      }

      if (!query) {
        console.error('Usage: vpr send <vpr> [--dry-run]');
        process.exit(1);
      }

      const config = loadConfig() ?? {};
      const { createProvider } = await import('../src/providers/index.mjs');
      const provider = createProvider({ provider: 'none', ...config });

      const result = await send(query, { provider });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr help / --help / -h
    // -----------------------------------------------------------------------
    case 'help':
    case '--help':
    case '-h': {
      console.log(HELP);
      break;
    }

    // -----------------------------------------------------------------------
    // No args — TUI not yet implemented
    // -----------------------------------------------------------------------
    case undefined: {
      console.log('TUI not yet implemented');
      break;
    }

    // -----------------------------------------------------------------------
    // Unknown command
    // -----------------------------------------------------------------------
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.error('Run `vpr help` for usage.');
      process.exit(1);
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
