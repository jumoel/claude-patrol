import { useCallback, useEffect, useRef, useState } from 'react';
import { acknowledgeReviewRequest, fetchReviewRequests, refreshReviewRequests } from '../lib/api.js';
import { ApiError } from '../lib/errors.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** SQLite paging is independent of remote polling and session activity.
 * @param {boolean} enabled @param {string} planId */
export function useReviewRequests(enabled, planId) {
  const [page, setPage] = useState(/** @type {import('../types').ReviewRequestPage | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {unknown} */ (null));
  const [busy, setBusy] = useState(/** @type {Set<string>} */ (new Set()));
  const current = useRef(page);
  const sequence = useRef(0);
  const statusSequence = useRef(0);
  const active = useRef(/** @type {AbortController | null} */ (null));

  const reload = useCallback(async () => {
    if (!enabled) return;
    const version = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const next = await fetchReviewRequests({}, controller.signal);
      if (version !== sequence.current) return;
      current.current = next;
      setPage(next);
      setError(null);
    } catch (failure) {
      if (!controller.signal.aborted && version === sequence.current) setError(failure);
    } finally {
      if (version === sequence.current) setLoading(false);
    }
  }, [enabled]);

  const reconcile = useCallback(async () => {
    if (!enabled) return;
    const version = sequence.current;
    const statusVersion = ++statusSequence.current;
    try {
      const status = await fetchReviewRequests({ status_only: 'true' });
      if (version !== sequence.current || statusVersion !== statusSequence.current) return;
      const previous = current.current;
      if (!previous || previous.list_version !== status.list_version) {
        await reload();
        return;
      }
      const ids = previous.rows.map((row) => row.id);
      const batches = [];
      for (let offset = 0; offset < ids.length; offset += 100) batches.push(ids.slice(offset, offset + 100));
      const updates = await Promise.all(batches.map((batch) => fetchReviewRequests({ ids: batch.join(',') })));
      if (version !== sequence.current || statusVersion !== statusSequence.current) return;
      if (updates.some((update) => update.list_version !== status.list_version)) {
        await reload();
        return;
      }
      const byId = new Map(updates.flatMap((update) => update.rows).map((row) => [row.id, row]));
      const next = {
        ...previous,
        source: status.source,
        total_count: status.total_count,
        rows: previous.rows.map((row) => byId.get(row.id) ?? row),
      };
      current.current = next;
      setPage(next);
      setError(null);
    } catch (failure) {
      if (version === sequence.current && statusVersion === statusSequence.current) setError(failure);
    }
  }, [enabled, reload]);

  const loadMore = useCallback(async () => {
    const previous = current.current;
    if (!previous?.next_cursor || loading) return;
    const version = sequence.current;
    setLoading(true);
    try {
      const next = await fetchReviewRequests({ cursor: previous.next_cursor });
      if (version !== sequence.current) return;
      if (next.list_version !== previous.list_version) {
        await reload();
        return;
      }
      statusSequence.current++;
      const merged = { ...next, rows: [...(current.current?.rows ?? previous.rows), ...next.rows] };
      current.current = merged;
      setPage(merged);
    } catch (failure) {
      if (version !== sequence.current) return;
      if (failure instanceof ApiError && failure.envelope.code === 'invalid_state') await reload();
      else setError(failure);
    } finally {
      if (version === sequence.current) setLoading(false);
    }
  }, [loading, reload]);

  const toggle = useCallback(
    async (/** @type {import('../types').ReviewRequestRow} */ row) => {
      const version = sequence.current;
      setBusy((previous) => new Set(previous).add(row.id));
      try {
        await acknowledgeReviewRequest(row, !row.collapsed);
        if (version !== sequence.current) return;
        await reconcile();
      } catch (failure) {
        if (version !== sequence.current) return;
        await reconcile();
        if (version === sequence.current) setError(failure);
      } finally {
        if (version === sequence.current)
          setBusy((previous) => {
            const next = new Set(previous);
            next.delete(row.id);
            return next;
          });
      }
    },
    [reconcile],
  );

  const retry = useCallback(async () => {
    const version = sequence.current;
    try {
      await refreshReviewRequests();
      if (version !== sequence.current) return;
      await reconcile();
    } catch (failure) {
      if (version === sequence.current) setError(failure);
    }
  }, [reconcile]);

  useEffect(() => {
    void planId;
    current.current = null;
    setPage(null);
    setBusy(new Set());
    setError(null);
    setLoading(false);
    if (enabled) void reload();
    return () => {
      sequence.current++;
      active.current?.abort();
    };
  }, [enabled, planId, reload]);
  useEffect(() => {
    if (!enabled) return undefined;
    const review = subscribeAppEvent('review-request-change', () => {
      void reconcile();
    });
    const account = subscribeAppEvent('local-change', () => {
      void reconcile();
    });
    const reconnect = subscribeAppEvent('open', () => {
      void reconcile();
    });
    return () => {
      review();
      account();
      reconnect();
    };
  }, [enabled, reconcile]);
  return { page, rows: page?.rows ?? [], loading, loaded: page !== null, error, busy, reload, retry, loadMore, toggle };
}
