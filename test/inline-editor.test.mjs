import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('inline editor buffer operations', () => {
  // Simulate the edit buffer operations from handleEditKey

  it('typing inserts at cursor position', () => {
    let buffer = 'hello';
    let cursorPos = 5;

    // Type ' world'
    for (const ch of ' world') {
      buffer = buffer.slice(0, cursorPos) + ch + buffer.slice(cursorPos);
      cursorPos++;
    }

    assert.strictEqual(buffer, 'hello world');
    assert.strictEqual(cursorPos, 11);
  });

  it('typing in the middle inserts correctly', () => {
    let buffer = 'helo world';
    let cursorPos = 3; // between 'hel' and 'o'

    buffer = buffer.slice(0, cursorPos) + 'l' + buffer.slice(cursorPos);
    cursorPos++;

    assert.strictEqual(buffer, 'hello world');
    assert.strictEqual(cursorPos, 4);
  });

  it('backspace deletes character before cursor', () => {
    let buffer = 'hello';
    let cursorPos = 5;

    buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
    cursorPos--;

    assert.strictEqual(buffer, 'hell');
    assert.strictEqual(cursorPos, 4);
  });

  it('backspace at position 0 does nothing', () => {
    let buffer = 'hello';
    let cursorPos = 0;

    if (cursorPos > 0) {
      buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
      cursorPos--;
    }

    assert.strictEqual(buffer, 'hello');
    assert.strictEqual(cursorPos, 0);
  });

  it('enter inserts newline at cursor', () => {
    let buffer = 'line one';
    let cursorPos = 8;

    buffer = buffer.slice(0, cursorPos) + '\n' + buffer.slice(cursorPos);
    cursorPos++;

    assert.strictEqual(buffer, 'line one\n');
    assert.strictEqual(cursorPos, 9);
  });

  it('enter in the middle splits the line', () => {
    let buffer = 'hello world';
    let cursorPos = 5;

    buffer = buffer.slice(0, cursorPos) + '\n' + buffer.slice(cursorPos);
    cursorPos++;

    assert.strictEqual(buffer, 'hello\n world');
    assert.strictEqual(cursorPos, 6);
  });

  it('left arrow moves cursor back', () => {
    let cursorPos = 5;
    cursorPos = Math.max(0, cursorPos - 1);
    assert.strictEqual(cursorPos, 4);
  });

  it('left arrow at 0 stays at 0', () => {
    let cursorPos = 0;
    cursorPos = Math.max(0, cursorPos - 1);
    assert.strictEqual(cursorPos, 0);
  });

  it('right arrow moves cursor forward', () => {
    const buffer = 'hello';
    let cursorPos = 3;
    cursorPos = Math.min(buffer.length, cursorPos + 1);
    assert.strictEqual(cursorPos, 4);
  });

  it('right arrow at end stays at end', () => {
    const buffer = 'hello';
    let cursorPos = 5;
    cursorPos = Math.min(buffer.length, cursorPos + 1);
    assert.strictEqual(cursorPos, 5);
  });

  it('ctrl+z restores original', () => {
    const original = 'original text';
    let buffer = 'modified text';
    let cursorPos = 13;

    // Ctrl+Z
    buffer = original;
    cursorPos = buffer.length;

    assert.strictEqual(buffer, 'original text');
    assert.strictEqual(cursorPos, 13);
  });
});

describe('inline editor arrow up/down', () => {
  function moveUp(buffer, cursorPos) {
    const before = buffer.slice(0, cursorPos);
    const lastNewline = before.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const prevNewline = before.lastIndexOf('\n', lastNewline - 1);
      const colInLine = cursorPos - lastNewline - 1;
      const prevLineStart = prevNewline + 1;
      const prevLineLen = lastNewline - prevLineStart;
      return prevLineStart + Math.min(colInLine, prevLineLen);
    }
    return cursorPos;
  }

  function moveDown(buffer, cursorPos) {
    const after = buffer.slice(cursorPos);
    const nextNewline = after.indexOf('\n');
    if (nextNewline >= 0) {
      const before = buffer.slice(0, cursorPos);
      const currentLineStart = before.lastIndexOf('\n') + 1;
      const colInLine = cursorPos - currentLineStart;
      const nextLineStart = cursorPos + nextNewline + 1;
      const nextNextNewline = buffer.indexOf('\n', nextLineStart);
      const nextLineLen = (nextNextNewline >= 0 ? nextNextNewline : buffer.length) - nextLineStart;
      return nextLineStart + Math.min(colInLine, nextLineLen);
    }
    return cursorPos;
  }

  it('up arrow moves to same column on previous line', () => {
    const buffer = 'first line\nsecond line';
    const cursorPos = 17; // at 'l' in 'second line' (col 6)
    const newPos = moveUp(buffer, cursorPos);
    assert.strictEqual(newPos, 6); // col 6 on first line
  });

  it('up arrow on first line stays put', () => {
    const buffer = 'first line\nsecond';
    const cursorPos = 5;
    const newPos = moveUp(buffer, cursorPos);
    assert.strictEqual(cursorPos, newPos);
  });

  it('up arrow clamps to shorter line', () => {
    const buffer = 'short\nvery long second line';
    const cursorPos = 25; // end of second line (col 19)
    const newPos = moveUp(buffer, cursorPos);
    assert.strictEqual(newPos, 5); // clamped to end of 'short'
  });

  it('down arrow moves to same column on next line', () => {
    const buffer = 'first line\nsecond line';
    const cursorPos = 6; // col 6 on first line
    const newPos = moveDown(buffer, cursorPos);
    assert.strictEqual(newPos, 17); // col 6 on second line
  });

  it('down arrow on last line stays put', () => {
    const buffer = 'first\nsecond';
    const cursorPos = 10; // in 'second'
    const newPos = moveDown(buffer, cursorPos);
    assert.strictEqual(cursorPos, newPos);
  });

  it('down arrow clamps to shorter next line', () => {
    const buffer = 'very long first line\nhi';
    const cursorPos = 15; // col 15 on first line
    const newPos = moveDown(buffer, cursorPos);
    assert.strictEqual(newPos, 23); // clamped to end of 'hi' (pos 21 + 2)
  });

  it('navigates through three lines', () => {
    const buffer = 'aaa\nbbb\nccc';
    // Start at end of line 1 (pos 3)
    let pos = 3;
    pos = moveDown(buffer, pos); // to line 2, col 3
    assert.strictEqual(pos, 7); // 'aaa\nbbb' = pos 7
    pos = moveDown(buffer, pos); // to line 3, col 3
    assert.strictEqual(pos, 11); // 'aaa\nbbb\nccc' = pos 11
    pos = moveUp(buffer, pos); // back to line 2
    assert.strictEqual(pos, 7);
    pos = moveUp(buffer, pos); // back to line 1
    assert.strictEqual(pos, 3);
  });
});

describe('word wrap', () => {
  function wordWrap(text, width) {
    const result = [];
    for (const line of text.split('\n')) {
      if (line.length <= width) { result.push(line); continue; }
      let remaining = line;
      while (remaining.length > width) {
        let breakAt = remaining.lastIndexOf(' ', width);
        if (breakAt <= 0) breakAt = width;
        result.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) result.push(remaining);
    }
    return result;
  }

  it('wraps long line at word boundary', () => {
    const text = 'Add Playwright E2E job to the CI pipeline so tests run on every push.';
    const wrapped = wordWrap(text, 40);
    assert.ok(wrapped.length > 1);
    for (const line of wrapped) {
      assert.ok(line.length <= 40, `line too long: ${line.length} "${line}"`);
    }
  });

  it('preserves short lines', () => {
    const wrapped = wordWrap('short', 40);
    assert.deepStrictEqual(wrapped, ['short']);
  });

  it('handles newlines in input', () => {
    const wrapped = wordWrap('line one\nline two', 40);
    assert.deepStrictEqual(wrapped, ['line one', 'line two']);
  });

  it('wraps multiple long lines', () => {
    const text = 'first very long line that should wrap\nsecond very long line that should also wrap';
    const wrapped = wordWrap(text, 20);
    assert.ok(wrapped.length >= 4);
    for (const line of wrapped) {
      assert.ok(line.length <= 20, `line too long: ${line.length} "${line}"`);
    }
  });

  it('handles no spaces — breaks at width', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const wrapped = wordWrap(text, 10);
    assert.strictEqual(wrapped[0], 'abcdefghij');
    assert.strictEqual(wrapped[1], 'klmnopqrst');
  });
});
