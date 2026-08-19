import { useCallback, useEffect, useState } from 'react';
import { fetchPeerReviewState, requestPeerReview } from '../lib/api.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** Track one workspace's inverse-provider review lifecycle across component remounts. */
/** @param {string | undefined} workspaceId */
export function usePeerReviewState(workspaceId) {
  const [review, setReview] = useState(/** @type {import('../types').PeerReview | null} */ (null));
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState(/** @type {string | null} */ (null));
  const [presenterProvider, setPresenterProvider] = useState(
    /** @type {import('../types').AgentProvider | null} */ (null),
  );
  const [reviewerProvider, setReviewerProvider] = useState(
    /** @type {import('../types').AgentProvider | null} */ (null),
  );
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    let active = true;
    setReview(null);
    setReady(false);
    setReason(null);
    setPresenterProvider(null);
    setReviewerProvider(null);
    setError(null);
    if (!workspaceId) return undefined;

    fetchPeerReviewState(workspaceId)
      .then((state) => {
        if (!active) return;
        setReview(state.review);
        setReady(state.ready);
        setReason(state.reason);
        setPresenterProvider(state.presenterProvider);
        setReviewerProvider(state.reviewerProvider);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });

    const unsubscribe = subscribeAppEvent('peer-review-state', (event) => {
      const update = JSON.parse(event.data);
      if (update.workspaceId === workspaceId) setReview(update.review);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId]);

  const requestReview = useCallback(async () => {
    if (!workspaceId) return;
    setRequesting(true);
    setError(null);
    try {
      const result = await requestPeerReview(workspaceId);
      setReview(result.review);
      setPresenterProvider(result.review.presenterProvider);
      setReviewerProvider(result.review.reviewerProvider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }, [workspaceId]);

  return { review, ready, reason, presenterProvider, reviewerProvider, requesting, error, requestReview };
}
