import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPRs, fetchConfig, triggerSync as apiTriggerSync } from '../lib/api.js';

/**
 * Calculate remaining seconds until next sync based on last sync time and interval.
 * @param {string | null} syncedAt
 * @param {number} intervalSeconds
 * @returns {number}
 */
function calcRemaining(syncedAt, intervalSeconds) {
  if (!syncedAt) return 0;
  const elapsed = Math.floor((Date.now() - new Date(syncedAt).getTime()) / 1000);
  return Math.max(0, intervalSeconds - elapsed);
}

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
  const syncedAtRef = useRef(null);
  const pollIntervalRef = useRef(600);
  filtersRef.current = filters;

  const loadPRs = useCallback(async () => {
    try {
      const data = await fetchPRs(filtersRef.current);
      setPRs(data.prs);
      setSyncedAt(data.synced_at);
      syncedAtRef.current = data.synced_at;
      setCountdown(calcRemaining(data.synced_at, pollIntervalRef.current));
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
      setPollInterval(cfg.poll.interval_seconds);
      pollIntervalRef.current = cfg.poll.interval_seconds;
      // Recalculate countdown with correct interval if we already have syncedAt
      if (syncedAtRef.current) {
        setCountdown(calcRemaining(syncedAtRef.current, cfg.poll.interval_seconds));
      }
    }).catch(() => {});
  }, []);

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Initial fetch and re-fetch on filter change
  useEffect(() => {
    loadPRs();
  }, [filters, loadPRs]);

  // SSE for live updates (sync from GitHub + local workspace/session changes)
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('sync', () => {
      setSyncing(false);
      loadPRs();
    });
    source.addEventListener('local-change', () => {
      loadPRs();
    });
    source.onerror = () => {
      // EventSource auto-reconnects
    };
    return () => source.close();
  }, [loadPRs]);

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
