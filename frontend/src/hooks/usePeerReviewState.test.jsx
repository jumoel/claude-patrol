import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { usePeerReviewState } from './usePeerReviewState.js';

const api = vi.hoisted(() => ({ fetchPeerReviewState: vi.fn(), requestPeerReview: vi.fn() }));
const eventStream = vi.hoisted(() => ({
  handlers: /** @type {Set<(event: MessageEvent<string>) => void>} */ (new Set()),
}));

vi.mock('../lib/api.js', () => api);
vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    if (type !== 'peer-review-state') return () => {};
    eventStream.handlers.add(handler);
    return () => eventStream.handlers.delete(handler);
  }),
}));

/** @typedef {{type: 'workspace' | 'work_item', id: string}} Target */
/** @typedef {{target: Target | undefined, prId: string | undefined}} HookProps */

const PR_ID = 'acme/api#7';
/** @type {Target} */
const workspaceTarget = { type: 'workspace', id: 'ws-1' };
/** @type {Target} */
const workItemTarget = { type: 'work_item', id: 'wi-1' };

/**
 * @param {Partial<import('../types').PeerReviewStatusResponse>} [overrides]
 * @returns {import('../types').PeerReviewStatusResponse}
 */
function peerState(overrides = {}) {
  return {
    review: null,
    presenterProvider: 'claude',
    reviewerProvider: 'codex',
    ready: true,
    reason: null,
    ...overrides,
  };
}

/**
 * @param {import('../types').PeerReviewStatus} status
 * @param {Partial<import('../types').PeerReview>} [overrides]
 * @returns {import('../types').PeerReview}
 */
function review(status, overrides = {}) {
  return {
    id: 'review-1',
    sessionId: 'session-1',
    prId: PR_ID,
    presenterProvider: 'claude',
    reviewerProvider: 'codex',
    status,
    requestedAt: '2026-08-30T10:00:00.000Z',
    startedAt: null,
    resultReadyAt: null,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

/** @param {Record<string, unknown>} payload */
function emit(payload) {
  act(() => {
    for (const handler of eventStream.handlers) {
      handler(new MessageEvent('peer-review-state', { data: JSON.stringify(payload) }));
    }
  });
}

/** @template T */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = /** @param {T} _value */ (_value) => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** @param {HookProps} initialProps */
function renderPeerReview(initialProps) {
  return renderHook(/** @param {HookProps} props */ (props) => usePeerReviewState(props.target, props.prId), {
    initialProps,
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  eventStream.handlers.clear();
  api.fetchPeerReviewState.mockResolvedValue(peerState());
});

test('stays idle without a target and loads the lifecycle once one is provided', async () => {
  const { result, rerender } = renderPeerReview({ target: undefined, prId: PR_ID });

  assert.equal(result.current.review, null);
  assert.equal(result.current.ready, false);
  assert.equal(result.current.presenterProvider, null);
  assert.equal(result.current.requesting, false);
  assert.equal(result.current.error, null);
  assert.equal(api.fetchPeerReviewState.mock.calls.length, 0);
  assert.equal(eventStream.handlers.size, 0);
  await act(async () => {
    await result.current.requestReview();
  });
  assert.equal(api.requestPeerReview.mock.calls.length, 0, 'requestReview is a no-op without a target');

  rerender({ target: workspaceTarget, prId: PR_ID });
  await waitFor(() => assert.equal(result.current.ready, true));
  assert.deepEqual(api.fetchPeerReviewState.mock.calls, [[workspaceTarget, PR_ID]]);
  assert.equal(result.current.presenterProvider, 'claude');
  assert.equal(result.current.reviewerProvider, 'codex');
  assert.equal(result.current.reason, null);
  assert.equal(eventStream.handlers.size, 1);
});

test('requestReview reports requesting, adopts the returned review, and turns a rejection into error text', async () => {
  const pending =
    /** @type {ReturnType<typeof deferred<{review: import('../types').PeerReview, dispatchedAt: number}>>} */ (
      deferred()
    );
  api.requestPeerReview.mockReturnValueOnce(pending.promise);
  const { result } = renderPeerReview({ target: workspaceTarget, prId: PR_ID });
  await waitFor(() => assert.equal(result.current.ready, true));

  /** @type {Promise<void> | undefined} */
  let request;
  act(() => {
    request = result.current.requestReview();
  });
  assert.equal(result.current.requesting, true);
  assert.deepEqual(api.requestPeerReview.mock.calls, [[workspaceTarget, PR_ID]]);

  await act(async () => {
    pending.resolve({
      review: review('requested', { presenterProvider: 'codex', reviewerProvider: 'claude' }),
      dispatchedAt: 1,
    });
    await request;
  });
  assert.equal(result.current.requesting, false);
  assert.equal(result.current.review?.status, 'requested');
  assert.equal(result.current.presenterProvider, 'codex', 'providers follow the returned review');
  assert.equal(result.current.reviewerProvider, 'claude');
  assert.equal(result.current.error, null);

  api.requestPeerReview.mockRejectedValueOnce(new Error('presenter session is busy'));
  await act(async () => {
    await result.current.requestReview();
  });
  assert.equal(result.current.error, 'presenter session is busy');
  assert.equal(result.current.requesting, false);
  assert.equal(result.current.review?.status, 'requested', 'the previous review survives a failed request');
});

test('peer-review-state events update the review only for the matching target', async () => {
  const { result } = renderPeerReview({ target: workItemTarget, prId: PR_ID });
  await waitFor(() => assert.equal(result.current.ready, true));
  // Read through a call so assert's type narrowing does not pin the review to null.
  const status = () => result.current.review?.status ?? null;

  emit({ workspaceId: 'wi-1', review: review('running') });
  assert.equal(status(), null, 'a workspace id never matches a work item target');
  emit({ workItemId: 'wi-2', review: review('running') });
  assert.equal(status(), null);

  emit({ workItemId: 'wi-1', review: review('running') });
  assert.equal(status(), 'running');
  emit({ workItemId: 'wi-1', review: review('complete', { endedAt: '2026-08-30T10:10:00.000Z' }) });
  assert.equal(status(), 'complete');
  emit({ workItemId: 'wi-1', review: null });
  assert.equal(status(), null);
  assert.equal(result.current.ready, true, 'events only touch the review');
});

test('a target change resets state, drops the stale response, reports load failures, and unsubscribes on unmount', async () => {
  const first = /** @type {ReturnType<typeof deferred<import('../types').PeerReviewStatusResponse>>} */ (deferred());
  const second = /** @type {ReturnType<typeof deferred<import('../types').PeerReviewStatusResponse>>} */ (deferred());
  api.fetchPeerReviewState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender, unmount } = renderPeerReview({ target: workspaceTarget, prId: PR_ID });
  assert.equal(eventStream.handlers.size, 1);

  rerender({ target: workItemTarget, prId: PR_ID });
  assert.equal(eventStream.handlers.size, 1, 'the old subscription is replaced');
  assert.deepEqual(
    api.fetchPeerReviewState.mock.calls.map((call) => call[0]),
    [workspaceTarget, workItemTarget],
  );

  await act(async () => {
    second.resolve(peerState({ presenterProvider: 'codex', reviewerProvider: 'claude' }));
    await second.promise;
  });
  assert.equal(result.current.presenterProvider, 'codex');
  assert.equal(result.current.ready, true);

  await act(async () => {
    first.resolve(peerState({ ready: false, reason: 'session_restart_required', review: review('failed') }));
    await first.promise;
  });
  assert.equal(result.current.ready, true, 'the stale response is ignored');
  assert.equal(result.current.reason, null);
  assert.equal(result.current.review, null);

  api.fetchPeerReviewState.mockRejectedValueOnce(new Error('peer review endpoint missing'));
  rerender({ target: workspaceTarget, prId: 'acme/api#8' });
  assert.equal(result.current.presenterProvider, null, 'state resets while the new target loads');
  assert.equal(result.current.ready, false);
  await waitFor(() => assert.equal(result.current.error, 'peer review endpoint missing'));

  unmount();
  assert.equal(eventStream.handlers.size, 0);
});
