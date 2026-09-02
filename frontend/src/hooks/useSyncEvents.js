import { useEffect } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';

/**
 * Subscribes to SSE sync events and calls `callback` on each sync.
 *
 * A callback may return a cleanup function, the same way a useEffect body
 * does; it runs before the next sync-triggered call and on unmount. Loaders
 * use this to drop the result of a request that a newer sync has superseded.
 * @param {() => unknown} callback returning a function registers it as cleanup
 */
export function useSyncEvents(callback) {
  useEffect(() => {
    /** @type {(() => void) | null} */
    let cleanup = null;
    const unsubscribe = subscribeAppEvent('sync', () => {
      cleanup?.();
      const result = callback();
      cleanup = typeof result === 'function' ? /** @type {() => void} */ (result) : null;
    });
    return () => {
      cleanup?.();
      unsubscribe();
    };
  }, [callback]);
}
