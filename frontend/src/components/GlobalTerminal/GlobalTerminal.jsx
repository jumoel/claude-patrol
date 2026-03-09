import { useState, useCallback } from 'react';
import { Terminal } from '../Terminal/Terminal.jsx';
import styles from './GlobalTerminal.module.css';

/**
 * Persistent global terminal drawer at the bottom of the UI.
 */
export function GlobalTerminal() {
  const [open, setOpen] = useState(false);
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

  const toggle = useCallback(() => {
    if (!open && !session) {
      startSession();
    }
    setOpen(prev => !prev);
  }, [open, session, startSession]);

  const killSession = useCallback(async () => {
    if (!session) return;
    await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
    setSession(null);
  }, [session]);

  return (
    <div className={`${styles.drawer} ${open ? styles.open : styles.closed}`}>
      <div className={styles.handle} onClick={toggle}>
        <span className={styles.handleText}>
          {open ? 'Hide' : 'Show'} Global Terminal
        </span>
        {session && (
          <button className={styles.killButton} onClick={(e) => { e.stopPropagation(); killSession(); }}>
            Kill
          </button>
        )}
      </div>
      {open && (
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
      )}
    </div>
  );
}
