import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { PeerReviewCoordinator } from './peer-review-coordinator.js';

test('peer review is reserved per workspace and completes after the presenter returns idle', () => {
  const events = new EventEmitter();
  const updates = [];
  events.on('peer-review-state', (update) => updates.push(update));
  const coordinator = new PeerReviewCoordinator({ events });
  const request = {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    prId: 'acme/app#1',
    presenterProvider: 'claude',
    reviewerProvider: 'codex',
  };

  try {
    const requested = coordinator.request(request);
    assert.equal(requested.status, 'requested');
    assert.equal(requested.reviewerProvider, 'codex');
    assert.throws(
      () => coordinator.request(request),
      (error) => error.code === 'review_in_progress',
    );
    assert.throws(
      () => coordinator.claim({ workspaceId: 'workspace-1', sessionId: 'other-session', reviewerProvider: 'codex' }),
      (error) => error.code === 'review_session_mismatch',
    );
    assert.throws(
      () => coordinator.claim({ workspaceId: 'workspace-1', sessionId: 'session-1', reviewerProvider: 'claude' }),
      (error) => error.code === 'review_provider_mismatch',
    );

    const running = coordinator.claim({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      reviewerProvider: 'codex',
    });
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

test('peer review request fails if the presenter never claims it', async () => {
  const events = new EventEmitter();
  const coordinator = new PeerReviewCoordinator({ events, requestTimeoutMs: 5 });
  try {
    coordinator.request({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      prId: 'acme/app#1',
      presenterProvider: 'codex',
      reviewerProvider: 'claude',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const review = coordinator.getByWorkspace('workspace-1');
    assert.equal(review.status, 'failed');
    assert.equal(review.error.code, 'request_timeout');
  } finally {
    coordinator.close();
  }
});
