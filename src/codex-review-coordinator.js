import { randomUUID } from 'node:crypto';

const FINAL_STATUSES = new Set(['complete', 'failed', 'delivery_unconfirmed']);
const ACTIVE_STATUSES = new Set(['requested', 'running', 'delivering']);

function reviewError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicReview(review) {
  if (!review) return null;
  return {
    id: review.id,
    workspaceId: review.workspaceId,
    sessionId: review.sessionId,
    prId: review.prId,
    status: review.status,
    requestedAt: review.requestedAt,
    startedAt: review.startedAt,
    resultReadyAt: review.resultReadyAt,
    endedAt: review.endedAt,
    error: review.error,
  };
}

function normalizeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'review_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Owns the explicit review lifecycle across the HTTP request, Claude MCP call,
 * Codex run, and final delivery into Claude's terminal.
 */
export class CodexReviewCoordinator {
  constructor({
    events,
    requestTimeoutMs = 2 * 60 * 1000,
    deliveryTimeoutMs = 5 * 60 * 1000,
    retentionMs = 5 * 60 * 1000,
    now = () => Date.now(),
  }) {
    this.events = events;
    this.requestTimeoutMs = requestTimeoutMs;
    this.deliveryTimeoutMs = deliveryTimeoutMs;
    this.retentionMs = retentionMs;
    this.now = now;
    this.reviews = new Map();
    this.timers = new Map();
    this.handleSessionState = this.handleSessionState.bind(this);
    this.events.on('session-state', this.handleSessionState);
  }

  request({ workspaceId, sessionId, prId }) {
    const existing = this.reviews.get(workspaceId);
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      throw reviewError('review_in_progress', 'A Codex review is already in progress for this workspace');
    }

    const review = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      prId,
      status: 'requested',
      requestedAt: new Date(this.now()).toISOString(),
      startedAt: null,
      resultReadyAt: null,
      endedAt: null,
      error: null,
      observedDeliveryWork: false,
    };
    this.reviews.set(workspaceId, review);
    this.setTimer(review.id, this.requestTimeoutMs, () => {
      this.fail(review.id, reviewError('request_timeout', 'Claude did not start the Codex review within two minutes'));
    });
    this.emit(review);
    return publicReview(review);
  }

  claim({ workspaceId, sessionId }) {
    const review = this.reviews.get(workspaceId);
    if (!review || review.status !== 'requested') {
      throw reviewError('review_not_requested', 'No Codex review was requested for this workspace');
    }
    if (review.sessionId !== sessionId) {
      throw reviewError('review_session_mismatch', 'This Codex review belongs to a different Claude session');
    }
    this.clearTimer(review.id);
    review.status = 'running';
    review.startedAt = new Date(this.now()).toISOString();
    this.emit(review);
    return publicReview(review);
  }

  markDelivering(reviewId) {
    const review = this.findById(reviewId);
    if (!review || review.status !== 'running') return null;
    review.status = 'delivering';
    review.resultReadyAt = new Date(this.now()).toISOString();
    // The tool call itself proves this Claude session is in a turn. Its next
    // idle transition confirms Claude had a chance to present the result.
    review.observedDeliveryWork = true;
    this.setTimer(review.id, this.deliveryTimeoutMs, () => {
      this.finish(review, 'delivery_unconfirmed', {
        code: 'delivery_unconfirmed',
        message: 'Codex returned a review, but Patrol could not confirm that Claude presented it',
      });
    });
    this.emit(review);
    return publicReview(review);
  }

  fail(reviewId, error) {
    const review = this.findById(reviewId);
    if (!review || FINAL_STATUSES.has(review.status)) return null;
    return this.finish(review, 'failed', normalizeError(error));
  }

  getByWorkspace(workspaceId) {
    return publicReview(this.reviews.get(workspaceId));
  }

  handleSessionState({ sessionId, state }) {
    for (const review of this.reviews.values()) {
      if (review.status !== 'delivering' || review.sessionId !== sessionId) continue;
      if (state === 'working') {
        review.observedDeliveryWork = true;
      } else if (state === 'idle' && review.observedDeliveryWork) {
        this.finish(review, 'complete', null);
      } else if (state === 'exited') {
        this.finish(review, 'delivery_unconfirmed', {
          code: 'session_exited',
          message: 'Claude exited before Patrol could confirm delivery of the Codex review',
        });
      }
    }
  }

  finish(review, status, error) {
    this.clearTimer(review.id);
    review.status = status;
    review.endedAt = new Date(this.now()).toISOString();
    review.error = error;
    this.emit(review);
    this.setTimer(review.id, this.retentionMs, () => {
      if (this.reviews.get(review.workspaceId)?.id === review.id) {
        this.reviews.delete(review.workspaceId);
        this.events.emit('codex-review-state', { workspaceId: review.workspaceId, review: null });
      }
      this.clearTimer(review.id);
    });
    return publicReview(review);
  }

  findById(reviewId) {
    for (const review of this.reviews.values()) {
      if (review.id === reviewId) return review;
    }
    return null;
  }

  emit(review) {
    this.events.emit('codex-review-state', { workspaceId: review.workspaceId, review: publicReview(review) });
  }

  setTimer(reviewId, delay, callback) {
    this.clearTimer(reviewId);
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    this.timers.set(reviewId, timer);
  }

  clearTimer(reviewId) {
    const timer = this.timers.get(reviewId);
    if (timer) clearTimeout(timer);
    this.timers.delete(reviewId);
  }

  close() {
    this.events.removeListener('session-state', this.handleSessionState);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.reviews.clear();
  }
}
