import { useCallback, useEffect, useState } from 'react';
import { fetchCodexReviewState, requestCodexReview } from '../lib/api.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** Track one workspace's review lifecycle across component remounts. */
/** @param {string | undefined} workspaceId */
export function useCodexReviewState(workspaceId) {
  const [review, setReview] = useState(/** @type {import('../types').CodexReview | null} */ (null));
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState(/** @type {string | null} */ (null));
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    let active = true;
    setReview(null);
    setReady(false);
    setReason(null);
    setError(null);
    if (!workspaceId) return undefined;

    fetchCodexReviewState(workspaceId)
      .then((state) => {
        if (!active) return;
        setReview(state.review);
        setReady(state.ready);
        setReason(state.reason);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });

    const unsubscribe = subscribeAppEvent('codex-review-state', (event) => {
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
      const result = await requestCodexReview(workspaceId);
      setReview(result.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }, [workspaceId]);

  return { review, ready, reason, requesting, error, requestReview };
}
