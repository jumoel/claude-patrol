import { useCallback, useEffect, useState } from 'react';
import { fetchPeerReviewState, requestPeerReview } from '../lib/api.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** Track one local-work target's inverse-provider review lifecycle across component remounts. */
/** @param {{type: 'workspace'|'work_item', id: string} | undefined} target @param {string | undefined} prId */
export function usePeerReviewState(target, prId) {
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
    if (!target) return undefined;

    fetchPeerReviewState(target, prId)
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
      if (
        (target.type === 'workspace' && update.workspaceId === target.id) ||
        (target.type === 'work_item' && update.workItemId === target.id)
      ) {
        setReview(update.review);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [prId, target]);

  const requestReview = useCallback(async () => {
    if (!target) return;
    setRequesting(true);
    setError(null);
    try {
      const result = await requestPeerReview(target, prId);
      setReview(result.review);
      setPresenterProvider(result.review.presenterProvider);
      setReviewerProvider(result.review.reviewerProvider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }, [prId, target]);

  return { review, ready, reason, presenterProvider, reviewerProvider, requesting, error, requestReview };
}
