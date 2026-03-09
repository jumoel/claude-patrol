import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPRs, triggerSync as apiTriggerSync } from '../lib/api.js';

/**
 * Hook to fetch PRs and auto-refresh via SSE.
 * @param {Record<string, string>} filters
 */
export function usePRs(filters) {
  const [prs, setPRs] = useState([]);
  const [syncedAt, setSyncedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const loadPRs = useCallback(async () => {
    try {
      const data = await fetchPRs(filtersRef.current);
      setPRs(data.prs);
      setSyncedAt(data.synced_at);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch and re-fetch on filter change
  useEffect(() => {
    loadPRs();
  }, [filters, loadPRs]);

  // SSE for live updates
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('sync', () => {
      loadPRs();
    });
    source.onerror = () => {
      // EventSource auto-reconnects
    };
    return () => source.close();
  }, [loadPRs]);

  const triggerSync = useCallback(async () => {
    await apiTriggerSync();
  }, []);

  return { prs, syncedAt, loading, error, triggerSync };
}
