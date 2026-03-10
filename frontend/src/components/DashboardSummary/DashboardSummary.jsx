import { useState, useEffect, useRef } from 'react';
import { fetchWorkspaces, fetchSessions } from '../../lib/api.js';
import styles from './DashboardSummary.module.css';

/**
 * Summary stats bar above the PR table.
 * @param {{ prCount: number, syncedAt: string | null }} props
 */
function StatDropdown({ label, items, renderItem, emptyClass }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <span className={styles.dropdownWrapper} ref={ref}>
      <button
        className={`${styles.stat} ${styles.clickable} ${items.length === 0 ? styles.disabled : ''}`}
        onClick={() => items.length > 0 && setOpen(prev => !prev)}
        type="button"
      >
        {label}
      </button>
      {open && items.length > 0 && (
        <div className={styles.dropdown}>
          {items.map(renderItem)}
        </div>
      )}
    </span>
  );
}

export function DashboardSummary({ prCount, syncedAt }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    fetchWorkspaces().then(setWorkspaces).catch(() => {});
    fetchSessions().then(setSessions).catch(() => {});
  }, [syncedAt]);

  // Build a workspace_id -> workspace lookup for session labels
  const wsById = Object.fromEntries(workspaces.map(ws => [ws.id, ws]));

  return (
    <div className={styles.bar}>
      <span className={styles.stat}>{prCount} open PRs</span>
      <span className={styles.divider} />
      <StatDropdown
        label={`${workspaces.length} active workspaces`}
        items={workspaces}
        renderItem={(ws) => (
          <a
            key={ws.id}
            className={styles.dropdownItem}
            href={`#/pr/${encodeURIComponent(ws.pr_id)}`}
          >
            <span className={styles.itemName}>{ws.name}</span>
            <span className={styles.itemDetail}>{ws.path}</span>
          </a>
        )}
      />
      <span className={styles.divider} />
      <StatDropdown
        label={`${sessions.length} running sessions`}
        items={sessions}
        renderItem={(sess) => {
          const ws = sess.workspace_id ? wsById[sess.workspace_id] : null;
          const label = ws ? ws.name : 'Global session';
          const detail = `PID ${sess.pid} - started ${new Date(sess.started_at).toLocaleTimeString()}`;
          const href = ws ? `#/pr/${encodeURIComponent(ws.pr_id)}` : null;
          const Tag = href ? 'a' : 'span';
          return (
            <Tag key={sess.id} className={styles.dropdownItem} {...(href ? { href } : {})}>
              <span className={styles.itemName}>{label}</span>
              <span className={styles.itemDetail}>{detail}</span>
            </Tag>
          );
        }}
      />
    </div>
  );
}
