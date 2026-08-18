import { useEffect } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';

/**
 * Subscribes to SSE sync events and calls `callback` on each sync.
 * @param {() => void} callback
 */
export function useSyncEvents(callback) {
  useEffect(() => {
    return subscribeAppEvent('sync', () => callback());
  }, [callback]);
}
