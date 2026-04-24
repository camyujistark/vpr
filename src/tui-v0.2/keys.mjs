export function handleKey(state, key, nodes) {
  const focused = nodes[state.cursor] || null;

  switch (key) {
    case 'q':
    case '\x03':
      return { state, action: { type: 'quit' } };

    case 'j':
      return {
        state: { ...state, cursor: Math.min(state.cursor + 1, nodes.length - 1) },
        action: null,
      };

    case 'k':
      return {
        state: { ...state, cursor: Math.max(state.cursor - 1, 0) },
        action: null,
      };

    case 'r':
      return { state, action: { type: 'refresh' } };

    case 'e':
      return { state, action: { type: 'edit-plan' } };

    case 'g': {
      if (!focused) return { state, action: null };
      return {
        state,
        action: {
          type: 'gen',
          level: focused.level,
          name: focused.level === 'epic' ? null : focused.title,
        },
      };
    }

    case 'G':
      return { state, action: { type: 'gen-all' } };

    case 'p':
      return { state, action: { type: 'ship', dry: false } };

    case 'P':
      return { state, action: { type: 'ship', dry: true } };

    case '?':
      return {
        state: { ...state, showHelp: !state.showHelp },
        action: null,
      };

    default:
      return { state, action: null };
  }
}
