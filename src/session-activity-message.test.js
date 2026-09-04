import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SESSION_ACTIVITY_MESSAGE_LENGTH, normalizeSessionActivityMessage } from './session-activity-message.js';

test('normalizes and sanitizes short public activity messages', () => {
  assert.equal(normalizeSessionActivityMessage('  Running\n\ttests  '), 'Running tests');
  assert.equal(normalizeSessionActivityMessage('token=ghp_abcdefghijklmnop'), 'token=<redacted-token>');
  assert.ok(normalizeSessionActivityMessage('password=a '.repeat(5)).length <= MAX_SESSION_ACTIVITY_MESSAGE_LENGTH);
});

test('rejects empty, overlong, and deceptive activity messages', () => {
  for (const value of ['   ', 'x'.repeat(MAX_SESSION_ACTIVITY_MESSAGE_LENGTH + 1), 'watching\u200bCI']) {
    assert.throws(
      () => normalizeSessionActivityMessage(value),
      (error) => error.code === 'invalid_activity_message',
    );
  }
});
