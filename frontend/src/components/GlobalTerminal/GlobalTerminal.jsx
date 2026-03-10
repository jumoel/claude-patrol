import { useState, useCallback, useEffect } from 'react';
import { Terminal } from '../Terminal/Terminal.jsx';
import styles from './GlobalTerminal.module.css';

/**
 * Persistent global terminal drawer at the bottom of the UI.
 * @param {{ open: boolean, onToggle: () => void }} props
 */
export function GlobalTerminal({ open, onToggle }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);

  const startSession = useCallback(async () => {
    if (session) return;
    setLoading(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global: true }),
      });
      if (!res.ok) throw new Error('Failed to create session');
      const data = await res.json();
      setSession(data);
    } catch (err) {
      console.error('Failed to start global session:', err);
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Auto-start session when opened for the first time
  useEffect(() => {
    if (open && !session && !loading) {
      startSession();
    }
  }, [open, session, loading, startSession]);

  const killSession = useCallback(async () => {
    if (!session) return;
    await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    setSession(null);
  }, [session]);

  if (!open) return null;

  return (
    <div className={styles.drawer}>
      <div className={styles.handle}>
        <span className={styles.handleText}>Global Terminal</span>
        <div className={styles.handleActions}>
          {session && (
            <button className={styles.killButton} onClick={killSession}>
              Kill
            </button>
          )}
          <button className={styles.closeButton} onClick={onToggle}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="3" x2="11" y2="11" />
              <line x1="11" y1="3" x2="3" y2="11" />
            </svg>
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {loading && <p className={styles.loading}>Starting session...</p>}
        {session && <Terminal wsUrl={`/ws/sessions/${session.id}`} />}
        {!session && !loading && (
          <div className={styles.placeholder}>
            <button className={styles.startButton} onClick={startSession}>
              Start Global Session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
