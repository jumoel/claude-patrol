import { useState, useEffect } from 'react';
import { fetchWorkspaces, fetchSessions } from '../../lib/api.js';
import styles from './DashboardSummary.module.css';

/**
 * Summary stats bar above the PR table.
 * @param {{ prCount: number, syncedAt: string | null }} props
 */
export function DashboardSummary({ prCount, syncedAt }) {
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    fetchWorkspaces().then(ws => setWorkspaceCount(ws.length)).catch(() => {});
    fetchSessions().then(ss => setSessionCount(ss.length)).catch(() => {});
  }, [syncedAt]);

  const sinceSync = syncedAt ? timeSince(syncedAt) : 'never';

  return (
    <div className={styles.bar}>
      <span className={styles.stat}>{prCount} open PRs</span>
      <span className={styles.divider} />
      <span className={styles.stat}>{workspaceCount} active workspaces</span>
      <span className={styles.divider} />
      <span className={styles.stat}>{sessionCount} running sessions</span>
      <span className={styles.divider} />
      <span className={styles.stat}>Last synced: {sinceSync}</span>
    </div>
  );
}

function timeSince(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}
