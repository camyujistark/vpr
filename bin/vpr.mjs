#!/usr/bin/env node
/**
 * VPR — Virtual Pull Request manager.
 *
 * Usage:
 *   vpr init                    Set up VPR for this project
 *   vpr                         Open TUI (default)
 *   vpr list                    Print VPR groups (non-interactive)
 *   vpr render [base]           Create real branch chain from VPRs
 */

import { loadConfig } from '../src/config.mjs';

const cmd = process.argv[2];

switch (cmd) {
  case 'init': {
    const { init } = await import('../src/commands/init.mjs');
    await init();
    break;
  }

  case 'list': {
    // TODO: non-interactive list (like virtual-chain.sh --md)
    console.log('Not yet implemented — use the TUI for now');
    break;
  }

  case 'render': {
    // TODO: materialize VPRs into real branch chain
    console.log('Not yet implemented');
    break;
  }

  case 'help':
  case '--help':
  case '-h': {
    console.log(`
  VPR — Virtual Pull Request manager

  Commands:
    vpr init          Set up VPR for this project
    vpr               Open interactive TUI
    vpr list          Print VPR groups
    vpr render        Create real branch chain from VPRs

  The TUI shows your commits grouped by VPR trailer, with a
  split-pane diff preview. Move commits between groups with
  space, edit PR titles and descriptions, create work items.
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
