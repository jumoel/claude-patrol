import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispatchWsMessage } from './pty-manager.js';

/**
 * Defense against the regression class that produced `claude-patrol#2`: the
 * WS message validator and handler used to be two independently-maintained
 * lists. These tests exercise every documented WS message type through the
 * unified dispatcher so adding a handler arm without validation (or vice
 * versa) breaks here, not in production after a user-reported regression.
 */

function makeEntry() {
  const writes = [];
  const resizes = [];
  return {
    writes,
    resizes,
    proc: {
      write(data) {
        writes.push(data);
      },
      resize(cols, rows) {
        resizes.push([cols, rows]);
      },
    },
  };
}

const ctx = { tmuxName: 'patrol-test' };

describe('dispatchWsMessage', () => {
  it('routes input to PTY write', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(JSON.stringify({ type: 'input', data: 'hello' }), entry, ctx);
    assert.deepEqual(result, { type: 'input' });
    assert.deepEqual(entry.writes, ['hello']);
  });

  it('routes resize to PTY resize and sets suppression window', () => {
    const entry = makeEntry();
    const before = Date.now();
    const result = dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), entry, ctx);
    assert.deepEqual(result, { type: 'resize' });
    assert.deepEqual(entry.resizes, [[120, 40]]);
    assert.ok(entry.resizeSuppressUntil >= before);
  });

  it('routes prompt-submit to the splitting submitter (text first, Enter later)', async () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(
      JSON.stringify({ type: 'prompt-submit', text: 'investigate failures' }),
      entry,
      ctx,
    );
    assert.deepEqual(result, { type: 'prompt-submit' });
    // Text is written synchronously; the Enter follows after the split delay.
    assert.deepEqual(entry.writes, ['investigate failures']);
    // Wait long enough for the split-write delay (PROMPT_SUBMIT_DELAY_MS = 100ms).
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(entry.writes, ['investigate failures', '\r']);
  });

  it('strips trailing carriage returns from prompt-submit text', async () => {
    const entry = makeEntry();
    dispatchWsMessage(JSON.stringify({ type: 'prompt-submit', text: 'foo\r' }), entry, ctx);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(entry.writes, ['foo', '\r']);
  });

  it('rejects unknown message types', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(JSON.stringify({ type: 'something-else', data: 'x' }), entry, ctx);
    assert.equal(result, null);
    assert.deepEqual(entry.writes, []);
  });

  it('rejects malformed JSON', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage('not json', entry, ctx);
    assert.equal(result, null);
  });

  it('rejects messages with missing or wrong-type fields', () => {
    const entry = makeEntry();
    // input without data
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'input' }), entry, ctx), null);
    // input with non-string data
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'input', data: 42 }), entry, ctx), null);
    // prompt-submit without text
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'prompt-submit' }), entry, ctx), null);
    // prompt-submit with non-string text
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'prompt-submit', text: 42 }), entry, ctx), null);
    // resize with non-integer dims
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 'wide', rows: 40 }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 80.5, rows: 40 }), entry, ctx), null);
    assert.deepEqual(entry.writes, []);
    assert.deepEqual(entry.resizes, []);
  });

  it('rejects messages without a string type field', () => {
    const entry = makeEntry();
    assert.equal(dispatchWsMessage(JSON.stringify({ data: 'x' }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 42 }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify(null), entry, ctx), null);
  });
});
