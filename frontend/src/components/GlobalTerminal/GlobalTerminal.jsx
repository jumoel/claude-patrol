import { useState, useCallback, useEffect } from 'react';
import { Terminal } from '../Terminal/Terminal.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import { promoteSession, fetchConfig } from '../../lib/api.js';
import shared from '../../styles/shared.module.css';
import styles from './GlobalTerminal.module.css';

const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.85;
const DEFAULT_HEIGHT = 600;
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

function persistHeight(h) {
  try { localStorage.setItem(STORAGE_KEY, String(Math.round(h))); } catch { /* ignore */ }
}

/**
 * Persistent global terminal drawer at the bottom of the UI.
 * Stays mounted when closed to preserve the xterm instance and session.
 * @param {{ open: boolean, onToggle: () => void }} props
 */
export function GlobalTerminal({ open, onToggle }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [promoteRepo, setPromoteRepo] = useState('');
  const [promoteBranch, setPromoteBranch] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [repos, setRepos] = useState([]);

  const { height, setHeight, dragging, handleProps } = useResizeHandle({
    initial: loadHeight(),
    min: MIN_HEIGHT,
    max: window.innerHeight * MAX_HEIGHT_RATIO,
    direction: 'up',
    onPersist: persistHeight,
  });

  useEscapeKey(maximized, useCallback(() => setMaximized(false), []));

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

  const handleSessionExit = useCallback(() => {
    setSession(null);
  }, []);

  const popOutSession = useCallback(async () => {
    if (!session) return;
    try {
      await fetch(`/api/sessions/${session.id}/popout`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to pop out session:', err);
    }
  }, [session]);

  // Fetch repos for the promote dropdown
  useEffect(() => {
    if (!showPromote) return;
    fetchConfig().then(cfg => {
      const repoList = (cfg.poll?.repos || []).filter(r => r.includes('/') && !r.includes('*'));
      setRepos(repoList);
      if (repoList.length > 0 && !promoteRepo) setPromoteRepo(repoList[0]);
    }).catch(() => {});
  }, [showPromote]);

  const handlePromote = useCallback(async () => {
    if (!session || !promoteRepo || !promoteBranch) return;
    setPromoting(true);
    try {
      const result = await promoteSession(session.id, promoteRepo, promoteBranch);
      setSession(null);
      setShowPromote(false);
      setPromoteBranch('');
      setMaximized(false);
      onToggle();
      window.location.hash = `#/workspace/${result.workspace.id}`;
    } catch (err) {
      console.error('Failed to promote session:', err);
      alert(`Promote failed: ${err.message}`);
    } finally {
      setPromoting(false);
    }
  }, [session, promoteRepo, promoteBranch, onToggle]);

  // Double-click toggles between min and default
  const handleDoubleClick = useCallback(() => {
    setHeight(prev => {
      const next = prev <= MIN_HEIGHT + 20 ? DEFAULT_HEIGHT : MIN_HEIGHT;
      persistHeight(next);
      return next;
    });
  }, [setHeight]);

  // The spacer height is used by the parent to add scroll room.
  // The drawer itself is position:fixed so it doesn't participate in flow.
  const spacerHeight = open && !maximized ? height : 0;

  return (
    <>
      {/* Flow spacer - pushes content up so it's scrollable behind the drawer */}
      <div style={{ height: spacerHeight, flexShrink: 0 }} />
      {dragging && <div className={shared.dragOverlay} />}
      <div
        className={maximized ? styles.maximized : styles.drawer}
        style={maximized ? { display: open ? 'flex' : 'none' } : { height, display: open ? 'flex' : 'none' }}
      >
        {!maximized && (
          <div className={styles.resizeHandle} {...handleProps} onDoubleClick={handleDoubleClick}>
            <div className={styles.resizeGrip} />
          </div>
        )}
        <div className={styles.handle}>
          <span className={styles.handleText}>Global Terminal</span>
          <div className={styles.handleActions}>
            {session && (
              <>
                <button className={styles.promoteButton} onClick={() => setShowPromote(s => !s)}>
                  Promote
                </button>
                <button className={styles.maximizeButton} onClick={() => setMaximized(m => !m)}>
                  {maximized ? 'Restore' : 'Maximize'}
                </button>
                <button className={styles.popOutButton} onClick={popOutSession}>
                  Pop out
                </button>
                <button className={styles.killButton} onClick={killSession}>
                  Kill
                </button>
              </>
            )}
            <button className={styles.closeButton} onClick={() => { setMaximized(false); onToggle(); }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="11" y2="11" />
                <line x1="11" y1="3" x2="3" y2="11" />
              </svg>
            </button>
          </div>
        </div>
        {showPromote && (
          <div className={styles.promoteForm}>
            <select
              className={styles.promoteSelect}
              value={promoteRepo}
              onChange={e => setPromoteRepo(e.target.value)}
              disabled={promoting}
            >
              {repos.length === 0 && <option value="">Loading...</option>}
              {repos.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <input
              className={styles.promoteInput}
              type="text"
              placeholder="branch-name"
              value={promoteBranch}
              onChange={e => setPromoteBranch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePromote()}
              disabled={promoting}
            />
            <button
              className={styles.promoteSubmit}
              onClick={handlePromote}
              disabled={promoting || !promoteRepo || !promoteBranch}
            >
              {promoting ? 'Promoting...' : 'Go'}
            </button>
            <button
              className={styles.promoteCancel}
              onClick={() => setShowPromote(false)}
              disabled={promoting}
            >
              Cancel
            </button>
          </div>
        )}
        <div className={styles.content}>
          {loading && <p className={styles.loading}>Starting session...</p>}
          {session && <Terminal wsUrl={`/ws/sessions/${session.id}`} focus={open} onExit={handleSessionExit} />}
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
