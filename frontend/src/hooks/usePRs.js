import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPRs, fetchConfig, triggerSync as apiTriggerSync } from '../lib/api.js';

/**
 * Hook to fetch PRs and auto-refresh via SSE.
 * @param {Record<string, string>} filters
 */
export function usePRs(filters) {
  const [prs, setPRs] = useState([]);
  const [syncedAt, setSyncedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [pollInterval, setPollInterval] = useState(600);
  const [countdown, setCountdown] = useState(0);
  const filtersRef = useRef(filters);
  const countdownRef = useRef(null);
  filtersRef.current = filters;

  const resetCountdown = useCallback((seconds) => {
    setCountdown(seconds);
  }, []);

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

  // Fetch config for poll interval
  useEffect(() => {
    fetchConfig().then(cfg => {
      setPollInterval(cfg.poll_interval_seconds);
      setCountdown(cfg.poll_interval_seconds);
    }).catch(() => {});
  }, []);

  // Countdown timer
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, []);

  // Initial fetch and re-fetch on filter change
  useEffect(() => {
    loadPRs();
  }, [filters, loadPRs]);

  // SSE for live updates
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('sync', () => {
      setSyncing(false);
      resetCountdown(pollInterval);
      loadPRs();
    });
    source.onerror = () => {
      // EventSource auto-reconnects
    };
    return () => source.close();
  }, [loadPRs, pollInterval, resetCountdown]);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      await apiTriggerSync();
    } catch {
      setSyncing(false);
    }
  }, []);

  return { prs, syncedAt, loading, error, syncing, countdown, triggerSync };
}
