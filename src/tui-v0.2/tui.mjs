import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve as pathResolve } from 'path';
import { parse } from '../core/plan.mjs';
import { flattenPlan } from './tree.mjs';
import { renderTree, renderHelp, renderFooter } from './render.mjs';
import { handleKey } from './keys.mjs';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_OFF = '\x1b[?25l';
const CURSOR_ON = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIP_BIN = pathResolve(__dirname, '..', '..', 'bin', 'ship.mjs');

function readPlanOrNull(planPath) {
  try {
    return parse(planPath);
  } catch {
    return null;
  }
}

function readKey() {
  const buf = Buffer.alloc(8);
  const n = fs.readSync(0, buf, 0, buf.length);
  return buf.slice(0, n).toString('utf-8');
}

function enterAlt() {
  process.stdout.write(ALT_ON);
  process.stdout.write(CURSOR_OFF);
  process.stdin.setRawMode(true);
}

function exitAlt() {
  try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  process.stdout.write(CURSOR_ON);
  process.stdout.write(ALT_OFF);
}

function suspend(fn) {
  exitAlt();
  try {
    fn();
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
  process.stdout.write('\n(press any key to return to the TUI)');
  process.stdin.setRawMode(true);
  readKey();
  process.stdin.setRawMode(false);
  enterAlt();
}

function draw(plan, state) {
  process.stdout.write(CLEAR);
  if (!plan) {
    process.stdout.write('(no plan.md — press q to quit, or r after creating one)\n');
    return;
  }
  const nodes = flattenPlan(plan);
  const clampedCursor = Math.min(state.cursor, Math.max(0, nodes.length - 1));
  if (state.showHelp) {
    process.stdout.write(renderHelp() + '\n');
  } else {
    process.stdout.write(renderTree(nodes, clampedCursor) + '\n');
  }
  process.stdout.write('\n' + renderFooter({ status: state.status }) + '\n');
}

function runShip(action) {
  const args = [SHIP_BIN];
  if (action.dry) args.push('--dry');
  spawnSync('node', args, { stdio: 'inherit' });
}

function runGen(action) {
  const args = [SHIP_BIN, 'gen'];
  if (action.type === 'gen-all') {
    args.push('--all');
  } else {
    args.push(action.level);
    if (action.name) args.push(action.name);
  }
  spawnSync('node', args, { stdio: 'inherit' });
}

function runEditor(planPath) {
  const editor = process.env.EDITOR || 'vi';
  spawnSync(editor, [planPath], { stdio: 'inherit' });
}

export function startTui({ planPath = 'plan.md' } = {}) {
  let plan = readPlanOrNull(planPath);
  let state = { cursor: 0, showHelp: false, status: plan ? '' : `no ${planPath}` };

  process.on('exit', exitAlt);
  process.on('SIGINT', () => { exitAlt(); process.exit(0); });

  enterAlt();

  try {
    while (true) {
      draw(plan, state);
      const key = readKey();
      const nodes = plan ? flattenPlan(plan) : [];
      const { state: next, action } = handleKey(state, key, nodes);
      state = { ...next, status: '' };

      if (!action) continue;

      switch (action.type) {
        case 'quit':
          return;
        case 'refresh':
          plan = readPlanOrNull(planPath);
          state.status = plan ? 'refreshed' : `no ${planPath}`;
          break;
        case 'edit-plan':
          suspend(() => runEditor(planPath));
          plan = readPlanOrNull(planPath) || plan;
          break;
        case 'gen':
        case 'gen-all':
          suspend(() => runGen(action));
          plan = readPlanOrNull(planPath) || plan;
          break;
        case 'ship':
          suspend(() => runShip(action));
          break;
      }
    }
  } finally {
    exitAlt();
  }
}
