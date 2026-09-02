import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createShutdownController } from './shutdown.js';

function harness({ sessions = 0, isClean = false, isTTY = true } = {}) {
  const calls = { exit: [], forceExit: 0, destroyTui: 0, log: [] };
  const stdin = Object.assign(new EventEmitter(), {
    isRaw: false,
    setRawMode(value) {
      this.isRaw = value;
    },
    resume() {},
  });
  const controller = createShutdownController({
    activeSessionCount: () => sessions,
    exit: async (kill) => {
      calls.exit.push(kill);
    },
    forceExit: () => {
      calls.forceExit += 1;
    },
    isClean,
    isTTY,
    stdin,
    destroyTui: () => {
      calls.destroyTui += 1;
    },
    log: (line) => calls.log.push(line),
  });
  return { controller, calls, stdin };
}

test('a signal with no sessions exits immediately, preserving nothing', async () => {
  const { controller, calls } = harness({ sessions: 0 });
  await controller.shutdown('SIGINT');
  assert.deepEqual(calls.exit, [false]);
  assert.equal(controller.state, 'exiting');
});

test('--clean and SIGTERM skip the prompt; --clean kills sessions', async () => {
  const clean = harness({ sessions: 2, isClean: true });
  await clean.controller.shutdown('SIGINT');
  assert.deepEqual(clean.calls.exit, [true]);

  const term = harness({ sessions: 2 });
  await term.controller.shutdown('SIGTERM');
  assert.deepEqual(term.calls.exit, [false]);
});

test('with live sessions SIGINT prompts, and the keypress decides kill or preserve', async () => {
  const { controller, calls, stdin } = harness({ sessions: 3 });
  controller.shutdown('SIGINT');
  assert.equal(controller.state, 'prompting');
  assert.equal(calls.destroyTui, 1);
  assert.match(calls.log[0], /3 active session\(s\)/);
  assert.equal(stdin.isRaw, true);

  stdin.emit('data', 'k');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.exit, [true]);
  assert.equal(controller.state, 'exiting');
  assert.equal(stdin.listenerCount('data'), 0, 'the key handler is removed after one key');
});

test('Enter or Ctrl-C while prompting preserves sessions, and a second signal preserves too', async () => {
  const enter = harness({ sessions: 1 });
  enter.controller.shutdown('SIGINT');
  enter.stdin.emit('data', '\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(enter.calls.exit, [false]);

  const second = harness({ sessions: 1 });
  second.controller.shutdown('SIGINT');
  await second.controller.shutdown('SIGINT');
  assert.deepEqual(second.calls.exit, [false]);

  const ctrlC = harness({ sessions: 1 });
  ctrlC.controller.shutdown('SIGINT');
  ctrlC.stdin.emit('data', '\x03');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctrlC.calls.exit, [false]);
});

test('a signal while already exiting force-exits', async () => {
  const { controller, calls } = harness({ sessions: 0 });
  await controller.shutdown('SIGINT');
  controller.shutdown('SIGINT');
  assert.equal(calls.forceExit, 1);
});
