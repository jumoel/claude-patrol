import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWorkItem, fetchWorkItems } from '../lib/api.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** @param {unknown} error */
function isAbort(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * @returns {{workItems: import('../types').WorkItemListItem[], loading: boolean, loaded: boolean, error: unknown, reload: () => void}}
 */
export function useWorkItems(enabled = true) {
  const [workItems, setWorkItems] = useState(/** @type {import('../types').WorkItemListItem[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(/** @type {unknown} */ (null));
  const request = useRef(/** @type {AbortController | null} */ (null));

  const reload = useCallback(() => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    fetchWorkItems(controller.signal)
      .then(({ work_items: items }) => {
        setWorkItems(items);
        setLoaded(true);
      })
      .catch((nextError) => {
        if (!isAbort(nextError)) setError(nextError);
      })
      .finally(() => {
        if (request.current === controller) setLoading(false);
      });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      // Nothing will ever load; report settled like usePRs does.
      setLoading(false);
      return undefined;
    }
    reload();
    /** @param {MessageEvent<string>} event */
    const onTask = (event) => {
      try {
        const task = JSON.parse(event.data);
        if (typeof task.kind === 'string' && task.kind.startsWith('work-item.')) reload();
      } catch {
        // Ignore malformed event data. The database is fetched again on the next local change.
      }
    };
    const unsubscribeLocal = subscribeAppEvent('local-change', reload);
    const unsubscribeTask = subscribeAppEvent('task-update', onTask);
    return () => {
      request.current?.abort();
      unsubscribeLocal();
      unsubscribeTask();
    };
  }, [enabled, reload]);

  return { workItems, loading, loaded, error, reload };
}

/**
 * @param {string} id
 * @returns {{workItem: import('../types').WorkItemDetail | null, loading: boolean, error: unknown, reload: () => void}}
 */
export function useWorkItem(id) {
  const [workItem, setWorkItem] = useState(/** @type {import('../types').WorkItemDetail | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {unknown} */ (null));
  const request = useRef(/** @type {AbortController | null} */ (null));

  const reload = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    fetchWorkItem(id, controller.signal)
      .then(({ work_item: item }) => setWorkItem(item))
      .catch((nextError) => {
        if (!isAbort(nextError)) setError(nextError);
      })
      .finally(() => {
        if (request.current === controller) setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setWorkItem(null);
    reload();
    /** @param {MessageEvent<string>} event */
    const onTask = (event) => {
      try {
        const task = JSON.parse(event.data);
        if (task.context?.workItemId === id) reload();
      } catch {
        // Ignore malformed event data. The database is fetched again on the next local change.
      }
    };
    const unsubscribeLocal = subscribeAppEvent('local-change', reload);
    const unsubscribeTask = subscribeAppEvent('task-update', onTask);
    return () => {
      request.current?.abort();
      unsubscribeLocal();
      unsubscribeTask();
    };
  }, [id, reload]);

  return { workItem, loading, error, reload };
}
