import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

let origTmpContents;

function snapshotTmp() {
  origTmpContents = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ship-')));
}

function assertTmpClean() {
  const after = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ship-')));
  const leaked = [...after].filter(f => !origTmpContents.has(f));
  assert.deepStrictEqual(leaked, [], 'temp file leaked');
}

describe('core/editor editInEditor', () => {
  beforeEach(snapshotTmp);
  afterEach(assertTmpClean);

  it('returns modified content when the editor writes to the temp file', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    const runEditor = (_editor, tmpFile) => {
      fs.writeFileSync(tmpFile, 'new content\n');
    };
    const result = editInEditor('old content', { runEditor });
    assert.strictEqual(result, 'new content\n');
  });

  it('returns null when the temp file is emptied (discard convention)', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    const runEditor = (_editor, tmpFile) => {
      fs.writeFileSync(tmpFile, '');
    };
    const result = editInEditor('initial', { runEditor });
    assert.strictEqual(result, null);
  });

  it('returns null when the temp file contains only whitespace', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    const runEditor = (_editor, tmpFile) => {
      fs.writeFileSync(tmpFile, '   \n\n\t\n');
    };
    const result = editInEditor('initial', { runEditor });
    assert.strictEqual(result, null);
  });

  it('seeds the temp file with initial content before invoking the editor', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    let seenInitial = null;
    const runEditor = (_editor, tmpFile) => {
      seenInitial = fs.readFileSync(tmpFile, 'utf-8');
      fs.writeFileSync(tmpFile, seenInitial + ' + appended');
    };
    editInEditor('the initial text', { runEditor });
    assert.strictEqual(seenInitial, 'the initial text');
  });

  it('cleans up the temp file even when runEditor throws', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    const runEditor = () => { throw new Error('editor crashed'); };
    assert.throws(
      () => editInEditor('initial', { runEditor }),
      /editor crashed/
    );
    // afterEach asserts the temp file is cleaned up
  });

  it('uses EDITOR env var by default', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    let seenEditor = null;
    const runEditor = (editor, tmpFile) => {
      seenEditor = editor;
      fs.writeFileSync(tmpFile, 'x');
    };
    editInEditor('x', { env: { EDITOR: 'my-editor' }, runEditor });
    assert.strictEqual(seenEditor, 'my-editor');
  });

  it('falls back to vi when no EDITOR is set', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    let seenEditor = null;
    const runEditor = (editor, tmpFile) => {
      seenEditor = editor;
      fs.writeFileSync(tmpFile, 'x');
    };
    editInEditor('x', { env: {}, runEditor });
    assert.strictEqual(seenEditor, 'vi');
  });

  it('temp file has a .md suffix by default', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    let seenPath = null;
    const runEditor = (_editor, tmpFile) => {
      seenPath = tmpFile;
      fs.writeFileSync(tmpFile, 'x');
    };
    editInEditor('x', { runEditor });
    assert.match(seenPath, /\.md$/);
  });

  it('respects a custom suffix', async () => {
    const { editInEditor } = await import('../../src/core/editor.mjs');
    let seenPath = null;
    const runEditor = (_editor, tmpFile) => {
      seenPath = tmpFile;
      fs.writeFileSync(tmpFile, 'x');
    };
    editInEditor('x', { runEditor, suffix: '.txt' });
    assert.match(seenPath, /\.txt$/);
  });
});
