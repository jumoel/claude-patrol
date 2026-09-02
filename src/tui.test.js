import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { destroyTui, initTui, setHeader } from './tui.js';

/** Capture everything written to stdout while the TUI is active. */
function captureStdout() {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    clear: () => chunks.splice(0),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

afterEach(() => {
  destroyTui();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

test('initTui draws the frame with the header and footer and routes console output into it', () => {
  const out = captureStdout();
  try {
    initTui({ header: 'polling org:acme', footer: '[space] open' });
    const frame = out.text();
    assert.match(frame, /claude-patrol/);
    assert.match(frame, /polling org:acme/);
    assert.match(frame, /\[space\] open/);
    assert.match(frame, /┌─+┐/, 'top border');
    assert.match(frame, /└─+┘/, 'bottom border');
    assert.notEqual(console.log, originalLog, 'console.log is patched while the TUI is active');

    out.clear();
    console.log('[claude-patrol] Reattached 2 sessions');
    console.warn('rate limited');
    console.error({ code: 'boom' });
    const logs = out.text();
    assert.match(logs, /Reattached 2 sessions/);
    assert.doesNotMatch(logs, /\[claude-patrol\] Reattached/, 'the app prefix is stripped inside the panel');
    assert.match(logs, /WRN.*rate limited/);
    assert.match(logs, /ERR.*\{"code":"boom"\}/);

    out.clear();
    setHeader('setup mode');
    assert.match(out.text(), /setup mode/);
  } finally {
    out.restore();
  }
});

test('destroyTui restores the console and clears the screen', () => {
  const out = captureStdout();
  try {
    initTui({ header: 'h', footer: 'f' });
    const patched = console.log;
    out.clear();
    destroyTui();
    assert.notEqual(console.log, patched, 'the panel logger is gone');
    assert.match(out.text(), /\x1b\[2J\x1b\[H\x1b\[\?25h/, 'clear screen, home, show cursor');
    out.clear();
    console.log('after teardown');
    assert.equal(out.text(), 'after teardown\n', 'console.log writes plainly again');
    out.clear();
    destroyTui();
    assert.equal(out.text(), '', 'a second destroy is a no-op');
  } finally {
    out.restore();
  }
});
