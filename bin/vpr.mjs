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
    vpr ticket stories <name> --prd <path>   Extract "## User Stories" from
                                    a PRD into item.userStories. Surfaces
                                    in PR descriptions at send time.
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
    vpr send <vpr> --target <ref>   Override the target branch (default = chain top)
    vpr send <vpr> --skip-lint      Skip the ESLint pre-flight gate
    vpr send --all                  Send all
    vpr send --dry-run              Preview

  Ralph:
    vpr ralph <item> <max-iter>     TDD loop. Default: Docker sandbox via
                                    .sandcastle/main.ts (isolated worktree).
                                    Each iteration = one acceptance criterion
                                    until COMPLETE / SLICE-DONE rolls to next /
                                    HUMAN-INPUT-NEEDED pauses for review.
      --host                        Run on host (no Docker isolation).
                                    Faster but trusts the agent fully.
      --prd <path>                  Override the parent PRD attached to claude
                                    (host mode only; sandcastle reads meta.json).
      --test-cmd "<cmd>"            Test command run between iterations
                                    (host mode only; default: "npm test").
    vpr sync <item>                 Advance slice bookmarks from Ralph-Slice
                                    trailers on the latest sandcastle temp
                                    branch. Auto-runs after \`vpr ralph\`;
                                    invoke manually for live per-iter syncs.
    vpr recover --yes               Undo the most recent ralph run by
                                    restoring jj from the pre-ralph op
                                    snapshot in .vpr/ralph-snapshot.txt.
                                    Use when sandcastle's merge-back
                                    cascaded conflicts onto the chain.
    vpr push-sent                   List sent VPR bookmarks whose local
                                    commit_id diverged from origin (preview).
    vpr push-sent --yes             Force-push the listed bookmarks. Use
                                    after rebasing the chain onto an
                                    upstream PR that was squash-merged or
                                    force-updated.
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
      // Top-level `vpr ticket --help` or `vpr ticket` (no sub) prints the
      // ticket subset of HELP so users can find the right verb.
      if (sub === undefined || sub === '--help' || sub === '-h') {
        console.log(`vpr ticket — manage items (each backed by an Azure DevOps work item)

  vpr ticket new "title"                 Create item + work item
  vpr ticket new "title" --parent <wi>   Create as child of parent WI
  vpr ticket new <wi-id>                 Attach to existing work item
  vpr ticket list                        List items (JSON)
  vpr ticket edit <name>                 Edit item interactively
  vpr ticket done <name>                 Close item
  vpr ticket hold <name>                 Park item — drops to bottom of status
  vpr ticket unhold <name>               Restore a held item

Pass --help to any subcommand for its own usage.`);
        break;
      }
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
            console.error('Usage: vpr ticket edit <name> [--title "..."] [--depends-on a,b] [--remove-depends-on a,b]');
            process.exit(1);
          }
          const flags = parseFlags(ticketArgs.slice(1));
          const updates = {};
          if (flags.title) updates.wiTitle = flags.title;
          if (flags['depends-on']) {
            updates.addDependsOn = flags['depends-on'].split(',').map(s => s.trim()).filter(Boolean);
          }
          if (flags['remove-depends-on']) {
            updates.removeDependsOn = flags['remove-depends-on'].split(',').map(s => s.trim()).filter(Boolean);
          }
          try {
            await ticketEdit(name, updates);
          } catch (err) {
            console.error(err.message);
            process.exit(1);
          }
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

        case 'stories': {
          // vpr ticket stories <name> --prd <path>
          // Extracts numbered "## User Stories" entries from a PRD file and
          // stores them on the item as userStories: string[]. Surfaces in
          // PR body at send time + readable from `vpr ticket list`.
          const name = ticketArgs[0];
          const flags = parseFlags(ticketArgs.slice(1));
          if (!name || !flags.prd || name === '--help' || name === '-h') {
            const stream = (name === '--help' || name === '-h') ? console.log : console.error;
            stream(`vpr ticket stories <name> --prd <path>

Extracts the "## User Stories" section from a PRD markdown file and stores
the numbered list on the item. Surfaces in PR descriptions under "## User
Stories Verified" when slices ship.`);
            process.exit(name && flags.prd ? 0 : 1);
          }
          const { readFileSync } = await import('node:fs');
          const md = readFileSync(String(flags.prd), 'utf-8');
          const m = md.match(/## User Stories\s*\n\n([\s\S]*?)(?=\n## )/);
          if (!m) {
            console.error(`Error: no "## User Stories" section in ${flags.prd}`);
            process.exit(1);
          }
          const stories = [];
          const re = /^\d+\.\s+([\s\S]+?)(?=\n\d+\.|\n##|\Z)/gm;
          let mm;
          while ((mm = re.exec(m[1])) !== null) {
            stories.push(mm[1].replace(/\s+/g, ' ').trim());
          }
          const { loadMeta, saveMeta, appendEvent } = await import('../src/core/meta.mjs');
          const meta = await loadMeta();
          if (!meta.items[name]) {
            console.error(`Error: item "${name}" not found in meta`);
            process.exit(1);
          }
          meta.items[name].userStories = stories;
          await saveMeta(meta);
          await appendEvent('cli', 'ticket.stories', { name, count: stories.length });
          console.log(`Stored ${stories.length} user stories on ${name}.`);
          break;
        }

        default: {
          console.error(`Unknown ticket sub-command: ${sub ?? '(none)'}`);
          console.error('Available: new, list, edit, done, hold, unhold, stories');
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
      if (!title || title === '--help' || title === '-h') {
        const stream = title ? console.log : console.error;
        stream(`vpr add — create a new VPR slice in the current item

  vpr add "title"                       Create slice in current item
  vpr add "title" --item <name>         Target a specific item
  vpr add "title" --model <claude-id>   Suggest a default model for /ralph
  vpr add "title" --manual              Mark slice as a manual update
                                        (commits made outside a ralph loop)

The slice gets a title; story + acceptance live on the slice and can be
filled in later via \`vpr edit\`.`);
        process.exit(title ? 0 : 1);
      }
      const flags = parseFlags(args.slice(1));
      const { addVpr } = await import('../src/commands/add.mjs');
      const result = await addVpr(title, {
        item: flags.item || undefined,
        model: flags.model || undefined,
        manual: flags.manual === true || flags.manual === 'true',
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // -----------------------------------------------------------------------
    // vpr edit <vpr> [--story "..." | --title "..." | --output "..."]
    // -----------------------------------------------------------------------
    case 'edit': {
      const query = args[0];
      if (!query || query === '--help' || query === '-h') {
        const stream = query ? console.log : console.error;
        stream(`vpr edit — update fields on an existing VPR slice

  vpr edit <vpr> --story "..."          Set the story
  vpr edit <vpr> --title "..."          Set the title
  vpr edit <vpr> --acceptance "..."     Set acceptance criteria
  vpr edit <vpr> --output "..."         Set the PR URL output
  vpr edit <vpr> --model <claude-id>    Set the suggested /ralph model

<vpr> matches the bookmark suffix; partial matches are accepted.`);
        process.exit(query ? 0 : 1);
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
      if (!query || query === '--help' || query === '-h') {
        const stream = query ? console.log : console.error;
        stream(`vpr remove — dissolve a VPR slice

  vpr remove <vpr>                      Drop the slice from the item

The slice's bookmark is deleted; commits stay in the chain. Useful when
a slice's content has been folded into another (e.g. a squash).`);
        process.exit(query ? 0 : 1);
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
    // vpr next  — list unblocked items
    // -----------------------------------------------------------------------
    case 'next': {
      const { next: nextCmd } = await import('../src/commands/next.mjs');
      const items = await nextCmd();
      if (items.length === 0) {
        console.log('(no ready items)');
      } else {
        for (const v of items) {
          const wi = v.wi != null ? `wi#${v.wi}` : 'wi#-';
          console.log(`${v.name}  ${wi}  (depth=${v.depth}, vprs=${v.vprCount})`);
        }
      }
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

      // Pre-send audit: trailer-based bookmark check across the whole chain.
      // Catches drift caused by manual rebases / divergent change-ids that
      // moved bookmarks off their slice tip. Skipped with --skip-audit for
      // emergency overrides.
      if (!flags['skip-audit']) {
        try {
          const { auditBookmarks } = await import('../src/commands/audit-bookmarks.mjs');
          const report = await auditBookmarks();
          const repairable = report.drift.filter(d => d.kind !== 'missing-tip');
          if (repairable.length > 0) {
            console.error(`Bookmark drift detected — ${repairable.length} unsent bookmark${repairable.length === 1 ? '' : 's'} sit off their Ralph-Slice tip:`);
            for (const d of repairable) {
              const cur = d.current ? d.current.slice(0, 8) : '(none)';
              const exp = d.expected ? d.expected.slice(0, 8) : '(none)';
              console.error(`    ${d.bookmark}\n      ${cur} → expected ${exp}`);
            }
            console.error(`\nRun \`vpr sync --repair\` to fix, then re-send.`);
            console.error(`Or pass --skip-audit if you know what you're doing.`);
            process.exit(1);
          }
        } catch { /* audit failure shouldn't block send if optional */ }
      }

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
        const targetOverride = flags.target ? String(flags.target) : undefined;
        const result = await send(query, { provider, dryRun: true, targetBranch: targetOverride });
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
        const targetOverride = flags.target ? String(flags.target) : undefined;
        const result = await send(query, {
          provider,
          force: Boolean(flags.force),
          targetBranch: targetOverride,
          skipLint: Boolean(flags['skip-lint']),
        });
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
    // vpr sync <item>  — advance slice bookmarks from Ralph-Slice trailers
    // -----------------------------------------------------------------------
    case 'sync': {
      const flags = parseFlags(args);
      const positional = args.filter(a => !a.startsWith('--'));
      const item = positional[0];

      // --check audits the entire chain (no item arg needed) using
      // Ralph-Slice trailers from `main..HEAD` to find drift.
      if (flags.check) {
        const { auditBookmarks } = await import('../src/commands/audit-bookmarks.mjs');
        const report = await auditBookmarks();
        if (report.ok.length > 0) {
          console.log(`✓ ${report.ok.length} bookmark${report.ok.length === 1 ? '' : 's'} on slice tip.`);
        }
        if (report.drift.length === 0) {
          console.log('No drift detected.');
        } else {
          console.log(`\n⚠ Drift in ${report.drift.length} bookmark${report.drift.length === 1 ? '' : 's'}:`);
          for (const d of report.drift) {
            const cur = d.current ? d.current.slice(0, 8) : '(none)';
            const exp = d.expected ? d.expected.slice(0, 8) : '(no Ralph-Slice trailer found)';
            console.log(`    ${d.kind.padEnd(12)} ${d.bookmark}\n      current: ${cur} → expected: ${exp}`);
          }
          console.log('\nRun `vpr sync --repair` to apply fixes (skips missing-tip).');
          process.exit(1);
        }
        break;
      }

      if (flags.repair) {
        const { auditBookmarks, repairBookmarks } = await import('../src/commands/audit-bookmarks.mjs');
        try { execSync('jj git import', { stdio: 'ignore' }); } catch { /* ignore */ }
        const report = await auditBookmarks();
        const { repaired, skipped } = await repairBookmarks(report);
        if (repaired.length > 0) {
          console.log(`✓ Repaired ${repaired.length}:`);
          for (const r of repaired) console.log(`    ${r.bookmark} → ${r.sha.slice(0, 8)}`);
        }
        if (skipped.length > 0) {
          console.log(`\n⚠ Skipped ${skipped.length}:`);
          for (const s of skipped) console.log(`    ${s.bookmark}: ${s.reason}`);
        }
        if (repaired.length === 0 && skipped.length === 0) {
          console.log('Nothing to repair.');
        }
        break;
      }

      if (!item || item === '--help' || item === '-h') {
        const stream = item ? console.log : console.error;
        stream(`vpr sync — advance slice bookmarks from Ralph-Slice trailers

  vpr sync <item>           Walk the latest sandcastle/ralph-<item>/* branch,
                            group commits by their Ralph-Slice trailer, and
                            move each slice's jj bookmark to its tip commit.
  vpr sync --check          Audit-only: scan main..HEAD for drift between
                            unsent bookmarks and their slice tips. Exits 1
                            on drift. No mutations.
  vpr sync --repair         Same scan, applies fixes via \`jj bookmark set\`.

Idempotent. Safe to run mid-ralph (between iterations) or after a run
completes. Combine with /loop for live per-iteration syncing while
ralph is running.`);
        process.exit(item ? 0 : 1);
      }
      try { execSync('jj git import', { stdio: 'ignore' }); } catch { /* ignore */ }
      const { syncRalphBookmarks } = await import('../src/commands/sync-ralph.mjs');
      const { advanced, skipped } = await syncRalphBookmarks(item);
      if (Object.keys(advanced).length > 0) {
        console.log(`Slice bookmarks advanced (${Object.keys(advanced).length}):`);
        for (const [slice, sha] of Object.entries(advanced)) {
          console.log(`  ${slice} → ${sha.slice(0, 8)}`);
        }
      } else {
        console.log('No bookmarks advanced.');
      }
      if (skipped.length > 0) {
        console.log('\nSkipped:');
        for (const s of skipped) console.log(`  ${s}`);
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr ralph <item> <max-iter> [--host] [--prd <path>] [--test-cmd "<cmd>"]
    // -----------------------------------------------------------------------
    case 'ralph': {
      const positional = args.filter(a => !a.startsWith('--'));
      const item = positional[0];
      const maxIter = positional[1];
      if (!item || maxIter === undefined || item === '--help' || item === '-h') {
        const stream = item === '--help' || item === '-h' ? console.log : console.error;
        stream(`vpr ralph — TDD loop driving slices to completion

  vpr ralph <item> <max-iter>            Run inside Docker sandbox (default)
  vpr ralph <item> <max-iter> --host     Run on host (no isolation, faster)

  --prd <path>                           Override the PRD attached to claude
  --test-cmd "<cmd>"                     Test command between iterations

Default mode: sandcastle (Docker) — uses .sandcastle/main.ts. Worktree
isolation, jj inside the container, can't escape the repo. Slower per
iteration (container boot) but safer.

Host mode (--host): claude -p with bypassPermissions on your real repo.
Faster startup, no isolation. Use when you trust the slice + want speed.`);
        process.exit(item ? 0 : 1);
      }
      if (!/^\d+$/.test(maxIter)) {
        console.error('Error: <max-iter> must be a positive integer');
        process.exit(1);
      }

      const flags = parseFlags(args);
      const __dirname = dirname(fileURLToPath(import.meta.url));

      // Default = sandcastle (Docker). --host opts back into the host script.
      if (!flags.host) {
        const sandcastleMain = join(process.cwd(), '.sandcastle', 'main.ts');
        if (!existsSync(sandcastleMain)) {
          console.error(`Error: .sandcastle/main.ts not found in ${process.cwd()}`);
          console.error("Hint: this repo isn't set up for sandcastle. Run with --host to use host mode, or scaffold sandcastle first.");
          process.exit(1);
        }

        // Pre-ralph: snapshot jj op-log head so the entire run can be undone
        // with a single `vpr recover` if sandcastle's git refs collide with
        // host jj on import (cascade via divergent change-ids).
        try {
          const { snapshotJjOp } = await import('../src/core/jj-snapshot.mjs');
          const opId = snapshotJjOp();
          if (opId) console.log(`→ jj op snapshot: ${opId} (recover with: vpr recover)`);
        } catch { /* not jj-colocated — skip */ }

        const childArgs = ['tsx', sandcastleMain, item];
        const result = spawnSync('npx', childArgs, {
          stdio: 'inherit',
          env: { ...process.env, SANDCASTLE_MAX_ITER: maxIter },
        });

        // Post-ralph: auto-advance slice bookmarks based on Ralph-Slice
        // trailers so the chain reflects the iteration's work. Sandcastle
        // produces commits on a temp branch; this maps each slice back to its
        // bookmark on host. Idempotent — safe to re-run.
        try {
          execSync('jj git import', { stdio: 'ignore' });
        } catch { /* not jj-colocated — ignore */ }
        try {
          const { syncRalphBookmarks } = await import('../src/commands/sync-ralph.mjs');
          const { advanced, skipped } = await syncRalphBookmarks(item);
          if (Object.keys(advanced).length > 0) {
            console.log(`\n→ Slice bookmarks advanced (${Object.keys(advanced).length}):`);
            for (const [slice, sha] of Object.entries(advanced)) {
              console.log(`    ${slice} → ${sha.slice(0, 8)}`);
            }
          }
          if (skipped.length > 0) {
            console.log(`\n  Skipped:`);
            for (const s of skipped) console.log(`    ${s}`);
          }
        } catch (err) {
          console.error(`\n  Bookmark sync failed: ${err.message}`);
        }

        // Recovery hint — always print after a sandcastle run so the user has
        // a one-liner if anything looks off (cascade abandons, divergent
        // imports, wrong bookmark advances).
        try {
          const { readSnapshot } = await import('../src/core/jj-snapshot.mjs');
          const snap = readSnapshot();
          if (snap) {
            console.log(`\n  Undo this entire ralph run: vpr recover  (snapshot: ${snap})`);
          }
        } catch { /* ignore */ }

        process.exit(result.status ?? 1);
      }

      // --host: legacy host-mode ralph script.
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
    // vpr push-sent — re-push every sent bookmark that diverged from origin
    // -----------------------------------------------------------------------
    case 'push-sent': {
      const flags = parseFlags(args);
      const { previewPushSent, pushSent } = await import('../src/commands/push-sent.mjs');
      const { toPush, skipped } = await previewPushSent();

      if (toPush.length === 0 && skipped.length === 0) {
        console.log('All sent bookmarks already in sync with origin.');
        break;
      }

      if (toPush.length > 0) {
        console.log(`Sent bookmarks diverged from origin (${toPush.length}):`);
        for (const b of toPush) console.log(`    ${b}`);
      }
      if (skipped.length > 0) {
        console.log(`\n⚠ Will skip ${skipped.length}:`);
        for (const s of skipped) console.log(`    ${s.bookmark}: ${s.reason}`);
      }

      if (!flags.yes) {
        console.log(`\nRe-run with --yes to force-push the ${toPush.length} listed bookmark${toPush.length === 1 ? '' : 's'}.`);
        break;
      }

      const { pushed, skipped: pushSkipped } = await pushSent(toPush);
      if (pushed.length > 0) {
        console.log(`\n✓ Pushed ${pushed.length} bookmark${pushed.length === 1 ? '' : 's'}.`);
      }
      if (pushSkipped.length > 0) {
        console.log(`\n⚠ Push errors:`);
        for (const s of pushSkipped) console.log(`    ${s.bookmark}: ${s.reason}`);
      }
      break;
    }

    // -----------------------------------------------------------------------
    // vpr recover — restore jj from the pre-ralph snapshot
    // -----------------------------------------------------------------------
    case 'recover': {
      const flags = parseFlags(args);
      const { readSnapshot, restoreFromSnapshot } = await import('../src/core/jj-snapshot.mjs');
      const snap = readSnapshot();
      if (!snap) {
        console.error('Error: no snapshot at .vpr/ralph-snapshot.txt');
        console.error('Hint: snapshots are written automatically by `vpr ralph` (sandcastle mode).');
        process.exit(1);
      }
      if (!flags.yes) {
        console.log(`This will run: jj op restore ${snap}`);
        console.log('Effect: undo every jj op since the most recent ralph run started.');
        console.log('Re-run with --yes to confirm.');
        process.exit(1);
      }
      restoreFromSnapshot();
      console.log(`\n✓ Restored to op ${snap}.`);
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
    // No args — launch the TUI
    // -----------------------------------------------------------------------
    case undefined: {
      const { startTui } = await import('../src/tui/tui.mjs');
      await startTui();
      break;
    }

    // -----------------------------------------------------------------------
    // vpr help / --help / -h — top-level usage
    // -----------------------------------------------------------------------
    case 'help':
    case '--help':
    case '-h': {
      console.log(HELP);
      break;
    }

    // -----------------------------------------------------------------------
    // Unknown command
    // -----------------------------------------------------------------------
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.error('Run `vpr --help` for usage.');
      process.exit(1);
    }
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
