import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../../src/commands/generate.mjs';

describe('buildPrompt()', () => {
  it('includes a THIS SLICE section with the item wi, wiTitle and wiDescription', () => {
    const prompt = buildPrompt({
      item: {
        wi: 17148,
        wiTitle: 'VPR Stacked PR Orchestration',
        wiDescription: 'Detach held items off the active chain.',
        parentWi: null,
        parentWiTitle: null,
        parentWiDescription: null,
      },
      vpr: { title: 'Slice title', story: 'do the thing' },
      commits: [{ subject: 'feat: thing' }],
    });

    assert.ok(
      prompt.includes('THIS SLICE (Task #17148): VPR Stacked PR Orchestration'),
      `expected THIS SLICE header in prompt; got:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Detach held items off the active chain.'),
      `expected wiDescription in prompt; got:\n${prompt}`
    );
  });
});
