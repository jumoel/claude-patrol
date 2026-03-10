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

  return (
    <div className={styles.bar}>
      <span className={styles.stat}>{prCount} open PRs</span>
      <span className={styles.divider} />
      <span className={styles.stat}>{workspaceCount} active workspaces</span>
      <span className={styles.divider} />
      <span className={styles.stat}>{sessionCount} running sessions</span>
    </div>
  );
}
