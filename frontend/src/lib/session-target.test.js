import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sessionTargetKey } from './session-target.js';

test('sessionTargetKey matches the keys the server emits in target states', () => {
  assert.equal(sessionTargetKey({ type: 'workspace', id: 'ws-1' }), 'workspace:ws-1');
  assert.equal(sessionTargetKey({ type: 'work_item', id: 'item' }), 'work-item:item');
  assert.equal(sessionTargetKey({ type: 'global' }), null);
  assert.equal(sessionTargetKey(null), null);
  assert.equal(sessionTargetKey(undefined), null);
});
