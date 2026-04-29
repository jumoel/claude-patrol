import { useEffect, useState } from 'react';
import { fetchTasks } from '../lib/api.js';

const COMPLETED_TTL_MS = 5 * 60 * 1000;
const MAX_VISIBLE = 50;

/**
 * Subscribe to backend task updates. Returns a sorted list of tasks
 * (running first, most recent completed next).
 * @returns {Array<object>}
 */
export function useTasks() {
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((initial) => {
        if (!cancelled) setTasks(initial);
      })
      .catch(() => {});

    const source = new EventSource('/api/events');
    source.addEventListener('task-update', (e) => {
      try {
        const incoming = JSON.parse(e.data);
        setTasks((prev) => merge(prev, incoming));
      } catch {
        /* ignore malformed payloads */
      }
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return tasks;
}

function merge(prev, incoming) {
  const without = prev.filter((t) => t.id !== incoming.id);
  const next = [incoming, ...without];

  // Drop completed tasks older than TTL so the UI doesn't fill with stale rows.
  const now = Date.now();
  const fresh = next.filter((t) => !t.endedAt || now - new Date(t.endedAt).getTime() < COMPLETED_TTL_MS);

  fresh.sort((a, b) => {
    if (!a.endedAt && b.endedAt) return -1;
    if (a.endedAt && !b.endedAt) return 1;
    return new Date(b.startedAt) - new Date(a.startedAt);
  });

  return fresh.slice(0, MAX_VISIBLE);
}
