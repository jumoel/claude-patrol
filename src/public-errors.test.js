import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePublicText, sanitizePublicValue, truncateUtf8 } from './public-errors.js';
import { completeTask, createTask, listTasks, updateTaskProgress } from './tasks.js';

test('public text redacts credentials and stays within its UTF-8 byte limit', () => {
  const text = sanitizePublicText(
    'Authorization: Bearer abcdefghijklmnop api_key=super-secret-value ghp_abcdefghijklmnop /tmp/.codex/auth.json ENV_SECRET',
    { maxBytes: 140, env: { TEST_SECRET: 'ENV_SECRET' } },
  );

  assert.doesNotMatch(text, /abcdefghijklmnop|super-secret-value|auth\.json|ENV_SECRET/);
  assert.match(text, /<redacted>/);
  assert.match(text, /<redacted-token>/);
  assert.match(text, /<provider-credentials>/);
  assert.match(text, /<redacted-env>/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 140);
  assert.equal(Buffer.byteLength(truncateUtf8('\u00e9'.repeat(20), 17), 'utf8') <= 17, true);
});

test('public values bound nested collections and redact their contents', () => {
  const value = sanitizePublicValue({
    token: 'access_token=super-secret-value',
    values: Array.from({ length: 40 }, (_, index) => `value-${index}`),
  });

  assert.equal(value.values.length, 32);
  assert.equal(value.token.includes('super-secret-value'), false);
});

test('task events expose only sanitized bounded progress and errors', () => {
  const task = createTask({
    kind: 'work-item.create',
    label: 'Create api_key=super-secret-value',
    context: { command: 'Authorization: Bearer abcdefghijklmnop' },
  });
  updateTaskProgress(task.id, { current: 1, total: 2 });
  completeTask(task.id, {
    error: 'password=super-secret-value',
    warnings: ['refresh_token=another-secret-value'],
  });

  const exposed = listTasks().find((candidate) => candidate.id === task.id);
  assert.equal(exposed.status, 'error');
  assert.deepEqual(exposed.progress, { current: 1, total: 2 });
  assert.doesNotMatch(JSON.stringify(exposed), /super-secret-value|another-secret-value|abcdefghijklmnop/);
  assert.throws(() => updateTaskProgress(task.id, { current: 3, total: 2 }), TypeError);
});
