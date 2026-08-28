import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from './index.js';

test('server entrypoint loads its dependency graph', () => {
  assert.equal(typeof startServer, 'function');
});
