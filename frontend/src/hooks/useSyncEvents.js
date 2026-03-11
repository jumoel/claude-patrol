import { useEffect } from 'react';

/**
 * Subscribes to SSE sync events and calls `callback` on each sync.
 * @param {() => void} callback
 */
export function useSyncEvents(callback) {
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('sync', () => callback());
    return () => source.close();
  }, [callback]);
}
