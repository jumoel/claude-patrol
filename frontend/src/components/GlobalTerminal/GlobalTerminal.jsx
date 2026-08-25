import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import {
  createSession as apiCreateSession,
  reattachSession as apiReattachSession,
  fetchSessions,
  promoteSession,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { LazyTerminal } from '../Terminal/LazyTerminal.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
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
  } catch {
    /* ignore */
  }
  return DEFAULT_HEIGHT;
}

/** @param {number} h */
function persistHeight(h) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

/**
 * Persistent global terminal drawer at the bottom of the UI.
 * Stays mounted when closed to preserve the xterm instance and session.
 * @param {{ open: boolean, onToggle: () => void, onSessionChange?: (session: import('../../types').Session | null) => void }} props
 */
export function GlobalTerminal({ open, onToggle, onSessionChange }) {
  const { provider } = useAgentProvider();
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [launchError, setLaunchError] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [promoteRepo, setPromoteRepo] = useState('');
  const [promoteBranch, setPromoteBranch] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [reattaching, setReattaching] = useState(false);
  const autoStartAttempted = useRef(false);
  const poppingOut = useRef(false);

  const { height, setHeight, dragging, handleProps } = useResizeHandle({
    initial: loadHeight(),
    min: MIN_HEIGHT,
    max: window.innerHeight * MAX_HEIGHT_RATIO,
    direction: 'up',
    onPersist: persistHeight,
  });

  useEscapeKey(
    maximized,
    useCallback(() => setMaximized(false), []),
  );

  useEffect(() => {
    let active = true;
    fetchSessions({ type: 'global' })
      .then((sessions) => {
        if (active) setSession(sessions[0] || null);
      })
      .catch((error) => {
        if (active) setLaunchError(getErrorMessage(error, 'Failed to load the global session'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Notify parent when session changes
  useEffect(() => {
    onSessionChange?.(session);
  }, [session, onSessionChange]);

  const startSession = useCallback(async () => {
    if (session) return;
    setLoading(true);
    setLaunchError('');
    try {
      setSession(await apiCreateSession({ type: 'global' }, provider));
    } catch (err) {
      console.error('Failed to start global session:', err);
      setLaunchError(getErrorMessage(err, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
    } finally {
      setLoading(false);
    }
  }, [provider, session]);

  // Auto-start session when opened for the first time
  useEffect(() => {
    if (!open) {
      autoStartAttempted.current = false;
    } else if (!session && !loading && !autoStartAttempted.current) {
      autoStartAttempted.current = true;
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
    if (poppingOut.current) {
      poppingOut.current = false;
      setSession((current) => (current ? { ...current, status: 'detached' } : null));
    } else {
      setSession(null);
    }
  }, []);

  const popOutSession = useCallback(async () => {
    if (!session) return;
    poppingOut.current = true;
    try {
      const response = await fetch(`/api/sessions/${session.id}/popout`, { method: 'POST' });
      if (!response.ok) throw new Error(`Pop out failed: ${response.status}`);
      setSession((current) => (current ? { ...current, status: 'detached' } : null));
      setMaximized(false);
    } catch (err) {
      poppingOut.current = false;
      console.error('Failed to pop out session:', err);
    }
  }, [session]);

  const reattachSession = useCallback(async () => {
    if (!session) return;
    setReattaching(true);
    setLaunchError('');
    try {
      setSession(await apiReattachSession(session.id));
    } catch (error) {
      setLaunchError(getErrorMessage(error, 'Failed to reattach the global session'));
    } finally {
      setReattaching(false);
    }
  }, [session]);

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
      alert(`Promote failed: ${getErrorMessage(err)}`);
    } finally {
      setPromoting(false);
    }
  }, [session, promoteRepo, promoteBranch, onToggle]);

  // Double-click toggles between min and default
  const handleDoubleClick = useCallback(() => {
    setHeight((prev) => {
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
        <Stack justify="between" className={styles.handle}>
          <span className={styles.handleText}>
            Global {(session?.provider ?? provider) === 'codex' ? 'Codex' : 'Claude'}
          </span>
          <Stack gap={2}>
            {session && (
              <>
                {session.status === 'active' && session.provider === 'claude' && (
                  <Button variant="success" size="xs" dark onClick={() => setShowPromote((s) => !s)}>
                    Promote
                  </Button>
                )}
                {session.status === 'active' ? (
                  <>
                    <Button size="xs" dark onClick={() => setMaximized((m) => !m)}>
                      {maximized ? 'Restore' : 'Maximize'}
                    </Button>
                    <Button variant="primary" size="xs" dark onClick={popOutSession}>
                      Pop out
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="xs"
                    dark
                    onClick={reattachSession}
                    disabled={reattaching}
                    busy={reattaching}
                  >
                    {reattaching ? 'Reattaching...' : 'Reattach'}
                  </Button>
                )}
                <Button variant="danger" size="xs" dark onClick={killSession}>
                  Kill
                </Button>
              </>
            )}
            <button
              className={styles.closeButton}
              onClick={() => {
                setMaximized(false);
                onToggle();
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <line x1="3" y1="3" x2="11" y2="11" />
                <line x1="11" y1="3" x2="3" y2="11" />
              </svg>
            </button>
          </Stack>
        </Stack>
        {showPromote && session?.provider === 'claude' && (
          <Stack gap={2} className={styles.promoteForm}>
            <RepoCombobox value={promoteRepo} onChange={setPromoteRepo} disabled={promoting} variant="dark" />
            <input
              className={styles.promoteInput}
              type="text"
              placeholder="branch-name"
              value={promoteBranch}
              onChange={(e) => setPromoteBranch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePromote()}
              disabled={promoting}
            />
            <Button
              variant="success"
              size="xs"
              dark
              filled
              onClick={handlePromote}
              disabled={promoting || !promoteRepo || !promoteBranch}
              busy={promoting}
            >
              {promoting ? 'Promoting...' : 'Go'}
            </Button>
            <Button variant="ghost" size="xs" dark onClick={() => setShowPromote(false)} disabled={promoting}>
              Cancel
            </Button>
          </Stack>
        )}
        <div className={styles.content}>
          {loading && <LoadingIndicator className={styles.loading}>Loading global session...</LoadingIndicator>}
          {session?.status === 'active' && (
            <LazyTerminal wsUrl={`/ws/sessions/${session.id}`} focus={open} onExit={handleSessionExit} />
          )}
          {session?.status === 'detached' && (
            <div className={styles.placeholder}>
              <Stack direction="col" gap={3}>
                <p className={styles.detached}>Session is running in an external terminal.</p>
                <Button
                  variant="primary"
                  size="lg"
                  dark
                  onClick={reattachSession}
                  disabled={reattaching}
                  busy={reattaching}
                >
                  {reattaching ? 'Reattaching...' : 'Reattach global session'}
                </Button>
                {launchError && (
                  <p className={styles.launchError} role="alert">
                    {launchError}
                  </p>
                )}
              </Stack>
            </div>
          )}
          {!session && !loading && (
            <div className={styles.placeholder}>
              <Stack direction="col" gap={3}>
                <Stack gap={2}>
                  <AgentProviderButton variant="primary" size="lg" dark onClick={startSession}>
                    Start global {provider === 'codex' ? 'Codex' : 'Claude'} session
                  </AgentProviderButton>
                </Stack>
                {launchError && (
                  <p className={styles.launchError} role="alert">
                    {launchError}
                  </p>
                )}
              </Stack>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
