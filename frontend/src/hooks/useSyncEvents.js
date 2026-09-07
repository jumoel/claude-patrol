import { useEffect } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';

/**
 * Subscribes to SSE sync events and calls `callback` on each sync.
 *
 * A callback may return a cleanup function, the same way a useEffect body
 * does; it runs before the next sync-triggered call and on unmount. Loaders
 * use this to drop the result of a request that a newer sync has superseded.
 * @param {() => unknown} callback returning a function registers it as cleanup
 * @param {string | null} [prId] also reload this PR when its shared snapshot changes
 * @param {() => unknown} [reviewCallback] content-only loader; excludes sessions and comments
 */
export function useSyncEvents(callback, prId = null, reviewCallback = callback) {
  useEffect(() => {
    /** @type {(() => void) | null} */
    let cleanup = null;
    const reload = () => {
      cleanup?.();
      const result = callback();
      cleanup = typeof result === 'function' ? /** @type {() => void} */ (result) : null;
    };
    const unsubscribe = subscribeAppEvent('sync', reload);
    const unsubscribeOpen = subscribeAppEvent('open', reload);
    const unsubscribeReview = prId
      ? subscribeAppEvent('review-request-change', (event) => {
          try {
            const change = JSON.parse(event.data);
            if (['detail', 'summary'].includes(change.kind) && (change.invalidate_all || change.ids?.includes(prId)))
              reviewCallback();
          } catch {
            /* Ignore malformed events. */
          }
        })
      : () => {};
    return () => {
      cleanup?.();
      unsubscribe();
      unsubscribeOpen();
      unsubscribeReview();
    };
  }, [callback, prId, reviewCallback]);
}
