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

  it('includes a PARENT PRD section when parentWi and parentWiDescription are present', () => {
    const prompt = buildPrompt({
      item: {
        wi: 17150,
        wiTitle: 'Generate prompt enrichment',
        wiDescription: 'Slice spec body.',
        parentWi: 17148,
        parentWiTitle: 'VPR Stacked PR Orchestration',
        parentWiDescription: 'Full PRD: problem, solution, user stories.',
      },
      vpr: { title: 'Slice title', story: 'do the thing' },
      commits: [{ subject: 'feat: thing' }],
    });

    assert.ok(
      prompt.includes('PARENT PRD (PBI #17148): VPR Stacked PR Orchestration'),
      `expected PARENT PRD header in prompt; got:\n${prompt}`
    );
    assert.ok(
      prompt.includes('Full PRD: problem, solution, user stories.'),
      `expected parentWiDescription in prompt; got:\n${prompt}`
    );
    const parentIdx = prompt.indexOf('PARENT PRD');
    const sliceIdx = prompt.indexOf('THIS SLICE');
    assert.ok(
      parentIdx >= 0 && sliceIdx >= 0 && parentIdx < sliceIdx,
      `expected PARENT PRD to appear before THIS SLICE; got:\n${prompt}`
    );
  });

  it('keeps single-line headers intact when title or commit subjects contain newlines', () => {
    const prompt = buildPrompt({
      item: {
        wi: 17150,
        wiTitle: 'Slice ticket',
        wiDescription: null,
        parentWi: null,
        parentWiTitle: null,
        parentWiDescription: null,
      },
      vpr: { title: 'multi\nline title', story: 'do the thing' },
      commits: [{ subject: 'feat: thing\nstray body line' }],
    });

    const titleLine = prompt
      .split('\n')
      .find(l => l.startsWith('PR Title:'));
    assert.ok(titleLine, `expected a PR Title line; got:\n${prompt}`);
    assert.ok(
      titleLine.includes('multi') && titleLine.includes('line title'),
      `expected the full title to stay on one line; got: ${JSON.stringify(titleLine)}\nfull prompt:\n${prompt}`
    );

    const commitBullets = prompt.split('\n').filter(l => l.startsWith('- '));
    assert.equal(
      commitBullets.length,
      1,
      `expected exactly one commit bullet; got ${commitBullets.length}:\n${commitBullets.join('\n')}`
    );
    assert.ok(
      commitBullets[0].includes('feat: thing') && commitBullets[0].includes('stray body line'),
      `expected commit subject to be flattened onto one bullet; got: ${commitBullets[0]}`
    );
  });

  it('falls back gracefully when wiDescription and parent fields are missing', () => {
    const prompt = buildPrompt({
      item: {
        wi: 17150,
        wiTitle: 'Slice ticket',
        wiDescription: null,
        parentWi: null,
        parentWiTitle: null,
        parentWiDescription: null,
      },
      vpr: { title: 'Slice title', story: 'do the thing' },
      commits: [{ subject: 'feat: thing' }],
    });

    assert.ok(
      !prompt.includes('PARENT PRD'),
      `expected no PARENT PRD section; got:\n${prompt}`
    );
    assert.ok(
      prompt.includes('THIS SLICE (Task #17150): Slice ticket'),
      `expected THIS SLICE header; got:\n${prompt}`
    );
    assert.ok(
      !prompt.includes('null'),
      `expected no literal "null" leak; got:\n${prompt}`
    );
    assert.ok(
      prompt.includes('PR Title: Slice title'),
      `expected PR Title line; got:\n${prompt}`
    );
    assert.ok(
      prompt.includes('- feat: thing'),
      `expected commit subject; got:\n${prompt}`
    );
  });
});
