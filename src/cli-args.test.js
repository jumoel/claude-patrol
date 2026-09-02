import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliOptions } from './cli-args.js';

test('parseCliOptions reads every server flag and lets programmatic options win', () => {
  assert.deepEqual(parseCliOptions([]), {
    port: null,
    host: null,
    reattach: false,
    clean: false,
    open: false,
    noOpen: false,
  });
  assert.deepEqual(parseCliOptions(['--port', '4100', '--host', '0.0.0.0', '--reattach', '--open']), {
    port: 4100,
    host: '0.0.0.0',
    reattach: true,
    clean: false,
    open: true,
    noOpen: false,
  });
  assert.equal(parseCliOptions(['--clean'], { open: true, noOpen: true }).open, true);
  assert.equal(parseCliOptions([], { reattach: true }).reattach, true);
  assert.throws(() => parseCliOptions(['--port', 'abc']), /--port must be an integer/);
  assert.throws(() => parseCliOptions(['--port']), /--port must be an integer/);
  assert.throws(() => parseCliOptions(['--host']), /--host requires a value/);
});
