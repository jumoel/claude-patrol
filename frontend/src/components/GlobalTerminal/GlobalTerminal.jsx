import { useState, useCallback, useEffect, useRef } from 'react';
import { Terminal } from '../Terminal/Terminal.jsx';
import styles from './GlobalTerminal.module.css';

const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.85;
const DEFAULT_HEIGHT = 400;
const STORAGE_KEY = 'claude-patrol-terminal-height';

function loadHeight() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const h = Number(saved);
      if (h >= MIN_HEIGHT && h <= window.innerHeight * MAX_HEIGHT_RATIO) return h;
    }
  } catch { /* ignore */ }
  return DEFAULT_HEIGHT;
}

/**
 * Persistent global terminal drawer at the bottom of the UI.
 * Stays mounted when closed to preserve the xterm instance and session.
 * @param {{ open: boolean, onToggle: () => void }} props
 */
export function GlobalTerminal({ open, onToggle }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [height, setHeight] = useState(loadHeight);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(null);

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
    onToggle();
  }, [session, onToggle]);

  const popOutSession = useCallback(async () => {
    if (!session) return;
    try {
      await fetch(`/api/sessions/${session.id}/popout`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to pop out session:', err);
    }
  }, [session]);

  // Drag resize handlers
  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, height };
    setDragging(true);
    e.target.setPointerCapture(e.pointerId);
  }, [height]);

  const handlePointerMove = useCallback((e) => {
    if (!dragStartRef.current) return;
    const delta = dragStartRef.current.y - e.clientY;
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
    const newHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, dragStartRef.current.height + delta));
    setHeight(newHeight);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    setHeight(h => {
      try { localStorage.setItem(STORAGE_KEY, String(Math.round(h))); } catch { /* ignore */ }
      return h;
    });
  }, []);

  // Double-click toggles between min and default
  const handleDoubleClick = useCallback(() => {
    setHeight(prev => {
      const next = prev <= MIN_HEIGHT + 20 ? DEFAULT_HEIGHT : MIN_HEIGHT;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // The spacer height is used by the parent to add scroll room.
  // The drawer itself is position:fixed so it doesn't participate in flow.
  const spacerHeight = open ? height : 0;

  return (
    <>
      {/* Flow spacer - pushes content up so it's scrollable behind the drawer */}
      <div style={{ height: spacerHeight, flexShrink: 0 }} />
      {dragging && <div className={styles.dragOverlay} />}
      <div
        className={styles.drawer}
        style={{ height, display: open ? 'flex' : 'none' }}
      >
        <div
          className={styles.resizeHandle}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          <div className={styles.resizeGrip} />
        </div>
        <div className={styles.handle}>
          <span className={styles.handleText}>Global Terminal</span>
          <div className={styles.handleActions}>
            {session && (
              <>
                <button className={styles.popOutButton} onClick={popOutSession}>
                  Pop out
                </button>
                <button className={styles.killButton} onClick={killSession}>
                  Kill
                </button>
              </>
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
          {session && <Terminal wsUrl={`/ws/sessions/${session.id}`} focus={open} />}
          {!session && !loading && (
            <div className={styles.placeholder}>
              <button className={styles.startButton} onClick={startSession}>
                Start Global Session
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
