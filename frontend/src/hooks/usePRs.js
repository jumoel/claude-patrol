import { useCallback, useEffect, useRef, useState } from 'react';
import { triggerSync as apiTriggerSync, fetchConfig, fetchPRs } from '../lib/api.js';
import { getErrorMessage } from '../lib/errors.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

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
  const [prs, setPRs] = useState(/** @type {import('../types').PullRequest[]} */ ([]));
  const [syncedAt, setSyncedAt] = useState(/** @type {string | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [syncing, setSyncing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [ghRateLimit, setGhRateLimit] = useState(/** @type {import('../types').GhRateLimit | null} */ (null));
  const [freshness, setFreshness] = useState(/** @type {import('../types').PullRequestFreshness | null} */ (null));
  const filtersRef = useRef(filters);
  const syncedAtRef = useRef(/** @type {string | null} */ (null));
  const pollIntervalRef = useRef(600);
  filtersRef.current = filters;

  const loadPRs = useCallback(async () => {
    try {
      const data = await fetchPRs(filtersRef.current);
      setPRs(data.prs);
      setSyncedAt(data.synced_at);
      setFreshness(data.freshness ?? null);
      syncedAtRef.current = data.synced_at;
      setCountdown(calcRemaining(data.synced_at, pollIntervalRef.current));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch config for poll interval
  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        pollIntervalRef.current = cfg.poll.interval_seconds;
        // Recalculate countdown with correct interval if we already have syncedAt
        if (syncedAtRef.current) {
          setCountdown(calcRemaining(syncedAtRef.current, cfg.poll.interval_seconds));
        }
      })
      .catch(() => {});
  }, []);

  // Countdown timer
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Initial fetch. Live updates below refresh the same stable filter set.
  useEffect(() => {
    loadPRs();
  }, [loadPRs]);

  // SSE for live updates (sync from GitHub + local workspace/session changes)
  useEffect(() => {
    const unsubscribers = [
      subscribeAppEvent('sync', () => {
        setSyncing(false);
        loadPRs();
      }),
      subscribeAppEvent('gh-rate-limit', (event) => {
        try {
          /** @type {import('../types').GhRateLimit} */
          const data = JSON.parse(event.data);
          setGhRateLimit(data?.limited ? data : null);
        } catch {
          /* ignore */
        }
      }),
      subscribeAppEvent('local-change', () => {
        // Re-fetch config so interval is up-to-date for the next sync.
        fetchConfig()
          .then((cfg) => {
            pollIntervalRef.current = cfg.poll.interval_seconds;
            setCountdown(cfg.poll.interval_seconds);
          })
          .catch(() => {});
        loadPRs();
      }),
    ];
    return () =>
      unsubscribers.forEach((unsubscribe) => {
        unsubscribe();
      });
  }, [loadPRs]);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      await apiTriggerSync();
    } catch {
      setSyncing(false);
    }
  }, []);

  return { prs, syncedAt, freshness, loading, error, syncing, countdown, triggerSync, ghRateLimit };
}
