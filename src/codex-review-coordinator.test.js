import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CodexReviewCoordinator } from './codex-review-coordinator.js';

test('Codex review lifecycle is reserved per workspace and completes after Claude returns idle', () => {
  const events = new EventEmitter();
  const updates = [];
  events.on('codex-review-state', (update) => updates.push(update));
  const coordinator = new CodexReviewCoordinator({ events });

  try {
    const requested = coordinator.request({ workspaceId: 'workspace-1', sessionId: 'session-1', prId: 'acme/app#1' });
    assert.equal(requested.status, 'requested');
    assert.throws(
      () => coordinator.request({ workspaceId: 'workspace-1', sessionId: 'session-1', prId: 'acme/app#1' }),
      (error) => error.code === 'review_in_progress',
    );
    assert.throws(
      () => coordinator.claim({ workspaceId: 'workspace-1', sessionId: 'other-session' }),
      (error) => error.code === 'review_session_mismatch',
    );

    const running = coordinator.claim({ workspaceId: 'workspace-1', sessionId: 'session-1' });
    assert.equal(running.status, 'running');
    assert.equal(coordinator.markDelivering(running.id).status, 'delivering');
    events.emit('session-state', { sessionId: 'session-1', workspaceId: 'workspace-1', state: 'idle' });

    const complete = coordinator.getByWorkspace('workspace-1');
    assert.equal(complete.status, 'complete');
    assert.equal(complete.error, null);
    assert.deepEqual(
      updates.map((update) => update.review?.status),
      ['requested', 'running', 'delivering', 'complete'],
    );
  } finally {
    coordinator.close();
  }
});

test('Codex review request fails if Claude never claims it', async () => {
  const events = new EventEmitter();
  const coordinator = new CodexReviewCoordinator({ events, requestTimeoutMs: 5 });
  try {
    coordinator.request({ workspaceId: 'workspace-1', sessionId: 'session-1', prId: 'acme/app#1' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const review = coordinator.getByWorkspace('workspace-1');
    assert.equal(review.status, 'failed');
    assert.equal(review.error.code, 'request_timeout');
  } finally {
    coordinator.close();
  }
});
