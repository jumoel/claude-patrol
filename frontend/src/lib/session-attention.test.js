import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sessionAttentionState } from './session-attention.js';

const idleSession = /** @type {import('../types').Session} */ ({
  id: 'session-1',
  target: { type: 'work_item', id: 'work-1' },
  activity_state: 'idle',
  activity_changed_at: '2026-08-27T15:23:33.806Z',
  status: 'active',
  provider: 'codex',
  started_at: '2026-08-27T13:30:28.193Z',
});

test('keeps an idle transition waiting until its session is acknowledged', () => {
  assert.equal(sessionAttentionState(idleSession, 'idle', new Set()), 'waiting');
  assert.equal(sessionAttentionState(idleSession, 'idle', new Set([idleSession.id])), 'idle');
});

test('working state overrides an earlier idle acknowledgement', () => {
  assert.equal(sessionAttentionState(idleSession, 'working', new Set([idleSession.id])), 'working');
});
