#!/usr/bin/env node
/**
 * VPR v2 — Virtual Pull Request Manager CLI entry point.
 *
 * Dispatches to command modules in src/commands/.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

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

  Setup:
    vpr init                            Initialize VPR in current repo
    vpr init --provider azure-devops    With provider config
      --org <url> --project <name>
      --repo <name> --wiType <type>

  Items:
    vpr ticket new "title"          Create item + work item
    vpr ticket new "title" --parent 17148   Create as child of an existing parent WI
    vpr ticket new 17065            Attach to existing work item
    vpr ticket list                 List items
    vpr ticket edit <name>          Edit item
    vpr ticket done <name>          Close item
    vpr ticket hold <name>          Park item — moves to bottom of vpr status
    vpr ticket unhold <name>        Restore a held item
    vpr plan pull 17148             Pull a parent WI; create one item per child Task

  VPRs:
    vpr add "title"                 Create VPR in current item
    vpr add "title" --item <name>   Create VPR in specific item
    vpr edit <vpr> --story "..."    Write story
    vpr edit <vpr> --title "..."    Set title
    vpr remove <vpr>                Dissolve VPR
    vpr clear --yes                 Remove ALL VPRs and items
    vpr list                        JSON output
    vpr status                      Human-readable overview

  Commits:
    vpr log [N]                     jj graph
    vpr squash <vpr>                Squash adjacent same-file commits

  AI:
    vpr generate <vpr>              Generate output from story
    vpr generate --all              Generate all empty outputs

  Work:
    vpr hold <changeId>             Park a commit
    vpr unhold <changeId>           Release

  Push:
    vpr send <vpr>                  Send one VPR
    vpr send <vpr> --force          Delete stale branch bookmark if it exists
    vpr send --all                  Send all
    vpr send --dry-run              Preview

  Ralph:
    vpr ralph <item> <max-iter>     TDD loop — claude advances one acceptance
                                    criterion per iteration until COMPLETE,
                                    SLICE-DONE rolls to next, HUMAN-INPUT-NEEDED
                                    pauses for review.
      --prd <path>                  Override the parent PRD attached to claude
                                    (defaults to item.parentWiDescription).
      --test-cmd "<cmd>"            Test command run between iterations
                                    (default: "npm test").
`.trim();

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const [, , cmd, ...args] = process.argv;

// Check for git worktree — jj can't colocate in worktrees
try {
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  if (gitDir.includes('.git/worktrees')) {
    console.error('Error: VPR cannot run inside a git worktree (jj cannot colocate here).');
    console.error('Hint: Run VPR from the main git repository, or cherry-pick commits to the target branch.');
    process.exit(1);
  }
} catch { /* not a git repo — jj init will handle that */ }

try {
  switch (cmd) {
    // -----------------------------------------------------------------------
    // vpr init
    // -----------------------------------------------------------------------
    case 'init': {
      const flags = parseFlags(args);
      const { init } = await import('../src/commands/init.mjs');
      const result = await init(flags);
      for (const step of result.steps) {
        console.log(`  ${step}`);
      }
      console.log('\nVPR initialized.');
      break;
    }

    // -----------------------------------------------------------------------
    // vpr ticket <sub> [...]
    // -----------------------------------------------------------------------
    case 'ticket': {
      const [sub, ...ticketArgs] = args;
      const { ticketNew, ticketList, ticketEdit, ticketDone, ticketHold, ticketUnhold } = await import('../src/commands/ticket.mjs');

      switch (sub) {
        case 'new': {
          const raw = ticketArgs[0];
          if (!raw) {
            console.error('Usage: vpr ticket new "title" | <workItemId> [--parent <wi-id>]');
            process.exit(1);
          }
          const titleOrId = /^\d+$/.test(raw) ? Number(raw) : raw;
          const flags = parseFlags(ticketArgs.slice(1));
          const parentId = flags.parent ? Number(flags.parent) : undefined;
          if (parentId && typeof titleOrId === 'number') {
            console.error('Error: --parent only applies when creating a new WI from a title');
            process.exit(1);
          }

          const config = loadConfig() ?? {};
          const { createProvider } = await import('../src/providers/index.mjs');
          const provider = createProvider({ provider: 'none', ...config });

          const result = await ticketNew(titleOrId, { provider, parentId });
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

        case 'hold': {
          const name = ticketArgs[0];
          if (!name) {
            console.error('Usage: vpr ticket hold <name>');
            process.exit(1);
          }
          const res = await ticketHold(name);
          if (res.detached) console.log(`Held ${name} — detached commits onto trunk`);
          else if (res.reason === 'already-detached') console.log(`Held ${name} — already a sidebranch off trunk`);
          else if (res.reason === 'no-bookmarks') console.log(`Held ${name} — no bookmarks to detach`);
          else if (res.reason === 'no-jj') console.log(`Held ${name} — jj not available, metadata only`);
          else console.log(`Held ${name}`);
          break;
        }

        case 'unhold': {
          const name = ticketArgs[0];
          if (!name) {
            console.error('Usage: vpr ticket unhold <name>');
            process.exit(1);
          }
          await ticketUnhold(name);
          break;
        }

        default: {
          console.error(`Unknown ticket sub-command: ${sub ?? '(none)'}`);
          console.error('Available: new, list, edit, done, hold, unhold');
          process.exit(1);
        }
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr plan pull <parent-wi-id>
    // -----------------------------------------------------------------------
    case 'plan': {
      const sub = args[0];
      if (sub !== 'pull') {
        console.error(`Unknown plan sub-command: ${sub ?? '(none)'}`);
        console.error('Usage: vpr plan pull <parent-wi-id>');
        process.exit(1);
      }
      const raw = args[1];
      const parentId = /^\d+$/.test(raw ?? '') ? Number(raw) : null;
      if (!parentId) {
        console.error('Usage: vpr plan pull <parent-wi-id>');
        process.exit(1);
      }
      const config = loadConfig() ?? {};
      const { createProvider } = await import('../src/providers/index.mjs');
      const provider = createProvider({ provider: 'none', ...config });
      const { planPull } = await import('../src/commands/plan-pull.mjs');
      const result = await planPull(parentId, { provider });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr add "title" [--item <name>]
    // -----------------------------------------------------------------------
    case 'add': {
      const title = args[0];
      if (!title) {
        console.error('Usage: vpr add "title" [--item <name>] [--model <claude-model-id>]');
        process.exit(1);
      }
      const flags = parseFlags(args.slice(1));
      const { addVpr } = await import('../src/commands/add.mjs');
      const result = await addVpr(title, {
        item: flags.item || undefined,
        model: flags.model || undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr edit <vpr> [--story "..." | --title "..." | --output "..."]
    // -----------------------------------------------------------------------
    case 'edit': {
      const query = args[0];
      if (!query) {
        console.error('Usage: vpr edit <vpr> [--story "..." | --title "..." | --acceptance "..." | --output "..." | --model <claude-model-id>]');
        process.exit(1);
      }
      const flags = parseFlags(args.slice(1));
      const updates = {};
      if (flags.story !== undefined) updates.story = flags.story;
      if (flags.title !== undefined) updates.title = flags.title;
      if (flags.acceptance !== undefined) updates.acceptance = flags.acceptance;
      if (flags.output !== undefined) updates.output = flags.output;
      if (flags.model !== undefined) updates.model = flags.model;
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
    // vpr clear --yes  — remove every VPR and item
    // -----------------------------------------------------------------------
    case 'clear': {
      const flags = parseFlags(args);
      if (!flags.yes) {
        console.error('Usage: vpr clear --yes');
        console.error('This removes ALL VPRs and items from .vpr/meta.json and deletes their jj bookmarks.');
        process.exit(1);
      }
      const { clearAll } = await import('../src/commands/clear.mjs');
      const { bookmarks } = await clearAll({ actor: 'cli' });
      console.log(JSON.stringify({ cleared: bookmarks.length, bookmarks }, null, 2));
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
        const story = typeof flags.story === 'string' ? flags.story : undefined;
        const result = await generate(query, { generateCmd: config.generateCmd, story });
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr squash <vpr>
    // -----------------------------------------------------------------------
    case 'squash': {
      const query = args[0];
      if (!query) {
        console.error('Usage: vpr squash <vpr>');
        process.exit(1);
      }
      const { prepareSquash, buildSquashContent, parseSquashContent, executeSquash } = await import('../src/commands/squash.mjs');
      const { openEditor } = await import('../src/tui/editor.mjs');

      const { bookmark, candidates } = await prepareSquash(query);
      const content = buildSquashContent(candidates);

      openEditor(content, (result) => {
        const actions = parseSquashContent(result);
        const { squashed, kept, errors } = executeSquash(actions);
        console.log(`Squashed ${squashed}, kept ${kept}${errors.length ? `, ${errors.length} errors` : ''}`);
        for (const err of errors) console.error(`  ${err}`);
      });
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

        // Show what send would do
        const config = loadConfig() ?? {};
        const { createProvider } = await import('../src/providers/index.mjs');
        const provider = createProvider({ provider: 'none', ...config });
        const result = await send(query, { provider, dryRun: true });
        console.log(`\n  Branch: ${result.branchName}`);
        console.log(`  Target: ${result.targetBranch}`);
        console.log(`  Title:  ${result.prTitle}`);
        break;
      }

      if (!query) {
        console.error('Usage: vpr send <vpr> [--dry-run]');
        process.exit(1);
      }

      const config = loadConfig() ?? {};
      const { createProvider } = await import('../src/providers/index.mjs');
      const provider = createProvider({ provider: 'none', ...config });

      try {
        const result = await send(query, { provider, force: Boolean(flags.force) });
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        if (err.code === 'BRANCH_COLLISION') {
          console.error(`Error: ${err.message}`);
          console.error(`Re-run with --force to delete the stale bookmark and continue.`);
          process.exit(1);
        }
        throw err;
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr ralph <item> <max-iter> [--prd <path>] [--test-cmd "<cmd>"]
    // -----------------------------------------------------------------------
    case 'ralph': {
      const positional = args.filter(a => !a.startsWith('--'));
      const item = positional[0];
      const maxIter = positional[1];
      if (!item || !maxIter) {
        console.error('Usage: vpr ralph <item> <max-iter> [--prd <path>] [--test-cmd "<cmd>"]');
        process.exit(1);
      }
      if (!/^\d+$/.test(maxIter)) {
        console.error('Error: <max-iter> must be a positive integer');
        process.exit(1);
      }

      const flags = parseFlags(args);
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const scriptPath = join(__dirname, '..', 'scripts', 'ralph');
      if (!existsSync(scriptPath)) {
        console.error(`Error: ralph script not found at ${scriptPath}`);
        process.exit(1);
      }

      const childArgs = [item, maxIter];
      if (flags.prd) childArgs.push('--prd', String(flags.prd));
      if (flags['test-cmd']) childArgs.push('--test-cmd', String(flags['test-cmd']));

      const result = spawnSync(scriptPath, childArgs, { stdio: 'inherit' });
      process.exit(result.status ?? 1);
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
      const { startTui } = await import('../src/tui/tui.mjs');
      await startTui();
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
