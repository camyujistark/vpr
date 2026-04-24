const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const REVERSE = '\x1b[7m';

function indent(depth) {
  return '  '.repeat(depth);
}

function formatNode(n) {
  switch (n.level) {
    case 'epic': {
      const wi = n.node.wi ? ` ${DIM}PBI ${n.node.wi}${RESET}` : '';
      return `${BOLD}${CYAN}${n.title}${RESET}${wi}`;
    }
    case 'task': {
      const wi = n.node.wi ? ` ${DIM}Task ${n.node.wi}${RESET}` : '';
      return `${YELLOW}${n.title}${RESET}${wi}`;
    }
    case 'pr': {
      const commits = n.node.commits
        ? ` ${DIM}(${n.node.commits})${RESET}`
        : ` ${DIM}(no commits)${RESET}`;
      return `${GREEN}${n.title}${RESET}${commits}`;
    }
    default:
      return n.title;
  }
}

export function renderTree(nodes, cursor) {
  const lines = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const marker = i === cursor ? '▸ ' : '  ';
    const line = `${indent(n.depth)}${marker}${formatNode(n)}`;
    lines.push(i === cursor ? `${REVERSE}${line}${RESET}` : line);
  }
  return lines.join('\n');
}

export function renderHelp() {
  const rows = [
    ['j/k',  'down / up'],
    ['g',    'gen Description (shells out to ship gen)'],
    ['G',    'gen all (shells out to ship gen --all)'],
    ['e',    'edit plan.md in $EDITOR'],
    ['p',    'ship — push stacked PRs'],
    ['P',    'ship --dry (preview)'],
    ['r',    'refresh from disk'],
    ['?',    'help (toggle this pane)'],
    ['q',    'quit'],
  ];
  const lines = [`${BOLD}ship TUI — keys${RESET}`, ''];
  for (const [k, desc] of rows) {
    lines.push(`  ${BOLD}${k.padEnd(4)}${RESET}${desc}`);
  }
  return lines.join('\n');
}

export function renderFooter({ mode = 'normal', status = '' } = {}) {
  const parts = [`${DIM}mode: ${mode}${RESET}`];
  if (status) parts.push(`${DIM}${status}${RESET}`);
  parts.push(`${DIM}? help  q quit${RESET}`);
  return parts.join('  ');
}
