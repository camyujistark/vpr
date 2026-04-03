#!/usr/bin/env node
/**
 * VPR — Virtual Pull Request manager.
 *
 * Interactive:
 *   vpr                         Open TUI
 *   vpr init                    Set up VPR for this project
 *
 * CLI (for AI/scripting):
 *   vpr new "title" ["desc"]    Create ticket + bookmark
 *   vpr edit <id> --flag "val"  Edit ticket/PR fields
 *   vpr move <id> --after <id>  Move commit
 *   vpr delete <id>             Delete commit or group
 *   vpr list                    List groups as JSON
 *   vpr status                  Show chain summary
 *   vpr push [bookmark]         Push bookmarks to remote
 */

import { loadConfig } from '../src/config.mjs';

const cmd = process.argv[2];
const args = process.argv.slice(3);

switch (cmd) {
  case 'init': {
    const { init } = await import('../src/commands/init.mjs');
    await init();
    break;
  }

  case 'new': {
    const { cmdNew } = await import('../src/commands/cli.mjs');
    cmdNew(args);
    break;
  }

  case 'edit': {
    const { cmdEdit } = await import('../src/commands/cli.mjs');
    cmdEdit(args);
    break;
  }

  case 'move': {
    const { cmdMove } = await import('../src/commands/cli.mjs');
    cmdMove(args);
    break;
  }

  case 'delete': {
    const { cmdDelete } = await import('../src/commands/cli.mjs');
    cmdDelete(args);
    break;
  }

  case 'list': {
    const { cmdList } = await import('../src/commands/cli.mjs');
    cmdList();
    break;
  }

  case 'status': {
    const { cmdStatus } = await import('../src/commands/cli.mjs');
    cmdStatus();
    break;
  }

  case 'push': {
    const { cmdPush } = await import('../src/commands/cli.mjs');
    cmdPush(args);
    break;
  }

  case 'help':
  case '--help':
  case '-h': {
    console.log(`
  VPR — Virtual Pull Request manager

  Interactive:
    vpr               Open TUI
    vpr init          Set up for this project

  CLI (for AI/scripting):
    vpr new "title" ["desc"]          Create ticket + bookmark
    vpr edit <id> --title "val"       Edit ticket title (renames branch)
    vpr edit <id> --desc "val"        Edit ticket description
    vpr edit <id> --pr-title "val"    Edit PR title
    vpr edit <id> --pr-desc "val"     Edit PR description
    vpr move <sha> --after <sha>      Move commit after target
    vpr move <sha> --before <sha>     Move commit before target
    vpr delete <sha-or-bookmark>      Delete commit or group
    vpr list                          List groups as JSON
    vpr status                        Show chain summary
    vpr push [bookmark]               Push bookmarks to remote

  <id> can be: bookmark name, TP index (tp-91), or partial match
`);
    break;
  }

  default: {
    // Default: open TUI
    const config = loadConfig();
    if (!config) {
      console.error('VPR not initialized. Run `vpr init` first.');
      process.exit(1);
    }

    const { startTui } = await import('../src/tui.mjs');
    startTui(config, process.argv[2]);
    break;
  }
}
