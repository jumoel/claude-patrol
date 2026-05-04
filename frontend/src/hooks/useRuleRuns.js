import { useEffect, useState } from 'react';
import { fetchRuleRuns } from '../lib/api.js';

const COMPLETED_TTL_MS = 30 * 60 * 1000;
const MAX_VISIBLE = 50;

/**
 * Subscribe to rule-run events. Initial state from /api/rules/runs, live updates
 * via the `rule-run` SSE event (emitted on insert and on each persisted update).
 * Sorted: running first, most recent completed next.
 * @returns {Array<object>}
 */
export function useRuleRuns() {
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetchRuleRuns({ limit: MAX_VISIBLE })
      .then((initial) => {
        if (!cancelled) setRuns(initial);
      })
      .catch(() => {});

    const source = new EventSource('/api/events');
    source.addEventListener('rule-run', (e) => {
      try {
        const incoming = JSON.parse(e.data);
        setRuns((prev) => merge(prev, incoming));
      } catch {
        /* ignore malformed payloads */
      }
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return runs;
}

function merge(prev, incoming) {
  const without = prev.filter((r) => r.id !== incoming.id);
  const next = [incoming, ...without];

  const now = Date.now();
  const fresh = next.filter((r) => !r.ended_at || now - new Date(r.ended_at).getTime() < COMPLETED_TTL_MS);

  fresh.sort((a, b) => {
    if (!a.ended_at && b.ended_at) return -1;
    if (a.ended_at && !b.ended_at) return 1;
    return new Date(b.started_at) - new Date(a.started_at);
  });

  return fresh.slice(0, MAX_VISIBLE);
}
